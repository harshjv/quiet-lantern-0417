//go:build linux

package netns

import (
	"net/netip"
	"regexp"
	"slices"
	"testing"

	"github.com/google/nftables"
	"github.com/google/nftables/expr"
	"golang.org/x/sys/unix"
)

var (
	testBaseline = Baseline{
		Resolver: netip.MustParseAddr("10.200.1.1"),
		Self:     netip.MustParseAddr("10.200.1.2"),
		Subnet:   netip.MustParsePrefix("10.200.1.0/24"),
	}
	testPool = netip.MustParsePrefix("10.200.0.0/16")
)

func testLive() liveSets {
	hosts := []netip.Prefix{
		netip.MustParsePrefix("10.200.1.1/32"),
		netip.MustParsePrefix("10.200.0.1/32"),
		netip.MustParsePrefix("203.0.113.7/32"),
		netip.MustParsePrefix("10.201.0.0/24"),
	}
	vip := netip.MustParseAddr("10.255.0.5")
	stopped := netip.MustParseAddr("10.255.0.9")
	return liveSets{
		hosts:   intervalElements(hosts),
		private: intervalElements(PrivateRanges),
		targets: map[netip.Addr]bool{vip: true},
		rejects: map[netip.Addr]bool{stopped: true},
		sw:      map[netip.Addr]netip.Addr{vip: netip.MustParseAddr("10.200.1.9")},
	}
}

func verdictFor(t *testing.T, b Baseline, addr string, proto uint8, port uint16) Verdict {
	t.Helper()
	rules := egressTable(b, namedSets())
	return evaluate(rules, b, testPool, testLive(), Packet{Addr: netip.MustParseAddr(addr), Proto: proto, Port: port})
}

func TestEvaluatorVerdictsPerPath(t *testing.T) {
	cases := []struct {
		name    string
		addr    string
		proto   uint8
		port    uint16
		verdict string
		path    string
	}{
		{"service reaches a virtual IP in its reach set", "10.255.0.5", unix.IPPROTO_TCP, 8080, VerdictAccept, PathSameEnvironment},
		{"service reaches an address in its environment subnet", "10.200.1.77", unix.IPPROTO_TCP, 5432, VerdictAccept, PathSameEnvironment},
		{"service reaches the resolver over udp", "10.200.1.1", unix.IPPROTO_UDP, 53, VerdictAccept, PathResolver},
		{"service reaches the resolver over tcp", "10.200.1.1", unix.IPPROTO_TCP, 53, VerdictAccept, PathResolver},
		{"query to a hardcoded public resolver is intercepted to the resolver", "8.8.8.8", unix.IPPROTO_UDP, 53, VerdictAccept, PathResolver},
		{"query to docker embedded dns is intercepted to the resolver", "127.0.0.11", unix.IPPROTO_UDP, 53, VerdictAccept, PathResolver},
		{"service reaches its own loopback", "127.0.0.1", unix.IPPROTO_TCP, 3000, VerdictAccept, PathLoopback},
		{"service reaches its own address through lo", "10.200.1.2", unix.IPPROTO_TCP, 3000, VerdictAccept, PathLoopback},
		{"host interface address is blocked", "203.0.113.7", unix.IPPROTO_TCP, 22, VerdictDrop, PathHostAddress},
		{"bridge gateway is blocked outside port 53", "10.200.1.1", unix.IPPROTO_TCP, 80, VerdictDrop, PathHostAddress},
		{"another bridge gateway is blocked", "10.200.0.1", unix.IPPROTO_TCP, 80, VerdictDrop, PathHostAddress},
		{"system subnet host address is blocked", "10.201.0.4", unix.IPPROTO_TCP, 7900, VerdictDrop, PathHostAddress},
		{"address inside the pool and outside the subnet is another environment", "10.200.2.5", unix.IPPROTO_TCP, 80, VerdictDrop, PathOtherEnv},
		{"cloud metadata is blocked", "169.254.169.254", unix.IPPROTO_TCP, 80, VerdictDrop, PathCloudMetadata},
		{"other private range is blocked", "192.168.1.10", unix.IPPROTO_TCP, 80, VerdictDrop, PathPrivateRange},
		{"carrier grade nat range is blocked", "100.64.1.1", unix.IPPROTO_TCP, 80, VerdictDrop, PathPrivateRange},
		{"multicast is blocked", "224.0.0.251", unix.IPPROTO_UDP, 5353, VerdictDrop, PathPrivateRange},
		{"public destination is allowed", "93.184.216.34", unix.IPPROTO_TCP, 443, VerdictAccept, PathPublicInternet},
		{"public udp destination is allowed", "1.1.1.1", unix.IPPROTO_UDP, 443, VerdictAccept, PathPublicInternet},
		{"stopped virtual IP is rejected over tcp", "10.255.0.9", unix.IPPROTO_TCP, 80, VerdictReject, PathNoSwitchTarget},
		{"stopped virtual IP is rejected over udp", "10.255.0.9", unix.IPPROTO_UDP, 9000, VerdictReject, PathNoSwitchTarget},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := verdictFor(t, testBaseline, c.addr, c.proto, c.port)
			if got.Verdict != c.verdict || got.Path != c.path {
				t.Fatalf("got %s via %s (%s), want %s via %s", got.Verdict, got.Path, got.Rule, c.verdict, c.path)
			}
		})
	}
}

