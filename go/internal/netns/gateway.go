//go:build linux

package netns

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"net/netip"

	"github.com/google/nftables"
	"github.com/google/nftables/expr"
	"github.com/google/nftables/userdata"
	"golang.org/x/sys/unix"
)

const gatewayLayoutVersion = "1a.6-gateway"

type GatewayBaseline struct {
	Resolver netip.Addr
	Self     netip.Addr
}

func (b GatewayBaseline) fingerprint() string {
	sum := sha256.Sum256([]byte(gatewayLayoutVersion + "|" + b.Resolver.String() + "|" + b.Self.String()))
	return hex.EncodeToString(sum[:8])
}

func gatewayTargetsSet() *nftables.Set {
	return &nftables.Set{Table: table, Name: "gateway_targets", KeyType: concatAddrPort, Concatenation: true}
}

func addrPortKey(a netip.AddrPort) []byte {
	b := make([]byte, 8)
	copy(b, a.Addr().AsSlice())
	binary.BigEndian.PutUint16(b[4:], a.Port())
	return b
}

func (n *Namespace) SyncGateway(b GatewayBaseline, hostAddrs []netip.Prefix, targets []netip.AddrPort) (Result, error) {
	c, err := nftables.New(nftables.WithNetNSFd(n.fd()))
	if err != nil {
		return Unchanged, err
	}
	if state := layoutState(c, table, "egress", commentPrefix+b.fingerprint()); state != Unchanged {
		return state, writeGateway(c, b, hostAddrs, targets)
	}
	changed := false
	hosts := hostAddrsSet()
	haveHosts, err := c.GetSetElements(hosts)
	if err != nil {
		return Unchanged, err
	}
	if wantHosts := intervalElements(hostAddrs); !sameIntervals(haveHosts, wantHosts) {
		c.FlushSet(hosts)
		if len(wantHosts) > 0 {
			if err := c.SetAddElements(hosts, wantHosts); err != nil {
				return Unchanged, err
			}
		}
		changed = true
	}
	set := gatewayTargetsSet()
	have, err := c.GetSetElements(set)
	if err != nil {
		return Unchanged, err
	}
	haveKeys := map[string]bool{}
	for _, el := range have {
		haveKeys[string(el.Key)] = true
	}
	want := map[string]bool{}
	var add, del []nftables.SetElement
	for _, t := range targets {
		k := addrPortKey(t)
		want[string(k)] = true
		if !haveKeys[string(k)] {
			add = append(add, nftables.SetElement{Key: k})
		}
	}
	for k := range haveKeys {
		if !want[k] {
			del = append(del, nftables.SetElement{Key: []byte(k)})
		}
	}
	if len(del) > 0 {
		if err := c.SetDeleteElements(set, del); err != nil {
			return Unchanged, err
		}
		changed = true
	}
	if len(add) > 0 {
		if err := c.SetAddElements(set, add); err != nil {
			return Unchanged, err
		}
		changed = true
	}
	if !changed {
		return Unchanged, nil
	}
	return Updated, c.Flush()
}

func writeGateway(c *nftables.Conn, b GatewayBaseline, hostAddrs []netip.Prefix, targets []netip.AddrPort) error {
	c.AddTable(table)
	c.DelTable(table)
	c.AddTable(table)

	hosts, private, gw := hostAddrsSet(), privateRangesSet(), gatewayTargetsSet()
	var targetEls []nftables.SetElement
	for _, t := range targets {
		targetEls = append(targetEls, nftables.SetElement{Key: addrPortKey(t)})
	}
	for _, set := range []struct {
		s   *nftables.Set
		els []nftables.SetElement
	}{
		{hosts, intervalElements(hostAddrs)},
		{private, intervalElements(PrivateRanges)},
		{gw, targetEls},
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

	tcp := []expr.Any{
		&expr.Meta{Key: expr.MetaKeyL4PROTO, Register: 1},
		&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte{unix.IPPROTO_TCP}},
	}
	rules := [][]expr.Any{
		{
			&expr.Ct{Register: 1, Key: expr.CtKeySTATE},
			&expr.Bitwise{SourceRegister: 1, DestRegister: 1, Len: 4,
				Mask: binaryNative(expr.CtStateBitESTABLISHED | expr.CtStateBitRELATED), Xor: []byte{0, 0, 0, 0}},
			&expr.Cmp{Op: expr.CmpOpNeq, Register: 1, Data: []byte{0, 0, 0, 0}},
			verdict(expr.VerdictAccept),
		},
		{
			&expr.Meta{Key: expr.MetaKeyOIFNAME, Register: 1},
			&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: ifname("lo")},
			verdict(expr.VerdictAccept),
		},
	}
	for _, proto := range []byte{unix.IPPROTO_UDP, unix.IPPROTO_TCP} {
		rules = append(rules, append(dport53(proto),
			daddr(),
			&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: resolver},
			&expr.Counter{},
			verdict(expr.VerdictAccept),
		))
	}
	rules = append(rules,
		append(ipv4(), daddr(), lookup(hosts, false), &expr.Counter{}, verdict(expr.VerdictDrop)),
		append(append(ipv4(), tcp...),
			daddr(),
			&expr.Payload{DestRegister: regProto, Base: expr.PayloadBaseTransportHeader, Offset: 2, Len: 2},
			lookup(gw, false),
			&expr.Counter{},
			verdict(expr.VerdictAccept)),
		append(ipv4(), daddr(), lookup(private, false), &expr.Counter{}, verdict(expr.VerdictDrop)),
		append(append(ipv4(), tcp...),
			&expr.Payload{DestRegister: 1, Base: expr.PayloadBaseTransportHeader, Offset: 2, Len: 2},
			&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: port(443)},
			&expr.Counter{},
			verdict(expr.VerdictAccept)),
		append(ipv4(), &expr.Counter{}, verdict(expr.VerdictDrop)),
	)
	for i, exprs := range rules {
		r := &nftables.Rule{Table: table, Chain: egress, Exprs: exprs}
		if i == 0 {
			r.UserData = userdata.AppendString(nil, userdata.TypeComment, commentPrefix+b.fingerprint())
		}
		c.AddRule(r)
	}
	return c.Flush()
}
