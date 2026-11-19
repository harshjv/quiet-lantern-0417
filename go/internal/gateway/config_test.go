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

var testCloudflared = netip.MustParseAddr("10.200.1.2")

func TestATunnelRouteMatchesItsHostnameOnlyFromCloudflared(t *testing.T) {
	body, err := RouteConfig(Route{ID: "system-dashboard", Hostname: "dash.sly.test", Upstream: netip.MustParseAddrPort("100.64.0.1:7900"), Cloudflared: testCloudflared})
	if err != nil {
		t.Fatal(err)
	}
	doc := parse(t, body)
	router := dig(t, doc, "http", "routers", "system-dashboard").(map[string]any)
	if router["rule"] != "Host(`dash.sly.test`) && ClientIP(`10.200.1.2/32`)" {
		t.Errorf("rule %v", router["rule"])
	}
	if eps := router["entryPoints"].([]any); len(eps) != 1 || eps[0] != "web" {
		t.Errorf("entrypoints %v", eps)
	}
	servers := dig(t, doc, "http", "services", "system-dashboard", "loadBalancer", "servers").([]any)
	if len(servers) != 1 || servers[0].(map[string]any)["url"] != "http://100.64.0.1:7900" {
		t.Errorf("servers %v", servers)
	}
	if dig(t, doc, "http", "services", "system-dashboard", "loadBalancer", "passHostHeader") != true {
		t.Error("the Host header must reach Dispatch, which splits the surfaces by Host")
	}
	if has(doc, "tls") || has(doc, "http", "middlewares") {
		t.Errorf("a tunnel route carries no tls and no middlewares: %v", doc)
	}
}

func TestARouteWithoutTheCloudflaredAddressIsRefused(t *testing.T) {
	if _, err := RouteConfig(Route{ID: "r", Hostname: "a.sly.test", Upstream: netip.MustParseAddrPort("100.64.0.1:80")}); err == nil {
		t.Fatal("a route must name the cloudflared address it trusts")
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

func TestTheWebEntryPointBoundsTimeoutsKeepAlivesStreamsAndHeaders(t *testing.T) {
	body, err := StaticConfig(testCloudflared)
	if err != nil {
		t.Fatal(err)
	}
	doc := parse(t, body)
	for _, ep := range []string{"web"} {
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
	if has(doc, "entryPoints", "websecure") || has(doc, "certificatesResolvers") {
		t.Error("the Gateway serves plain HTTP to cloudflared only and holds no certificates")
	}
	if got := dig(t, doc, "entryPoints", "web", "forwardedHeaders", "trustedIPs").([]any); len(got) != 1 || got[0] != "10.200.1.2/32" {
		t.Errorf("forwarded headers must trust cloudflared alone, got %v", got)
	}
}

func TestTheIdleTimeoutOutlastsCloudflaredsOriginKeepAlive(t *testing.T) {
	if IdleTimeout <= 90*time.Second {
		t.Fatalf("idle timeout %s must exceed cloudflared's 90s origin keepalive or reused connections reset", IdleTimeout)
	}
}

func TestResponsesAreNeverCutByAWriteTimeout(t *testing.T) {
	body, err := StaticConfig(testCloudflared)
	if err != nil {
		t.Fatal(err)
	}
	if got := dig(t, parse(t, body), "entryPoints", "web", "transport", "respondingTimeouts", "writeTimeout"); got != "0s" {
		t.Fatalf("writeTimeout %v would cut SSE and large downloads", got)
	}
}

func TestAccessLogsAreBufferedSoTheyNeverBlockRequestsUnderLoad(t *testing.T) {
	body, err := StaticConfig(testCloudflared)
	if err != nil {
		t.Fatal(err)
	}
	if got := dig(t, parse(t, body), "accessLog", "bufferingSize"); got != uint64(256) {
		t.Fatalf("bufferingSize %v", got)
	}
}