func TestEvaluatorReportsTheRuleTextThatDecided(t *testing.T) {
	got := verdictFor(t, testBaseline, "169.254.169.254", unix.IPPROTO_TCP, 80)
	if got.Rule != "ip daddr @private_ranges drop" {
		t.Fatalf("rule %q", got.Rule)
	}
}

func TestEvaluatorHostDropBeatsEnvironmentSubnetAccept(t *testing.T) {
	live := testLive()
	live.hosts = intervalElements([]netip.Prefix{netip.MustParsePrefix("10.200.1.1/32")})
	rules := egressTable(testBaseline, namedSets())
	got := evaluate(rules, testBaseline, testPool, live, Packet{Addr: netip.MustParseAddr("10.200.1.1"), Proto: unix.IPPROTO_TCP, Port: 8080})
	if got.Verdict != VerdictDrop || got.Path != PathHostAddress {
		t.Fatalf("got %+v", got)
	}
}

func TestEvaluatorRejectBeatsHostDrop(t *testing.T) {
	live := testLive()
	vip := netip.MustParseAddr("10.255.0.9")
	live.hosts = intervalElements([]netip.Prefix{netip.MustParsePrefix("10.255.0.0/24")})
	got := evaluate(egressTable(testBaseline, namedSets()), testBaseline, testPool, live, Packet{Addr: vip, Proto: unix.IPPROTO_TCP, Port: 80})
	if got.Verdict != VerdictReject {
		t.Fatalf("got %+v", got)
	}
}

func TestEvaluatorWithoutSubnetDropsEnvironmentAddresses(t *testing.T) {
	b := testBaseline
	b.Subnet = netip.Prefix{}
	got := verdictFor(t, b, "10.200.1.77", unix.IPPROTO_TCP, 80)
	if got.Verdict != VerdictDrop || got.Path != PathOtherEnv {
		t.Fatalf("got %+v", got)
	}
}

func TestEvaluatorRegistryAllowListOpensOnlyThatSocket(t *testing.T) {
	b := testBaseline
	b.Allow = []netip.AddrPort{netip.MustParseAddrPort("10.202.0.2:5000")}
	allowed := verdictFor(t, b, "10.202.0.2", unix.IPPROTO_TCP, 5000)
	if allowed.Verdict != VerdictAccept || allowed.Path != PathRegistry {
		t.Fatalf("allowed socket: %+v", allowed)
	}
	other := verdictFor(t, b, "10.202.0.2", unix.IPPROTO_TCP, 5001)
	if other.Verdict != VerdictDrop {
		t.Fatalf("other port: %+v", other)
	}
}

