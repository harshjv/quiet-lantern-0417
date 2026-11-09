//go:build linux

package netns

import (
	"net/netip"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/nftables/expr"
	"github.com/ti-mo/conntrack"
	"golang.org/x/sys/unix"
)

var (
	sbxPool     = netip.MustParsePrefix("10.200.0.0/16")
	sbxJoined   = SandboxBaseline{Resolver: netip.MustParseAddr("10.200.10.1"), Self: netip.MustParseAddr("10.200.10.2"), Subnet: netip.MustParsePrefix("10.200.10.0/24"), Joined: true}
	sbxIsolated = SandboxBaseline{Resolver: netip.MustParseAddr("10.200.20.1"), Self: netip.MustParseAddr("10.200.20.2")}
	sbxAllowed  = netip.MustParseAddr("93.184.215.14")
)

var sbxSetRef = regexp.MustCompile(`@([a-z_0-9]+)`)

func allowlisted(b SandboxBaseline) SandboxBaseline {
	b.Allowlist = true
	b.Ports = []uint16{443, 22}
	return b
}

func sbxLive() liveSets {
	hosts := []netip.Prefix{
		netip.MustParsePrefix("178.104.122.185/32"),
		netip.MustParsePrefix("10.200.10.1/32"),
		netip.MustParsePrefix("10.200.20.1/32"),
		netip.MustParsePrefix("172.17.0.1/32"),
	}
	vip := netip.MustParseAddr("100.64.0.2")
	return liveSets{
		hosts:   intervalElements(hosts),
		private: intervalElements(PrivateRanges),
		targets: map[netip.Addr]bool{vip: true},
		rejects: map[netip.Addr]bool{netip.MustParseAddr("100.64.0.3"): true},
		sw:      map[netip.Addr]netip.Addr{vip: netip.MustParseAddr("10.200.10.50")},
	}
}

func sbxAllow() map[string]map[netip.Addr]bool {
	return map[string]map[netip.Addr]bool{
		"egress_allow_443": {sbxAllowed: true},
		"egress_allow_22":  {},
	}
}

func sbxRules(b SandboxBaseline) []sandboxRule {
	return sandboxTable(b, namedSets(), allowSets(b))
}

func sbxVerdict(b SandboxBaseline, addr string, proto uint8, port uint16, inbound bool) Verdict {
	p := Packet{Addr: netip.MustParseAddr(addr), Proto: proto, Port: port}
	return evaluateSandbox(sbxRules(b), b, sbxPool, sbxLive(), sbxAllow(), p, inbound)
}

func sbxVariants() map[string]SandboxBaseline {
	return map[string]SandboxBaseline{
		"isolated open":      sbxIsolated,
		"isolated allowlist": allowlisted(sbxIsolated),
		"joined open":        sbxJoined,
		"joined allowlist":   allowlisted(sbxJoined),
	}
}

func TestSandboxTableOrderPerVariant(t *testing.T) {
	head := []string{
		"ct state established,related accept",
		`iifname != "sbx" drop`,
	}
	resolver := func(a string) []string {
		return []string{"ip daddr " + a + " udp dport 53 accept", "ip daddr " + a + " tcp dport 53 accept"}
	}
	joined := []string{"ip daddr @switch_reject reject with tcp reset", "ip daddr @switch_reject reject with icmpx port-unreachable"}
	env := []string{"ct original ip daddr @vip_targets accept", "ip daddr 10.200.10.0/24 accept"}
	open := []string{"ip daddr != @private_ranges accept"}
	allow := []string{
		"ip daddr @egress_allow_22 tcp dport 22 accept",
		"ip daddr @egress_allow_443 tcp dport 443 accept",
		"meta l4proto tcp reject with tcp reset",
		"reject with icmpx port-unreachable",
	}
	cat := func(parts ...[]string) []string { return slices.Concat(parts...) }
	want := map[string][]string{
		"isolated open":      cat(head, resolver("10.200.20.1"), []string{"ip daddr @host_addrs drop", "ip daddr @private_ranges drop"}, open),
		"isolated allowlist": cat(head, resolver("10.200.20.1"), []string{"ip daddr @host_addrs drop", "ip daddr @private_ranges drop"}, allow),
		"joined open":        cat(head, resolver("10.200.10.1"), joined, []string{"ip daddr @host_addrs drop"}, env, []string{"ip daddr @private_ranges drop"}, open),
		"joined allowlist":   cat(head, resolver("10.200.10.1"), joined, []string{"ip daddr @host_addrs drop"}, env, []string{"ip daddr @private_ranges drop"}, allow),
	}
	for name, b := range sbxVariants() {
		var got []string
		for _, r := range sbxRules(b) {
			got = append(got, r.text)
		}
		if !slices.Equal(got, want[name]) {
			t.Errorf("%s:\ngot  %q\nwant %q", name, got, want[name])
		}
	}
}

