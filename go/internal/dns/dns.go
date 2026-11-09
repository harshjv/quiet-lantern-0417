package dns

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/harshjv/stationly/go/internal/upgrade"
	mdns "github.com/miekg/dns"
)

const (
	answerTTL      = 30
	negativeTTL    = 5
	upstreamWait   = 5 * time.Second
	internalSuffix = "internal."
	shutdownWait   = 2 * time.Second
)

type Record struct {
	Name string
	VIP  netip.Addr
}

type Zone struct {
	Subnet  netip.Prefix
	Records []Record
	Log     bool
}

type zone struct {
	subnet netip.Prefix
	names  map[string]netip.Addr
	log    bool
}

type listener struct {
	addr     string
	udp, tcp *mdns.Server
}

type Resolver struct {
	log       *slog.Logger
	upstream  string
	mu        sync.RWMutex
	zones     []zone
	listeners map[netip.Addr]*listener
	host      netip.Addr
	hostFrom  []netip.Prefix
	stats     HostStats
	rings     rings
	probes    probes
	budgets   *budgets
	sandboxes map[netip.Addr]SandboxPolicy
	onAllow   func(AllowAnswer)
}

type HostStats struct {
	Queries   atomic.Int64
	Forwarded atomic.Int64
	Refused   atomic.Int64
	Failed    atomic.Int64
}

func (r *Resolver) SetHost(addr netip.Addr, from []netip.Prefix) {
	r.mu.Lock()
	r.host, r.hostFrom = addr, from
	r.mu.Unlock()
}

func (r *Resolver) Host() (netip.Addr, *HostStats) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.host, &r.stats
}

func (r *Resolver) Upstream() string { return r.upstream }

func (r *Resolver) Listening() []netip.Addr {
	out := make([]netip.Addr, 0, len(r.listeners))
	for a := range r.listeners {
		out = append(out, a)
	}
	return out
}

func (r *Resolver) hostPolicy(local netip.Addr, src netip.Addr) (bool, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if !r.host.IsValid() || local != r.host {
		return false, false
	}
	for _, p := range r.hostFrom {
		if p.Contains(src) {
			return true, true
		}
	}
	return true, false
}

func addrOf(a net.Addr) netip.Addr {
	ap, err := netip.ParseAddrPort(a.String())
	if err != nil {
		return netip.Addr{}
	}
	return ap.Addr().Unmap()
}

func (r *Resolver) serveHost(w mdns.ResponseWriter, req *mdns.Msg, src netip.Addr, allowed bool) {
	r.stats.Queries.Add(1)
	m := new(mdns.Msg)
	q := req.Question[0]
	name := strings.ToLower(mdns.Fqdn(q.Name))
	internal := name == internalSuffix || strings.HasSuffix(name, "."+internalSuffix)
	var resp *mdns.Msg
	switch {
	case !allowed || internal:
		r.stats.Refused.Add(1)
		resp = m.SetRcode(req, mdns.RcodeRefused)
	case q.Qtype == mdns.TypeHTTPS || q.Qtype == mdns.TypeSVCB:
		m.SetReply(req)
		m.RecursionAvailable = true
		resp = m
	default:
		resp = r.forward(req, w.LocalAddr().Network())
		if resp.Rcode == mdns.RcodeServerFailure {
			r.stats.Failed.Add(1)
		} else {
			r.stats.Forwarded.Add(1)
		}
	}
	r.log.Info("resolver host query", "source", src, "name", q.Name, "type", mdns.TypeToString[q.Qtype], "rcode", mdns.RcodeToString[resp.Rcode], "answers", len(resp.Answer))
	w.WriteMsg(resp)
}

func UpstreamFrom(resolvConf string) (string, error) {
	cfg, err := mdns.ClientConfigFromFile(resolvConf)
	if err != nil {
		return "", err
	}
	if len(cfg.Servers) == 0 {
		return "", fmt.Errorf("%s lists no nameserver", resolvConf)
	}
	return net.JoinHostPort(cfg.Servers[0], cfg.Port), nil
}

func New(log *slog.Logger, upstream string) *Resolver {
	return &Resolver{log: log, upstream: upstream, listeners: map[netip.Addr]*listener{}, rings: rings{bySource: map[netip.Addr]*ring{}}, budgets: newBudgets()}
}

func (r *Resolver) SetZones(zones []Zone) {
	built := make([]zone, 0, len(zones))
	for _, z := range zones {
		names := map[string]netip.Addr{}
		for _, rec := range z.Records {
			names[strings.ToLower(mdns.Fqdn(rec.Name+"."+internalSuffix))] = rec.VIP
		}
		built = append(built, zone{subnet: z.Subnet, names: names, log: z.Log})
	}
	r.mu.Lock()
	r.zones = built
	r.mu.Unlock()
}

func (r *Resolver) Listen(addrs []netip.Addr) map[netip.Addr]error {
	want := map[netip.Addr]bool{}
	failed := map[netip.Addr]error{}
	for _, a := range addrs {
		want[a] = true
		if _, ok := r.listeners[a]; ok {
			continue
		}
		l, err := r.bind(a)
		if err != nil {
			failed[a] = err
			r.log.Error("resolver listen", "address", a, "error", err)
			continue
		}
		r.listeners[a] = l
		r.log.Info("resolver listening", "address", a, "port", 53)
	}
	for a, l := range r.listeners {
		if !want[a] {
			l.shutdown()
			delete(r.listeners, a)
			r.log.Info("resolver stopped", "address", a)
		}
	}
	return failed
}

func (r *Resolver) Close() {
	for a, l := range r.listeners {
		l.shutdown()
		delete(r.listeners, a)
	}
}

