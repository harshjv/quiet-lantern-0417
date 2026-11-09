//go:build linux

package netns

import (
	"cmp"
	"errors"
	"fmt"
	"net/netip"
	"slices"
	"strconv"

	"github.com/google/nftables"
	"github.com/google/nftables/expr"
	"github.com/google/nftables/userdata"
	"golang.org/x/sys/unix"
)

const (
	PathSameEnvironment = "same_environment"
	PathResolver        = "resolver"
	PathLoopback        = "loopback"
	PathHostAddress     = "host_address"
	PathOtherEnv        = "other_environment"
	PathCloudMetadata   = "cloud_metadata"
	PathPrivateRange    = "private_range"
	PathPublicInternet  = "public_internet"
	PathNoSwitchTarget  = "no_switch_target"
	PathRegistry        = "registry"
)

const (
	VerdictAccept = "accept"
	VerdictDrop   = "drop"
	VerdictReject = "reject"
)

var CloudMetadata = netip.MustParseAddr("169.254.169.254")

var ErrRulesetMismatch = errors.New("the namespace's egress chain was not written from this baseline")

type termKind int

const (
	termIPv4 termKind = iota
	termL4
	termDport
	termDaddr
	termDaddrPrefix
	termDaddrSet
	termCtOriginalSet
	termOif
	termEstablished
)

type term struct {
	kind   termKind
	proto  byte
	port   uint16
	addr   netip.Addr
	prefix netip.Prefix
	set    *nftables.Set
	invert bool
	name   string
}

type verdictKind int

const (
	verdictAccept verdictKind = iota
	verdictDrop
	verdictRejectTCP
	verdictRejectICMPX
)

type egressRule struct {
	terms   []term
	verdict verdictKind
	counter bool
	record  bool
	path    string
	text    string
}

type egressSets struct {
	hosts, private, targets, rejects *nftables.Set
}

func ipv4Term() term              { return term{kind: termIPv4} }
func l4Term(p byte) term          { return term{kind: termL4, proto: p} }
func dportTerm(p uint16) term     { return term{kind: termDport, port: p} }
func daddrTerm(a netip.Addr) term { return term{kind: termDaddr, addr: a} }

func setTerm(s *nftables.Set, invert bool) term {
	return term{kind: termDaddrSet, set: s, invert: invert}
}

func protoName(p byte) string {
	if p == unix.IPPROTO_UDP {
		return "udp"
	}
	return "tcp"
}

func egressTable(b Baseline, s egressSets) []egressRule {
	rules := []egressRule{
		{terms: []term{{kind: termEstablished}}, verdict: verdictAccept, text: "ct state established,related accept"},
		{terms: []term{{kind: termOif, name: "lo"}}, verdict: verdictAccept, path: PathLoopback, text: `oifname "lo" accept`},
	}
	for _, proto := range []byte{unix.IPPROTO_UDP, unix.IPPROTO_TCP} {
		rules = append(rules, egressRule{
			terms:   []term{ipv4Term(), l4Term(proto), dportTerm(53), daddrTerm(b.Resolver)},
			verdict: verdictAccept, counter: true, path: PathResolver,
			text: fmt.Sprintf("ip daddr %s %s dport 53 accept", b.Resolver, protoName(proto)),
		})
	}
	for _, a := range b.Allow {
		rules = append(rules, egressRule{
			terms:   []term{ipv4Term(), l4Term(unix.IPPROTO_TCP), daddrTerm(a.Addr()), dportTerm(a.Port())},
			verdict: verdictAccept, counter: true, path: PathRegistry,
			text: fmt.Sprintf("ip daddr %s tcp dport %d accept", a.Addr(), a.Port()),
		})
	}
	rules = append(rules,
		egressRule{terms: []term{ipv4Term(), l4Term(unix.IPPROTO_TCP), setTerm(s.rejects, false)}, verdict: verdictRejectTCP, counter: true, record: true, path: PathNoSwitchTarget, text: "ip daddr @switch_reject reject with tcp reset"},
		egressRule{terms: []term{ipv4Term(), setTerm(s.rejects, false)}, verdict: verdictRejectICMPX, counter: true, record: true, path: PathNoSwitchTarget, text: "ip daddr @switch_reject reject with icmpx port-unreachable"},
		egressRule{terms: []term{ipv4Term(), setTerm(s.hosts, false)}, verdict: verdictDrop, counter: true, record: true, path: PathHostAddress, text: "ip daddr @host_addrs drop"},
		egressRule{terms: []term{ipv4Term(), {kind: termCtOriginalSet, set: s.targets}}, verdict: verdictAccept, counter: true, path: PathSameEnvironment, text: "ct original ip daddr @vip_targets accept"},
	)
	if b.Subnet.IsValid() {
		rules = append(rules, egressRule{terms: []term{ipv4Term(), {kind: termDaddrPrefix, prefix: b.Subnet.Masked()}}, verdict: verdictAccept, counter: true, path: PathSameEnvironment, text: "ip daddr " + b.Subnet.Masked().String() + " accept"})
	}
	return append(rules,
		egressRule{terms: []term{ipv4Term(), setTerm(s.private, false)}, verdict: verdictDrop, counter: true, record: true, path: PathPrivateRange, text: "ip daddr @private_ranges drop"},
		egressRule{terms: []term{ipv4Term(), setTerm(s.private, true)}, verdict: verdictAccept, counter: true, path: PathPublicInternet, text: "ip daddr != @private_ranges accept"},
	)
}

