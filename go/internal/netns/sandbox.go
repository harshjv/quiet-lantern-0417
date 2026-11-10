//go:build linux

package netns

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/netip"
	"slices"
	"strconv"
	"time"

	"github.com/google/nftables"
	"github.com/google/nftables/expr"
	"golang.org/x/sys/unix"
)

const (
	SandboxIf            = "sbx"
	PathSandboxInbound   = "sandbox_inbound"
	PathDomainNotAllowed = "domain_not_allowed"
	sandboxLayout        = "sbx.1"
	couplerIf            = "eth0"
	allowSetPrefix       = "egress_allow_"
)

var (
	CouplerLink = netip.MustParseAddr("169.254.1.1")
	SandboxLink = netip.MustParseAddr("169.254.1.2")
)

type SandboxBaseline struct {
	Resolver  netip.Addr
	Self      netip.Addr
	Subnet    netip.Prefix
	Joined    bool
	Allowlist bool
	Ports     []uint16
}

type AllowElement struct {
	Addr    netip.Addr
	Timeout time.Duration
}

type SandboxElements struct {
	HostAddrs []netip.Prefix
	Switch    map[netip.Addr]netip.Addr
	Pending   []netip.Addr
	Reject    []netip.Addr
	Allow     map[uint16][]AllowElement
}

func (b SandboxBaseline) ports() []uint16 {
	if !b.Allowlist {
		return nil
	}
	out := slices.Clone(b.Ports)
	slices.Sort(out)
	return slices.Compact(out)
}

func (b SandboxBaseline) validate() error {
	if !b.Resolver.Is4() {
		return errors.New("the sandbox baseline has no IPv4 resolver")
	}
	if b.Joined && !b.Subnet.IsValid() {
		return errors.New("a joined sandbox baseline needs its environment subnet")
	}
	if slices.Contains(b.Ports, 0) {
		return errors.New("the sandbox baseline lists port 0")
	}
	return nil
}

func (b SandboxBaseline) fingerprint() string {
	text := sandboxLayout + "|" + b.Resolver.String() + "|" + b.Self.String() + "|" + b.Subnet.Masked().String() + "|" + strconv.FormatBool(b.Joined) + "|" + strconv.FormatBool(b.Allowlist)
	for _, p := range b.ports() {
		text += "|" + strconv.Itoa(int(p))
	}
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:8])
}

func (e SandboxElements) elements(b SandboxBaseline) Elements {
	if !b.Joined {
		return Elements{HostAddrs: e.HostAddrs}
	}
	return Elements{HostAddrs: e.HostAddrs, Switch: e.Switch, Pending: e.Pending, Reject: e.Reject}
}

func allowSet(p uint16) *nftables.Set {
	return &nftables.Set{Table: table, Name: allowSetPrefix + strconv.Itoa(int(p)), KeyType: nftables.TypeIPAddr, HasTimeout: true}
}

func allowSets(b SandboxBaseline) map[uint16]*nftables.Set {
	out := map[uint16]*nftables.Set{}
	for _, p := range b.ports() {
		out[p] = allowSet(p)
	}
	return out
}

func iifExprs(name string, not bool) []expr.Any {
	op := expr.CmpOpEq
	if not {
		op = expr.CmpOpNeq
	}
	return []expr.Any{&expr.Meta{Key: expr.MetaKeyIIFNAME, Register: 1}, &expr.Cmp{Op: op, Register: 1, Data: ifname(name)}}
}

func oifExprs(name string) []expr.Any {
	return []expr.Any{&expr.Meta{Key: expr.MetaKeyOIFNAME, Register: 1}, &expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: ifname(name)}}
}