func TestSandboxBlockingRulesAreRecordedBeforeTheyDecide(t *testing.T) {
	for name, b := range sbxVariants() {
		rules := sbxRules(b)
		exprs := sandboxExprs(rules, refusedSet())
		i := 0
		for _, r := range rules {
			blocked := r.verdict != verdictAccept
			if blocked != r.record {
				t.Errorf("%s: %q blocks=%v records=%v", name, r.text, blocked, r.record)
			}
			if !r.record {
				if hasExpr[*expr.Dynset](exprs[i]) {
					t.Errorf("%s: %q records without blocking", name, r.text)
				}
				i++
				continue
			}
			rec, dec := exprs[i], exprs[i+1]
			i += 2
			if !hasExpr[*expr.Dynset](rec) || hasExpr[*expr.Verdict](rec) || hasExpr[*expr.Reject](rec) {
				t.Errorf("%s: %q recording rule is wrong", name, r.text)
			}
			if hasExpr[*expr.Dynset](dec) || (!hasExpr[*expr.Verdict](dec) && !hasExpr[*expr.Reject](dec)) {
				t.Errorf("%s: %q verdict rule is wrong", name, r.text)
			}
			n := len(r.match())
			if n == 0 || !slices.EqualFunc(rec[:n], dec[:n], func(a, b expr.Any) bool { return typeName(a) == typeName(b) }) {
				t.Errorf("%s: %q recording and verdict rules differ in their match", name, r.text)
			}
		}
		if i != len(exprs) {
			t.Errorf("%s: consumed %d of %d expression lists", name, i, len(exprs))
		}
	}
}

func TestSandboxEveryNonEstablishedRuleCounts(t *testing.T) {
	for name, b := range sbxVariants() {
		for i, r := range sbxRules(b) {
			if i == 0 {
				if r.terms[0].kind != termEstablished || r.counter {
					t.Errorf("%s: first rule %q", name, r.text)
				}
				continue
			}
			if !r.counter {
				t.Errorf("%s: %q has no counter", name, r.text)
				continue
			}
			if _, ok := r.verdictExprs()[0].(*expr.Counter); !ok {
				t.Errorf("%s: %q counter is not first in its verdict", name, r.text)
			}
		}
	}
}

func TestSandboxRulesReferenceTheSetsNamedInTheirText(t *testing.T) {
	for name, b := range sbxVariants() {
		for _, r := range sbxRules(b) {
			var want, got []string
			for _, m := range sbxSetRef.FindAllStringSubmatch(r.text, -1) {
				want = append(want, m[1])
			}
			for _, e := range r.match() {
				if l, ok := e.(*expr.Lookup); ok {
					got = append(got, l.SetName)
				}
			}
			slices.Sort(want)
			slices.Sort(got)
			if !slices.Equal(got, want) {
				t.Errorf("%s: %q looks up %v", name, r.text, got)
			}
		}
	}
}

