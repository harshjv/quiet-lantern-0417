//go:build linux

package deploy

import (
	"io"
	"log/slog"
	"net/netip"
	"reflect"
	"testing"

	"github.com/harshjv/stationly/go/internal/netns"
	"github.com/harshjv/stationly/go/internal/protocol"
)

const (
	domainRouteID = "dom_01JCWH0AM1AAAAAAAAAAAAAAAA"
	alphaVIP      = "100.64.10.2"
)

func serviceRoute(ingress string) doc {
	r := doc{
		"hash":          testDigest,
		"hostname":      "web.sly.test",
		"ingress":       ingress,
		"target":        doc{"service_id": alphaWhoami, "virtual_ip": alphaVIP, "port": 8080},
		"tls":           nil,
		"redirect_http": false,
	}
	if ingress == "direct" {
		r["tls"] = doc{"resolver": "letsencrypt"}
		r["redirect_http"] = true
	}
	return r
}

func withPublicAddress(d doc) {
	at(d, "station")["public_address"] = publicAddress
}

func withServiceRoute(ingress, webPorts string) func(d doc) {
	return func(d doc) {
		withPublicAddress(d)
		at(d, "gateway", "routes")[domainRouteID] = serviceRoute(ingress)
		at(d, "station", "inbound")["web_ports"] = webPorts
	}
}

func hostLayoutOf(p *Plan) netns.HostLayout {
	s := &Station{log: slog.New(slog.NewTextHandler(io.Discard, nil)), plan: p}
	s.gw.ingressID = "ingress"
	return s.hostLayout()
}

func TestAStationWithoutADirectRouteKeepsTheWebPortsClosed(t *testing.T) {
	p := mustBuild(t, withPublicAddress)
	if p.Gateway.WebOpen || hostLayoutOf(p).WebOpen {
		t.Fatal("with no direct route the host layout must close 80 and 443")
	}
}

func TestATunnelRouteAloneKeepsTheWebPortsClosed(t *testing.T) {
	p := mustBuild(t, withServiceRoute("tunnel", "closed"))
	if hostLayoutOf(p).WebOpen {
		t.Fatal("a tunnel route arrives through cloudflared, never on the public 80 and 443")
	}
}

func TestADirectDomainOpensTheWebPortsAndRemovingItClosesThem(t *testing.T) {
	none := hostLayoutOf(mustBuild(t, withPublicAddress))
	with := hostLayoutOf(mustBuild(t, withServiceRoute("direct", "open")))
	removed := hostLayoutOf(mustBuild(t, withPublicAddress))
	if none.WebOpen || !with.WebOpen || removed.WebOpen {
		t.Fatalf("web ports none=%v with=%v removed=%v", none.WebOpen, with.WebOpen, removed.WebOpen)
	}
	if !reflect.DeepEqual(none, removed) {
		t.Fatalf("removing the last direct route must return the host layout to the closed one\nbefore %+v\nafter  %+v", none, removed)
	}
}

func TestTheDomainlessAddressRouteIsADirectRouteThatOpensTheWebPorts(t *testing.T) {
	p := mustBuild(t, withDispatch(map[string]doc{"system-address": dispatchRoute(publicAddress, "letsencrypt-shortlived")}))
	if !hostLayoutOf(p).WebOpen {
		t.Fatal("system-address serves Dispatch on https://<public address>, so 80 and 443 must be open")
	}
}

func TestWebPortsThatDisagreeWithTheRoutesRejectTheGeneration(t *testing.T) {
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "web_ports is closed but must be open", withServiceRoute("direct", "closed"))
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "web_ports is open but must be closed", func(d doc) {
		withPublicAddress(d)
		at(d, "station", "inbound")["web_ports"] = "open"
	})
}

func variableChange(d doc) {
	dep := deploymentDoc(d, alphaWhoami, 2, false)
	target := dep["target"].(map[string]any)
	env := target["env"].([]any)
	env[0].(map[string]any)["value"] = "rotated"
	target["env_digest"] = "sha256:" + testDigest[len("sha256:"):]
	addDeployment(d, "dep_01JCWH0AM1AAAAAAAAAAAAAAA2", dep)
}

func TestAVariableChangeRolloutKeepsEveryNamespaceLayout(t *testing.T) {
	routes := withServiceRoute("direct", "open")
	before := mustBuild(t, routes)
	after := mustBuild(t, edits(routes, variableChange))
	if len(after.Generation.Deployments) != 1 {
		t.Fatalf("the variable change must arrive as one deployment, got %d", len(after.Generation.Deployments))
	}
	if b, a := hostLayoutOf(before), hostLayoutOf(after); !reflect.DeepEqual(b, a) {
		t.Fatalf("a variable change must leave the host table's layout alone, so cutover only swaps switch elements\nbefore %+v\nafter  %+v", b, a)
	}
	self := netip.MustParseAddr("10.200.16.4")
	for envID := range before.Generation.Environments {
		bs := &Station{plan: before}
		as := &Station{plan: after}
		if b, a := bs.nsBaseline(envID, self), as.nsBaseline(envID, self); !reflect.DeepEqual(b, a) {
			t.Fatalf("environment %s: a running Coupler's namespace baseline changed with a variable change (%+v to %+v), which rewrites its ruleset during cutover", envID, b, a)
		}
	}
	if before.Gateway.Routes[0].Upstream != after.Gateway.Routes[0].Upstream {
		t.Fatal("the Gateway's upstream is the service's virtual IP and must not move with a deployment")
	}
}