func (r *Resolver) bind(a netip.Addr) (*listener, error) {
	addr := netip.AddrPortFrom(a, 53).String()
	pc, err := upgrade.ListenPacket("dns/udp/"+addr, "udp4", addr)
	if err != nil {
		return nil, err
	}
	ln, err := upgrade.Listen("dns/tcp/"+addr, "tcp4", addr)
	if err != nil {
		pc.Close()
		upgrade.Forget("dns/udp/" + addr)
		return nil, err
	}
	l := &listener{addr: addr,
		udp: &mdns.Server{PacketConn: pc, Handler: r},
		tcp: &mdns.Server{Listener: ln, Handler: r},
	}
	for _, s := range []*mdns.Server{l.udp, l.tcp} {
		go func() {
			if err := s.ActivateAndServe(); err != nil && !errors.Is(err, net.ErrClosed) {
				r.log.Warn("resolver server stopped", "address", addr, "error", err)
			}
		}()
	}
	return l, nil
}

func (l *listener) shutdown() {
	upgrade.Forget("dns/udp/" + l.addr)
	upgrade.Forget("dns/tcp/" + l.addr)
	ctx, cancel := context.WithTimeout(context.Background(), shutdownWait)
	defer cancel()
	l.udp.ShutdownContext(ctx)
	l.tcp.ShutdownContext(ctx)
}

func (r *Resolver) zoneFor(src netip.Addr) *zone {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for i := range r.zones {
		if r.zones[i].subnet.Contains(src) {
			return &r.zones[i]
		}
	}
	return nil
}

func source(w mdns.ResponseWriter) netip.Addr {
	ap, err := netip.ParseAddrPort(w.RemoteAddr().String())
	if err != nil {
		return netip.Addr{}
	}
	return ap.Addr().Unmap()
}

func (r *Resolver) ServeDNS(w mdns.ResponseWriter, req *mdns.Msg) {
	m := new(mdns.Msg)
	if len(req.Question) != 1 {
		w.WriteMsg(m.SetRcodeFormatError(req))
		return
	}
	src := source(w)
	if !r.budgets.allow(src) {
		w.WriteMsg(m.SetRcode(req, mdns.RcodeRefused))
		return
	}
	probe := r.probes.has(w.RemoteAddr())
	if isHost, allowed := r.hostPolicy(addrOf(w.LocalAddr()), src); isHost {
		r.serveHost(w, req, src, allowed)
		return
	}
	if p, ok := r.sandboxPolicy(src); ok {
		r.serveSandbox(w, req, src, p, probe)
		return
	}
	z := r.zoneFor(src)
	if z == nil {
		w.WriteMsg(m.SetRcode(req, mdns.RcodeRefused))
		return
	}
	q := req.Question[0]
	name := strings.ToLower(mdns.Fqdn(q.Name))
	internal := name == internalSuffix || strings.HasSuffix(name, "."+internalSuffix)
	start := time.Now()
	upstream := false
	var resp *mdns.Msg
	switch {
	case internal:
		resp = z.answer(req, name, q.Qtype)
	case q.Qtype == mdns.TypeHTTPS || q.Qtype == mdns.TypeSVCB:
		m.SetReply(req)
		m.RecursionAvailable = true
		resp = m
	default:
		resp = r.forward(req, w.LocalAddr().Network())
		upstream = true
	}
	w.WriteMsg(resp)
	if z.log {
		r.rings.record(src, start, name, q.Qtype, resp, upstream, probe, "")
	}
}

func soa() mdns.RR {
	return &mdns.SOA{
		Hdr:     mdns.RR_Header{Name: internalSuffix, Rrtype: mdns.TypeSOA, Class: mdns.ClassINET, Ttl: negativeTTL},
		Ns:      "ns." + internalSuffix,
		Mbox:    "hostmaster." + internalSuffix,
		Serial:  1,
		Refresh: 3600,
		Retry:   600,
		Expire:  86400,
		Minttl:  negativeTTL,
	}
}

func (z *zone) answer(req *mdns.Msg, name string, qtype uint16) *mdns.Msg {
	m := new(mdns.Msg)
	m.SetReply(req)
	m.Authoritative = true
	m.RecursionAvailable = true
	vip, ok := z.names[name]
	switch {
	case !ok:
		m.Rcode = mdns.RcodeNameError
		m.Ns = []mdns.RR{soa()}
	case qtype == mdns.TypeA || qtype == mdns.TypeANY:
		m.Answer = []mdns.RR{&mdns.A{
			Hdr: mdns.RR_Header{Name: req.Question[0].Name, Rrtype: mdns.TypeA, Class: mdns.ClassINET, Ttl: answerTTL},
			A:   vip.AsSlice(),
		}}
	default:
		m.Ns = []mdns.RR{soa()}
	}
	return m
}

func (r *Resolver) forward(req *mdns.Msg, network string) *mdns.Msg {
	c := &mdns.Client{Net: network, Timeout: upstreamWait}
	resp, _, err := c.Exchange(req, r.upstream)
	if err != nil {
		r.log.Debug("upstream query failed", "name", req.Question[0].Name, "error", err)
		return new(mdns.Msg).SetRcode(req, mdns.RcodeServerFailure)
	}
	resp.Answer = strip(resp.Answer)
	resp.Ns = strip(resp.Ns)
	resp.Extra = strip(resp.Extra)
	return resp
}

func strip(rrs []mdns.RR) []mdns.RR {
	out := rrs[:0]
	for _, rr := range rrs {
		if t := rr.Header().Rrtype; t == mdns.TypeHTTPS || t == mdns.TypeSVCB {
			continue
		}
		out = append(out, rr)
	}
	return out
}