func TestSandboxRejectsUsePortUnreachable(t *testing.T) {
	for name, b := range sbxVariants() {
		for _, list := range sandboxExprs(sbxRules(b), refusedSet()) {
			for _, e := range list {
				if r, ok := e.(*expr.Reject); ok && r.Type == unix.NFT_REJECT_ICMPX_UNREACH && r.Code != unix.NFT_REJECT_ICMPX_PORT_UNREACH {
					t.Errorf("%s: icmpx reject with code %d", name, r.Code)
				}
			}
		}
	}
}

func TestSandboxInboundRuleMatchesEveryInterfaceButSbx(t *testing.T) {
	r := sbxRules(sbxIsolated)[1]
	m := r.match()
	meta, ok := m[0].(*expr.Meta)
	if !ok || meta.Key != expr.MetaKeyIIFNAME {
		t.Fatalf("first expression %+v", m[0])
	}
	cmp := m[1].(*expr.Cmp)
	if cmp.Op != expr.CmpOpNeq || string(cmp.Data) != string(ifname(SandboxIf)) || len(cmp.Data) != 16 {
		t.Fatalf("cmp %+v", cmp)
	}
	if r.path != PathSandboxInbound || r.verdict != verdictDrop {
		t.Fatalf("rule %+v", r)
	}
}

func TestSandboxAllowRuleMatchesSetProtocolAndPort(t *testing.T) {
	for _, r := range sbxRules(allowlisted(sbxIsolated)) {
		if r.text != "ip daddr @egress_allow_443 tcp dport 443 accept" {
			continue
		}
		var cmps [][]byte
		var sets []string
		for _, e := range r.match() {
			switch x := e.(type) {
			case *expr.Cmp:
				cmps = append(cmps, x.Data)
			case *expr.Lookup:
				sets = append(sets, x.SetName)
			}
		}
		if !slices.EqualFunc(cmps, [][]byte{{unix.NFPROTO_IPV4}, {unix.IPPROTO_TCP}, {1, 187}}, slices.Equal[[]byte]) || !slices.Equal(sets, []string{"egress_allow_443"}) {
			t.Fatalf("cmps %v sets %v", cmps, sets)
		}
		return
	}
	t.Fatal("allow rule missing")
}

func TestSandboxMasqueradeMatchesInterfacesOnly(t *testing.T) {
	m := masqExprs()
	if len(m) != 6 {
		t.Fatalf("got %d expressions", len(m))
	}
	keys := []expr.MetaKey{expr.MetaKeyIIFNAME, expr.MetaKeyOIFNAME}
	names := []string{SandboxIf, "eth0"}
	for i := range 2 {
		meta := m[2*i].(*expr.Meta)
		cmp := m[2*i+1].(*expr.Cmp)
		if meta.Key != keys[i] || cmp.Op != expr.CmpOpEq || string(cmp.Data) != string(ifname(names[i])) {
			t.Errorf("match %d: %+v %+v", i, meta, cmp)
		}
	}
	if _, ok := m[4].(*expr.Counter); !ok {
		t.Error("no counter")
	}
	if _, ok := m[5].(*expr.Masq); !ok {
		t.Error("no masquerade")
	}
	if hasExpr[*expr.Payload](m) {
		t.Error("masquerade must not match on an address")
	}
}

func TestSandboxForwardRuleOpensOnlyNewConnectionsToTheSandbox(t *testing.T) {
	m := forwardOutExprs()
	meta := m[0].(*expr.Meta)
	if meta.Key != expr.MetaKeyOIFNAME || string(m[1].(*expr.Cmp).Data) != string(ifname(SandboxIf)) {
		t.Fatalf("oif %+v", m[:2])
	}
	var addr, state bool
	for i, e := range m {
		if c, ok := e.(*expr.Cmp); ok && slices.Equal(c.Data, SandboxLink.AsSlice()) {
			addr = true
		}
		if ct, ok := e.(*expr.Ct); ok && ct.Key == expr.CtKeySTATE {
			b := m[i+1].(*expr.Bitwise)
			state = slices.Equal(b.Mask, binaryNative(expr.CtStateBitNEW))
		}
	}
	if !addr || !state {
		t.Fatalf("address %v state %v", addr, state)
	}
	last := m[len(m)-1].(*expr.Verdict)
	if last.Kind != expr.VerdictAccept || !hasExpr[*expr.Counter](m) {
		t.Fatalf("verdict %+v", last)
	}
}