func sandboxTable(b SandboxBaseline, s egressSets, allow map[uint16]*nftables.Set) []egressRule {
	tcp, udp := byte(unix.IPPROTO_TCP), byte(unix.IPPROTO_UDP)
	rules := []egressRule{
		{terms: []term{{kind: termEstablished}}, verdict: verdictAccept, text: "ct state established,related accept"},
		{iif: SandboxIf, iifNot: true, terms: []term{ipv4Term()}, verdict: verdictDrop, counter: true, record: true, path: PathSandboxInbound, text: `iifname != "sbx" drop`},
	}
	for _, proto := range []byte{udp, tcp} {
		rules = append(rules, egressRule{terms: []term{ipv4Term(), l4Term(proto), dportTerm(53), daddrTerm(b.Resolver)}, verdict: verdictAccept, counter: true, path: PathResolver, text: fmt.Sprintf("ip daddr %s %s dport 53 accept", b.Resolver, protoName(proto))})
	}
	if b.Joined {
		rules = append(rules,
			egressRule{terms: []term{ipv4Term(), l4Term(tcp), setTerm(s.rejects, false)}, verdict: verdictRejectTCP, counter: true, record: true, path: PathNoSwitchTarget, text: "ip daddr @switch_reject reject with tcp reset"},
			egressRule{terms: []term{ipv4Term(), setTerm(s.rejects, false)}, verdict: verdictRejectICMPX, counter: true, record: true, path: PathNoSwitchTarget, text: "ip daddr @switch_reject reject with icmpx port-unreachable"},
		)
	}
	rules = append(rules, egressRule{terms: []term{ipv4Term(), setTerm(s.hosts, false)}, verdict: verdictDrop, counter: true, record: true, path: PathHostAddress, text: "ip daddr @host_addrs drop"})
	if b.Joined {
		rules = append(rules, egressRule{terms: []term{ipv4Term(), {kind: termCtOriginalSet, set: s.targets}}, verdict: verdictAccept, counter: true, path: PathSameEnvironment, text: "ct original ip daddr @vip_targets accept"})
		if b.Subnet.IsValid() {
			rules = append(rules, egressRule{terms: []term{ipv4Term(), {kind: termDaddrPrefix, prefix: b.Subnet.Masked()}}, verdict: verdictAccept, counter: true, path: PathSameEnvironment, text: "ip daddr " + b.Subnet.Masked().String() + " accept"})
		}
	}
	rules = append(rules, egressRule{terms: []term{ipv4Term(), setTerm(s.private, false)}, verdict: verdictDrop, counter: true, record: true, path: PathPrivateRange, text: "ip daddr @private_ranges drop"})
	if !b.Allowlist {
		return append(rules, egressRule{terms: []term{ipv4Term(), setTerm(s.private, true)}, verdict: verdictAccept, counter: true, path: PathPublicInternet, text: "ip daddr != @private_ranges accept"})
	}
	for _, p := range b.ports() {
		rules = append(rules, egressRule{terms: []term{ipv4Term(), setTerm(allow[p], false), l4Term(tcp), dportTerm(p)}, verdict: verdictAccept, counter: true, path: PathPublicInternet, text: fmt.Sprintf("ip daddr @%s tcp dport %d accept", allow[p].Name, p)})
	}
	return append(rules,
		egressRule{terms: []term{ipv4Term(), l4Term(tcp)}, verdict: verdictRejectTCP, counter: true, record: true, path: PathDomainNotAllowed, text: "meta l4proto tcp reject with tcp reset"},
		egressRule{terms: []term{ipv4Term()}, verdict: verdictRejectICMPX, counter: true, record: true, path: PathDomainNotAllowed, text: "reject with icmpx port-unreachable"},
	)
}

func interceptExprs(proto byte, resolver netip.Addr) []expr.Any {
	return append(iifExprs(SandboxIf, false), dnsDNAT(proto, resolver)...)
}

func switchInExprs(targets, smap *nftables.Set) []expr.Any {
	return append(iifExprs(SandboxIf, false), switchDNAT(targets, smap)...)
}

func ctNew() []expr.Any {
	return []expr.Any{
		&expr.Ct{Register: 1, Key: expr.CtKeySTATE},
		&expr.Bitwise{SourceRegister: 1, DestRegister: 1, Len: 4, Mask: binaryNative(expr.CtStateBitNEW), Xor: []byte{0, 0, 0, 0}},
		&expr.Cmp{Op: expr.CmpOpNeq, Register: 1, Data: []byte{0, 0, 0, 0}},
	}
}

func forwardOutExprs() []expr.Any {
	out := append(append(oifExprs(SandboxIf), ipv4()...), daddr(), &expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: SandboxLink.AsSlice()})
	return append(append(out, ctNew()...), &expr.Counter{}, verdict(expr.VerdictAccept))
}

func masqExprs() []expr.Any {
	return append(append(iifExprs(SandboxIf, false), oifExprs(couplerIf)...), &expr.Counter{}, &expr.Masq{})
}

func established() []expr.Any {
	return term{kind: termEstablished}.exprs()
}

func allowElements(els []AllowElement) []nftables.SetElement {
	var out []nftables.SetElement
	for _, e := range els {
		if !e.Addr.Unmap().Is4() || e.Timeout <= 0 {
			continue
		}
		out = append(out, nftables.SetElement{Key: e.Addr.Unmap().AsSlice(), Timeout: e.Timeout})
	}
	return out
}

