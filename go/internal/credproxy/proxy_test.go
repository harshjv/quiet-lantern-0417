package credproxy

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const (
	publicHost = "public.example.test"
	relayHost  = "169.254.1.1:7900"
	waitLimit  = 5 * time.Second
)

var (
	credentialAddr = netip.MustParseAddr("192.0.2.10")
	credentialDst  = netip.AddrPortFrom(credentialAddr, 443)
	publicDst      = netip.MustParseAddrPort("198.51.100.7:443")
)

func discardLog() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func testKey(c string) string {
	return "sk-ant-api03-sly_" + strings.Repeat(c, 26)
}

type seen struct {
	APIKey        string `json:"api_key"`
	Authorization string `json:"authorization"`
	Other         string `json:"other"`
	Host          string `json:"host"`
	Query         string `json:"query"`
}

type harness struct {
	t           *testing.T
	proxy       *Proxy
	addr        string
	proxyCA     *CA
	upstream    *httptest.Server
	public      *httptest.Server
	publicCA    *CA
	hits        atomic.Int32
	publicHits  atomic.Int32
	release     chan struct{}
	creds       map[string]Credential
	mu          sync.Mutex
	used        map[string]int
	misdirected map[string]int
	dialed      []netip.AddrPort
	originalDst netip.AddrPort
}

func echo(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(seen{
		APIKey:        r.Header.Get("X-Api-Key"),
		Authorization: r.Header.Get("Authorization"),
		Other:         r.Header.Get("X-Other"),
		Host:          r.Host,
		Query:         r.URL.RawQuery,
	})
}

func (h *harness) upstreamHandler(w http.ResponseWriter, r *http.Request) {
	h.hits.Add(1)
	switch r.URL.Path {
	case "/sse":
		w.Header().Set("Content-Type", "text/event-stream")
		h.stream(w, r, "data: one\n\n", "data: two\n\n")
	case "/sized":
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", "8")
		h.stream(w, r, "one\n", "two\n")
	case "/ws":
		h.websocket(w, r)
	default:
		echo(w, r)
	}
}

func (h *harness) stream(w http.ResponseWriter, r *http.Request, first, second string) {
	_, _ = io.WriteString(w, first)
	w.(http.Flusher).Flush()
	select {
	case <-h.release:
	case <-r.Context().Done():
		return
	case <-time.After(2 * waitLimit):
	}
	_, _ = io.WriteString(w, second)
}

func (h *harness) websocket(w http.ResponseWriter, r *http.Request) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || r.ProtoMajor != 1 {
		http.Error(w, "not an HTTP/1.1 websocket upgrade", http.StatusBadRequest)
		return
	}
	conn, rw, err := http.NewResponseController(w).Hijack()
	if err != nil {
		h.t.Errorf("hijack: %v", err)
		return
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(waitLimit))
	fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n%s\n", r.Header.Get("X-Api-Key"))
	_ = rw.Flush()
	line, err := rw.ReadString('\n')
	if err != nil {
		return
	}
	_, _ = rw.WriteString("echo " + line)
	_ = rw.Flush()
}

