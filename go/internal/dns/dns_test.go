package dns

import (
	"log/slog"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	mdns "github.com/miekg/dns"
)

type fakeWriter struct {
	local, remote net.Addr
	sent          *mdns.Msg
}

func (f *fakeWriter) LocalAddr() net.Addr        { return f.local }
func (f *fakeWriter) RemoteAddr() net.Addr       { return f.remote }
func (f *fakeWriter) WriteMsg(m *mdns.Msg) error { f.sent = m; return nil }
func (f *fakeWriter) Write([]byte) (int, error)  { return 0, nil }
func (f *fakeWriter) Close() error               { return nil }
func (f *fakeWriter) TsigStatus() error          { return nil }
func (f *fakeWriter) TsigTimersOnly(bool)        {}
func (f *fakeWriter) Hijack()                    {}

func udpAddr(s string) net.Addr { return net.UDPAddrFromAddrPort(netip.MustParseAddrPort(s)) }
func tcpAddr(s string) net.Addr { return net.TCPAddrFromAddrPort(netip.MustParseAddrPort(s)) }

var (
	alphaSubnet = netip.MustParsePrefix("10.200.1.0/24")
	betaSubnet  = netip.MustParsePrefix("10.200.2.0/24")
	alphaClient = "10.200.1.2:41000"
	betaClient  = "10.200.2.2:41000"
)

func testResolver(t *testing.T, upstream string) *Resolver {
	t.Helper()
	r := New(slog.New(slog.DiscardHandler), upstream)
	r.SetZones([]Zone{
		{Subnet: alphaSubnet, Log: true, Records: []Record{
			{Name: "db", VIP: netip.MustParseAddr("100.64.1.2")},
			{Name: "web", VIP: netip.MustParseAddr("100.64.1.3")},
		}},
		{Subnet: betaSubnet, Log: true, Records: []Record{
			{Name: "db", VIP: netip.MustParseAddr("100.64.2.2")},
			{Name: "cache", VIP: netip.MustParseAddr("100.64.2.3")},
		}},
	})
	return r
}

func ask(r *Resolver, from, name string, qtype uint16) *mdns.Msg {
	return askOn(r, udpAddr("10.200.1.1:53"), from, name, qtype)
}

func askOn(r *Resolver, local net.Addr, from, name string, qtype uint16) *mdns.Msg {
	w := &fakeWriter{local: local, remote: udpAddr(from)}
	if local.Network() == "tcp" {
		w.remote = tcpAddr(from)
	}
	req := new(mdns.Msg)
	req.SetQuestion(name, qtype)
	r.ServeDNS(w, req)
	return w.sent
}

func vipOf(t *testing.T, m *mdns.Msg) string {
	t.Helper()
	if len(m.Answer) != 1 {
		t.Fatalf("answers %v", m.Answer)
	}
	a, ok := m.Answer[0].(*mdns.A)
	if !ok {
		t.Fatalf("answer %v", m.Answer[0])
	}
	return a.A.String()
}

type upstreamServer struct {
	addr    string
	mu      sync.Mutex
	queries []string
	nets    []string
}

func (u *upstreamServer) seen() []string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]string(nil), u.queries...)
}

func startUpstream(t *testing.T, build func(req *mdns.Msg) *mdns.Msg) *upstreamServer {
	t.Helper()
	pc, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Skipf("loopback udp unavailable: %v", err)
	}
	u := &upstreamServer{addr: pc.LocalAddr().String()}
	srv := &mdns.Server{PacketConn: pc, Handler: mdns.HandlerFunc(func(w mdns.ResponseWriter, req *mdns.Msg) {
		u.mu.Lock()
		u.queries = append(u.queries, req.Question[0].Name)
		u.nets = append(u.nets, w.LocalAddr().Network())
		u.mu.Unlock()
		resp := build(req)
		w.WriteMsg(resp)
	})}
	started := make(chan struct{})
	srv.NotifyStartedFunc = func() { close(started) }
	go srv.ActivateAndServe()
	<-started
	t.Cleanup(func() { srv.Shutdown() })
	return u
}