func (t term) exprs() []expr.Any {
	switch t.kind {
	case termIPv4:
		return ipv4()
	case termL4:
		return []expr.Any{&expr.Meta{Key: expr.MetaKeyL4PROTO, Register: 1}, &expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte{t.proto}}}
	case termDport:
		return []expr.Any{&expr.Payload{DestRegister: 1, Base: expr.PayloadBaseTransportHeader, Offset: 2, Len: 2}, &expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: port(t.port)}}
	case termDaddr:
		return []expr.Any{daddr(), &expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: t.addr.AsSlice()}}
	case termDaddrPrefix:
		return []expr.Any{daddr(),
			&expr.Bitwise{SourceRegister: 1, DestRegister: 1, Len: 4, Mask: mask(t.prefix), Xor: []byte{0, 0, 0, 0}},
			&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: t.prefix.Masked().Addr().AsSlice()}}
	case termDaddrSet:
		return []expr.Any{daddr(), lookup(t.set, t.invert)}
	case termCtOriginalSet:
		return []expr.Any{&expr.Ct{Register: 1, Key: expr.CtKeyDSTIP, Direction: 0}, lookup(t.set, false)}
	case termOif:
		return []expr.Any{&expr.Meta{Key: expr.MetaKeyOIFNAME, Register: 1}, &expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: ifname(t.name)}}
	case termEstablished:
		return []expr.Any{
			&expr.Ct{Register: 1, Key: expr.CtKeySTATE},
			&expr.Bitwise{SourceRegister: 1, DestRegister: 1, Len: 4, Mask: binaryNative(expr.CtStateBitESTABLISHED | expr.CtStateBitRELATED), Xor: []byte{0, 0, 0, 0}},
			&expr.Cmp{Op: expr.CmpOpNeq, Register: 1, Data: []byte{0, 0, 0, 0}},
		}
	}
	return nil
}

func (r egressRule) match() []expr.Any {
	var out []expr.Any
	for _, t := range r.terms {
		out = append(out, t.exprs()...)
	}
	return out
}

func (r egressRule) verdictExprs() []expr.Any {
	var out []expr.Any
	if r.counter {
		out = append(out, &expr.Counter{})
	}
	switch r.verdict {
	case verdictDrop:
		return append(out, verdict(expr.VerdictDrop))
	case verdictRejectTCP:
		return append(out, &expr.Reject{Type: unix.NFT_REJECT_TCP_RST})
	case verdictRejectICMPX:
		return append(out, &expr.Reject{Type: unix.NFT_REJECT_ICMPX_UNREACH, Code: unix.NFT_REJECT_ICMPX_PORT_UNREACH})
	}
	return append(out, verdict(expr.VerdictAccept))
}

func egressExprs(rules []egressRule, refused *nftables.Set) [][]expr.Any {
	var out [][]expr.Any
	for _, r := range rules {
		if r.record {
			out = append(out, append(r.match(), recordRefused(refused)...))
		}
		out = append(out, append(r.match(), r.verdictExprs()...))
	}
	return out
}

