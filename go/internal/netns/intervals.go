//go:build linux

package netns

import (
	"net/netip"
	"slices"

	"github.com/google/nftables"
)

type span struct {
	first, last uint32
}

func u32(a netip.Addr) uint32 {
	b := a.As4()
	return uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])
}

func addrBytes(v uint32) []byte {
	return []byte{byte(v >> 24), byte(v >> 16), byte(v >> 8), byte(v)}
}

func spans(prefixes []netip.Prefix) []span {
	var out []span
	for _, p := range prefixes {
		if !p.Addr().Is4() {
			continue
		}
		p = p.Masked()
		first := u32(p.Addr())
		last := first | (uint32(1)<<(32-p.Bits()) - 1)
		if p.Bits() == 0 {
			last = ^uint32(0)
		}
		out = append(out, span{first, last})
	}
	slices.SortFunc(out, func(a, b span) int {
		switch {
		case a.first < b.first:
			return -1
		case a.first > b.first:
			return 1
		}
		return 0
	})
	var merged []span
	for _, s := range out {
		if n := len(merged); n > 0 && (merged[n-1].last == ^uint32(0) || s.first <= merged[n-1].last+1) {
			merged[n-1].last = max(merged[n-1].last, s.last)
			continue
		}
		merged = append(merged, s)
	}
	return merged
}

func intervalElements(prefixes []netip.Prefix) []nftables.SetElement {
	merged := spans(prefixes)
	var els []nftables.SetElement
	if len(merged) > 0 && merged[0].first != 0 {
		els = append(els, nftables.SetElement{Key: addrBytes(0), IntervalEnd: true})
	}
	for _, s := range merged {
		els = append(els, nftables.SetElement{Key: addrBytes(s.first)})
		if s.last != ^uint32(0) {
			els = append(els, nftables.SetElement{Key: addrBytes(s.last + 1), IntervalEnd: true})
		}
	}
	return els
}

func sameIntervals(a, b []nftables.SetElement) bool {
	key := func(e nftables.SetElement) string {
		if e.IntervalEnd {
			return "e" + string(e.Key)
		}
		return "s" + string(e.Key)
	}
	if len(a) != len(b) {
		return false
	}
	seen := map[string]int{}
	for _, e := range a {
		seen[key(e)]++
	}
	for _, e := range b {
		seen[key(e)]--
	}
	for _, n := range seen {
		if n != 0 {
			return false
		}
	}
	return true
}