func TestEvaluatorMapsIPv4MappedAddresses(t *testing.T) {
	got := verdictFor(t, testBaseline, "::ffff:93.184.216.34", unix.IPPROTO_TCP, 443)
	if got.Verdict != VerdictAccept || got.Path != PathPublicInternet {
		t.Fatalf("got %+v", got)
	}
}

func TestEvaluatorDropsNonIPv4ByPolicy(t *testing.T) {
	got := verdictFor(t, testBaseline, "2606:4700::1111", unix.IPPROTO_TCP, 443)
	if got.Verdict != VerdictDrop || got.Rule != "policy drop" {
		t.Fatalf("got %+v", got)
	}
}

func TestEvaluatorVirtualIPFollowsTheSwitchBeforeFiltering(t *testing.T) {
	live := testLive()
	live.sw[netip.MustParseAddr("10.255.0.5")] = netip.MustParseAddr("10.200.1.200")
	got := evaluate(egressTable(testBaseline, namedSets()), testBaseline, testPool, live, Packet{Addr: netip.MustParseAddr("10.255.0.5"), Proto: unix.IPPROTO_TCP, Port: 80})
	if got.Path != PathSameEnvironment || got.Verdict != VerdictAccept {
		t.Fatalf("got %+v", got)
	}
}

func TestEvaluatorSkipsEstablishedRule(t *testing.T) {
	rules := egressTable(testBaseline, namedSets())
	if rules[0].text != "ct state established,related accept" {
		t.Fatalf("first rule is %q", rules[0].text)
	}
	got := evaluate(rules[:1], testBaseline, testPool, testLive(), Packet{Addr: netip.MustParseAddr("8.8.8.8"), Proto: unix.IPPROTO_TCP, Port: 443})
	if got.Verdict != VerdictDrop || got.Rule != "policy drop" {
		t.Fatalf("established-only table must fall to policy drop, got %+v", got)
	}
}

func TestEgressTableOrderMatchesDocumentedChain(t *testing.T) {
	var texts []string
	for _, r := range egressTable(testBaseline, namedSets()) {
		texts = append(texts, r.text)
	}
	want := []string{
		"ct state established,related accept",
		`oifname "lo" accept`,
		"ip daddr 10.200.1.1 udp dport 53 accept",
		"ip daddr 10.200.1.1 tcp dport 53 accept",
		"ip daddr @switch_reject reject with tcp reset",
		"ip daddr @switch_reject reject with icmpx port-unreachable",
		"ip daddr @host_addrs drop",
		"ct original ip daddr @vip_targets accept",
		"ip daddr 10.200.1.0/24 accept",
		"ip daddr @private_ranges drop",
		"ip daddr != @private_ranges accept",
	}
	if !slices.Equal(texts, want) {
		t.Fatalf("got\n%q\nwant\n%q", texts, want)
	}
}

func TestEgressTablePathIDsAreTheDocumentedEgressOnes(t *testing.T) {
	documented := []string{PathSameEnvironment, PathResolver, PathLoopback, PathHostAddress, PathOtherEnv, PathCloudMetadata, PathPrivateRange, PathPublicInternet, PathNoSwitchTarget}
	allowed := append(slices.Clone(documented), "", PathRegistry)
	b := testBaseline
	b.Allow = []netip.AddrPort{netip.MustParseAddrPort("10.202.0.2:5000")}
	for _, r := range egressTable(b, namedSets()) {
		if !slices.Contains(allowed, r.path) {
			t.Errorf("rule %q carries undocumented path %q", r.text, r.path)
		}
	}
	for _, id := range []string{"inbound_domain", "inbound_tcp", "inbound_other"} {
		for _, r := range egressTable(b, namedSets()) {
			if r.path == id {
				t.Errorf("inbound path %s must not appear in an egress rule", id)
			}
		}
	}
}

