//go:build linux

package deploy

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"path/filepath"
	"time"

	mdns "github.com/miekg/dns"
	"golang.org/x/sys/unix"

	"github.com/harshjv/stationly/go/internal/millis"
	"github.com/harshjv/stationly/go/internal/netns"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/sandbox/runsc"
)

const (
	sandboxListenTimeout = 5 * time.Second
	sandboxListenMax     = 256 << 10
)

const sandboxListenScript = `for f in tcp tcp6 udp udp6; do echo "@@$f"; cat /proc/net/$f; done`

func (s *Station) sandboxListening(ctx context.Context, t netTarget, port uint16, proto string) ([]netns.Socket, error) {
	ctx, cancel := context.WithTimeout(ctx, sandboxListenTimeout)
	defer cancel()
	rt := runsc.At(runsc.LibDir, runsc.StateBase, t.runsc)
	ex, err := rt.Exec(ctx, runsc.ExecSpec{ID: t.serviceID, BundleDir: filepath.Join(sandboxBundles, t.serviceID), Args: []string{"/bin/sh", "-c", sandboxListenScript}, Cwd: "/"})
	if err != nil {
		return nil, err
	}
	ex.Stdin.Close()
	go func() { _, _ = io.Copy(io.Discard, ex.Stderr) }()
	out, readErr := io.ReadAll(io.LimitReader(ex.Stdout, sandboxListenMax))
	if ctx.Err() != nil || readErr != nil {
		_ = ex.Kill()
	}
	code, waitErr := ex.Wait()
	if err := errors.Join(readErr, ctx.Err()); err != nil {
		return nil, err
	}
	if waitErr != nil {
		return nil, waitErr
	}
	if code != 0 && !bytes.Contains(out, []byte(netns.SectionMark)) {
		return nil, fmt.Errorf("the sandbox's shell exited %d without a socket table", code)
	}
	return netns.ListeningDump(out, port, proto)
}

func sandboxProbeBlocked(v *protocol.NetworkVerdict, addr netip.Addr) *protocol.ProbeTcp {
	if v == nil || v.Verdict == protocol.NetworkVerdictValueAccept {
		return nil
	}
	result := protocol.ProbeTcpResultTimeout
	if v.Verdict == protocol.NetworkVerdictValueReject {
		result = protocol.ProbeTcpResultRefused
		if v.Path == protocol.NetworkPathIdNoSwitchTarget {
			result = protocol.ProbeTcpResultRejected
		}
	}
	return &protocol.ProbeTcp{Address: protocol.ProbeTcpAddress(ptr(addr.String())), Result: result}
}

func sandboxRoute(ns *netns.Namespace, t netTarget, dst netip.AddrPort) netip.AddrPort {
	if !t.baseline.Joined {
		return dst
	}
	if realAddr, _, err := ns.SwitchEntry(dst.Addr()); err == nil && realAddr.IsValid() {
		return netip.AddrPortFrom(realAddr, dst.Port())
	}
	return dst
}

func (s *Station) sandboxDNS(t netTarget, name string) (*protocol.ProbeDns, []netip.Addr, error) {
	start := time.Now()
	msg, err := s.resolver.QueryAs(t.ring, name)
	if err != nil {
		return nil, nil, err
	}
	out := &protocol.ProbeDns{Rcode: mdns.RcodeToString[msg.Rcode], Answers: []string{}, Ms: millis.Of(time.Since(start))}
	var answers []netip.Addr
	for _, rr := range msg.Answer {
		if a, ok := rr.(*mdns.A); ok {
			if addr, ok := netip.AddrFromSlice(a.A.To4()); ok {
				answers = append(answers, addr)
				out.Answers = append(out.Answers, addr.String())
			}
		}
	}
	return out, answers, nil
}

func (s *Station) probeSandbox(ctx context.Context, ns *netns.Namespace, t netTarget, b protocol.NetworkProbeBody, res *protocol.NetworkProbeResultBody, attach func(netns.Packet)) error {
	literal, litErr := netip.ParseAddr(b.To)
	if b.Kind == protocol.ProbeKindDns || litErr != nil || !literal.Is4() {
		d, answers, err := s.sandboxDNS(t, b.To)
		if err != nil {
			return err
		}
		res.Dns = d
		if b.Kind == protocol.ProbeKindDns {
			attach(netns.Packet{Addr: t.resolver, Port: 53, Proto: unix.IPPROTO_UDP})
			return nil
		}
		if len(answers) == 0 {
			res.Tcp = &protocol.ProbeTcp{Address: protocol.ProbeTcpAddress(nil), Result: protocol.ProbeTcpResultNoAnswer}
			return nil
		}
		literal = answers[0]
	}
	dst := netip.AddrPortFrom(literal, uint16(*b.Port))
	attach(netns.Packet{Addr: literal, Port: dst.Port(), Proto: unix.IPPROTO_TCP})
	if res.Verdict == nil {
		return errors.New("the sandbox ruleset gave no verdict for the destination")
	}
	if blocked := sandboxProbeBlocked(res.Verdict, literal); blocked != nil {
		res.Tcp = blocked
		return nil
	}
	dst = sandboxRoute(ns, t, dst)
	start := time.Now()
	conn, cerr := (&net.Dialer{}).DialContext(ctx, "tcp4", dst.String())
	ms := millis.Of(time.Since(start))
	if conn != nil {
		conn.Close()
	}
	result, err := probeTCPResult(ctx, cerr, res.Verdict)
	if err != nil {
		return err
	}
	res.Tcp = &protocol.ProbeTcp{Address: protocol.ProbeTcpAddress(ptr(literal.String())), Result: result, Ms: ms}
	return nil
}
