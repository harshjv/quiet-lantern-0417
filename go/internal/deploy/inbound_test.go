//go:build linux

package deploy

import (
	"io"
	"log/slog"
	"net/netip"
	"reflect"
	"testing"

	"github.com/harshjv/stationly/go/internal/netns"
)

const (
	domainRouteID = "dom_01JCWH0AM1AAAAAAAAAAAAAAAA"
	alphaVIP      = "100.64.10.2"
)

func withServiceRoute(d doc) {
	at(d, "gateway", "routes")[domainRouteID] = doc{
		"hash":     testDigest,
		"hostname": "web.sly.test",
		"target":   doc{"service_id": alphaWhoami, "virtual_ip": alphaVIP, "port": 8080},
	}
}

func hostLayoutOf(p *Plan) netns.HostLayout {
	s := &Station{log: slog.New(slog.NewTextHandler(io.Discard, nil)), plan: p}
	s.gw.ingressID = "ingress"
	return s.hostLayout()
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
	before := mustBuild(t, withServiceRoute)
	after := mustBuild(t, edits(withServiceRoute, variableChange))
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