func writeSandbox(c *nftables.Conn, b SandboxBaseline, e SandboxElements, sw map[netip.Addr]netip.Addr, reject []netip.Addr) error {
	sets := newSwitchSets()
	tables := sets.elements(e.HostAddrs, sw, reject)
	allow := allowSets(b)
	for _, p := range b.ports() {
		tables = append(tables, setEls{allow[p], allowElements(e.Allow[p])})
	}
	if err := resetTable(c, table, tables); err != nil {
		return err
	}

	drop := nftables.ChainPolicyDrop
	intercept := c.AddChain(&nftables.Chain{Name: "dns_intercept", Table: table, Type: nftables.ChainTypeNAT, Hooknum: nftables.ChainHookPrerouting, Priority: nftables.ChainPriorityRef(-110)})
	for _, proto := range []byte{unix.IPPROTO_UDP, unix.IPPROTO_TCP} {
		c.AddRule(&nftables.Rule{Table: table, Chain: intercept, Exprs: interceptExprs(proto, b.Resolver)})
	}
	if b.Joined {
		switchIn := c.AddChain(&nftables.Chain{Name: "switch_in", Table: table, Type: nftables.ChainTypeNAT, Hooknum: nftables.ChainHookPrerouting, Priority: nftables.ChainPriorityRef(-100)})
		c.AddRule(&nftables.Rule{Table: table, Chain: switchIn, Exprs: switchInExprs(sets.targets, sets.smap)})
	}

	egress := c.AddChain(&nftables.Chain{Name: "egress", Table: table, Type: nftables.ChainTypeFilter, Hooknum: nftables.ChainHookForward, Priority: nftables.ChainPriorityRef(0), Policy: &drop})
	addFingerprinted(c, egress, egressExprs(sandboxTable(b, sets.egress(), allow), sets.refused), commentPrefix+b.fingerprint())

	inbound := c.AddChain(&nftables.Chain{Name: "inbound", Table: table, Type: nftables.ChainTypeFilter, Hooknum: nftables.ChainHookInput, Priority: nftables.ChainPriorityRef(0), Policy: &drop})
	c.AddRule(&nftables.Rule{Table: table, Chain: inbound, Exprs: append(established(), verdict(expr.VerdictAccept))})
	c.AddRule(&nftables.Rule{Table: table, Chain: inbound, Exprs: append(iifExprs("lo", false), verdict(expr.VerdictAccept))})

	localOut := c.AddChain(&nftables.Chain{Name: "local_out", Table: table, Type: nftables.ChainTypeFilter, Hooknum: nftables.ChainHookOutput, Priority: nftables.ChainPriorityRef(0), Policy: &drop})
	c.AddRule(&nftables.Rule{Table: table, Chain: localOut, Exprs: append(established(), verdict(expr.VerdictAccept))})
	c.AddRule(&nftables.Rule{Table: table, Chain: localOut, Exprs: append(oifExprs("lo"), verdict(expr.VerdictAccept))})
	c.AddRule(&nftables.Rule{Table: table, Chain: localOut, Exprs: forwardOutExprs()})

	masq := c.AddChain(&nftables.Chain{Name: "masq", Table: table, Type: nftables.ChainTypeNAT, Hooknum: nftables.ChainHookPostrouting, Priority: nftables.ChainPriorityRef(100)})
	c.AddRule(&nftables.Rule{Table: table, Chain: masq, Exprs: masqExprs()})
	return c.Flush()
}

func (n *Namespace) SyncSandbox(b SandboxBaseline, e SandboxElements) (Result, error) {
	if err := b.validate(); err != nil {
		return Unchanged, err
	}
	el := e.elements(b)
	return n.syncTable(commentPrefix+b.fingerprint(), el, func(c *nftables.Conn, sw map[netip.Addr]netip.Addr) error {
		return writeSandbox(c, b, e, sw, el.Reject)
	})
}

func (n *Namespace) SandboxVerdict(b SandboxBaseline, pool netip.Prefix, p Packet, inbound bool) (Verdict, error) {
	c, live, err := n.liveFor(commentPrefix + b.fingerprint())
	if err != nil {
		return Verdict{}, err
	}
	allow := map[string]map[netip.Addr]bool{}
	for _, s := range allowSets(b) {
		if allow[s.Name], err = readAddrs(c, s); err != nil {
			return Verdict{}, err
		}
	}
	return evaluateSandbox(sandboxTable(b, namedSets(), allowSets(b)), b, pool, live, allow, p, inbound), nil
}

func evaluateSandbox(rules []egressRule, b SandboxBaseline, pool netip.Prefix, live liveSets, allow map[string]map[netip.Addr]bool, p Packet, inbound bool) Verdict {
	live.allow = allow
	rt := route{original: p.Addr.Unmap(), iif: SandboxIf}
	rt.daddr = rt.original
	switch {
	case inbound:
		rt.iif = couplerIf
	case dnsQuery(p) && b.Resolver.IsValid():
		rt.daddr = b.Resolver
	case b.Joined && live.targets[rt.original]:
		if realAddr, ok := live.sw[rt.original]; ok {
			rt.daddr = realAddr
		}
	}
	if rt.daddr == CouplerLink || (b.Self.IsValid() && rt.daddr == b.Self) {
		return Verdict{Verdict: VerdictDrop, Path: PathSandboxInbound, Rule: "inbound policy drop"}
	}
	return decide(rules, pool, live, p, rt)
}