func newHarness(t *testing.T, creds map[string]Credential, originalDst netip.AddrPort) *harness {
	t.Helper()
	now := time.Now()
	h := &harness{
		t:           t,
		release:     make(chan struct{}),
		used:        map[string]int{},
		misdirected: map[string]int{},
		originalDst: originalDst,
		creds:       creds,
		proxyCA:     testCA(t, "sbx_test", testHosts, now),
		publicCA:    testCA(t, "public", []string{publicHost}, now),
	}
	upstreamCA := testCA(t, "upstream", testHosts, now)
	h.upstream = httptest.NewUnstartedServer(http.HandlerFunc(h.upstreamHandler))
	h.upstream.EnableHTTP2 = true
	h.upstream.TLS = &tls.Config{GetCertificate: func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
		return upstreamCA.Leaf(hello.ServerName, time.Now())
	}}
	h.upstream.StartTLS()
	t.Cleanup(h.upstream.Close)
	h.public = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.publicHits.Add(1)
		echo(w, r)
	}))
	publicLeaf, err := h.publicCA.Leaf(publicHost, now)
	if err != nil {
		t.Fatal(err)
	}
	h.public.TLS = &tls.Config{Certificates: []tls.Certificate{*publicLeaf}}
	h.public.StartTLS()
	t.Cleanup(h.public.Close)

	rootCAs := caPool(upstreamCA)
	h.proxy = New(Config{
		Hosts: testHosts,
		CA:    h.proxyCA,
		Lookup: func(placeholder string) (Credential, bool) {
			c, ok := h.creds[placeholder]
			return c, ok
		},
		Dial:    h.dial,
		Resolve: h.resolve,
		OriginalDst: func(net.Conn) (netip.AddrPort, error) {
			return h.originalDst, nil
		},
		RootCAs: rootCAs,
		Count: func(placeholder string, misdirected bool) {
			h.mu.Lock()
			defer h.mu.Unlock()
			if misdirected {
				h.misdirected[placeholder]++
			} else {
				h.used[placeholder]++
			}
		},
		Log: discardLog(),
	})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	h.addr = ln.Addr().String()
	go func() { _ = h.proxy.Serve(ln) }()
	t.Cleanup(func() { _ = h.proxy.Close() })
	return h
}

func (h *harness) resolve(_ context.Context, host string) ([]netip.Addr, error) {
	if host != credentialHost {
		h.t.Errorf("the proxy resolved %q", host)
		return nil, errors.New("not resolvable in the test")
	}
	return []netip.Addr{credentialAddr}, nil
}

func (h *harness) dial(ctx context.Context, to netip.AddrPort) (net.Conn, error) {
	h.mu.Lock()
	h.dialed = append(h.dialed, to)
	h.mu.Unlock()
	var target string
	switch to {
	case credentialDst:
		target = h.upstream.Listener.Addr().String()
	case publicDst:
		target = h.public.Listener.Addr().String()
	default:
		h.t.Errorf("the proxy dialled %s", to)
		return nil, errors.New("not dialable in the test")
	}
	return (&net.Dialer{}).DialContext(ctx, "tcp", target)
}

func (h *harness) dials() []netip.AddrPort {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]netip.AddrPort(nil), h.dialed...)
}

func (h *harness) counts() (map[string]int, map[string]int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	used, misdirected := h.used, h.misdirected
	h.used, h.misdirected = map[string]int{}, map[string]int{}
	return used, misdirected
}

func (h *harness) client(h2 bool) *http.Client {
	return &http.Client{Timeout: waitLimit, Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "tcp", h.addr)
		},
		TLSClientConfig:   &tls.Config{RootCAs: caPool(h.proxyCA)},
		ForceAttemptHTTP2: h2,
	}}
}

func (h *harness) send(c *http.Client, host string, headers map[string]string) (*http.Response, seen) {
	h.t.Helper()
	req, err := http.NewRequest(http.MethodPost, "https://"+credentialHost+"/v1/messages?key="+testKey("Q"), strings.NewReader("{}"))
	if err != nil {
		h.t.Fatal(err)
	}
	if host != "" {
		req.Host = host
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := c.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		h.t.Fatal(err)
	}
	var s seen
	if resp.StatusCode == http.StatusOK {
		if err := json.Unmarshal(body, &s); err != nil {
			h.t.Fatalf("upstream body %q: %v", body, err)
		}
	} else {
		resp.Body = io.NopCloser(strings.NewReader(string(body)))
	}
	return resp, s
}

