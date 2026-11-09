//go:build linux

package netns

import (
	"encoding/binary"
	"net/netip"

	"github.com/google/nftables"
	"github.com/google/nftables/expr"
	"github.com/google/nftables/userdata"
	"golang.org/x/sys/unix"
)

func ipv4() []expr.Any {
	return []expr.Any{
		&expr.Meta{Key: expr.MetaKeyNFPROTO, Register: 1},
		&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte{unix.NFPROTO_IPV4}},
	}
}

func port(p uint16) []byte {
	b := make([]byte, 2)
	binary.BigEndian.PutUint16(b, p)
	return b
}

func dport53(proto byte) []expr.Any {
	return append(ipv4(),
		&expr.Meta{Key: expr.MetaKeyL4PROTO, Register: 1},
		&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte{proto}},
		&expr.Payload{DestRegister: 1, Base: expr.PayloadBaseTransportHeader, Offset: 2, Len: 2},
		&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: port(53)},
	)
}

func saddr() *expr.Payload {
	return &expr.Payload{DestRegister: 1, Base: expr.PayloadBaseNetworkHeader, Offset: 12, Len: 4}
}

func daddr() *expr.Payload {
	return &expr.Payload{DestRegister: 1, Base: expr.PayloadBaseNetworkHeader, Offset: 16, Len: 4}
}

func lookup(s *nftables.Set, invert bool) *expr.Lookup {
	return &expr.Lookup{SourceRegister: 1, SetName: s.Name, SetID: s.ID, Invert: invert}
}

func verdict(k expr.VerdictKind) *expr.Verdict {
	return &expr.Verdict{Kind: k}
}

func mask(p netip.Prefix) []byte {
	m := make([]byte, 4)
	bits := p.Bits()
	for i := range m {
		switch {
		case bits >= 8:
			m[i] = 0xff
			bits -= 8
		case bits > 0:
			m[i] = byte(0xff << (8 - bits))
			bits = 0
		}
	}
	return m
}

func ifname(name string) []byte {
	b := make([]byte, 16)
	copy(b, name)
	return b
}

func write(c *nftables.Conn, b Baseline, hostAddrs []netip.Prefix, sw map[netip.Addr]netip.Addr, reject []netip.Addr) error {
	c.AddTable(table)
	c.DelTable(table)
	c.AddTable(table)

	hosts, private, targets, smap, rejects, refused := hostAddrsSet(), privateRangesSet(), vipTargetsSet(), switchMap(), switchRejectSet(), refusedSet()
	var targetEls, switchEls, rejectEls []nftables.SetElement
	for _, vip := range reject {
		rejectEls = append(rejectEls, nftables.SetElement{Key: vip.AsSlice()})
	}
	for vip, real := range sw {
		targetEls = append(targetEls, nftables.SetElement{Key: vip.AsSlice()})
		switchEls = append(switchEls, nftables.SetElement{Key: vip.AsSlice(), Val: real.AsSlice()})
	}
	for _, set := range []struct {
		s   *nftables.Set
		els []nftables.SetElement
	}{
		{hosts, intervalElements(hostAddrs)},
		{private, intervalElements(PrivateRanges)},
		{targets, targetEls},
		{smap, switchEls},
		{rejects, rejectEls},
		{refused, nil},
	} {
		if err := c.AddSet(set.s, set.els); err != nil {
			return err
		}
	}

	resolver := b.Resolver.AsSlice()
	self := b.Self.AsSlice()
	drop := nftables.ChainPolicyDrop

	intercept := c.AddChain(&nftables.Chain{Name: "dns_intercept", Table: table, Type: nftables.ChainTypeNAT, Hooknum: nftables.ChainHookOutput, Priority: nftables.ChainPriorityRef(-110)})
	source := c.AddChain(&nftables.Chain{Name: "dns_source", Table: table, Type: nftables.ChainTypeNAT, Hooknum: nftables.ChainHookPostrouting, Priority: nftables.ChainPriorityRef(100)})
	switchOut := c.AddChain(&nftables.Chain{Name: "switch_out", Table: table, Type: nftables.ChainTypeNAT, Hooknum: nftables.ChainHookOutput, Priority: nftables.ChainPriorityRef(-100)})
	egress := c.AddChain(&nftables.Chain{Name: "egress", Table: table, Type: nftables.ChainTypeFilter, Hooknum: nftables.ChainHookOutput, Priority: nftables.ChainPriorityRef(0), Policy: &drop})

	for _, proto := range []byte{unix.IPPROTO_UDP, unix.IPPROTO_TCP} {
		c.AddRule(&nftables.Rule{Table: table, Chain: intercept, Exprs: append(dport53(proto),
			&expr.Counter{},
			&expr.Immediate{Register: 1, Data: resolver},
			&expr.Immediate{Register: 2, Data: port(53)},
			&expr.NAT{Type: expr.NATTypeDestNAT, Family: unix.NFPROTO_IPV4, RegAddrMin: 1, RegProtoMin: 2, Specified: true},
		)})
		c.AddRule(&nftables.Rule{Table: table, Chain: source, Exprs: append(dport53(proto),
			saddr(),
			&expr.Bitwise{SourceRegister: 1, DestRegister: 1, Len: 4, Mask: []byte{255, 0, 0, 0}, Xor: []byte{0, 0, 0, 0}},
			&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte{127, 0, 0, 0}},
			daddr(),
			&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: resolver},
			&expr.Counter{},
			&expr.Immediate{Register: 1, Data: self},
			&expr.NAT{Type: expr.NATTypeSourceNAT, Family: unix.NFPROTO_IPV4, RegAddrMin: 1},
		)})
	}

	c.AddRule(&nftables.Rule{Table: table, Chain: switchOut, Exprs: append(ipv4(),
		daddr(),
		lookup(targets, false),
		daddr(),
		&expr.Lookup{SourceRegister: 1, DestRegister: 1, IsDestRegSet: true, SetName: smap.Name, SetID: smap.ID},
		&expr.Counter{},
		&expr.NAT{Type: expr.NATTypeDestNAT, Family: unix.NFPROTO_IPV4, RegAddrMin: 1},
	)})

	egressRules := egressExprs(egressTable(b, egressSets{hosts: hosts, private: private, targets: targets, rejects: rejects}), refused)
	for i, exprs := range egressRules {
		r := &nftables.Rule{Table: table, Chain: egress, Exprs: exprs}
		if i == 0 {
			r.UserData = userdata.AppendString(nil, userdata.TypeComment, commentPrefix+b.fingerprint())
		}
		c.AddRule(r)
	}
	return c.Flush()
}

func recordRefused(refused *nftables.Set) []expr.Any {
	return []expr.Any{
		daddr(),
		&expr.Meta{Key: expr.MetaKeyL4PROTO, Register: 9},
		&expr.Payload{DestRegister: 10, Base: expr.PayloadBaseTransportHeader, Offset: 2, Len: 2},
		&expr.Dynset{SrcRegKey: 1, SetName: refused.Name, SetID: refused.ID, Operation: unix.NFT_DYNSET_OP_UPDATE},
	}
}

func binaryNative(v uint32) []byte {
	b := make([]byte, 4)
	binary.NativeEndian.PutUint32(b, v)
	return b
}