func TestPathIDConstantsAreTheDocumentedStrings(t *testing.T) {
	want := map[string]string{
		PathSameEnvironment: "same_environment",
		PathResolver:        "resolver",
		PathLoopback:        "loopback",
		PathHostAddress:     "host_address",
		PathOtherEnv:        "other_environment",
		PathCloudMetadata:   "cloud_metadata",
		PathPrivateRange:    "private_range",
		PathPublicInternet:  "public_internet",
		PathNoSwitchTarget:  "no_switch_target",
	}
	for got, doc := range want {
		if got != doc {
			t.Errorf("%q != %q", got, doc)
		}
	}
}

func TestRulesThatDropOrRejectRefusedDestinationsAreRecorded(t *testing.T) {
	for _, r := range egressTable(testBaseline, namedSets()) {
		blocked := r.verdict != verdictAccept
		if blocked && r.path != "" && !r.record {
			t.Errorf("blocking rule %q is not recorded", r.text)
		}
		if !blocked && r.record {
			t.Errorf("accepting rule %q records a refusal", r.text)
		}
	}
}

func hasExpr[T expr.Any](list []expr.Any) bool {
	for _, e := range list {
		if _, ok := e.(T); ok {
			return true
		}
	}
	return false
}

func TestRecordingRulesPrecedeTheirVerdictAndShareTheirMatch(t *testing.T) {
	rules := egressTable(testBaseline, namedSets())
	exprs := egressExprs(rules, refusedSet())
	i := 0
	for _, r := range rules {
		if r.record {
			rec, verdictList := exprs[i], exprs[i+1]
			i += 2
			if !hasExpr[*expr.Dynset](rec) {
				t.Errorf("%q: first list does not update the refused set", r.text)
			}
			if hasExpr[*expr.Verdict](rec) || hasExpr[*expr.Reject](rec) {
				t.Errorf("%q: recording rule must not decide", r.text)
			}
			if hasExpr[*expr.Dynset](verdictList) {
				t.Errorf("%q: verdict rule must not record", r.text)
			}
			if !hasExpr[*expr.Verdict](verdictList) && !hasExpr[*expr.Reject](verdictList) {
				t.Errorf("%q: verdict rule has no verdict", r.text)
			}
			if len(r.match()) == 0 || !slices.EqualFunc(rec[:len(r.match())], verdictList[:len(r.match())], func(a, b expr.Any) bool { return typeName(a) == typeName(b) }) {
				t.Errorf("%q: recording and verdict rules differ in their match", r.text)
			}
			continue
		}
		if hasExpr[*expr.Dynset](exprs[i]) {
			t.Errorf("%q: non-recording rule updates the refused set", r.text)
		}
		i++
	}
	if i != len(exprs) {
		t.Fatalf("consumed %d of %d expression lists", i, len(exprs))
	}
}

func typeName(e expr.Any) string {
	switch e.(type) {
	case *expr.Meta:
		return "meta"
	case *expr.Cmp:
		return "cmp"
	case *expr.Payload:
		return "payload"
	case *expr.Lookup:
		return "lookup"
	case *expr.Ct:
		return "ct"
	case *expr.Bitwise:
		return "bitwise"
	}
	return "other"
}

func TestRecordKeyIsDestinationProtocolAndPort(t *testing.T) {
	list := recordRefused(refusedSet())
	if len(list) != 4 {
		t.Fatalf("got %d expressions", len(list))
	}
	p := list[0].(*expr.Payload)
	if p.Offset != 16 || p.Len != 4 || p.Base != expr.PayloadBaseNetworkHeader {
		t.Errorf("address load: %+v", p)
	}
	m := list[1].(*expr.Meta)
	if m.Key != expr.MetaKeyL4PROTO || m.Register != 9 {
		t.Errorf("protocol load: %+v", m)
	}
	port := list[2].(*expr.Payload)
	if port.Offset != 2 || port.Len != 2 || port.DestRegister != 10 || port.Base != expr.PayloadBaseTransportHeader {
		t.Errorf("port load: %+v", port)
	}
	d := list[3].(*expr.Dynset)
	if d.Operation != unix.NFT_DYNSET_OP_UPDATE || d.SetName != "refused" {
		t.Errorf("dynset: %+v", d)
	}
}

var setRef = regexp.MustCompile(`@([a-z_]+)`)

