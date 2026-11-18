//go:build linux

package deploy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/harshjv/stationly/go/internal/credproxy"
	"github.com/harshjv/stationly/go/internal/dns"
	"github.com/harshjv/stationly/go/internal/fsx"
	"github.com/harshjv/stationly/go/internal/netns"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/sandbox"
)

const (
	credentialsCADir   = "credentials"
	credentialsCAKey   = "ca.key"
	credentialsCACert  = "ca.crt"
	trustInstallWait   = 60 * time.Second
	defaultSandboxPath = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
)

var trustInstall = []string{"update-ca-certificates", "--fresh"}

func credentialsEnv() string {
	return "NODE_EXTRA_CA_CERTS=" + protocol.CredentialsCAPath
}

func (s *Station) credentialsCADir(id string) string {
	return filepath.Join(s.opts.StateDir, credentialsCADir, id)
}

func (s *Station) credentialsCA(id string) (*credproxy.CA, error) {
	dir := s.credentialsCADir(id)
	now := time.Now()
	certPEM, certErr := os.ReadFile(filepath.Join(dir, credentialsCACert))
	keyPEM, keyErr := os.ReadFile(filepath.Join(dir, credentialsCAKey))
	if certErr == nil && keyErr == nil {
		if ca, err := credproxy.ParseCA(certPEM, keyPEM); err == nil && ca.Fits(protocol.CredentialHosts, now) {
			return ca, nil
		}
	}
	ca, err := credproxy.NewCA(id, protocol.CredentialHosts, now)
	if err != nil {
		return nil, err
	}
	keyPEM, err = ca.KeyPEM()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if err := fsx.WriteFile(filepath.Join(dir, credentialsCAKey), keyPEM, 0o600); err != nil {
		return nil, err
	}
	if err := fsx.WriteFile(filepath.Join(dir, credentialsCACert), ca.CertPEM(), 0o644); err != nil {
		return nil, err
	}
	s.log.Info("credentials CA made", "sandbox", id, "hosts", strings.Join(protocol.CredentialHosts, ","), "not_after", ca.Cert.NotAfter.UTC().Format(time.RFC3339))
	return ca, nil
}

func (s *Station) dropCredentialsCA(id string) {
	if err := os.RemoveAll(s.credentialsCADir(id)); err != nil {
		s.log.Warn("remove the credentials CA", "sandbox", id, "error", err)
	}
}

func installTrust(ctx context.Context, rt sandbox.Runtime, version, id string, env []string) error {
	ctx, cancel := context.WithTimeout(ctx, trustInstallWait)
	defer cancel()
	p, err := rt.Exec(ctx, version, sandbox.ExecSpec{ID: id, BundleDir: sandboxBundle(id), Args: trustInstall, Env: append([]string{defaultSandboxPath}, env...), Cwd: "/"})
	if err != nil {
		return err
	}
	_ = p.Stdin().Close()
	var out strings.Builder
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, p.Stdout())
		close(done)
	}()
	_, _ = io.Copy(&limitedWriter{w: &out, left: 4096}, p.Stderr())
	<-done
	code, err := p.Wait()
	if err != nil {
		return err
	}
	if code != 0 {
		return fmt.Errorf("%s exited %d: %s", strings.Join(trustInstall, " "), code, firstLine(out.String()))
	}
	return nil
}

type limitedWriter struct {
	w    io.Writer
	left int
}

func (l *limitedWriter) Write(b []byte) (int, error) {
	n := len(b)
	if l.left > 0 {
		keep := b[:min(len(b), l.left)]
		l.left -= len(keep)
		_, _ = l.w.Write(keep)
	}
	return n, nil
}

func (s *Station) openCredentialsProxy(st *sbxState) {
	if !st.baseline.Credentials || st.proxy != nil {
		return
	}
	id := st.rec.ID
	ca, err := s.credentialsCA(id)
	if err != nil {
		s.log.Error("load the credentials CA", "sandbox", id, "error", err)
		return
	}
	ns, err := netns.OpenChecked(st.pid, st.inode)
	if err != nil {
		s.log.Error("open the Coupler namespace for the credentials proxy", "sandbox", id, "error", err)
		return
	}
	ln, err := ns.ListenCoupler(protocol.NetworkCredentialsProxyPort)
	if err != nil {
		ns.Close()
		s.log.Error("listen for the credentials proxy", "sandbox", id, "error", err)
		return
	}
	p := credproxy.New(credproxy.Config{
		Hosts: protocol.CredentialHosts,
		CA:    ca,
		Lookup: func(placeholder string) (credproxy.Credential, bool) {
			c, ok := s.relayCreds.lookup(id, placeholder, time.Now())
			return credproxy.Credential{Value: c.value, Hosts: c.hosts}, ok
		},
		Dial: ns.DialCoupler,
		Resolve: func(ctx context.Context, host string) ([]netip.Addr, error) {
			return net.DefaultResolver.LookupNetIP(ctx, "ip4", host)
		},
		OriginalDst: netns.OriginalDst,
		Count: func(placeholder string, misdirected bool) {
			s.relayCreds.count(id, placeholder, misdirected)
		},
		Log: s.log.With("sandbox", id),
	})
	st.proxy, st.proxyNS = p, ns
	go func() {
		if err := p.Serve(ln); err != nil && !errors.Is(err, net.ErrClosed) {
			s.log.Warn("the credentials proxy stopped", "sandbox", id, "error", err)
		}
	}()
	s.log.Info("credentials proxy listening", "sandbox", id, "address", netip.AddrPortFrom(netns.CouplerLink, protocol.NetworkCredentialsProxyPort))
}

func (st *sbxState) closeCredentialsProxy() {
	if st.proxy == nil {
		return
	}
	_ = st.proxy.Close()
	st.proxyNS.Close()
	st.proxy, st.proxyNS = nil, nil
}

func (s *Station) onCredential(a dns.AllowAnswer) {
	e := s.sbx.index.get(a.Source)
	if e == nil || e.creds == nil {
		return
	}
	refresh := e.creds.Observe(a, time.Now())[dns.DefaultAllowPort]
	if len(refresh) == 0 {
		return
	}
	ns, err := netns.Open(e.pid)
	if err != nil {
		s.log.Warn("open the sandbox Coupler namespace for the credential set", "sandbox", e.id, "error", err)
		return
	}
	defer ns.Close()
	out := make([]netns.AllowElement, 0, len(refresh))
	for _, el := range refresh {
		out = append(out, netns.AllowElement{Addr: el.Addr, Timeout: el.Timeout})
	}
	if err := ns.RefreshCredentialHosts(out); err != nil {
		s.log.Warn("write the credential set", "sandbox", e.id, "name", a.Name, "error", err)
	}
}

func credentialElements(e *sbxNetEntry) []netns.AllowElement {
	if e == nil || e.creds == nil {
		return nil
	}
	return toNetnsAllow(e.creds.Elements(time.Now()))[dns.DefaultAllowPort]
}