func publicAnswer(req *mdns.Msg) *mdns.Msg {
	m := new(mdns.Msg)
	m.SetReply(req)
	m.Answer = []mdns.RR{
		&mdns.A{Hdr: mdns.RR_Header{Name: req.Question[0].Name, Rrtype: mdns.TypeA, Class: mdns.ClassINET, Ttl: 60}, A: net.IPv4(93, 184, 216, 34)},
		&mdns.HTTPS{SVCB: mdns.SVCB{Hdr: mdns.RR_Header{Name: req.Question[0].Name, Rrtype: mdns.TypeHTTPS, Class: mdns.ClassINET, Ttl: 60}, Priority: 1, Target: "."}},
	}
	m.Extra = []mdns.RR{&mdns.SVCB{Hdr: mdns.RR_Header{Name: req.Question[0].Name, Rrtype: mdns.TypeSVCB, Class: mdns.ClassINET, Ttl: 60}, Priority: 1, Target: "."}}
	return m
}

func TestServiceNameAnswersTheVirtualIPOfTheAskingEnvironment(t *testing.T) {
	r := testResolver(t, "127.0.0.1:1")
	m := ask(r, alphaClient, "db.internal.", mdns.TypeA)
	if m.Rcode != mdns.RcodeSuccess || !m.Authoritative || vipOf(t, m) != "100.64.1.2" {
		t.Fatalf("got %v", m)
	}
	if ttl := m.Answer[0].Header().Ttl; ttl != 30 {
		t.Fatalf("ttl %d", ttl)
	}
}

func TestTheSameNameAnswersEachEnvironmentItsOwnVirtualIP(t *testing.T) {
	r := testResolver(t, "127.0.0.1:1")
	if got := vipOf(t, ask(r, alphaClient, "db.internal.", mdns.TypeA)); got != "100.64.1.2" {
		t.Errorf("alpha %s", got)
	}
	if got := vipOf(t, ask(r, betaClient, "db.internal.", mdns.TypeA)); got != "100.64.2.2" {
		t.Errorf("beta %s", got)
	}
}

func TestAServiceOfAnotherEnvironmentIsNXDOMAIN(t *testing.T) {
	r := testResolver(t, "127.0.0.1:1")
	m := ask(r, alphaClient, "cache.internal.", mdns.TypeA)
	if m.Rcode != mdns.RcodeNameError || len(m.Answer) != 0 || len(m.Ns) != 1 {
		t.Fatalf("got %v", m)
	}
	if ttl := m.Ns[0].Header().Ttl; ttl != 5 {
		t.Fatalf("negative ttl %d", ttl)
	}
}

func TestMultiLabelInternalNamesAreNXDOMAIN(t *testing.T) {
	r := testResolver(t, "127.0.0.1:1")
	for _, name := range []string{"db.alpha.internal.", "db.beta.internal.", "a.b.c.internal.", "internal."} {
		if m := ask(r, alphaClient, name, mdns.TypeA); m.Rcode != mdns.RcodeNameError || len(m.Answer) != 0 {
			t.Errorf("%s: %v", name, m)
		}
	}
}

func TestInternalNamesMatchCaseInsensitively(t *testing.T) {
	r := testResolver(t, "127.0.0.1:1")
	if got := vipOf(t, ask(r, alphaClient, "DB.Internal.", mdns.TypeA)); got != "100.64.1.2" {
		t.Fatalf("got %s", got)
	}
}

func TestRecordNamesAreStoredLowercase(t *testing.T) {
	r := New(slog.New(slog.DiscardHandler), "127.0.0.1:1")
	r.SetZones([]Zone{{Subnet: alphaSubnet, Records: []Record{{Name: "Web-App", VIP: netip.MustParseAddr("100.64.1.9")}}}})
	if got := vipOf(t, ask(r, alphaClient, "web-app.internal.", mdns.TypeA)); got != "100.64.1.9" {
		t.Fatalf("got %s", got)
	}
}