func TestRuleExpressionsReferenceTheSetsNamedInTheirText(t *testing.T) {
	for _, r := range egressTable(testBaseline, namedSets()) {
		var want []string
		for _, m := range setRef.FindAllStringSubmatch(r.text, -1) {
			want = append(want, m[1])
		}
		var got []string
		for _, e := range r.match() {
			if l, ok := e.(*expr.Lookup); ok {
				got = append(got, l.SetName)
			}
		}
		if !slices.Equal(got, want) {
			t.Errorf("%q: expressions look up %v", r.text, got)
		}
	}
}

func TestNegatedSetRuleInvertsTheLookup(t *testing.T) {
	var found bool
	for _, r := range egressTable(testBaseline, namedSets()) {
		if r.text != "ip daddr != @private_ranges accept" {
			continue
		}
		found = true
		for _, e := range r.match() {
			if l, ok := e.(*expr.Lookup); ok && !l.Invert {
				t.Error("negated lookup is not inverted")
			}
		}
	}
	if !found {
		t.Fatal("rule missing")
	}
}

func TestCtOriginalRuleReadsTheOriginalDestination(t *testing.T) {
	for _, r := range egressTable(testBaseline, namedSets()) {
		if r.text != "ct original ip daddr @vip_targets accept" {
			continue
		}
		for _, e := range r.match() {
			if c, ok := e.(*expr.Ct); ok {
				if c.Key != expr.CtKeyDSTIP || c.Direction != 0 {
					t.Fatalf("ct: %+v", c)
				}
				return
			}
		}
		t.Fatal("no ct expression")
	}
	t.Fatal("rule missing")
}

func TestResolverRulesMatchProtocolPortAndAddress(t *testing.T) {
	for _, proto := range []uint8{unix.IPPROTO_UDP, unix.IPPROTO_TCP} {
		var found bool
		for _, r := range egressTable(testBaseline, namedSets()) {
			if r.path != PathResolver || r.terms[1].proto != proto {
				continue
			}
			found = true
			var cmps [][]byte
			for _, e := range r.match() {
				if c, ok := e.(*expr.Cmp); ok {
					cmps = append(cmps, c.Data)
				}
			}
			want := [][]byte{{unix.NFPROTO_IPV4}, {proto}, {0, 53}, testBaseline.Resolver.AsSlice()}
			if !slices.EqualFunc(cmps, want, slices.Equal[[]byte]) {
				t.Errorf("proto %d: compares %v, want %v", proto, cmps, want)
			}
		}
		if !found {
			t.Errorf("no resolver rule for protocol %d", proto)
		}
	}
}

func TestEveryEgressRuleHasAMatchAndVerdict(t *testing.T) {
	for _, r := range egressTable(testBaseline, namedSets()) {
		if len(r.match()) == 0 || len(r.verdictExprs()) == 0 {
			t.Errorf("%q has an empty match or verdict", r.text)
		}
	}
}

func TestBlockingRulesCountBeforeTheyDecide(t *testing.T) {
	for _, r := range egressTable(testBaseline, namedSets()) {
		if !r.counter {
			continue
		}
		if _, ok := r.verdictExprs()[0].(*expr.Counter); !ok {
			t.Errorf("%q: counter is not first in the verdict list", r.text)
		}
	}
}

func TestVerdictExpressionsPerKind(t *testing.T) {
	drop := egressRule{verdict: verdictDrop}.verdictExprs()
	if v := drop[0].(*expr.Verdict); v.Kind != expr.VerdictDrop {
		t.Errorf("drop: %+v", v)
	}
	accept := egressRule{verdict: verdictAccept}.verdictExprs()
	if v := accept[0].(*expr.Verdict); v.Kind != expr.VerdictAccept {
		t.Errorf("accept: %+v", v)
	}
	tcp := egressRule{verdict: verdictRejectTCP}.verdictExprs()
	if r := tcp[0].(*expr.Reject); r.Type != unix.NFT_REJECT_TCP_RST {
		t.Errorf("tcp reset: %+v", r)
	}
	icmp := egressRule{verdict: verdictRejectICMPX}.verdictExprs()
	if r := icmp[0].(*expr.Reject); r.Type != unix.NFT_REJECT_ICMPX_UNREACH || r.Code != unix.NFT_REJECT_ICMPX_PORT_UNREACH {
		t.Errorf("icmpx: %+v", r)
	}
}

