package dns

import (
	"errors"
	"maps"
	"net"
	"net/netip"
	"slices"
	"strings"
	"time"

	mdns "github.com/miekg/dns"
)

const (
	RefusedDomainNotAllowed = "domain_not_allowed"
	RefusedRebind           = "rebind"
)

type SandboxPolicy struct {
	Joined    bool
	Allowlist bool
	Domains   []AllowDomain
	Blocked   []netip.Prefix
}

type AllowAnswer struct {
	Source netip.Addr
	Name   string
	Addrs  []netip.Addr
	TTL    uint32
	Ports  []uint16
}

func (r *Resolver) SetSandboxes(m map[netip.Addr]SandboxPolicy) {
	c := maps.Clone(m)
	r.mu.Lock()
	r.sandboxes = c
	r.mu.Unlock()
}

func (r *Resolver) OnAllow(f func(AllowAnswer)) {
	r.mu.Lock()
	r.onAllow = f
	r.mu.Unlock()
}

func (r *Resolver) sandboxPolicy(src netip.Addr) (SandboxPolicy, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.sandboxes[src]
	return p, ok
}

func (r *Resolver) allowHook() func(AllowAnswer) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.onAllow
}

func (r *Resolver) serveSandbox(w mdns.ResponseWriter, req *mdns.Msg, src netip.Addr, p SandboxPolicy, probe bool) {
	q := req.Question[0]
	name := strings.ToLower(mdns.Fqdn(q.Name))
	internal := name == internalSuffix || strings.HasSuffix(name, "."+internalSuffix)
	start := time.Now()
	upstream := false
	refused := ""
	var resp *mdns.Msg
	switch {
	case internal:
		resp = r.sandboxInternal(req, src, name, q.Qtype, p.Joined)
	case q.Qtype == mdns.TypeAAAA || q.Qtype == mdns.TypeHTTPS || q.Qtype == mdns.TypeSVCB:
		resp = new(mdns.Msg).SetReply(req)
		resp.RecursionAvailable = true
	case !p.Allowlist:
		resp = r.forward(req, w.LocalAddr().Network())
		upstream = true
	default:
		entry, ok := Match(p.Domains, name)
		if !ok {
			refused = RefusedDomainNotAllowed
			resp = nxdomain(req)
			break
		}
		upstream = true
		resp, refused = r.allowlisted(req, w.LocalAddr().Network(), src, name, entry, p.Blocked)
	}
	w.WriteMsg(resp)
	r.rings.record(src, start, name, q.Qtype, resp, upstream, probe, refused)
}

func (r *Resolver) sandboxInternal(req *mdns.Msg, src netip.Addr, name string, qtype uint16, joined bool) *mdns.Msg {
	if joined {
		if z := r.zoneFor(src); z != nil {
			return z.answer(req, name, qtype)
		}
	}
	m := new(mdns.Msg).SetReply(req)
	m.Authoritative = true
	m.RecursionAvailable = true
	m.Rcode = mdns.RcodeNameError
	m.Ns = []mdns.RR{soa()}
	return m
}

func nxdomain(req *mdns.Msg) *mdns.Msg {
	m := new(mdns.Msg).SetRcode(req, mdns.RcodeNameError)
	m.RecursionAvailable = true
	return m
}

func (r *Resolver) allowlisted(req *mdns.Msg, network string, src netip.Addr, name string, entry AllowDomain, blocked []netip.Prefix) (*mdns.Msg, string) {
	up := r.forward(req, network)
	if up.Rcode == mdns.RcodeServerFailure {
		return up, ""
	}
	m := new(mdns.Msg).SetReply(req)
	m.Rcode = up.Rcode
	m.RecursionAvailable = up.RecursionAvailable
	var addrs []netip.Addr
	var ttl uint32
	for _, rr := range up.Answer {
		switch v := rr.(type) {
		case *mdns.A:
			a, ok := netip.AddrFromSlice(v.A.To4())
			if !ok || rebind(a, blocked) {
				r.log.Info("resolver refused rebind", "source", src, "name", name, "address", v.A.String())
				return nxdomain(req), RefusedRebind
			}
			if len(addrs) == 0 || v.Hdr.Ttl < ttl {
				ttl = v.Hdr.Ttl
			}
			addrs = append(addrs, a)
			m.Answer = append(m.Answer, rr)
		case *mdns.CNAME:
			m.Answer = append(m.Answer, rr)
		}
	}
	for _, rr := range up.Ns {
		if _, ok := rr.(*mdns.SOA); ok {
			m.Ns = append(m.Ns, rr)
		}
	}
	if len(addrs) > 0 {
		if f := r.allowHook(); f != nil {
			ports := slices.Clone(entry.Ports)
			if len(ports) == 0 {
				ports = []uint16{DefaultAllowPort}
			}
			f(AllowAnswer{Source: src, Name: strings.TrimSuffix(name, "."), Addrs: addrs, TTL: ttl, Ports: ports})
		}
	}
	return m, ""
}

type captureWriter struct {
	local, remote net.Addr
	msg           *mdns.Msg
}

func (w *captureWriter) LocalAddr() net.Addr         { return w.local }
func (w *captureWriter) RemoteAddr() net.Addr        { return w.remote }
func (w *captureWriter) Write(b []byte) (int, error) { return len(b), nil }
func (w *captureWriter) Close() error                { return nil }
func (w *captureWriter) TsigStatus() error           { return nil }
func (w *captureWriter) TsigTimersOnly(bool)         {}
func (w *captureWriter) Hijack()                     {}

func (w *captureWriter) WriteMsg(m *mdns.Msg) error {
	w.msg = m
	return nil
}

func (r *Resolver) QueryAs(src netip.Addr, name string) (*mdns.Msg, error) {
	p, ok := r.sandboxPolicy(src)
	if !ok {
		return nil, errors.New("the resolver holds no sandbox policy for this source")
	}
	q := new(mdns.Msg).SetQuestion(mdns.Fqdn(name), mdns.TypeA)
	w := &captureWriter{local: &net.UDPAddr{IP: net.IPv4zero, Port: 53}, remote: &net.UDPAddr{IP: src.AsSlice()}}
	r.serveSandbox(w, q, src, p, true)
	if w.msg == nil {
		return nil, errors.New("the resolver wrote no answer")
	}
	return w.msg, nil
}