func TestAnyQueryForAKnownNameReturnsTheAddress(t *testing.T) {
	r := testResolver(t, "127.0.0.1:1")
	if got := vipOf(t, ask(r, alphaClient, "db.internal.", mdns.TypeANY)); got != "100.64.1.2" {
		t.Fatalf("got %s", got)
	}
}

func TestAAAAAndOtherTypesForAKnownNameAreNODATA(t *testing.T) {
	r := testResolver(t, "127.0.0.1:1")
	for _, qtype := range []uint16{mdns.TypeAAAA, mdns.TypeTXT, mdns.TypeMX} {
		m := ask(r, alphaClient, "db.internal.", qtype)
		if m.Rcode != mdns.RcodeSuccess || len(m.Answer) != 0 || len(m.Ns) != 1 {
			t.Errorf("%s: %v", mdns.TypeToString[qtype], m)
		}
	}
}

func TestInternalAnswersAreMarkedAuthoritativeAndRecursionAvailable(t *testing.T) {
	r := testResolver(t, "127.0.0.1:1")
	for _, name := range []string{"db.internal.", "nope.internal."} {
		m := ask(r, alphaClient, name, mdns.TypeA)
		if !m.Authoritative || !m.RecursionAvailable {
			t.Errorf("%s: aa=%v ra=%v", name, m.Authoritative, m.RecursionAvailable)
		}
	}
}

func TestHTTPSAndSVCBQueriesAreNODATAWithoutAskingUpstream(t *testing.T) {
	up := startUpstream(t, publicAnswer)
	r := testResolver(t, up.addr)
	for _, name := range []string{"example.com.", "db.internal."} {
		for _, qtype := range []uint16{mdns.TypeHTTPS, mdns.TypeSVCB} {
			m := ask(r, alphaClient, name, qtype)
			if m.Rcode != mdns.RcodeSuccess || len(m.Answer) != 0 {
				t.Errorf("%s %s: %v", name, mdns.TypeToString[qtype], m)
			}
		}
	}
	if got := up.seen(); len(got) != 0 {
		t.Fatalf("upstream saw %v", got)
	}
}

func TestPublicNamesAreForwardedToTheUpstreamWithHTTPSAndSVCBStripped(t *testing.T) {
	up := startUpstream(t, publicAnswer)
	r := testResolver(t, up.addr)
	m := ask(r, alphaClient, "example.com.", mdns.TypeA)
	if m.Rcode != mdns.RcodeSuccess || len(m.Answer) != 1 || len(m.Extra) != 0 {
		t.Fatalf("got %v", m)
	}
	if vipOf(t, m) != "93.184.216.34" {
		t.Fatalf("answer %v", m.Answer)
	}
	if seen := up.seen(); len(seen) != 1 || seen[0] != "example.com." {
		t.Fatalf("upstream saw %v", seen)
	}
}

func TestForwardingUsesTheTransportTheClientUsed(t *testing.T) {
	up := startUpstream(t, publicAnswer)
	r := testResolver(t, up.addr)
	askOn(r, udpAddr("10.200.1.1:53"), alphaClient, "example.com.", mdns.TypeA)
	up.mu.Lock()
	defer up.mu.Unlock()
	if len(up.nets) != 1 || up.nets[0] != "udp" {
		t.Fatalf("transports %v", up.nets)
	}
}

func TestInternalNamesNeverReachTheUpstream(t *testing.T) {
	up := startUpstream(t, publicAnswer)
	r := testResolver(t, up.addr)
	ask(r, alphaClient, "db.internal.", mdns.TypeA)
	ask(r, alphaClient, "ghost.internal.", mdns.TypeA)
	ask(r, alphaClient, "db.alpha.internal.", mdns.TypeA)
	if got := up.seen(); len(got) != 0 {
		t.Fatalf("upstream saw %v", got)
	}
}

func TestUpstreamFailureAnswersSERVFAIL(t *testing.T) {
	r := testResolver(t, "127.0.0.1:1")
	m := askOn(r, tcpAddr("10.200.1.1:53"), alphaClient, "example.com.", mdns.TypeA)
	if m.Rcode != mdns.RcodeServerFailure {
		t.Fatalf("got %v", m)
	}
}