func TestTheProxySwapsABoundPlaceholderOnlyInTheCredentialHeaders(t *testing.T) {
	bound, unbound, both, relay := testKey("A"), testKey("B"), testKey("C"), testKey("D")
	h := newHarness(t, map[string]Credential{
		bound:   {Value: "real-bound", Hosts: []string{credentialHost}},
		unbound: {Value: "real-unbound", Hosts: []string{secondHost}},
		both:    {Value: "real-both", Hosts: []string{credentialHost, secondHost}},
		relay:   {Value: "real-relay", Hosts: []string{relayHost}},
	}, credentialDst)
	realKey := "sk-ant-api03-" + strings.Repeat("r", 90)
	lookalike := testKey("Z") + "realtail"
	cases := []struct {
		name        string
		host        string
		headers     map[string]string
		want        seen
		used        map[string]int
		misdirected map[string]int
	}{
		{"x-api-key", "", map[string]string{"X-Api-Key": bound}, seen{APIKey: "real-bound"}, map[string]int{bound: 1}, nil},
		{"Authorization: Bearer", "", map[string]string{"Authorization": "Bearer " + bound}, seen{Authorization: "Bearer real-bound"}, map[string]int{bound: 1}, nil},
		{"a lowercase bearer scheme", "", map[string]string{"Authorization": "bearer " + bound}, seen{Authorization: "bearer real-bound"}, map[string]int{bound: 1}, nil},
		{"both headers", "", map[string]string{"X-Api-Key": bound, "Authorization": "Bearer " + both}, seen{APIKey: "real-bound", Authorization: "Bearer real-both"}, map[string]int{bound: 1, both: 1}, nil},
		{"a Host with a port", credentialHost + ":443", map[string]string{"X-Api-Key": bound}, seen{APIKey: "real-bound", Host: credentialHost + ":443"}, map[string]int{bound: 1}, nil},
		{"a Host in another case", "API.Credential.Test", map[string]string{"X-Api-Key": bound}, seen{APIKey: "real-bound", Host: "API.Credential.Test"}, map[string]int{bound: 1}, nil},
		{"another scheme", "", map[string]string{"Authorization": "Basic " + bound}, seen{Authorization: "Basic " + bound}, nil, nil},
		{"another header", "", map[string]string{"X-Other": bound}, seen{Other: bound}, nil, nil},
		{"a real key", "", map[string]string{"X-Api-Key": realKey}, seen{APIKey: realKey}, nil, nil},
		{"a real key that only starts like a placeholder", "", map[string]string{"X-Api-Key": lookalike}, seen{APIKey: lookalike}, nil, nil},
		{"a Host unlike the SNI", "evil.example.test", map[string]string{"X-Api-Key": bound}, seen{APIKey: bound, Host: "evil.example.test"}, nil, map[string]int{bound: 1}},
		{"a Host of another credential host the value is bound to", secondHost, map[string]string{"Authorization": "Bearer " + both}, seen{Authorization: "Bearer " + both, Host: secondHost}, nil, map[string]int{both: 1}},
		{"a value bound to another credential host", "", map[string]string{"X-Api-Key": unbound}, seen{APIKey: unbound}, nil, map[string]int{unbound: 1}},
		{"a value bound to the relay", "", map[string]string{"Authorization": "Bearer " + relay}, seen{Authorization: "Bearer " + relay}, nil, map[string]int{relay: 1}},
	}
	c := h.client(false)
	for _, tc := range cases {
		resp, got := h.send(c, tc.host, tc.headers)
		if resp.StatusCode != http.StatusOK {
			t.Errorf("%s: status %d, want 200", tc.name, resp.StatusCode)
			continue
		}
		want := tc.want
		if want.Host == "" {
			want.Host = credentialHost
		}
		want.Query = "key=" + testKey("Q")
		if got != want {
			t.Errorf("%s: upstream saw %+v, want %+v", tc.name, got, want)
		}
		used, misdirected := h.counts()
		if fmt.Sprint(used) != fmt.Sprint(nonNil(tc.used)) || fmt.Sprint(misdirected) != fmt.Sprint(nonNil(tc.misdirected)) {
			t.Errorf("%s: counted used %v misdirected %v, want used %v misdirected %v", tc.name, used, misdirected, nonNil(tc.used), nonNil(tc.misdirected))
		}
	}
	if got := h.hits.Load(); got != int32(len(cases)) {
		t.Errorf("upstream hits %d, want %d", got, len(cases))
	}
	for _, to := range h.dials() {
		if to != credentialDst {
			t.Errorf("a credential request dialled %s, want the SNI's address %s", to, credentialDst)
		}
	}
}

func nonNil(m map[string]int) map[string]int {
	if m == nil {
		return map[string]int{}
	}
	return m
}