type Packet struct {
	Addr  netip.Addr
	Port  uint16
	Proto uint8
}

type Verdict struct {
	Verdict string
	Path    string
	Rule    string
}

type liveSets struct {
	hosts   []nftables.SetElement
	private []nftables.SetElement
	targets map[netip.Addr]bool
	rejects map[netip.Addr]bool
	sw      map[netip.Addr]netip.Addr
}

func inIntervals(els []nftables.SetElement, a netip.Addr) bool {
	sorted := slices.Clone(els)
	slices.SortStableFunc(sorted, func(x, y nftables.SetElement) int {
		return cmp.Compare(u32(addrOf(x.Key)), u32(addrOf(y.Key)))
	})
	v := u32(a)
	member := false
	for _, el := range sorted {
		if len(el.Key) < 4 || u32(addrOf(el.Key)) > v {
			break
		}
		member = !el.IntervalEnd
	}
	return member
}

func (r egressRule) matches(t term, p Packet, daddr, original netip.Addr, oif string, live liveSets) bool {
	switch t.kind {
	case termIPv4:
		return daddr.Is4()
	case termL4:
		return p.Proto == t.proto
	case termDport:
		return p.Port == t.port
	case termDaddr:
		return daddr == t.addr
	case termDaddrPrefix:
		return t.prefix.Contains(daddr)
	case termDaddrSet:
		in := false
		switch t.set.Name {
		case "host_addrs":
			in = inIntervals(live.hosts, daddr)
		case "private_ranges":
			in = inIntervals(live.private, daddr)
		case "vip_targets":
			in = live.targets[daddr]
		case "switch_reject":
			in = live.rejects[daddr]
		}
		return in != t.invert
	case termCtOriginalSet:
		return live.targets[original]
	case termOif:
		return oif == t.name
	case termEstablished:
		return false
	}
	return false
}