func TestUnknownSourceIsRefused(t *testing.T) {
	r := testResolver(t, "127.0.0.1:1")
	for _, name := range []string{"db.internal.", "example.com."} {
		if m := ask(r, "192.168.9.9:5000", name, mdns.TypeA); m.Rcode != mdns.RcodeRefused {
			t.Errorf("%s: %v", name, m)
		}
	}
}

func TestMalformedQuestionCountIsFORMERR(t *testing.T) {
	r := testResolver(t, "127.0.0.1:1")
	w := &fakeWriter{local: udpAddr("10.200.1.1:53"), remote: udpAddr(alphaClient)}
	req := new(mdns.Msg)
	r.ServeDNS(w, req)
	if w.sent.Rcode != mdns.RcodeFormatError {
		t.Fatalf("no question: %v", w.sent)
	}
	req.SetQuestion("a.internal.", mdns.TypeA)
	req.Question = append(req.Question, mdns.Question{Name: "b.internal.", Qtype: mdns.TypeA, Qclass: mdns.ClassINET})
	r.ServeDNS(w, req)
	if w.sent.Rcode != mdns.RcodeFormatError {
		t.Fatalf("two questions: %v", w.sent)
	}
}

func TestSetZonesReplacesEveryZone(t *testing.T) {
	r := testResolver(t, "127.0.0.1:1")
	r.SetZones([]Zone{{Subnet: alphaSubnet, Records: []Record{{Name: "fresh", VIP: netip.MustParseAddr("100.64.1.77")}}}})
	if m := ask(r, alphaClient, "db.internal.", mdns.TypeA); m.Rcode != mdns.RcodeNameError {
		t.Errorf("old record survived: %v", m)
	}
	if got := vipOf(t, ask(r, alphaClient, "fresh.internal.", mdns.TypeA)); got != "100.64.1.77" {
		t.Errorf("new record %s", got)
	}
	if m := ask(r, betaClient, "cache.internal.", mdns.TypeA); m.Rcode != mdns.RcodeRefused {
		t.Errorf("removed zone must refuse: %v", m)
	}
}

func hostResolver(t *testing.T, upstream string) *Resolver {
	r := testResolver(t, upstream)
	r.SetHost(netip.MustParseAddr("10.200.0.1"), []netip.Prefix{netip.MustParsePrefix("10.200.0.0/24"), netip.MustParsePrefix("203.0.113.7/32")})
	return r
}

func askHost(r *Resolver, from, name string, qtype uint16) *mdns.Msg {
	return askOn(r, udpAddr("10.200.0.1:53"), from, name, qtype)
}

func TestHostListenerForwardsPublicNamesFromTheSystemSubnet(t *testing.T) {
	up := startUpstream(t, publicAnswer)
	r := hostResolver(t, up.addr)
	m := askHost(r, "10.200.0.5:40000", "example.com.", mdns.TypeA)
	if m.Rcode != mdns.RcodeSuccess || len(m.Answer) != 1 || len(m.Extra) != 0 {
		t.Fatalf("got %v", m)
	}
	_, stats := r.Host()
	if stats.Queries.Load() != 1 || stats.Forwarded.Load() != 1 {
		t.Fatalf("stats %d/%d", stats.Queries.Load(), stats.Forwarded.Load())
	}
}

func TestHostListenerAnswersTheHostsOwnAddresses(t *testing.T) {
	up := startUpstream(t, publicAnswer)
	r := hostResolver(t, up.addr)
	if m := askHost(r, "203.0.113.7:40000", "example.com.", mdns.TypeA); m.Rcode != mdns.RcodeSuccess {
		t.Fatalf("got %v", m)
	}
}

func TestHostListenerRefusesEveryInternalName(t *testing.T) {
	r := hostResolver(t, "127.0.0.1:1")
	for _, name := range []string{"db.internal.", "internal.", "x.y.internal.", "DB.INTERNAL."} {
		if m := askHost(r, "10.200.0.5:40000", name, mdns.TypeA); m.Rcode != mdns.RcodeRefused {
			t.Errorf("%s: %v", name, m)
		}
	}
	_, stats := r.Host()
	if stats.Refused.Load() != 4 {
		t.Fatalf("refused %d", stats.Refused.Load())
	}
}