func TestTheProxySwapsOverHTTP2(t *testing.T) {
	bound := testKey("E")
	h := newHarness(t, map[string]Credential{bound: {Value: "real-h2", Hosts: []string{credentialHost}}}, credentialDst)
	resp, got := h.send(h.client(true), "", map[string]string{"X-Api-Key": bound})
	if resp.ProtoMajor != 2 {
		t.Fatalf("client spoke %s to the proxy, want HTTP/2", resp.Proto)
	}
	if got.APIKey != "real-h2" {
		t.Errorf("upstream saw x-api-key %q, want the value", got.APIKey)
	}
	if used, _ := h.counts(); used[bound] != 1 {
		t.Errorf("used %v, want the placeholder once", used)
	}
}

func TestTheProxyRefusesAnUnknownPlaceholderWithoutForwardingIt(t *testing.T) {
	bound, unknown := testKey("F"), testKey("G")
	h := newHarness(t, map[string]Credential{bound: {Value: "real-bound", Hosts: []string{credentialHost}}}, credentialDst)
	c := h.client(false)
	for _, headers := range []map[string]string{
		{"X-Api-Key": unknown},
		{"Authorization": "Bearer " + unknown},
		{"X-Api-Key": bound, "Authorization": "Bearer " + unknown},
	} {
		resp, _ := h.send(c, "", headers)
		if resp.StatusCode != http.StatusServiceUnavailable || resp.Header.Get("Retry-After") != "2" {
			t.Errorf("%v: status %d, Retry-After %q; want 503 and 2", headers, resp.StatusCode, resp.Header.Get("Retry-After"))
			continue
		}
		var body struct {
			Error struct{ Code, Explanation, Fix string } `json:"error"`
		}
		raw, _ := io.ReadAll(resp.Body)
		if err := json.Unmarshal(raw, &body); err != nil || body.Error.Code != "CREDENTIALS_UNAVAILABLE" || body.Error.Explanation == "" || body.Error.Fix == "" {
			t.Errorf("%v: body %q, want CREDENTIALS_UNAVAILABLE in the API's error envelope", headers, raw)
		}
		if strings.Contains(string(raw), "real-") {
			t.Errorf("%v: the 503 names a value", headers)
		}
	}
	if got := h.hits.Load(); got != 0 {
		t.Errorf("upstream hits %d, want none", got)
	}
	if used, misdirected := h.counts(); len(misdirected) != 0 || len(used) != 0 {
		t.Errorf("counted used %v misdirected %v for refused requests", used, misdirected)
	}
}