func TestSandboxInterceptSendsDNSFromSbxToTheResolver(t *testing.T) {
	for _, proto := range []byte{unix.IPPROTO_UDP, unix.IPPROTO_TCP} {
		m := interceptExprs(proto, sbxJoined.Resolver)
		if c := m[1].(*expr.Cmp); m[0].(*expr.Meta).Key != expr.MetaKeyIIFNAME || string(c.Data) != string(ifname(SandboxIf)) {
			t.Errorf("proto %d: no iif match", proto)
		}
		var imm [][]byte
		for _, e := range m {
			if i, ok := e.(*expr.Immediate); ok {
				imm = append(imm, i.Data)
			}
		}
		if !slices.EqualFunc(imm, [][]byte{sbxJoined.Resolver.AsSlice(), {0, 53}}, slices.Equal[[]byte]) {
			t.Errorf("proto %d: immediates %v", proto, imm)
		}
		if n, ok := m[len(m)-1].(*expr.NAT); !ok || n.Type != expr.NATTypeDestNAT {
			t.Errorf("proto %d: no dnat", proto)
		}
	}
}

func TestSandboxSwitchInLooksUpTheTargetsThenTheMap(t *testing.T) {
	m := switchInExprs(vipTargetsSet(), switchMap())
	var lookups []string
	for _, e := range m {
		if l, ok := e.(*expr.Lookup); ok {
			lookups = append(lookups, l.SetName)
		}
	}
	if !slices.Equal(lookups, []string{"vip_targets", "switch"}) {
		t.Fatalf("lookups %v", lookups)
	}
	if m[0].(*expr.Meta).Key != expr.MetaKeyIIFNAME {
		t.Fatal("no iif match")
	}
}