func TestRefusedSetSizeAndTimeoutAreExplicit(t *testing.T) {
	s := refusedSet()
	if s.Size != 256 || RefusedSize != 256 {
		t.Errorf("size %d", s.Size)
	}
	if !s.HasTimeout || s.Timeout != RefusedTimeout || RefusedTimeout.Minutes() != 10 {
		t.Errorf("timeout %v", s.Timeout)
	}
	if !s.Dynamic || !s.Counter || !s.Concatenation {
		t.Errorf("flags: %+v", s)
	}
}

func TestNamedSetsUseTheDocumentedNamesAndTypes(t *testing.T) {
	cases := []struct {
		set      *nftables.Set
		name     string
		interval bool
	}{
		{hostAddrsSet(), "host_addrs", true},
		{privateRangesSet(), "private_ranges", true},
		{vipTargetsSet(), "vip_targets", false},
		{switchRejectSet(), "switch_reject", false},
	}
	for _, c := range cases {
		if c.set.Name != c.name || c.set.Interval != c.interval || c.set.KeyType != nftables.TypeIPAddr {
			t.Errorf("%s: %+v", c.name, c.set)
		}
	}
	m := switchMap()
	if !m.IsMap || m.Name != "switch" || m.KeyType != nftables.TypeIPAddr || m.DataType != nftables.TypeIPAddr {
		t.Errorf("switch: %+v", m)
	}
}

func TestPrivateRangesAreTheDocumentedNine(t *testing.T) {
	want := []string{"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "224.0.0.0/4", "240.0.0.0/4"}
	var got []string
	for _, p := range PrivateRanges {
		got = append(got, p.String())
	}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v", got)
	}
}

func TestMaskBuildsPrefixMasks(t *testing.T) {
	cases := map[string][]byte{
		"10.0.0.0/8":     {255, 0, 0, 0},
		"100.64.0.0/10":  {255, 192, 0, 0},
		"172.16.0.0/12":  {255, 240, 0, 0},
		"10.200.1.0/24":  {255, 255, 255, 0},
		"1.2.3.4/32":     {255, 255, 255, 255},
		"0.0.0.0/0":      {0, 0, 0, 0},
		"192.168.0.0/17": {255, 255, 128, 0},
	}
	for p, want := range cases {
		if got := mask(netip.MustParsePrefix(p)); !slices.Equal(got, want) {
			t.Errorf("%s: %v", p, got)
		}
	}
}

func TestSubnetRuleComparesTheMaskedNetwork(t *testing.T) {
	b := testBaseline
	b.Subnet = netip.MustParsePrefix("10.200.1.77/24")
	for _, r := range egressTable(b, namedSets()) {
		if r.text != "ip daddr 10.200.1.0/24 accept" {
			continue
		}
		var last *expr.Cmp
		for _, e := range r.match() {
			if c, ok := e.(*expr.Cmp); ok {
				last = c
			}
		}
		if !slices.Equal(last.Data, []byte{10, 200, 1, 0}) {
			t.Fatalf("compares %v", last.Data)
		}
		return
	}
	t.Fatal("subnet rule missing")
}