func evaluate(rules []egressRule, b Baseline, pool netip.Prefix, live liveSets, p Packet) Verdict {
	original := p.Addr.Unmap()
	daddr := original
	if p.Port == 53 && (p.Proto == unix.IPPROTO_UDP || p.Proto == unix.IPPROTO_TCP) && b.Resolver.IsValid() {
		daddr = b.Resolver
	} else if live.targets[original] {
		if real, ok := live.sw[original]; ok {
			daddr = real
		}
	}
	oif := ""
	if daddr.IsLoopback() || daddr == b.Self {
		oif = "lo"
	}
	for _, r := range rules {
		if r.terms[0].kind == termEstablished {
			continue
		}
		ok := true
		for _, t := range r.terms {
			if !r.matches(t, p, daddr, original, oif, live) {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		v := Verdict{Verdict: VerdictAccept, Path: r.path, Rule: r.text}
		switch r.verdict {
		case verdictDrop:
			v.Verdict = VerdictDrop
		case verdictRejectTCP, verdictRejectICMPX:
			v.Verdict = VerdictReject
		}
		if r.path == PathPrivateRange {
			v.Path = privatePath(pool, original)
		}
		return v
	}
	return Verdict{Verdict: VerdictDrop, Path: privatePath(pool, original), Rule: "policy drop"}
}

func privatePath(pool netip.Prefix, a netip.Addr) string {
	switch {
	case pool.IsValid() && pool.Contains(a):
		return PathOtherEnv
	case a == CloudMetadata:
		return PathCloudMetadata
	}
	return PathPrivateRange
}

func readLive(c *nftables.Conn) (liveSets, error) {
	var live liveSets
	var err error
	if live.hosts, err = c.GetSetElements(hostAddrsSet()); err != nil {
		return live, err
	}
	if live.private, err = c.GetSetElements(privateRangesSet()); err != nil {
		return live, err
	}
	addrs := func(s *nftables.Set) (map[netip.Addr]bool, error) {
		els, err := c.GetSetElements(s)
		out := map[netip.Addr]bool{}
		for _, el := range els {
			out[addrOf(el.Key)] = true
		}
		return out, err
	}
	if live.targets, err = addrs(vipTargetsSet()); err != nil {
		return live, err
	}
	if live.rejects, err = addrs(switchRejectSet()); err != nil {
		return live, err
	}
	els, err := c.GetSetElements(switchMap())
	if err != nil {
		return live, err
	}
	live.sw = map[netip.Addr]netip.Addr{}
	for _, el := range els {
		live.sw[addrOf(el.Key)] = addrOf(el.Val)
	}
	return live, nil
}

func namedSets() egressSets {
	return egressSets{hosts: hostAddrsSet(), private: privateRangesSet(), targets: vipTargetsSet(), rejects: switchRejectSet()}
}

func (n *Namespace) Verdict(b Baseline, pool netip.Prefix, p Packet) (Verdict, error) {
	c, err := nftables.New(nftables.WithNetNSFd(n.fd()))
	if err != nil {
		return Verdict{}, err
	}
	rules, err := c.GetRules(table, &nftables.Chain{Name: "egress", Table: table})
	if err != nil {
		return Verdict{}, err
	}
	if len(rules) == 0 {
		return Verdict{}, ErrRulesetMismatch
	}
	if comment, ok := userdata.GetString(rules[0].UserData, userdata.TypeComment); !ok || comment != commentPrefix+b.fingerprint() {
		return Verdict{}, ErrRulesetMismatch
	}
	live, err := readLive(c)
	if err != nil {
		return Verdict{}, err
	}
	return evaluate(egressTable(b, namedSets()), b, pool, live, p), nil
}

func (n *Namespace) SwitchEntry(vip netip.Addr) (netip.Addr, bool, error) {
	c, err := nftables.New(nftables.WithNetNSFd(n.fd()))
	if err != nil {
		return netip.Addr{}, false, err
	}
	els, err := c.GetSetElements(switchMap())
	if err != nil {
		return netip.Addr{}, false, err
	}
	for _, el := range els {
		if addrOf(el.Key) == vip {
			return addrOf(el.Val), false, nil
		}
	}
	rejects, err := c.GetSetElements(switchRejectSet())
	if err != nil {
		return netip.Addr{}, false, err
	}
	for _, el := range rejects {
		if addrOf(el.Key) == vip {
			return netip.Addr{}, true, nil
		}
	}
	return netip.Addr{}, false, nil
}

func (n *Namespace) GatewayTarget(target netip.AddrPort) (bool, error) {
	c, err := nftables.New(nftables.WithNetNSFd(n.fd()))
	if err != nil {
		return false, err
	}
	els, err := c.GetSetElements(gatewayTargetsSet())
	if err != nil {
		return false, err
	}
	want := addrPortKey(target)
	for _, el := range els {
		if len(el.Key) >= 6 && string(el.Key[:6]) == string(want[:6]) {
			return true, nil
		}
	}
	return false, nil
}

func HostSwitch(vip netip.Addr) (netip.Addr, error) {
	c, err := nftables.New()
	if err != nil {
		return netip.Addr{}, err
	}
	els, err := c.GetSetElements(hostSwitchMap())
	if err != nil {
		return netip.Addr{}, err
	}
	for _, el := range els {
		if addrOf(el.Key) == vip {
			return addrOf(el.Val), nil
		}
	}
	return netip.Addr{}, nil
}

func HostPort(hostPort uint16) (netip.AddrPort, error) {
	c, err := nftables.New()
	if err != nil {
		return netip.AddrPort{}, err
	}
	els, err := c.GetSetElements(portSwitchMap())
	if err != nil {
		return netip.AddrPort{}, err
	}
	for _, el := range els {
		if len(el.Key) < 2 || len(el.Val) < 6 || uint16(el.Key[0])<<8|uint16(el.Key[1]) != hostPort {
			continue
		}
		a, _ := netip.AddrFromSlice(el.Val[:4])
		return netip.AddrPortFrom(a, uint16(el.Val[4])<<8|uint16(el.Val[5])), nil
	}
	return netip.AddrPort{}, nil
}

func OpenChecked(pid int, inode uint64) (*Namespace, error) {
	ns, err := Open(pid)
	if err != nil {
		return nil, err
	}
	if inode != 0 && ns.Inode != inode {
		ns.Close()
		return nil, fmt.Errorf("namespace of pid %s is %d, not %d", strconv.Itoa(pid), ns.Inode, inode)
	}
	return ns, nil
}