func TestSandboxVerdictsPerPath(t *testing.T) {
	tcp, udp := uint8(unix.IPPROTO_TCP), uint8(unix.IPPROTO_UDP)
	joinedAllow := allowlisted(sbxJoined)
	isolatedAllow := allowlisted(sbxIsolated)
	cases := []struct {
		name    string
		b       SandboxBaseline
		addr    string
		proto   uint8
		port    uint16
		inbound bool
		verdict string
		path    string
		rule    string
	}{
		{"joined resolver over udp", sbxJoined, "10.200.10.1", udp, 53, false, VerdictAccept, PathResolver, "ip daddr 10.200.10.1 udp dport 53 accept"},
		{"joined resolver over tcp", sbxJoined, "10.200.10.1", tcp, 53, false, VerdictAccept, PathResolver, "ip daddr 10.200.10.1 tcp dport 53 accept"},
		{"query to 8.8.8.8 is intercepted", sbxJoined, "8.8.8.8", udp, 53, false, VerdictAccept, PathResolver, "ip daddr 10.200.10.1 udp dport 53 accept"},
		{"tcp query to 1.1.1.1 is intercepted", sbxJoined, "1.1.1.1", tcp, 53, false, VerdictAccept, PathResolver, "ip daddr 10.200.10.1 tcp dport 53 accept"},
		{"query to cloud metadata is intercepted", sbxJoined, "169.254.169.254", udp, 53, false, VerdictAccept, PathResolver, "ip daddr 10.200.10.1 udp dport 53 accept"},
		{"isolated query is intercepted to its resolver", isolatedAllow, "8.8.8.8", udp, 53, false, VerdictAccept, PathResolver, "ip daddr 10.200.20.1 udp dport 53 accept"},
		{"joined env subnet", sbxJoined, "10.200.10.50", tcp, 80, false, VerdictAccept, PathSameEnvironment, "ip daddr 10.200.10.0/24 accept"},
		{"joined switch vip", sbxJoined, "100.64.0.2", tcp, 80, false, VerdictAccept, PathSameEnvironment, "ct original ip daddr @vip_targets accept"},
		{"joined allowlist keeps the env subnet", joinedAllow, "10.200.10.50", tcp, 5432, false, VerdictAccept, PathSameEnvironment, "ip daddr 10.200.10.0/24 accept"},
		{"switch_reject over tcp", sbxJoined, "100.64.0.3", tcp, 80, false, VerdictReject, PathNoSwitchTarget, "ip daddr @switch_reject reject with tcp reset"},
		{"switch_reject over udp", sbxJoined, "100.64.0.3", udp, 9000, false, VerdictReject, PathNoSwitchTarget, "ip daddr @switch_reject reject with icmpx port-unreachable"},
		{"host public address", sbxJoined, "178.104.122.185", tcp, 22, false, VerdictDrop, PathHostAddress, "ip daddr @host_addrs drop"},
		{"env bridge gateway off port 53", sbxJoined, "10.200.10.1", tcp, 80, false, VerdictDrop, PathHostAddress, "ip daddr @host_addrs drop"},
		{"docker bridge gateway", sbxJoined, "172.17.0.1", tcp, 80, false, VerdictDrop, PathHostAddress, "ip daddr @host_addrs drop"},
		{"isolated sandbox network gateway", sbxIsolated, "10.200.20.1", tcp, 7900, false, VerdictDrop, PathHostAddress, "ip daddr @host_addrs drop"},
		{"joined cloud metadata", sbxJoined, "169.254.169.254", tcp, 80, false, VerdictDrop, PathCloudMetadata, "ip daddr @private_ranges drop"},
		{"isolated cloud metadata", isolatedAllow, "169.254.169.254", tcp, 80, false, VerdictDrop, PathCloudMetadata, "ip daddr @private_ranges drop"},
		{"joined other environment", sbxJoined, "10.200.30.5", tcp, 80, false, VerdictDrop, PathOtherEnv, "ip daddr @private_ranges drop"},
		{"isolated reaching an environment", sbxIsolated, "10.200.10.50", tcp, 80, false, VerdictDrop, PathOtherEnv, "ip daddr @private_ranges drop"},
		{"isolated reaching another sandbox coupler", sbxIsolated, "10.200.20.3", tcp, 80, false, VerdictDrop, PathOtherEnv, "ip daddr @private_ranges drop"},
		{"isolated vip is not switched", sbxIsolated, "100.64.0.2", tcp, 80, false, VerdictDrop, PathPrivateRange, "ip daddr @private_ranges drop"},
		{"private range", sbxJoined, "192.168.1.10", tcp, 80, false, VerdictDrop, PathPrivateRange, "ip daddr @private_ranges drop"},
		{"another private range", sbxIsolated, "172.20.0.4", udp, 123, false, VerdictDrop, PathPrivateRange, "ip daddr @private_ranges drop"},
		{"open public tcp", sbxJoined, "93.184.215.14", tcp, 443, false, VerdictAccept, PathPublicInternet, "ip daddr != @private_ranges accept"},
		{"open public udp", sbxIsolated, "1.1.1.1", udp, 443, false, VerdictAccept, PathPublicInternet, "ip daddr != @private_ranges accept"},
		{"allowlist accepts a listed address on 443", isolatedAllow, "93.184.215.14", tcp, 443, false, VerdictAccept, PathPublicInternet, "ip daddr @egress_allow_443 tcp dport 443 accept"},
		{"joined allowlist accepts a listed address", joinedAllow, "93.184.215.14", tcp, 443, false, VerdictAccept, PathPublicInternet, "ip daddr @egress_allow_443 tcp dport 443 accept"},
		{"allowlist refuses port 80", isolatedAllow, "93.184.215.14", tcp, 80, false, VerdictReject, PathDomainNotAllowed, "meta l4proto tcp reject with tcp reset"},
		{"allowlist refuses 22 with an empty set", isolatedAllow, "93.184.215.14", tcp, 22, false, VerdictReject, PathDomainNotAllowed, "meta l4proto tcp reject with tcp reset"},
		{"allowlist refuses an unlisted address", isolatedAllow, "142.250.0.1", tcp, 443, false, VerdictReject, PathDomainNotAllowed, "meta l4proto tcp reject with tcp reset"},
		{"allowlist refuses doh by ip", isolatedAllow, "1.1.1.1", tcp, 443, false, VerdictReject, PathDomainNotAllowed, "meta l4proto tcp reject with tcp reset"},
		{"allowlist rejects public udp", isolatedAllow, "93.184.215.14", udp, 443, false, VerdictReject, PathDomainNotAllowed, "reject with icmpx port-unreachable"},
		{"allowlist rejects ntp", isolatedAllow, "162.159.200.1", udp, 123, false, VerdictReject, PathDomainNotAllowed, "reject with icmpx port-unreachable"},
		{"to the coupler link address", sbxJoined, "169.254.1.1", tcp, 22, false, VerdictDrop, PathSandboxInbound, "inbound policy drop"},
		{"to the coupler's own address", sbxJoined, "10.200.10.2", tcp, 8000, false, VerdictDrop, PathSandboxInbound, "inbound policy drop"},
		{"isolated to the coupler's own address", isolatedAllow, "10.200.20.2", tcp, 8000, false, VerdictDrop, PathSandboxInbound, "inbound policy drop"},
		{"inbound to the sandbox", sbxJoined, "169.254.1.2", tcp, 22, true, VerdictDrop, PathSandboxInbound, `iifname != "sbx" drop`},
		{"inbound udp to the sandbox", sbxIsolated, "169.254.1.2", udp, 53, true, VerdictDrop, PathSandboxInbound, `iifname != "sbx" drop`},
		{"inbound to the coupler", sbxJoined, "10.200.10.2", tcp, 8000, true, VerdictDrop, PathSandboxInbound, "inbound policy drop"},
		{"inbound to a public address through the coupler", sbxJoined, "93.184.215.14", tcp, 443, true, VerdictDrop, PathSandboxInbound, `iifname != "sbx" drop`},
		{"ipv6 falls to the policy", sbxJoined, "2606:4700::1111", tcp, 443, false, VerdictDrop, PathPrivateRange, "policy drop"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := sbxVerdict(c.b, c.addr, c.proto, c.port, c.inbound)
			if got.Verdict != c.verdict || got.Path != c.path || got.Rule != c.rule {
				t.Fatalf("got %s via %s (%s), want %s via %s (%s)", got.Verdict, got.Path, got.Rule, c.verdict, c.path, c.rule)
			}
		})
	}
}