func TestTheProxySplicesAnyOtherSNIToItsOriginalDestinationUntouched(t *testing.T) {
	for _, sni := range []string{publicHost, ""} {
		bound := testKey("H")
		h := newHarness(t, map[string]Credential{bound: {Value: "real-bound", Hosts: []string{credentialHost, publicHost}}}, publicDst)
		cfg := &tls.Config{ServerName: sni, RootCAs: caPool(h.publicCA)}
		if sni == "" {
			cfg.InsecureSkipVerify = true
		}
		conn, err := tls.Dial("tcp", h.addr, cfg)
		if err != nil {
			t.Fatalf("SNI %q: handshake through the proxy: %v", sni, err)
		}
		want, err := h.publicCA.Leaf(publicHost, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		if got := conn.ConnectionState().PeerCertificates[0]; !got.Equal(want.Leaf) {
			t.Errorf("SNI %q: the client saw %s from %s, want the upstream's own certificate", sni, got.Subject, got.Issuer)
		}
		_ = conn.SetDeadline(time.Now().Add(waitLimit))
		fmt.Fprintf(conn, "GET / HTTP/1.1\r\nHost: %s\r\nX-Api-Key: %s\r\nConnection: close\r\n\r\n", publicHost, bound)
		resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
		if err != nil {
			t.Fatalf("SNI %q: %v", sni, err)
		}
		var got seen
		_ = json.NewDecoder(resp.Body).Decode(&got)
		resp.Body.Close()
		conn.Close()
		if got.APIKey != bound {
			t.Errorf("SNI %q: the spliced upstream saw x-api-key %q, want the placeholder", sni, got.APIKey)
		}
		if h.publicHits.Load() != 1 || h.hits.Load() != 0 {
			t.Errorf("SNI %q: public hits %d, credential hits %d; want 1 and 0", sni, h.publicHits.Load(), h.hits.Load())
		}
		if dialed := h.dials(); len(dialed) != 1 || dialed[0] != publicDst {
			t.Errorf("SNI %q: dialled %v, want only the original destination %s", sni, dialed, publicDst)
		}
		if used, misdirected := h.counts(); len(used) != 0 || len(misdirected) != 0 {
			t.Errorf("SNI %q: counted used %v misdirected %v for a spliced connection", sni, used, misdirected)
		}
	}
}

func TestTheProxyServesTheSNIsLeafFromTheMachinesCA(t *testing.T) {
	h := newHarness(t, nil, credentialDst)
	conn, err := tls.Dial("tcp", h.addr, &tls.Config{ServerName: credentialHost, RootCAs: caPool(h.proxyCA)})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	leaf := conn.ConnectionState().PeerCertificates[0]
	if len(leaf.DNSNames) != 1 || leaf.DNSNames[0] != credentialHost || len(leaf.IPAddresses) != 0 {
		t.Errorf("leaf names %v %v, want only %s", leaf.DNSNames, leaf.IPAddresses, credentialHost)
	}
	if err := leaf.CheckSignatureFrom(h.proxyCA.Cert); err != nil {
		t.Errorf("leaf is not signed by the machine's CA: %v", err)
	}
}

func readLine(t *testing.T, r *bufio.Reader, what string) string {
	t.Helper()
	got := make(chan string, 1)
	go func() {
		line, _ := r.ReadString('\n')
		got <- line
	}()
	select {
	case line := <-got:
		return line
	case <-time.After(waitLimit / 2):
		t.Fatalf("%s did not arrive before the upstream finished", what)
		return ""
	}
}

func TestTheProxyFlushesStreamedResponsesAsTheyArrive(t *testing.T) {
	for _, tc := range []struct{ path, first, second string }{
		{"/sse", "data: one\n", "data: two\n"},
		{"/sized", "one\n", "two\n"},
	} {
		h := newHarness(t, nil, credentialDst)
		resp, err := h.client(false).Get("https://" + credentialHost + tc.path)
		if err != nil {
			t.Fatal(err)
		}
		r := bufio.NewReader(resp.Body)
		if line := readLine(t, r, tc.path+"'s first chunk"); line != tc.first {
			t.Errorf("%s: first line %q, want %q", tc.path, line, tc.first)
		}
		close(h.release)
		rest, _ := io.ReadAll(r)
		resp.Body.Close()
		if !strings.Contains(string(rest), strings.TrimSuffix(tc.second, "\n")) {
			t.Errorf("%s: rest %q, want %q", tc.path, rest, tc.second)
		}
	}
}

func TestAWebSocketUpgradeCarriesTheSwappedHeader(t *testing.T) {
	bound := testKey("J")
	h := newHarness(t, map[string]Credential{bound: {Value: "real-ws", Hosts: []string{credentialHost}}}, credentialDst)
	conn, err := tls.Dial("tcp", h.addr, &tls.Config{ServerName: credentialHost, RootCAs: caPool(h.proxyCA), NextProtos: []string{"http/1.1"}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(waitLimit))
	fmt.Fprintf(conn, "GET /ws HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nX-Api-Key: %s\r\n\r\n", credentialHost, bound)
	r := bufio.NewReader(conn)
	resp, err := http.ReadResponse(r, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status %d (%q), want 101", resp.StatusCode, body)
	}
	if line, _ := r.ReadString('\n'); line != "real-ws\n" {
		t.Errorf("the upgrade reached the upstream with x-api-key %q, want the value", strings.TrimSpace(line))
	}
	fmt.Fprint(conn, "ping\n")
	if line, _ := r.ReadString('\n'); line != "echo ping\n" {
		t.Errorf("after the upgrade the client read %q, want the echo", line)
	}
	if used, misdirected := h.counts(); used[bound] != 1 || len(misdirected) != 0 {
		t.Errorf("counted used %v misdirected %v, want the placeholder used once", used, misdirected)
	}
}
