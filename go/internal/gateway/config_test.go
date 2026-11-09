package gateway

import (
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/goccy/go-yaml"
)

type tree = map[string]any

func parse(t *testing.T, body []byte) tree {
	t.Helper()
	var out tree
	if err := yaml.Unmarshal(body, &out); err != nil {
		t.Fatalf("%v\n%s", err, body)
	}
	return out
}

func dig(t *testing.T, m tree, path ...string) any {
	t.Helper()
	var cur any = m
	for _, p := range path {
		next, ok := cur.(map[string]any)
		if !ok {
			t.Fatalf("%v: %q is not a map", path, p)
		}
		if cur, ok = next[p]; !ok {
			t.Fatalf("%v: no key %q", path, p)
		}
	}
	return cur
}

func has(m tree, path ...string) bool {
	var cur any = m
	for _, p := range path {
		next, ok := cur.(map[string]any)
		if !ok {
			return false
		}
		if cur, ok = next[p]; !ok {
			return false
		}
	}
	return true
}

func TestBothResolversExistWithTheShortlivedProfileOnlyOnTheSecond(t *testing.T) {
	body, err := StaticConfig(Static{CAServer: "https://acme.test/dir", Store: 3}, 2160)
	if err != nil {
		t.Fatal(err)
	}
	doc := parse(t, body)
	classic := dig(t, doc, "certificatesResolvers", ResolverClassic, "acme").(map[string]any)
	short := dig(t, doc, "certificatesResolvers", ResolverShortlived, "acme").(map[string]any)
	if _, ok := classic["profile"]; ok {
		t.Errorf("classic resolver carries a profile: %v", classic)
	}
	if short["profile"] != "shortlived" || short["disableCommonName"] != true || toInt(short["certificatesDuration"]) != ShortlivedHours {
		t.Errorf("shortlived resolver %v", short)
	}
	for _, r := range []map[string]any{classic, short} {
		if r["caServer"] != "https://acme.test/dir" || r["storage"] != "/data/acme.3.json" || r["keyType"] != KeyType {
			t.Errorf("resolver %v", r)
		}
		if _, ok := r["caCertificates"]; ok {
			t.Errorf("resolver names CA certificates without any: %v", r)
		}
	}
}

func TestCACertificatesAddTheFileOnTopOfTheSystemPool(t *testing.T) {
	body, err := StaticConfig(Static{CAServer: "https://pebble.test/dir", CACertificates: true}, 2160)
	if err != nil {
		t.Fatal(err)
	}
	doc := parse(t, body)
	for _, name := range []string{ResolverClassic, ResolverShortlived} {
		r := dig(t, doc, "certificatesResolvers", name, "acme").(map[string]any)
		files, _ := r["caCertificates"].([]any)
		if len(files) != 1 || files[0] != DataTarget+"/"+CAFileName || r["caSystemCertPool"] != true {
			t.Errorf("%s: %v", name, r)
		}
	}
}