func TestSandboxPathIDsAreTheDocumentedOnes(t *testing.T) {
	if PathSandboxInbound != "sandbox_inbound" || PathDomainNotAllowed != "domain_not_allowed" || SandboxIf != "sbx" {
		t.Fatal("constants changed")
	}
	allowed := []string{"", PathSandboxInbound, PathDomainNotAllowed, PathResolver, PathNoSwitchTarget, PathHostAddress, PathSameEnvironment, PathPrivateRange, PathPublicInternet}
	for name, b := range sbxVariants() {
		for _, r := range sbxRules(b) {
			if !slices.Contains(allowed, r.path) {
				t.Errorf("%s: %q carries path %q", name, r.text, r.path)
			}
		}
	}
	if CouplerLink.String() != "169.254.1.1" || SandboxLink.String() != "169.254.1.2" {
		t.Fatal("link addresses changed")
	}
}

func TestSandboxFingerprint(t *testing.T) {
	base := allowlisted(sbxJoined)
	seen := map[string]string{base.fingerprint(): "base"}
	variants := map[string]func(SandboxBaseline) SandboxBaseline{
		"resolver":    func(b SandboxBaseline) SandboxBaseline { b.Resolver = netip.MustParseAddr("10.200.10.9"); return b },
		"self":        func(b SandboxBaseline) SandboxBaseline { b.Self = netip.MustParseAddr("10.200.10.9"); return b },
		"subnet":      func(b SandboxBaseline) SandboxBaseline { b.Subnet = netip.MustParsePrefix("10.200.11.0/24"); return b },
		"joined":      func(b SandboxBaseline) SandboxBaseline { b.Joined = false; return b },
		"open":        func(b SandboxBaseline) SandboxBaseline { b.Allowlist = false; return b },
		"port added":  func(b SandboxBaseline) SandboxBaseline { b.Ports = []uint16{443, 22, 80}; return b },
		"port gone":   func(b SandboxBaseline) SandboxBaseline { b.Ports = []uint16{443}; return b },
		"no ports":    func(b SandboxBaseline) SandboxBaseline { b.Ports = nil; return b },
		"port change": func(b SandboxBaseline) SandboxBaseline { b.Ports = []uint16{443, 2222}; return b },
	}
	for name, f := range variants {
		fp := f(base).fingerprint()
		if prev, dup := seen[fp]; dup {
			t.Errorf("%s collides with %s", name, prev)
		}
		seen[fp] = name
	}
	same := base
	same.Ports = []uint16{22, 443, 443, 22}
	if same.fingerprint() != base.fingerprint() {
		t.Error("port order or duplicates changed the fingerprint")
	}
	hostBits := base
	hostBits.Subnet = netip.MustParsePrefix("10.200.10.77/24")
	if hostBits.fingerprint() != base.fingerprint() {
		t.Error("subnet host bits changed the fingerprint")
	}
	openA, openB := sbxJoined, sbxJoined
	openB.Ports = []uint16{443, 8443}
	if openA.fingerprint() != openB.fingerprint() {
		t.Error("ports changed an open-mode fingerprint")
	}
	if base.fingerprint() == testBaseline.fingerprint() {
		t.Error("sandbox and service fingerprints collide")
	}
}

