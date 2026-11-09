//go:build linux

package deploy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strconv"
	"testing"
	"time"

	"github.com/harshjv/stationly/go/internal/protocol"
)

func probeHost(t *testing.T, spec *protocol.ContainerSpecHealth) string {
	t.Helper()
	var seen string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Host
	}))
	defer srv.Close()
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatal(err)
	}
	ports := []protocol.ContainerPort{{Port: port, Protocol: protocol.PortProtocolHttp}}
	rule := ruleFor(spec, ports)
	rule.timeout = 2 * time.Second
	ok, result := probe(context.Background(), rule, netip.MustParseAddr("127.0.0.1"))
	if !ok {
		t.Fatalf("probe failed: %s", result)
	}
	return seen
}

func TestHTTPProbeSendsConfiguredHost(t *testing.T) {
	host := "bugsink.example.com"
	got := probeHost(t, &protocol.ContainerSpecHealth{Type: "http", Host: &host})
	if got != host {
		t.Fatalf("Host = %q, want %q", got, host)
	}
}

func TestHTTPProbeWithoutHostFallsBackToTargetAddress(t *testing.T) {
	got := probeHost(t, &protocol.ContainerSpecHealth{Type: "http"})
	if len(got) < 9 || got[:9] != "127.0.0.1" {
		t.Fatalf("Host = %q, want the target address", got)
	}
}