func TestADispatchHostnameRouteRedirectsAndTerminatesTLSWithTheClassicResolver(t *testing.T) {
	body, err := RouteConfig(Route{ID: "system-dashboard", Hostname: "dash.sly.test", Upstream: netip.MustParseAddrPort("100.64.0.1:7900"), Resolver: ResolverClassic, RedirectHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	doc := parse(t, body)
	redirect := dig(t, doc, "http", "routers", "system-dashboard-redirect").(map[string]any)
	if redirect["rule"] != "Host(`dash.sly.test`)" || redirect["service"] != "noop@internal" || dig(t, doc, "http", "middlewares", "system-dashboard-https", "redirectScheme", "permanent") != true {
		t.Errorf("redirect %v", redirect)
	}
	secure := dig(t, doc, "http", "routers", "system-dashboard").(map[string]any)
	if eps := secure["entryPoints"].([]any); len(eps) != 1 || eps[0] != "websecure" {
		t.Errorf("entrypoints %v", eps)
	}
	if dig(t, doc, "http", "routers", "system-dashboard", "tls", "certResolver") != ResolverClassic {
		t.Errorf("tls %v", secure["tls"])
	}
	servers := dig(t, doc, "http", "services", "system-dashboard", "loadBalancer", "servers").([]any)
	if len(servers) != 1 || servers[0].(map[string]any)["url"] != "http://100.64.0.1:7900" {
		t.Errorf("servers %v", servers)
	}
	if dig(t, doc, "http", "services", "system-dashboard", "loadBalancer", "passHostHeader") != true {
		t.Error("the Host header must reach Dispatch, which splits the surfaces by Host")
	}
	if has(doc, "tls") {
		t.Errorf("a hostname route must not set the default certificate: %v", doc["tls"])
	}
}

func TestTheAddressRouteSetsTheDefaultGeneratedCertificateForClientsWithoutSNI(t *testing.T) {
	body, err := RouteConfig(Route{ID: "system-address", Hostname: "198.51.100.10", Upstream: netip.MustParseAddrPort("100.64.0.1:7900"), Resolver: ResolverShortlived, RedirectHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	doc := parse(t, body)
	def := dig(t, doc, "tls", "stores", "default", "defaultGeneratedCert").(map[string]any)
	if def["resolver"] != ResolverShortlived || dig(t, doc, "tls", "stores", "default", "defaultGeneratedCert", "domain", "main") != "198.51.100.10" {
		t.Errorf("defaultGeneratedCert %v", def)
	}
	if dig(t, doc, "http", "routers", "system-address", "tls", "certResolver") != ResolverShortlived {
		t.Error("the address router must order from the shortlived resolver")
	}
}

func toInt(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case uint64:
		return int(n)
	case int64:
		return int(n)
	case float64:
		return int(n)
	}
	return -1
}

func TestBothPublicEntryPointsBoundTimeoutsKeepAlivesStreamsAndHeaders(t *testing.T) {
	body, err := StaticConfig(Static{Store: 1}, 2160)
	if err != nil {
		t.Fatal(err)
	}
	doc := parse(t, body)
	for _, ep := range []string{"web", "websecure"} {
		want := map[string]any{
			"transport.respondingTimeouts.readTimeout":  "1m0s",
			"transport.respondingTimeouts.writeTimeout": "0s",
			"transport.respondingTimeouts.idleTimeout":  "2m0s",
			"transport.keepAliveMaxTime":                "10m0s",
			"transport.keepAliveMaxRequests":            uint64(10000),
			"http2.maxConcurrentStreams":                uint64(100),
			"http.maxHeaderBytes":                       uint64(65536),
			"http.maxHeaderValueCount":                  uint64(100),
		}
		for path, v := range want {
			parts := append([]string{"entryPoints", ep}, strings.Split(path, ".")...)
			if got := dig(t, doc, parts...); got != v {
				t.Errorf("%s %s = %v (%T), want %v", ep, path, got, got, v)
			}
		}
	}
	if has(doc, "entryPoints", "traefik", "transport") {
		t.Error("the unpublished ping entrypoint takes no transport limits")
	}
}

func TestTheIdleTimeoutOutlastsCloudflaredsOriginKeepAlive(t *testing.T) {
	if IdleTimeout <= 90*time.Second {
		t.Fatalf("idle timeout %s must exceed cloudflared's 90s origin keepalive or reused connections reset", IdleTimeout)
	}
}

func TestResponsesAreNeverCutByAWriteTimeout(t *testing.T) {
	body, err := StaticConfig(Static{Store: 1}, 2160)
	if err != nil {
		t.Fatal(err)
	}
	if got := dig(t, parse(t, body), "entryPoints", "websecure", "transport", "respondingTimeouts", "writeTimeout"); got != "0s" {
		t.Fatalf("writeTimeout %v would cut SSE and large downloads", got)
	}
}

func TestAccessLogsAreBufferedSoTheyNeverBlockRequestsUnderLoad(t *testing.T) {
	body, err := StaticConfig(Static{Store: 1}, 2160)
	if err != nil {
		t.Fatal(err)
	}
	if got := dig(t, parse(t, body), "accessLog", "bufferingSize"); got != uint64(256) {
		t.Fatalf("bufferingSize %v", got)
	}
}
