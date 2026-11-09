package dns

import (
	"net/netip"
	"slices"
	"strings"
	"sync"
	"time"
)

type AllowEntry struct {
	Addr    netip.Addr
	Timeout time.Duration
	Replace bool
}

type element struct {
	expires time.Time
	timeout time.Duration
}

type AllowMirror struct {
	mu    sync.Mutex
	elems map[uint16]map[netip.Addr]element
	names map[string]map[netip.Addr]time.Time
}

func NewAllowMirror() *AllowMirror {
	return &AllowMirror{elems: map[uint16]map[netip.Addr]element{}, names: map[string]map[netip.Addr]time.Time{}}
}

func (m *AllowMirror) Observe(a AllowAnswer, now time.Time) map[uint16][]AllowEntry {
	m.mu.Lock()
	defer m.mu.Unlock()
	timeout := AllowTimeout(a.TTL)
	expires := now.Add(timeout)
	ports := a.Ports
	if len(ports) == 0 {
		ports = []uint16{DefaultAllowPort}
	}
	refresh := map[uint16][]AllowEntry{}
	for _, p := range ports {
		set := m.elems[p]
		if set == nil {
			set = map[netip.Addr]element{}
			m.elems[p] = set
		}
		for _, addr := range a.Addrs {
			e, ok := set[addr]
			live := ok && e.expires.After(now)
			if live && e.expires.Sub(now) >= timeout/2 {
				continue
			}
			set[addr] = element{expires: expires, timeout: timeout}
			refresh[p] = append(refresh[p], AllowEntry{Addr: addr, Timeout: timeout, Replace: live})
		}
	}
	name := strings.TrimSuffix(strings.ToLower(a.Name), ".")
	addrs := m.names[name]
	if addrs == nil {
		addrs = map[netip.Addr]time.Time{}
		m.names[name] = addrs
	}
	for _, addr := range a.Addrs {
		if old, ok := addrs[addr]; !ok || expires.After(old) {
			addrs[addr] = expires
		}
	}
	for p, entries := range refresh {
		slices.SortFunc(entries, func(x, y AllowEntry) int { return x.Addr.Compare(y.Addr) })
		refresh[p] = entries
	}
	return refresh
}

func (m *AllowMirror) Retain(domains []AllowDomain, now time.Time) (map[uint16][]netip.Addr, []netip.Addr) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.expire(now)
	keep := map[uint16]map[netip.Addr]bool{}
	for name, addrs := range m.names {
		d, ok := Match(domains, name)
		if !ok {
			delete(m.names, name)
			continue
		}
		ports := d.Ports
		if len(ports) == 0 {
			ports = []uint16{DefaultAllowPort}
		}
		for addr := range addrs {
			for _, p := range ports {
				if keep[p] == nil {
					keep[p] = map[netip.Addr]bool{}
				}
				keep[p][addr] = true
			}
		}
	}
	remove := map[uint16][]netip.Addr{}
	left := map[netip.Addr]bool{}
	for p, set := range m.elems {
		for addr := range set {
			if keep[p][addr] {
				continue
			}
			delete(set, addr)
			remove[p] = append(remove[p], addr)
			left[addr] = true
		}
		if len(set) == 0 {
			delete(m.elems, p)
		}
		slices.SortFunc(remove[p], netip.Addr.Compare)
	}
	var gone []netip.Addr
	for addr := range left {
		if !m.inAnySet(addr) {
			gone = append(gone, addr)
		}
	}
	slices.SortFunc(gone, netip.Addr.Compare)
	return remove, gone
}

func (m *AllowMirror) Elements(now time.Time) map[uint16][]AllowEntry {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.expire(now)
	out := map[uint16][]AllowEntry{}
	for p, set := range m.elems {
		entries := make([]AllowEntry, 0, len(set))
		for addr, e := range set {
			entries = append(entries, AllowEntry{Addr: addr, Timeout: e.expires.Sub(now)})
		}
		slices.SortFunc(entries, func(x, y AllowEntry) int { return x.Addr.Compare(y.Addr) })
		out[p] = entries
	}
	return out
}

func (m *AllowMirror) inAnySet(addr netip.Addr) bool {
	for _, set := range m.elems {
		if _, ok := set[addr]; ok {
			return true
		}
	}
	return false
}

func (m *AllowMirror) expire(now time.Time) {
	for p, set := range m.elems {
		for addr, e := range set {
			if !e.expires.After(now) {
				delete(set, addr)
			}
		}
		if len(set) == 0 {
			delete(m.elems, p)
		}
	}
	for name, addrs := range m.names {
		for addr, expires := range addrs {
			if !expires.After(now) {
				delete(addrs, addr)
			}
		}
		if len(addrs) == 0 {
			delete(m.names, name)
		}
	}
}