func TestHostListenerRefusesSourcesOutsideTheAllowedRanges(t *testing.T) {
	up := startUpstream(t, publicAnswer)
	r := hostResolver(t, up.addr)
	if m := askHost(r, "10.200.1.2:40000", "example.com.", mdns.TypeA); m.Rcode != mdns.RcodeRefused {
		t.Fatalf("an environment must not use the host listener: %v", m)
	}
	if got := up.seen(); len(got) != 0 {
		t.Fatalf("upstream saw %v", got)
	}
}

func TestHostListenerStripsHTTPSAndSVCBQueries(t *testing.T) {
	r := hostResolver(t, "127.0.0.1:1")
	m := askHost(r, "10.200.0.5:40000", "example.com.", mdns.TypeHTTPS)
	if m.Rcode != mdns.RcodeSuccess || len(m.Answer) != 0 {
		t.Fatalf("got %v", m)
	}
}

func TestHostListenerCountsUpstreamFailures(t *testing.T) {
	r := hostResolver(t, "127.0.0.1:1")
	m := askOn(r, tcpAddr("10.200.0.1:53"), "10.200.0.5:40000", "example.com.", mdns.TypeA)
	if m.Rcode != mdns.RcodeServerFailure {
		t.Fatalf("got %v", m)
	}
	_, stats := r.Host()
	if stats.Failed.Load() != 1 || stats.Forwarded.Load() != 0 {
		t.Fatalf("failed %d forwarded %d", stats.Failed.Load(), stats.Forwarded.Load())
	}
}

func TestHostQueriesAreNotRecordedInAnyServiceRing(t *testing.T) {
	up := startUpstream(t, publicAnswer)
	r := hostResolver(t, up.addr)
	askHost(r, "10.200.0.5:40000", "example.com.", mdns.TypeA)
	if got := r.Queries(netip.MustParseAddr("10.200.0.5")); len(got) != 0 {
		t.Fatalf("got %v", got)
	}
}

func TestQueryRingKeepsTheLast100QueriesNewestFirst(t *testing.T) {
	r := testResolver(t, "127.0.0.1:1")
	for i := 0; i < 150; i++ {
		ask(r, alphaClient, "q"+strconv.Itoa(i)+".internal.", mdns.TypeA)
	}
	got := r.Queries(netip.MustParseAddr("10.200.1.2"))
	if len(got) != 100 {
		t.Fatalf("got %d entries", len(got))
	}
	if got[0].Name != "q149.internal" || got[99].Name != "q50.internal" {
		t.Fatalf("newest %s oldest %s", got[0].Name, got[99].Name)
	}
}

func TestQueryRingBelowCapacityReturnsEveryQuery(t *testing.T) {
	r := testResolver(t, "127.0.0.1:1")
	for i := 0; i < 3; i++ {
		ask(r, alphaClient, "q"+strconv.Itoa(i)+".internal.", mdns.TypeA)
	}
	got := r.Queries(netip.MustParseAddr("10.200.1.2"))
	if len(got) != 3 || got[0].Name != "q2.internal" || got[2].Name != "q0.internal" {
		t.Fatalf("got %+v", got)
	}
}

func TestQueryRingExactlyAtCapacityHasNoWrapArtifacts(t *testing.T) {
	r := testResolver(t, "127.0.0.1:1")
	for i := 0; i < ringSize; i++ {
		ask(r, alphaClient, "q"+strconv.Itoa(i)+".internal.", mdns.TypeA)
	}
	got := r.Queries(netip.MustParseAddr("10.200.1.2"))
	if len(got) != ringSize || got[0].Name != "q99.internal" || got[99].Name != "q0.internal" {
		t.Fatalf("got %d: %s .. %s", len(got), got[0].Name, got[len(got)-1].Name)
	}
}