func TestSandboxPortsAreSortedDistinctAndOnlyInAllowlist(t *testing.T) {
	b := SandboxBaseline{Allowlist: true, Ports: []uint16{443, 22, 443, 8443, 22}}
	if got := b.ports(); !slices.Equal(got, []uint16{22, 443, 8443}) {
		t.Fatalf("got %v", got)
	}
	if !slices.Equal(b.Ports, []uint16{443, 22, 443, 8443, 22}) {
		t.Fatal("ports() changed the baseline")
	}
	b.Allowlist = false
	if got := b.ports(); got != nil {
		t.Fatalf("open mode ports %v", got)
	}
	if len(allowSets(b)) != 0 {
		t.Fatal("open mode has allow sets")
	}
}

func TestSandboxAllowSetShape(t *testing.T) {
	s := allowSet(443)
	if s.Name != "egress_allow_443" || !s.HasTimeout || s.Interval || s.Table != table {
		t.Fatalf("set %+v", s)
	}
}

func TestSandboxAllowElementsSkipExpiredAndNonIPv4(t *testing.T) {
	els := allowElements([]AllowElement{
		{Addr: sbxAllowed, Timeout: 5 * time.Minute},
		{Addr: netip.MustParseAddr("::ffff:140.82.121.4"), Timeout: time.Hour},
		{Addr: netip.MustParseAddr("1.2.3.4")},
		{Addr: netip.MustParseAddr("2606:4700::1"), Timeout: time.Hour},
	})
	if len(els) != 2 {
		t.Fatalf("got %+v", els)
	}
	if !slices.Equal(els[1].Key, []byte{140, 82, 121, 4}) || els[1].Timeout != time.Hour {
		t.Fatalf("mapped element %+v", els[1])
	}
}

