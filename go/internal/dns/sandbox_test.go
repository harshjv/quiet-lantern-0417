package dns

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"slices"
	"strings"
	"testing"
	"time"

	mdns "github.com/miekg/dns"
)

func TestParseDomainsNormalizesAndDefaults(t *testing.T) {
	got, err := ParseDomains([]AllowDomain{
		{Domain: "GitHub.com."},
		{Domain: "githubusercontent.com", Wildcard: true, Ports: []uint16{22, 443, 22}},
		{Domain: "a-b.example.co"},
		{Domain: "xn--bcher-kva.example"},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []AllowDomain{
		{Domain: "github.com", Ports: []uint16{443}},
		{Domain: "githubusercontent.com", Wildcard: true, Ports: []uint16{22, 443}},
		{Domain: "a-b.example.co", Ports: []uint16{443}},
		{Domain: "xn--bcher-kva.example", Ports: []uint16{443}},
	}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i := range want {
		if got[i].Domain != want[i].Domain || got[i].Wildcard != want[i].Wildcard || !slices.Equal(got[i].Ports, want[i].Ports) {
			t.Errorf("%d: got %+v want %+v", i, got[i], want[i])
		}
	}
}

func TestParseDomainsRejectsMalformedNames(t *testing.T) {
	long := strings.Repeat("a", 64) + ".com"
	total := strings.Repeat(strings.Repeat("a", 63)+".", 4) + "com"
	for _, name := range []string{"", ".", "com", "-a.com", "a-.com", "a..com", "a_b.com", "*.example.com", "exa mple.com", "ünicode.com", long, total, "1.2.3.4:443"} {
		_, err := ParseDomains([]AllowDomain{{Domain: "ok.com"}, {Domain: name}})
		var de *DomainError
		if !errors.As(err, &de) || de.Index != 1 {
			t.Errorf("%q: %v", name, err)
		}
	}
}

func TestParseDomainsAcceptsTheLongestValidName(t *testing.T) {
	name := strings.Repeat(strings.Repeat("a", 62)+".", 3) + strings.Repeat("b", 62) + ".c"
	if len(name) != 253 {
		t.Fatalf("len %d", len(name))
	}
	if _, err := ParseDomains([]AllowDomain{{Domain: name}}); err != nil {
		t.Fatal(err)
	}
}

func TestParseDomainsRejectsPortZero(t *testing.T) {
	if _, err := ParseDomains([]AllowDomain{{Domain: "a.com", Ports: []uint16{0}}}); err == nil {
		t.Fatal("accepted port 0")
	}
}

func TestParseDomainsLimitsEntries(t *testing.T) {
	in := make([]AllowDomain, MaxAllowDomains)
	for i := range in {
		in[i] = AllowDomain{Domain: fmt.Sprintf("d%d.example", i)}
	}
	if _, err := ParseDomains(in); err != nil {
		t.Fatalf("256 entries: %v", err)
	}
	_, err := ParseDomains(append(in, AllowDomain{Domain: "one-more.example"}))
	var de *DomainError
	if !errors.As(err, &de) || de.Index != MaxAllowDomains {
		t.Fatalf("257 entries: %v", err)
	}
}

func TestParseDomainsLimitsDistinctPorts(t *testing.T) {
	in := []AllowDomain{
		{Domain: "a.com", Ports: []uint16{1, 2, 3, 4}},
		{Domain: "b.com", Ports: []uint16{3, 4, 5, 6, 7, 8}},
		{Domain: "c.com", Ports: []uint16{8, 1}},
	}
	if _, err := ParseDomains(in); err != nil {
		t.Fatalf("8 ports: %v", err)
	}
	_, err := ParseDomains(append(in, AllowDomain{Domain: "d.com"}))
	var de *DomainError
	if !errors.As(err, &de) || de.Index != 3 {
		t.Fatalf("9 ports: %v", err)
	}
}

func TestMatchExactAndWildcard(t *testing.T) {
	domains := []AllowDomain{
		{Domain: "github.com", Ports: []uint16{443, 22}},
		{Domain: "githubusercontent.com", Wildcard: true, Ports: []uint16{443}},
	}
	cases := []struct {
		name string
		want string
		ok   bool
	}{
		{"github.com", "github.com", true},
		{"GitHub.com.", "github.com", true},
		{"api.github.com", "", false},
		{"evilgithub.com", "", false},
		{"githubusercontent.com", "githubusercontent.com", true},
		{"raw.githubusercontent.com", "githubusercontent.com", true},
		{"a.b.c.githubusercontent.com", "githubusercontent.com", true},
		{"a.b.c.d.githubusercontent.com", "", false},
		{"evilgithubusercontent.com", "", false},
		{"githubusercontent.com.evil.com", "", false},
	}
	for _, c := range cases {
		d, ok := Match(domains, c.name)
		if ok != c.ok || d.Domain != c.want {
			t.Errorf("%s: got %q %v", c.name, d.Domain, ok)
		}
	}
}

func TestAllowTimeoutFloorsAndCaps(t *testing.T) {
	for ttl, want := range map[uint32]time.Duration{0: 300 * time.Second, 60: 300 * time.Second, 300: 300 * time.Second, 2810: 2810 * time.Second, 3600: time.Hour, 86400: time.Hour} {
		if got := AllowTimeout(ttl); got != want {
			t.Errorf("%d: %v", ttl, got)
		}
	}
}

var (
	ghA = netip.MustParseAddr("140.82.121.4")
	ghB = netip.MustParseAddr("140.82.121.3")
	exA = netip.MustParseAddr("93.184.216.34")
)

func TestMirrorReturnsNewAddressesPerPort(t *testing.T) {
	m := NewAllowMirror()
	now := time.Unix(1_000_000, 0)
	got := m.Observe(AllowAnswer{Name: "github.com", Addrs: []netip.Addr{ghA, ghB}, TTL: 60, Ports: []uint16{443, 22}}, now)
	for _, p := range []uint16{443, 22} {
		if len(got[p]) != 2 || got[p][0].Addr != ghB || got[p][1].Addr != ghA || got[p][0].Timeout != 300*time.Second || got[p][0].Replace {
			t.Errorf("port %d: %+v", p, got[p])
		}
	}
}

func TestMirrorRefreshesOnlyWhenLessThanHalfIsLeft(t *testing.T) {
	m := NewAllowMirror()
	now := time.Unix(1_000_000, 0)
	a := AllowAnswer{Name: "github.com", Addrs: []netip.Addr{ghA}, TTL: 60, Ports: []uint16{443}}
	m.Observe(a, now)
	if got := m.Observe(a, now.Add(149*time.Second)); len(got) != 0 {
		t.Fatalf("refreshed with more than half left: %+v", got)
	}
	got := m.Observe(a, now.Add(151*time.Second))
	if len(got[443]) != 1 || !got[443][0].Replace || got[443][0].Timeout != 300*time.Second {
		t.Fatalf("no refresh: %+v", got)
	}
	if got := m.Observe(a, now.Add(152*time.Second)); len(got) != 0 {
		t.Fatalf("refreshed twice: %+v", got)
	}
	els := m.Elements(now.Add(200 * time.Second))
	if len(els[443]) != 1 || els[443][0].Timeout != 251*time.Second {
		t.Fatalf("elements %+v", els)
	}
}

func TestMirrorReAddsAnExpiredElementWithoutDelete(t *testing.T) {
	m := NewAllowMirror()
	now := time.Unix(1_000_000, 0)
	a := AllowAnswer{Name: "github.com", Addrs: []netip.Addr{ghA}, TTL: 60, Ports: []uint16{443}}
	m.Observe(a, now)
	got := m.Observe(a, now.Add(301*time.Second))
	if len(got[443]) != 1 || got[443][0].Replace {
		t.Fatalf("got %+v", got)
	}
}

func TestMirrorElementsDropExpired(t *testing.T) {
	m := NewAllowMirror()
	now := time.Unix(1_000_000, 0)
	m.Observe(AllowAnswer{Name: "github.com", Addrs: []netip.Addr{ghA}, TTL: 60, Ports: []uint16{443}}, now)
	m.Observe(AllowAnswer{Name: "example.com", Addrs: []netip.Addr{exA}, TTL: 3000, Ports: []uint16{443}}, now)
	els := m.Elements(now.Add(301 * time.Second))
	if len(els[443]) != 1 || els[443][0].Addr != exA {
		t.Fatalf("elements %+v", els)
	}
}

func TestMirrorRetainRemovesPerPortAndListsAddressesThatLeftEverySet(t *testing.T) {
	m := NewAllowMirror()
	now := time.Unix(1_000_000, 0)
	m.Observe(AllowAnswer{Name: "github.com", Addrs: []netip.Addr{ghA, ghB}, TTL: 60, Ports: []uint16{22, 443}}, now)
	m.Observe(AllowAnswer{Name: "example.com", Addrs: []netip.Addr{exA}, TTL: 60, Ports: []uint16{443}}, now)
	remove, gone := m.Retain([]AllowDomain{{Domain: "github.com", Ports: []uint16{443}}}, now.Add(time.Second))
	if !slices.Equal(remove[22], []netip.Addr{ghB, ghA}) || !slices.Equal(remove[443], []netip.Addr{exA}) || len(remove) != 2 {
		t.Fatalf("remove %v", remove)
	}
	if !slices.Equal(gone, []netip.Addr{exA}) {
		t.Fatalf("gone %v", gone)
	}
	els := m.Elements(now.Add(time.Second))
	if len(els) != 1 || len(els[443]) != 2 {
		t.Fatalf("elements %+v", els)
	}
	remove, gone = m.Retain(nil, now.Add(2*time.Second))
	if !slices.Equal(remove[443], []netip.Addr{ghB, ghA}) || !slices.Equal(gone, []netip.Addr{ghB, ghA}) {
		t.Fatalf("remove %v gone %v", remove, gone)
	}
	if els := m.Elements(now.Add(2 * time.Second)); len(els) != 0 {
		t.Fatalf("elements %+v", els)
	}
}

func TestMirrorRetainKeepsAnAddressAnotherListedNameAccountsFor(t *testing.T) {
	m := NewAllowMirror()
	now := time.Unix(1_000_000, 0)
	shared := netip.MustParseAddr("104.20.23.154")
	m.Observe(AllowAnswer{Name: "a.example", Addrs: []netip.Addr{shared}, TTL: 60, Ports: []uint16{443}}, now)
	m.Observe(AllowAnswer{Name: "b.example", Addrs: []netip.Addr{shared}, TTL: 60, Ports: []uint16{443}}, now)
	remove, gone := m.Retain([]AllowDomain{{Domain: "b.example", Ports: []uint16{443}}}, now)
	if len(remove) != 0 || len(gone) != 0 {
		t.Fatalf("remove %v gone %v", remove, gone)
	}
}

func TestMirrorRetainDropsExpiredWithoutReportingThem(t *testing.T) {
	m := NewAllowMirror()
	now := time.Unix(1_000_000, 0)
	m.Observe(AllowAnswer{Name: "github.com", Addrs: []netip.Addr{ghA}, TTL: 60, Ports: []uint16{443}}, now)
	remove, gone := m.Retain(nil, now.Add(301*time.Second))
	if len(remove) != 0 || len(gone) != 0 {
		t.Fatalf("remove %v gone %v", remove, gone)
	}
}

type orderWriter struct {
	fakeWriter
	events *[]string
}

func (o *orderWriter) WriteMsg(m *mdns.Msg) error {
	*o.events = append(*o.events, "write")
	return o.fakeWriter.WriteMsg(m)
}

const (
	joinedSandbox   = "10.200.1.50:41000"
	isolatedSandbox = "10.201.0.2:41000"
)

var (
	joinedAddr   = netip.MustParseAddr("10.200.1.50")
	isolatedAddr = netip.MustParseAddr("10.201.0.2")
	hostAddr     = netip.MustParseAddr("203.0.113.7")
)

func sandboxUpstream(req *mdns.Msg) *mdns.Msg {
	m := new(mdns.Msg)
	m.SetReply(req)
	q := req.Question[0]
	a := func(name string, ip net.IP, ttl uint32) mdns.RR {
		return &mdns.A{Hdr: mdns.RR_Header{Name: name, Rrtype: mdns.TypeA, Class: mdns.ClassINET, Ttl: ttl}, A: ip}
	}
	switch strings.ToLower(q.Name) {
	case "github.com.":
		m.Answer = []mdns.RR{a(q.Name, net.IPv4(140, 82, 121, 4), 120), a(q.Name, net.IPv4(140, 82, 121, 3), 60)}
		m.Extra = []mdns.RR{a("ns.github.com.", net.IPv4(10, 0, 0, 1), 60)}
	case "raw.githubusercontent.com.":
		m.Answer = []mdns.RR{
			&mdns.CNAME{Hdr: mdns.RR_Header{Name: q.Name, Rrtype: mdns.TypeCNAME, Class: mdns.ClassINET, Ttl: 300}, Target: "cdn.fastly.net."},
			&mdns.TXT{Hdr: mdns.RR_Header{Name: q.Name, Rrtype: mdns.TypeTXT, Class: mdns.ClassINET, Ttl: 300}, Txt: []string{"x"}},
			a("cdn.fastly.net.", net.IPv4(185, 199, 108, 133), 2810),
		}
	case "rebind.example.com.":
		m.Answer = []mdns.RR{a(q.Name, net.IPv4(93, 184, 216, 34), 60), a(q.Name, net.IPv4(10, 1, 2, 3), 60)}
	case "host.example.com.":
		m.Answer = []mdns.RR{a(q.Name, net.IPv4(203, 0, 113, 7), 60)}
	default:
		return publicAnswer(req)
	}
	return m
}

func sandboxResolver(t *testing.T) (*Resolver, *upstreamServer, *[]string, *[]AllowAnswer) {
	t.Helper()
	up := startUpstream(t, sandboxUpstream)
	r := testResolver(t, up.addr)
	domains, err := ParseDomains([]AllowDomain{
		{Domain: "github.com", Ports: []uint16{443, 22}},
		{Domain: "githubusercontent.com", Wildcard: true},
		{Domain: "rebind.example.com"},
		{Domain: "host.example.com"},
	})
	if err != nil {
		t.Fatal(err)
	}
	r.SetSandboxes(map[netip.Addr]SandboxPolicy{
		joinedAddr:   {Joined: true, Allowlist: true, Domains: domains, Blocked: []netip.Prefix{netip.PrefixFrom(hostAddr, 32)}},
		isolatedAddr: {},
	})
	events := &[]string{}
	answers := &[]AllowAnswer{}
	r.OnAllow(func(a AllowAnswer) {
		*events = append(*events, "allow")
		*answers = append(*answers, a)
	})
	return r, up, events, answers
}

func askSandbox(r *Resolver, events *[]string, from, name string, qtype uint16) *mdns.Msg {
	w := &orderWriter{fakeWriter: fakeWriter{local: udpAddr("10.200.1.1:53"), remote: udpAddr(from)}, events: events}
	req := new(mdns.Msg)
	req.SetQuestion(name, qtype)
	r.ServeDNS(w, req)
	return w.sent
}

func TestUnlistedNamesAreNXDOMAINAndNeverForwarded(t *testing.T) {
	r, up, events, _ := sandboxResolver(t)
	for _, name := range []string{"www.google.com.", "exfil-c2VjcmV0.attacker.example.", "evilgithub.com.", "a.b.c.d.githubusercontent.com.", "api.github.com."} {
		if m := askSandbox(r, events, joinedSandbox, name, mdns.TypeA); m.Rcode != mdns.RcodeNameError || len(m.Answer) != 0 {
			t.Errorf("%s: %v", name, m)
		}
	}
	if got := up.seen(); len(got) != 0 {
		t.Fatalf("upstream saw %v", got)
	}
	got := r.Queries(joinedAddr)
	if len(got) != 5 {
		t.Fatalf("ring %+v", got)
	}
	for _, q := range got {
		if q.Refused != RefusedDomainNotAllowed || q.Upstream || q.Rcode != "NXDOMAIN" {
			t.Errorf("ring entry %+v", q)
		}
	}
	if slices.Contains(*events, "allow") {
		t.Fatalf("allowed %v", *events)
	}
}

func TestListedNameIsAllowedBeforeTheReplyIsWritten(t *testing.T) {
	r, up, events, answers := sandboxResolver(t)
	m := askSandbox(r, events, joinedSandbox, "GitHub.com.", mdns.TypeA)
	if m.Rcode != mdns.RcodeSuccess || len(m.Answer) != 2 || len(m.Extra) != 0 {
		t.Fatalf("got %v", m)
	}
	if !slices.Equal(*events, []string{"allow", "write"}) {
		t.Fatalf("order %v", *events)
	}
	a := (*answers)[0]
	if a.Source != joinedAddr || a.Name != "github.com" || a.TTL != 60 || !slices.Equal(a.Ports, []uint16{22, 443}) || !slices.Equal(a.Addrs, []netip.Addr{ghA, ghB}) {
		t.Fatalf("allow %+v", a)
	}
	if got := up.seen(); len(got) != 1 {
		t.Fatalf("upstream saw %v", got)
	}
	if q := r.Queries(joinedAddr)[0]; q.Refused != "" || !q.Upstream || len(q.Answers) != 2 {
		t.Fatalf("ring %+v", q)
	}
}

func TestWildcardAnswerKeepsOnlyCNAMEAndARecords(t *testing.T) {
	r, _, events, answers := sandboxResolver(t)
	m := askSandbox(r, events, joinedSandbox, "raw.githubusercontent.com.", mdns.TypeA)
	if m.Rcode != mdns.RcodeSuccess || len(m.Answer) != 2 {
		t.Fatalf("got %v", m)
	}
	if _, ok := m.Answer[0].(*mdns.CNAME); !ok {
		t.Fatalf("first %v", m.Answer[0])
	}
	a := (*answers)[0]
	if a.TTL != 2810 || !slices.Equal(a.Ports, []uint16{443}) || a.Addrs[0] != netip.MustParseAddr("185.199.108.133") {
		t.Fatalf("allow %+v", a)
	}
}

func TestAnswerInPrivateOrHostSpaceIsRefusedAsRebind(t *testing.T) {
	r, up, events, answers := sandboxResolver(t)
	for _, name := range []string{"rebind.example.com.", "host.example.com."} {
		m := askSandbox(r, events, joinedSandbox, name, mdns.TypeA)
		if m.Rcode != mdns.RcodeNameError || len(m.Answer) != 0 {
			t.Errorf("%s: %v", name, m)
		}
	}
	if len(*answers) != 0 {
		t.Fatalf("allowed %+v", *answers)
	}
	if got := up.seen(); len(got) != 2 {
		t.Fatalf("upstream saw %v", got)
	}
	for _, q := range r.Queries(joinedAddr) {
		if q.Refused != RefusedRebind || !q.Upstream || len(q.Answers) != 0 {
			t.Errorf("ring %+v", q)
		}
	}
}

func TestRebindChecksTheNetnsPrivateRanges(t *testing.T) {
	for _, s := range []string{"0.1.2.3", "10.9.9.9", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "224.0.0.1", "255.255.255.255"} {
		if !rebind(netip.MustParseAddr(s), nil) {
			t.Errorf("%s allowed", s)
		}
	}
	for _, s := range []string{"1.1.1.1", "100.128.0.1", "172.32.0.1", "93.184.216.34"} {
		if rebind(netip.MustParseAddr(s), nil) {
			t.Errorf("%s refused", s)
		}
	}
}

func TestIsolatedSandboxGetsNXDOMAINForEveryInternalName(t *testing.T) {
	r, up, events, _ := sandboxResolver(t)
	for _, name := range []string{"db.internal.", "web.internal.", "internal."} {
		m := askSandbox(r, events, isolatedSandbox, name, mdns.TypeA)
		if m.Rcode != mdns.RcodeNameError || len(m.Answer) != 0 || len(m.Ns) != 1 {
			t.Errorf("%s: %v", name, m)
		}
	}
	if got := up.seen(); len(got) != 0 {
		t.Fatalf("upstream saw %v", got)
	}
	if got := r.Queries(isolatedAddr); len(got) != 3 {
		t.Fatalf("ring %+v", got)
	}
}

func TestJoinedSandboxResolvesItsEnvironmentsServices(t *testing.T) {
	r, _, events, _ := sandboxResolver(t)
	if got := vipOf(t, askSandbox(r, events, joinedSandbox, "db.internal.", mdns.TypeA)); got != "100.64.1.2" {
		t.Fatalf("got %s", got)
	}
	if m := askSandbox(r, events, joinedSandbox, "cache.internal.", mdns.TypeA); m.Rcode != mdns.RcodeNameError {
		t.Fatalf("got %v", m)
	}
}

func TestSandboxAAAAHTTPSAndSVCBAreEmpty(t *testing.T) {
	r, up, events, _ := sandboxResolver(t)
	for _, from := range []string{joinedSandbox, isolatedSandbox} {
		for _, qtype := range []uint16{mdns.TypeAAAA, mdns.TypeHTTPS, mdns.TypeSVCB} {
			m := askSandbox(r, events, from, "github.com.", qtype)
			if m.Rcode != mdns.RcodeSuccess || len(m.Answer) != 0 {
				t.Errorf("%s %s: %v", from, mdns.TypeToString[qtype], m)
			}
		}
	}
	if got := up.seen(); len(got) != 0 {
		t.Fatalf("upstream saw %v", got)
	}
}

func TestOpenModeSandboxForwardsLikeAService(t *testing.T) {
	r, up, events, answers := sandboxResolver(t)
	m := askSandbox(r, events, isolatedSandbox, "www.google.com.", mdns.TypeA)
	if m.Rcode != mdns.RcodeSuccess || vipOf(t, m) != "93.184.216.34" || len(m.Extra) != 0 {
		t.Fatalf("got %v", m)
	}
	if got := up.seen(); len(got) != 1 {
		t.Fatalf("upstream saw %v", got)
	}
	if len(*answers) != 0 {
		t.Fatalf("open mode called OnAllow %+v", *answers)
	}
	if q := r.Queries(isolatedAddr)[0]; q.Refused != "" || !q.Upstream {
		t.Fatalf("ring %+v", q)
	}
}

func TestSandboxPolicyIsCheckedBeforeTheZone(t *testing.T) {
	r, up, events, _ := sandboxResolver(t)
	if m := askSandbox(r, events, joinedSandbox, "example.com.", mdns.TypeA); m.Rcode != mdns.RcodeNameError {
		t.Fatalf("joined sandbox forwarded like a service: %v", m)
	}
	if m := ask(r, alphaClient, "example.com.", mdns.TypeA); m.Rcode != mdns.RcodeSuccess {
		t.Fatalf("service in the same subnet: %v", m)
	}
	if got := up.seen(); len(got) != 1 {
		t.Fatalf("upstream saw %v", got)
	}
}

func TestSandboxQueriesAreRecordedWithoutZoneLogging(t *testing.T) {
	r, _, events, _ := sandboxResolver(t)
	r.SetZones([]Zone{{Subnet: alphaSubnet, Log: false, Records: []Record{{Name: "db", VIP: netip.MustParseAddr("100.64.1.2")}}}})
	askSandbox(r, events, joinedSandbox, "db.internal.", mdns.TypeA)
	if got := r.Queries(joinedAddr); len(got) != 1 {
		t.Fatalf("ring %+v", got)
	}
}

func TestSetSandboxesReplacesThePolicies(t *testing.T) {
	r, _, events, _ := sandboxResolver(t)
	r.SetSandboxes(nil)
	if m := askSandbox(r, events, isolatedSandbox, "db.internal.", mdns.TypeA); m.Rcode != mdns.RcodeRefused {
		t.Fatalf("got %v", m)
	}
}

func TestQueryAsAnswersAsTheSandboxWouldAndRecordsAProbe(t *testing.T) {
	r, up, _, answers := sandboxResolver(t)
	refused, err := r.QueryAs(joinedAddr, "www.google.com")
	if err != nil || refused.Rcode != mdns.RcodeNameError || len(refused.Answer) != 0 {
		t.Fatalf("unlisted: %v %v", refused, err)
	}
	if got := up.seen(); len(got) != 0 {
		t.Fatalf("upstream saw %v", got)
	}
	listed, err := r.QueryAs(joinedAddr, "github.com")
	if err != nil || listed.Rcode != mdns.RcodeSuccess || len(listed.Answer) == 0 {
		t.Fatalf("listed: %v %v", listed, err)
	}
	if len(*answers) != 1 {
		t.Fatalf("allow answers %+v", *answers)
	}
	ring := r.Queries(joinedAddr)
	if len(ring) != 2 || !ring[0].Probe || !ring[1].Probe || ring[1].Refused != RefusedDomainNotAllowed {
		t.Fatalf("ring %+v", ring)
	}
	if internal, err := r.QueryAs(isolatedAddr, "web.internal"); err != nil || internal.Rcode != mdns.RcodeNameError {
		t.Fatalf("isolated internal: %v %v", internal, err)
	}
	if _, err := r.QueryAs(netip.MustParseAddr("10.9.9.9"), "github.com"); err == nil {
		t.Fatal("a source without a sandbox policy must be an error")
	}
}