func TestIntervalElementsMergeOverlapsAndAdjacency(t *testing.T) {
	els := intervalElements([]netip.Prefix{
		netip.MustParsePrefix("10.0.0.0/25"),
		netip.MustParsePrefix("10.0.0.128/25"),
		netip.MustParsePrefix("10.0.0.0/24"),
		netip.MustParsePrefix("192.168.0.0/16"),
	})
	want := []nftables.SetElement{
		{Key: []byte{0, 0, 0, 0}, IntervalEnd: true},
		{Key: []byte{10, 0, 0, 0}},
		{Key: []byte{10, 0, 1, 0}, IntervalEnd: true},
		{Key: []byte{192, 168, 0, 0}},
		{Key: []byte{192, 169, 0, 0}, IntervalEnd: true},
	}
	if len(els) != len(want) {
		t.Fatalf("got %d elements: %+v", len(els), els)
	}
	for i := range want {
		if !slices.Equal(els[i].Key, want[i].Key) || els[i].IntervalEnd != want[i].IntervalEnd {
			t.Errorf("element %d: %+v want %+v", i, els[i], want[i])
		}
	}
}

func TestIntervalElementsOmitTrailingEndAtTheTopOfTheSpace(t *testing.T) {
	els := intervalElements([]netip.Prefix{netip.MustParsePrefix("240.0.0.0/4")})
	last := els[len(els)-1]
	if last.IntervalEnd {
		t.Fatalf("an interval ending at 255.255.255.255 needs no end element: %+v", els)
	}
}

func TestIntervalElementsIgnoreIPv6AndEmptyInput(t *testing.T) {
	if got := intervalElements([]netip.Prefix{netip.MustParsePrefix("fd00::/8")}); len(got) != 0 {
		t.Fatalf("got %+v", got)
	}
	if got := intervalElements(nil); len(got) != 0 {
		t.Fatalf("got %+v", got)
	}
}