func TestSandboxBaselineValidation(t *testing.T) {
	if err := sbxJoined.validate(); err != nil {
		t.Fatal(err)
	}
	if err := allowlisted(sbxIsolated).validate(); err != nil {
		t.Fatal(err)
	}
	bad := map[string]SandboxBaseline{
		"no resolver":       {Self: sbxJoined.Self},
		"joined, no subnet": {Resolver: sbxJoined.Resolver, Joined: true},
		"port zero":         {Resolver: sbxJoined.Resolver, Allowlist: true, Ports: []uint16{0}},
	}
	for name, b := range bad {
		if b.validate() == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestSandboxElementsOfAnIsolatedSandboxCarryNoSwitch(t *testing.T) {
	vip := netip.MustParseAddr("100.64.0.2")
	e := SandboxElements{
		HostAddrs: []netip.Prefix{netip.MustParsePrefix("10.200.20.1/32")},
		Switch:    map[netip.Addr]netip.Addr{vip: netip.MustParseAddr("10.200.10.50")},
		Pending:   []netip.Addr{vip},
		Reject:    []netip.Addr{netip.MustParseAddr("100.64.0.3")},
	}
	iso := e.elements(sbxIsolated)
	if len(iso.Switch) != 0 || len(iso.Pending) != 0 || len(iso.Reject) != 0 || len(iso.HostAddrs) != 1 {
		t.Fatalf("isolated %+v", iso)
	}
	j := e.elements(sbxJoined)
	if len(j.Switch) != 1 || len(j.Pending) != 1 || len(j.Reject) != 1 {
		t.Fatalf("joined %+v", j)
	}
}

func flow(src, dst string, proto uint8, dport uint16) conntrack.Flow {
	var f conntrack.Flow
	f.TupleOrig.IP.SourceAddress = netip.MustParseAddr(src)
	f.TupleOrig.IP.DestinationAddress = netip.MustParseAddr(dst)
	f.TupleOrig.Proto.Protocol = proto
	f.TupleOrig.Proto.DestinationPort = dport
	return f
}

func TestSandboxEvictionMatchesOnlySandboxFlowsToRemovedAddresses(t *testing.T) {
	gone := netip.MustParseAddr("104.20.23.154")
	match := sandboxFlowTo([]netip.Addr{gone})
	cases := []struct {
		name string
		f    conntrack.Flow
		want bool
	}{
		{"sandbox https to the removed address", flow("169.254.1.2", "104.20.23.154", unix.IPPROTO_TCP, 443), true},
		{"sandbox ssh to the removed address", flow("169.254.1.2", "104.20.23.154", unix.IPPROTO_TCP, 22), true},
		{"sandbox udp to the removed address", flow("169.254.1.2", "104.20.23.154", unix.IPPROTO_UDP, 443), true},
		{"sandbox dns to the removed address", flow("169.254.1.2", "104.20.23.154", unix.IPPROTO_UDP, 53), false},
		{"sandbox to a kept address", flow("169.254.1.2", "140.82.121.4", unix.IPPROTO_TCP, 443), false},
		{"forward from the coupler to the sandbox", flow("169.254.1.1", "169.254.1.2", unix.IPPROTO_TCP, 8000), false},
		{"another source to the removed address", flow("10.200.20.2", "104.20.23.154", unix.IPPROTO_TCP, 443), false},
	}
	for _, c := range cases {
		if got := match(c.f); got != c.want {
			t.Errorf("%s: %v", c.name, got)
		}
	}
}

func TestInnerPathAndSandboxIDs(t *testing.T) {
	if got := InnerPath("sbx_01jcb4joined"); got != "/run/stationly/netns/sbx_01jcb4joined" {
		t.Fatalf("path %s", got)
	}
	for _, id := range []string{"", ".", "..", "a/b", "../x", "a\x00b"} {
		if checkSandboxID(id) == nil {
			t.Errorf("%q accepted", id)
		}
	}
	if err := checkSandboxID("sbx_01jcb4isol01"); err != nil {
		t.Fatal(err)
	}
}

func TestSandboxRuleTextsNameTheirInterfaceMatch(t *testing.T) {
	for name, b := range sbxVariants() {
		for _, r := range sbxRules(b) {
			if (r.iif != "") != strings.Contains(r.text, "iifname") {
				t.Errorf("%s: %q iif %q", name, r.text, r.iif)
			}
		}
	}
}