func TestEachSourceHasItsOwnRing(t *testing.T) {
	r := testResolver(t, "127.0.0.1:1")
	for i := 0; i < 120; i++ {
		ask(r, alphaClient, "flood"+strconv.Itoa(i)+".internal.", mdns.TypeA)
	}
	ask(r, betaClient, "db.internal.", mdns.TypeA)
	if got := r.Queries(netip.MustParseAddr("10.200.2.2")); len(got) != 1 || got[0].Name != "db.internal" {
		t.Fatalf("a flooding neighbour displaced entries: %+v", got)
	}
}

func TestQueryRingEntryDescribesTheQuery(t *testing.T) {
	r := testResolver(t, "127.0.0.1:1")
	ask(r, alphaClient, "db.internal.", mdns.TypeA)
	ask(r, alphaClient, "ghost.internal.", mdns.TypeA)
	got := r.Queries(netip.MustParseAddr("10.200.1.2"))
	if got[1].Type != "A" || got[1].Rcode != "NOERROR" || got[1].Upstream || got[1].Probe || len(got[1].Answers) != 1 || got[1].Answers[0] != netip.MustParseAddr("100.64.1.2") {
		t.Errorf("answered: %+v", got[1])
	}
	if got[0].Rcode != "NXDOMAIN" || len(got[0].Answers) != 0 {
		t.Errorf("negative: %+v", got[0])
	}
	if got[0].At.IsZero() || got[0].MS < 0 {
		t.Errorf("timing: %+v", got[0])
	}
}

func TestQueryRingMarksForwardedQueriesAsUpstream(t *testing.T) {
	up := startUpstream(t, publicAnswer)
	r := testResolver(t, up.addr)
	ask(r, alphaClient, "example.com.", mdns.TypeA)
	got := r.Queries(netip.MustParseAddr("10.200.1.2"))
	if len(got) != 1 || !got[0].Upstream || got[0].Name != "example.com" {
		t.Fatalf("got %+v", got)
	}
}

func TestQueryRingKeepsAtMostEightAnswerAddresses(t *testing.T) {
	up := startUpstream(t, func(req *mdns.Msg) *mdns.Msg {
		m := new(mdns.Msg)
		m.SetReply(req)
		for i := 1; i <= 12; i++ {
			m.Answer = append(m.Answer, &mdns.A{Hdr: mdns.RR_Header{Name: req.Question[0].Name, Rrtype: mdns.TypeA, Class: mdns.ClassINET, Ttl: 60}, A: net.IPv4(198, 51, 100, byte(i))})
		}
		return m
	})
	r := testResolver(t, up.addr)
	ask(r, alphaClient, "many.example.", mdns.TypeA)
	got := r.Queries(netip.MustParseAddr("10.200.1.2"))
	if len(got) != 1 || len(got[0].Answers) != ringAnswerMax || ringAnswerMax != 8 {
		t.Fatalf("got %+v", got)
	}
}

func TestZoneWithoutLoggingRecordsNothing(t *testing.T) {
	r := New(slog.New(slog.DiscardHandler), "127.0.0.1:1")
	r.SetZones([]Zone{{Subnet: alphaSubnet, Log: false, Records: []Record{{Name: "db", VIP: netip.MustParseAddr("100.64.1.2")}}}})
	ask(r, alphaClient, "db.internal.", mdns.TypeA)
	if got := r.Queries(netip.MustParseAddr("10.200.1.2")); len(got) != 0 {
		t.Fatalf("got %+v", got)
	}
}

func TestRefusedSourcesAreNotRecorded(t *testing.T) {
	r := testResolver(t, "127.0.0.1:1")
	ask(r, "192.168.9.9:5000", "db.internal.", mdns.TypeA)
	if got := r.Queries(netip.MustParseAddr("192.168.9.9")); len(got) != 0 {
		t.Fatalf("got %+v", got)
	}
}

