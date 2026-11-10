//go:build linux

package netns

import (
	"net/netip"

	"github.com/google/nftables"
	"github.com/google/nftables/expr"
	"github.com/google/nftables/userdata"
)

type setEls struct {
	s   *nftables.Set
	els []nftables.SetElement
}

type setOp struct {
	set *nftables.Set
	els []nftables.SetElement
	del bool
}

func resetTable(c *nftables.Conn, t *nftables.Table, sets []setEls) error {
	c.AddTable(t)
	c.DelTable(t)
	c.AddTable(t)
	for _, set := range sets {
		if err := c.AddSet(set.s, set.els); err != nil {
			return err
		}
	}
	return nil
}

func addFingerprinted(c *nftables.Conn, chain *nftables.Chain, rules [][]expr.Any, comment string) {
	for i, exprs := range rules {
		r := &nftables.Rule{Table: chain.Table, Chain: chain, Exprs: exprs}
		if i == 0 {
			r.UserData = userdata.AppendString(nil, userdata.TypeComment, comment)
		}
		c.AddRule(r)
	}
}

func applySetOps(c *nftables.Conn, changed bool, ops ...setOp) (bool, error) {
	for _, op := range ops {
		if len(op.els) == 0 {
			continue
		}
		changed = true
		var err error
		if op.del {
			err = c.SetDeleteElements(op.set, op.els)
		} else {
			err = c.SetAddElements(op.set, op.els)
		}
		if err != nil {
			return false, err
		}
	}
	if !changed {
		return false, nil
	}
	return true, c.Flush()
}

func syncIntervals(c *nftables.Conn, set *nftables.Set, prefixes []netip.Prefix) (bool, error) {
	have, err := c.GetSetElements(set)
	if err != nil {
		return false, err
	}
	want := intervalElements(prefixes)
	if sameIntervals(have, want) {
		return false, nil
	}
	c.FlushSet(set)
	if len(want) > 0 {
		if err := c.SetAddElements(set, want); err != nil {
			return false, err
		}
	}
	return true, nil
}

func diffElements[K, V comparable](have, want map[K]V, key func(K) []byte, val func(V) []byte) (del, add []nftables.SetElement) {
	for k, h := range have {
		if w, ok := want[k]; !ok || w != h {
			del = append(del, nftables.SetElement{Key: key(k)})
		}
	}
	for k, w := range want {
		if h, ok := have[k]; !ok || h != w {
			el := nftables.SetElement{Key: key(k)}
			if val != nil {
				el.Val = val(w)
			}
			add = append(add, el)
		}
	}
	return del, add
}

func addrKey(a netip.Addr) []byte {
	return a.AsSlice()
}

func keysOf[K comparable, V any](m map[K]V) map[K]bool {
	out := map[K]bool{}
	for k := range m {
		out[k] = true
	}
	return out
}

func addrSetElements(addrs []netip.Addr) []nftables.SetElement {
	var out []nftables.SetElement
	for _, a := range addrs {
		out = append(out, nftables.SetElement{Key: a.AsSlice()})
	}
	return out
}

func switchElements(sw map[netip.Addr]netip.Addr) (targets, pairs []nftables.SetElement) {
	for vip, real := range sw {
		targets = append(targets, nftables.SetElement{Key: vip.AsSlice()})
		pairs = append(pairs, nftables.SetElement{Key: vip.AsSlice(), Val: real.AsSlice()})
	}
	return targets, pairs
}

func readAddrs(c *nftables.Conn, s *nftables.Set) (map[netip.Addr]bool, error) {
	els, err := c.GetSetElements(s)
	out := map[netip.Addr]bool{}
	for _, el := range els {
		out[addrOf(el.Key)] = true
	}
	return out, err
}

func readAddrMap(c *nftables.Conn, s *nftables.Set) (map[netip.Addr]netip.Addr, error) {
	els, err := c.GetSetElements(s)
	out := map[netip.Addr]netip.Addr{}
	for _, el := range els {
		out[addrOf(el.Key)] = addrOf(el.Val)
	}
	return out, err
}

func addrOf(b []byte) netip.Addr {
	a, _ := netip.AddrFromSlice(b)
	return a.Unmap()
}

func addrsOf(addrs []netip.Addr) map[netip.Addr]bool {
	out := map[netip.Addr]bool{}
	for _, a := range addrs {
		out[a] = true
	}
	return out
}
