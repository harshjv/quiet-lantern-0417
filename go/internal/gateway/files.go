package gateway

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/harshjv/stationly/go/internal/fsx"
)

func ConfigFiles(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range entries {
		if e.Type().IsRegular() && strings.HasSuffix(e.Name(), ".yml") {
			out = append(out, e.Name())
		}
	}
	return out, nil
}

func CopyStore(dir string, from, to int) error {
	body, err := os.ReadFile(filepath.Join(dir, StoreName(from)))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return fsx.WriteFile(filepath.Join(dir, StoreName(to)), body, 0o600)
}

func RemoveStore(dir string, n int) error {
	err := os.Remove(filepath.Join(dir, StoreName(n)))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

func Ready(ctx context.Context, addr netip.Addr) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+netip.AddrPortFrom(addr, 80).String()+"/", nil)
	if err != nil {
		return 0, err
	}
	req.Host = ProbeHost
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true, Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp.StatusCode, nil
}

type Certificate struct {
	Issued    bool
	Issuer    string
	NotAfter  time.Time
	NotBefore time.Time
	Status    int
	Err       string
}

func Inspect(ctx context.Context, gw netip.Addr, hostname string) Certificate {
	var out Certificate
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var leaf *x509.Certificate
	sni := hostname
	if _, err := netip.ParseAddr(hostname); err == nil {
		sni = ""
	}
	cfg := &tls.Config{
		ServerName:         sni,
		InsecureSkipVerify: true,
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) > 0 {
				leaf = cs.PeerCertificates[0]
			}
			return nil
		},
	}
	dialer := &net.Dialer{}
	transport := &http.Transport{
		Proxy:           nil,
		TLSClientConfig: cfg,
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, network, netip.AddrPortFrom(gw, 443).String())
		},
		DisableKeepAlives: true,
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://"+hostname+"/", nil)
	if err != nil {
		out.Err = err.Error()
		return out
	}
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		out.Err = err.Error()
	} else {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		resp.Body.Close()
		out.Status = resp.StatusCode
	}
	if leaf == nil {
		return out
	}
	out.Issuer = leaf.Issuer.CommonName
	out.NotAfter, out.NotBefore = leaf.NotAfter, leaf.NotBefore
	out.Issued = leaf.VerifyHostname(hostname) == nil && leaf.Issuer.CommonName != "TRAEFIK DEFAULT CERT"
	return out
}