func TestNamesMapsAnAddressToTheLatestNameItResolvedFrom(t *testing.T) {
	up := startUpstream(t, publicAnswer)
	r := testResolver(t, up.addr)
	ask(r, alphaClient, "first.example.", mdns.TypeA)
	ask(r, alphaClient, "second.example.", mdns.TypeA)
	names := r.Names(netip.MustParseAddr("10.200.1.2"))
	if names[netip.MustParseAddr("93.184.216.34")] != "second.example" {
		t.Fatalf("got %v", names)
	}
}

func TestForgetClearsTheRingOfAReassignedAddress(t *testing.T) {
	r := testResolver(t, "127.0.0.1:1")
	ask(r, alphaClient, "db.internal.", mdns.TypeA)
	src := netip.MustParseAddr("10.200.1.2")
	r.Forget(src)
	if got := r.Queries(src); len(got) != 0 {
		t.Fatalf("got %+v", got)
	}
	if got := r.Names(src); len(got) != 0 {
		t.Fatalf("got %v", got)
	}
}

func TestRegisteredProbeSourceMarksTheRingEntry(t *testing.T) {
	r := testResolver(t, "127.0.0.1:1")
	release := r.RegisterProbe(netip.MustParseAddrPort(alphaClient))
	ask(r, alphaClient, "db.internal.", mdns.TypeA)
	release()
	ask(r, alphaClient, "db.internal.", mdns.TypeA)
	got := r.Queries(netip.MustParseAddr("10.200.1.2"))
	if !got[1].Probe || got[0].Probe {
		t.Fatalf("probe flags %v then %v", got[1].Probe, got[0].Probe)
	}
}

func TestProbeRegistrationsOfTheSamePortAreCounted(t *testing.T) {
	r := testResolver(t, "127.0.0.1:1")
	src := netip.MustParseAddrPort(alphaClient)
	first, second := r.RegisterProbe(src), r.RegisterProbe(src)
	first()
	ask(r, alphaClient, "db.internal.", mdns.TypeA)
	if !r.Queries(src.Addr())[0].Probe {
		t.Error("one registration is still live")
	}
	second()
	ask(r, alphaClient, "db.internal.", mdns.TypeA)
	if r.Queries(src.Addr())[0].Probe {
		t.Error("all registrations released")
	}
}