func TestSameIntervalsIgnoresOrder(t *testing.T) {
	a := intervalElements([]netip.Prefix{netip.MustParsePrefix("10.0.0.0/8"), netip.MustParsePrefix("192.168.0.0/16")})
	b := slices.Clone(a)
	slices.Reverse(b)
	if !sameIntervals(a, b) {
		t.Error("same set in another order must compare equal")
	}
	c := intervalElements([]netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")})
	if sameIntervals(a, c) {
		t.Error("different sets must differ")
	}
}

func TestInIntervalsMembership(t *testing.T) {
	els := intervalElements([]netip.Prefix{netip.MustParsePrefix("10.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10")})
	in := []string{"10.0.0.0", "10.255.255.255", "100.64.0.1", "100.127.255.255"}
	out := []string{"9.255.255.255", "11.0.0.0", "100.128.0.0", "0.0.0.0", "255.255.255.255"}
	for _, a := range in {
		if !inIntervals(els, netip.MustParseAddr(a)) {
			t.Errorf("%s should be inside", a)
		}
	}
	for _, a := range out {
		if inIntervals(els, netip.MustParseAddr(a)) {
			t.Errorf("%s should be outside", a)
		}
	}
}

func TestBaselineFingerprintChangesWithEveryField(t *testing.T) {
	base := testBaseline
	seen := map[string]string{base.fingerprint(): "base"}
	variants := map[string]Baseline{
		"resolver": {Resolver: netip.MustParseAddr("10.200.1.3"), Self: base.Self, Subnet: base.Subnet},
		"self":     {Resolver: base.Resolver, Self: netip.MustParseAddr("10.200.1.4"), Subnet: base.Subnet},
		"subnet":   {Resolver: base.Resolver, Self: base.Self, Subnet: netip.MustParsePrefix("10.200.2.0/24")},
		"allow":    {Resolver: base.Resolver, Self: base.Self, Subnet: base.Subnet, Allow: []netip.AddrPort{netip.MustParseAddrPort("10.202.0.2:5000")}},
	}
	for name, v := range variants {
		fp := v.fingerprint()
		if prev, dup := seen[fp]; dup {
			t.Errorf("%s collides with %s", name, prev)
		}
		seen[fp] = name
	}
}

func TestBaselineFingerprintIgnoresSubnetHostBits(t *testing.T) {
	a, b := testBaseline, testBaseline
	b.Subnet = netip.MustParsePrefix("10.200.1.99/24")
	if a.fingerprint() != b.fingerprint() {
		t.Fatal("host bits changed the fingerprint")
	}
}

func TestResolveKeepsPendingSwitchEntriesAndDropsRejected(t *testing.T) {
	vipA := netip.MustParseAddr("10.255.0.1")
	vipB := netip.MustParseAddr("10.255.0.2")
	vipC := netip.MustParseAddr("10.255.0.3")
	e := Elements{
		Switch:  map[netip.Addr]netip.Addr{vipA: netip.MustParseAddr("10.200.1.10")},
		Pending: []netip.Addr{vipB, vipC},
		Reject:  []netip.Addr{vipC},
	}
	have := map[netip.Addr]netip.Addr{
		vipA: netip.MustParseAddr("10.200.1.99"),
		vipB: netip.MustParseAddr("10.200.1.11"),
		vipC: netip.MustParseAddr("10.200.1.12"),
	}
	got := resolve(e, have)
	if len(got) != 2 || got[vipA] != netip.MustParseAddr("10.200.1.10") || got[vipB] != netip.MustParseAddr("10.200.1.11") {
		t.Fatalf("got %v", got)
	}
}

func TestHostFingerprintChangesWithEveryField(t *testing.T) {
	base := HostLayout{
		Public:        netip.MustParseAddr("203.0.113.7"),
		IngressBridge: "br-ingress",
		VirtualPrefix: netip.MustParsePrefix("10.255.0.0/16"),
		Translated:    []netip.Prefix{netip.MustParsePrefix("10.200.0.0/16")},
		EnvBridges:    []string{"br-a"},
	}
	variants := map[string]func(HostLayout) HostLayout{
		"public":  func(l HostLayout) HostLayout { l.Public = netip.MustParseAddr("203.0.113.8"); return l },
		"ingress": func(l HostLayout) HostLayout { l.IngressBridge = "br-other"; return l },
		"virtual": func(l HostLayout) HostLayout { l.VirtualPrefix = netip.MustParsePrefix("10.254.0.0/16"); return l },
		"web":     func(l HostLayout) HostLayout { l.WebOpen = true; return l },
		"rate":    func(l HostLayout) HostLayout { l.SourceRate = 5; return l },
		"bridges": func(l HostLayout) HostLayout { l.EnvBridges = []string{"br-a", "br-b"}; return l },
		"nets":    func(l HostLayout) HostLayout { l.Translated = nil; return l },
	}
	seen := map[string]string{base.fingerprint(): "base"}
	for name, f := range variants {
		fp := f(base).fingerprint()
		if prev, dup := seen[fp]; dup {
			t.Errorf("%s collides with %s", name, prev)
		}
		seen[fp] = name
	}
}

func TestPortElementsAreSortedAndEncodeAddressAndPort(t *testing.T) {
	els := portElements(map[uint16]netip.AddrPort{
		8080: netip.MustParseAddrPort("10.200.1.5:3000"),
		80:   netip.MustParseAddrPort("10.200.1.6:8080"),
	})
	if len(els) != 2 {
		t.Fatalf("got %d", len(els))
	}
	if !slices.Equal(els[0].Key, []byte{0, 80}) || !slices.Equal(els[1].Key, []byte{0x1f, 0x90}) {
		t.Fatalf("keys %v %v", els[0].Key, els[1].Key)
	}
	if !slices.Equal(els[0].Val, []byte{10, 200, 1, 6, 0x1f, 0x90, 0, 0}) {
		t.Fatalf("value %v", els[0].Val)
	}
}

func TestPrivatePathClassification(t *testing.T) {
	cases := map[string]string{
		"10.200.9.9":      PathOtherEnv,
		"169.254.169.254": PathCloudMetadata,
		"169.254.1.1":     PathPrivateRange,
		"10.1.1.1":        PathPrivateRange,
		"192.168.0.1":     PathPrivateRange,
	}
	for a, want := range cases {
		if got := privatePath(testPool, netip.MustParseAddr(a)); got != want {
			t.Errorf("%s: %s want %s", a, got, want)
		}
	}
	if got := privatePath(netip.Prefix{}, netip.MustParseAddr("10.200.9.9")); got != PathPrivateRange {
		t.Errorf("without a pool: %s", got)
	}
}
