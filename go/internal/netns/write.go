//go:build linux

package netns

import (
	"encoding/binary"
	"net/netip"

	"github.com/google/nftables"
	"github.com/google/nftables/expr"
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

func dnsDNAT(proto byte, resolver netip.Addr) []expr.Any {
	return append(dport53(proto),
		&expr.Counter{},
		&expr.Immediate{Register: 1, Data: resolver.AsSlice()},
		&expr.Immediate{Register: 2, Data: port(53)},
		&expr.NAT{Type: expr.NATTypeDestNAT, Family: unix.NFPROTO_IPV4, RegAddrMin: 1, RegProtoMin: 2, Specified: true},
	)
}

func dnsSNAT(proto byte, resolver, self netip.Addr) []expr.Any {
	return append(dport53(proto),
		saddr(),
		&expr.Bitwise{SourceRegister: 1, DestRegister: 1, Len: 4, Mask: []byte{255, 0, 0, 0}, Xor: []byte{0, 0, 0, 0}},
		&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte{127, 0, 0, 0}},
		daddr(),
		&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: resolver.AsSlice()},
		&expr.Counter{},
		&expr.Immediate{Register: 1, Data: self.AsSlice()},
		&expr.NAT{Type: expr.NATTypeSourceNAT, Family: unix.NFPROTO_IPV4, RegAddrMin: 1},
	)
}

func addDNSRedirect(c *nftables.Conn, intercept, source *nftables.Chain, resolver, self netip.Addr) {
	for _, proto := range []byte{unix.IPPROTO_UDP, unix.IPPROTO_TCP} {
		c.AddRule(&nftables.Rule{Table: intercept.Table, Chain: intercept, Exprs: dnsDNAT(proto, resolver)})
		c.AddRule(&nftables.Rule{Table: source.Table, Chain: source, Exprs: dnsSNAT(proto, resolver, self)})
	}
}

func switchDNAT(targets, smap *nftables.Set) []expr.Any {
	return append(ipv4(),
		daddr(),
		lookup(targets, false),
		daddr(),
		&expr.Lookup{SourceRegister: 1, DestRegister: 1, IsDestRegSet: true, SetName: smap.Name, SetID: smap.ID},
		&expr.Counter{},
		&expr.NAT{Type: expr.NATTypeDestNAT, Family: unix.NFPROTO_IPV4, RegAddrMin: 1},
	)
}

type switchSets struct {
	hosts, private, targets, smap, rejects, refused *nftables.Set
}

func newSwitchSets() switchSets {
	return switchSets{hostAddrsSet(), privateRangesSet(), vipTargetsSet(), switchMap(), switchRejectSet(), refusedSet()}
}

func (s switchSets) egress() egressSets {
	return egressSets{hosts: s.hosts, private: s.private, targets: s.targets, rejects: s.rejects}
}

func (s switchSets) elements(hostAddrs []netip.Prefix, sw map[netip.Addr]netip.Addr, reject []netip.Addr) []setEls {
	targetEls, switchEls := switchElements(sw)
	return []setEls{
		{s.hosts, intervalElements(hostAddrs)},
		{s.private, intervalElements(PrivateRanges)},
		{s.targets, targetEls},
		{s.smap, switchEls},
		{s.rejects, addrSetElements(reject)},
		{s.refused, nil},
	}
}

func write(c *nftables.Conn, b Baseline, hostAddrs []netip.Prefix, sw map[netip.Addr]netip.Addr, reject []netip.Addr) error {
	sets := newSwitchSets()
	if err := resetTable(c, table, sets.elements(hostAddrs, sw, reject)); err != nil {
		return err
	}

	drop := nftables.ChainPolicyDrop
	intercept := c.AddChain(&nftables.Chain{Name: "dns_intercept", Table: table, Type: nftables.ChainTypeNAT, Hooknum: nftables.ChainHookOutput, Priority: nftables.ChainPriorityRef(-110)})
	source := c.AddChain(&nftables.Chain{Name: "dns_source", Table: table, Type: nftables.ChainTypeNAT, Hooknum: nftables.ChainHookPostrouting, Priority: nftables.ChainPriorityRef(100)})
	switchOut := c.AddChain(&nftables.Chain{Name: "switch_out", Table: table, Type: nftables.ChainTypeNAT, Hooknum: nftables.ChainHookOutput, Priority: nftables.ChainPriorityRef(-100)})
	egress := c.AddChain(&nftables.Chain{Name: "egress", Table: table, Type: nftables.ChainTypeFilter, Hooknum: nftables.ChainHookOutput, Priority: nftables.ChainPriorityRef(0), Policy: &drop})

	addDNSRedirect(c, intercept, source, b.Resolver, b.Self)
	c.AddRule(&nftables.Rule{Table: table, Chain: switchOut, Exprs: switchDNAT(sets.targets, sets.smap)})
	addFingerprinted(c, egress, egressExprs(egressTable(b, sets.egress()), sets.refused), commentPrefix+b.fingerprint())
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
