package dns

import (
	"net"
	"net/netip"
	"strings"
	"sync"
	"time"

	mdns "github.com/miekg/dns"

	"github.com/harshjv/stationly/go/internal/millis"
)

const (
	ringSize      = 100
	ringAnswerMax = 8
)

type Query struct {
	At       time.Time
	Name     string
	Type     string
	Rcode    string
	Answers  []netip.Addr
	Upstream bool
	MS       float64
	Probe    bool
	Refused  string
}

type ring struct {
	mu      sync.Mutex
	entries [ringSize]Query
	next    int
	full    bool
}

type rings struct {
	mu       sync.RWMutex
	bySource map[netip.Addr]*ring
}

func (rs *rings) get(src netip.Addr, create bool) *ring {
	rs.mu.RLock()
	r := rs.bySource[src]
	rs.mu.RUnlock()
	if r != nil || !create {
		return r
	}
	rs.mu.Lock()
	defer rs.mu.Unlock()
	if r = rs.bySource[src]; r == nil {
		r = &ring{}
		rs.bySource[src] = r
	}
	return r
}

func (rs *rings) record(src netip.Addr, start time.Time, name string, qtype uint16, resp *mdns.Msg, upstream, probe bool, refused string) {
	q := Query{At: start, Name: strings.TrimSuffix(name, "."), Type: mdns.TypeToString[qtype], Rcode: mdns.RcodeToString[resp.Rcode], Upstream: upstream, Probe: probe, Refused: refused, MS: millis.Of(time.Since(start))}
	for _, rr := range resp.Answer {
		if len(q.Answers) == ringAnswerMax {
			break
		}
		if a, ok := rr.(*mdns.A); ok {
			if addr, ok := netip.AddrFromSlice(a.A.To4()); ok {
				q.Answers = append(q.Answers, addr)
			}
		}
	}
	r := rs.get(src, true)
	r.mu.Lock()
	r.entries[r.next] = q
	r.next = (r.next + 1) % ringSize
	if r.next == 0 {
		r.full = true
	}
	r.mu.Unlock()
}

func (r *Resolver) Queries(src netip.Addr) []Query {
	ring := r.rings.get(src, false)
	if ring == nil {
		return nil
	}
	ring.mu.Lock()
	defer ring.mu.Unlock()
	n := ring.next
	if ring.full {
		n = ringSize
	}
	out := make([]Query, 0, n)
	for i := 1; i <= n; i++ {
		out = append(out, ring.entries[(ring.next-i+ringSize)%ringSize])
	}
	return out
}

func (r *Resolver) Names(src netip.Addr) map[netip.Addr]string {
	out := map[netip.Addr]string{}
	for _, q := range r.Queries(src) {
		for _, a := range q.Answers {
			if _, seen := out[a]; !seen {
				out[a] = q.Name
			}
		}
	}
	return out
}

func (r *Resolver) Forget(src netip.Addr) {
	r.rings.mu.Lock()
	delete(r.rings.bySource, src)
	r.rings.mu.Unlock()
}

type probes struct {
	mu    sync.Mutex
	ports map[netip.AddrPort]int
}

func (p *probes) has(a net.Addr) bool {
	ap, err := netip.ParseAddrPort(a.String())
	if err != nil {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.ports[netip.AddrPortFrom(ap.Addr().Unmap(), ap.Port())] > 0
}

func (r *Resolver) RegisterProbe(src netip.AddrPort) func() {
	p := &r.probes
	p.mu.Lock()
	if p.ports == nil {
		p.ports = map[netip.AddrPort]int{}
	}
	p.ports[src]++
	p.mu.Unlock()
	return func() {
		p.mu.Lock()
		if p.ports[src]--; p.ports[src] <= 0 {
			delete(p.ports, src)
		}
		p.mu.Unlock()
	}
}