func TestUpstreamFromReadsTheFirstNameserver(t *testing.T) {
	path := filepath.Join(t.TempDir(), "resolv.conf")
	if err := os.WriteFile(path, []byte("search example.test\nnameserver 192.0.2.53\nnameserver 192.0.2.54\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := UpstreamFrom(path)
	if err != nil || got != "192.0.2.53:53" {
		t.Fatalf("got %q %v", got, err)
	}
}

func TestUpstreamFromFailsWithoutANameserver(t *testing.T) {
	path := filepath.Join(t.TempDir(), "resolv.conf")
	if err := os.WriteFile(path, []byte("search example.test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := UpstreamFrom(path); err == nil {
		t.Fatal("expected an error")
	}
	if _, err := UpstreamFrom(filepath.Join(t.TempDir(), "absent")); err == nil {
		t.Fatal("expected an error for a missing file")
	}
}

func TestStripRemovesOnlyHTTPSAndSVCBRecords(t *testing.T) {
	a := &mdns.A{Hdr: mdns.RR_Header{Name: "x.", Rrtype: mdns.TypeA}, A: net.IPv4(1, 2, 3, 4)}
	https := &mdns.HTTPS{SVCB: mdns.SVCB{Hdr: mdns.RR_Header{Name: "x.", Rrtype: mdns.TypeHTTPS}}}
	svcb := &mdns.SVCB{Hdr: mdns.RR_Header{Name: "x.", Rrtype: mdns.TypeSVCB}}
	got := strip([]mdns.RR{https, a, svcb})
	if len(got) != 1 || got[0] != mdns.RR(a) {
		t.Fatalf("got %v", got)
	}
}

func TestListeningReportsNothingBeforeAnyBind(t *testing.T) {
	r := testResolver(t, "127.0.0.1:1")
	if got := r.Listening(); len(got) != 0 {
		t.Fatalf("got %v", got)
	}
	if r.Upstream() != "127.0.0.1:1" {
		t.Fatalf("upstream %q", r.Upstream())
	}
}

func clockedResolver(t *testing.T) (*Resolver, *time.Time) {
	t.Helper()
	r := testResolver(t, "127.0.0.1:1")
	now := time.Unix(1_000_000, 0)
	r.budgets.now = func() time.Time { return now }
	return r, &now
}

func exhaust(r *Resolver, from string) {
	for range budgetBurst {
		ask(r, from, "db.internal.", mdns.TypeA)
	}
}

func TestEachSourceHasItsOwnQueryBudget(t *testing.T) {
	r, _ := clockedResolver(t)
	exhaust(r, alphaClient)
	if m := ask(r, alphaClient, "db.internal.", mdns.TypeA); m.Rcode != mdns.RcodeRefused {
		t.Fatalf("flooding source got %v", m)
	}
	if got := vipOf(t, ask(r, betaClient, "db.internal.", mdns.TypeA)); got != "100.64.2.2" {
		t.Fatalf("neighbour got %s", got)
	}
	if m := ask(r, "10.200.1.3:41000", "db.internal.", mdns.TypeA); m.Rcode != mdns.RcodeSuccess {
		t.Fatalf("same subnet other address got %v", m)
	}
}

func TestOverBudgetQueriesAreRefusedAndTheBudgetRefills(t *testing.T) {
	r, now := clockedResolver(t)
	exhaust(r, alphaClient)
	m := ask(r, alphaClient, "db.internal.", mdns.TypeA)
	if m.Rcode != mdns.RcodeRefused || len(m.Answer) != 0 {
		t.Fatalf("over budget got %v", m)
	}
	*now = now.Add(time.Second)
	if got := vipOf(t, ask(r, alphaClient, "db.internal.", mdns.TypeA)); got != "100.64.1.2" {
		t.Fatalf("after refill got %s", got)
	}
}

func TestRefusedOverBudgetQueriesAreNotLogged(t *testing.T) {
	r, _ := clockedResolver(t)
	exhaust(r, alphaClient)
	ask(r, alphaClient, "ghost.internal.", mdns.TypeA)
	for _, q := range r.Queries(netip.MustParseAddr("10.200.1.2")) {
		if q.Name == "ghost.internal." {
			t.Fatalf("logged %+v", q)
		}
	}
}

func TestIdleSourcesAreEvicted(t *testing.T) {
	r, now := clockedResolver(t)
	ask(r, alphaClient, "db.internal.", mdns.TypeA)
	ask(r, betaClient, "db.internal.", mdns.TypeA)
	if got := r.budgets.tracked(); got != 2 {
		t.Fatalf("tracked %d", got)
	}
	*now = now.Add(budgetIdle + budgetSweep)
	ask(r, alphaClient, "db.internal.", mdns.TypeA)
	if got := r.budgets.tracked(); got != 1 {
		t.Fatalf("tracked %d after eviction", got)
	}
}

func TestTrackedSourcesAreBounded(t *testing.T) {
	b := newBudgets()
	now := time.Unix(1_000_000, 0)
	b.now = func() time.Time { return now }
	base := netip.MustParseAddr("10.0.0.0").As4()
	for i := range budgetMaxSrcs + 10 {
		a := base
		a[1], a[2], a[3] = byte(i>>16), byte(i>>8), byte(i)
		b.allow(netip.AddrFrom4(a))
	}
	if got := b.tracked(); got != budgetMaxSrcs {
		t.Fatalf("tracked %d", got)
	}
	now = now.Add(budgetIdle + budgetSweep)
	if !b.allow(netip.MustParseAddr("10.9.9.9")) || b.tracked() != 1 {
		t.Fatalf("tracked %d after idle", b.tracked())
	}
}

func TestAAAAForAnUnknownInternalNameIsNXDOMAIN(t *testing.T) {
	r := testResolver(t, "127.0.0.1:1")
	if m := ask(r, alphaClient, "ghost.internal.", mdns.TypeAAAA); m.Rcode != mdns.RcodeNameError {
		t.Fatalf("got %v", m)
	}
}
