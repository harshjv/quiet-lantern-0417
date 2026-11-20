//go:build linux

package deploy

import (
	"strings"
	"testing"

	"github.com/harshjv/stationly/go/internal/protocol"
)

const (
	dispatchVIP = "100.64.0.1"
	testDigest  = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
)

func dispatchRoute(hostname string) doc {
	return doc{
		"hash":     testDigest,
		"hostname": hostname,
		"target":   doc{"system": "dispatch", "virtual_ip": dispatchVIP, "port": 7901},
	}
}

func withDispatch(routes map[string]doc) func(d doc) {
	return func(d doc) {
		at(d, "station")["hosts_dispatch"] = true
		d["system_targets"] = doc{"dispatch": doc{"hash": testDigest, "component": "dispatch", "virtual_ip": dispatchVIP, "port": 7901}}
		rs := at(d, "gateway", "routes")
		for id, r := range routes {
			rs[id] = r
		}
	}
}

func hostnameRoutes() map[string]doc {
	return map[string]doc{
		"system-api":       dispatchRoute("api.sly.test"),
		"system-dashboard": dispatchRoute("dash.sly.test"),
	}
}

func edits(fs ...func(d doc)) func(d doc) {
	return func(d doc) {
		for _, f := range fs {
			f(d)
		}
	}
}

func TestDispatchHostnamesBecomeSystemRoutesToDispatchsVirtualIP(t *testing.T) {
	p := mustBuild(t, withDispatch(hostnameRoutes()))
	gp := p.Gateway
	if len(gp.Routes) != 2 {
		t.Fatalf("routes %+v", gp.Routes)
	}
	for _, rp := range gp.Routes {
		if rp.System != systemDispatch || rp.ServiceID != "" || rp.Upstream.String() != dispatchVIP+":7901" {
			t.Errorf("route %s: %+v", rp.ID, rp)
		}
		cfg := string(rp.Config)
		if !strings.Contains(cfg, "http://"+dispatchVIP+":7901") || !strings.Contains(cfg, "ClientIP(`"+gp.Cloudflared.String()+"/32`)") {
			t.Errorf("route %s config:\n%s", rp.ID, cfg)
		}
	}
	st, ok := gp.SystemTargets[systemDispatch]
	if !ok || st.VIP.String() != dispatchVIP || st.Port != 7901 {
		t.Fatalf("system targets %+v", gp.SystemTargets)
	}
}

func TestARouteMayNotCarryAnIPAddress(t *testing.T) {
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "is an IP address", withDispatch(map[string]doc{"system-address": dispatchRoute("198.51.100.10")}))
}

func TestTheDispatchSystemTargetNeedsAStationThatHostsDispatch(t *testing.T) {
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "hosts_dispatch", edits(withDispatch(hostnameRoutes()), func(d doc) { at(d, "station")["hosts_dispatch"] = false }))
}

func TestTheDispatchVirtualIPMayNotBeAServicesAddress(t *testing.T) {
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "unique across the instance", edits(withDispatch(nil), func(d doc) {
		at(d, "system_targets", "dispatch")["virtual_ip"] = "100.64.10.2"
	}))
}

func TestTheDispatchSystemTargetUsesDispatchsPort(t *testing.T) {
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "7901", edits(withDispatch(nil), func(d doc) {
		at(d, "system_targets", "dispatch")["port"] = 8080
	}))
}

func TestOnlyTheDispatchSystemTargetExists(t *testing.T) {
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "the only system target", edits(withDispatch(nil), func(d doc) {
		d["system_targets"].(doc)["gateway"] = doc{"hash": testDigest, "component": "gateway", "virtual_ip": "100.64.0.3", "port": 80}
	}))
}

func TestASystemRouteMustMatchTheSystemTarget(t *testing.T) {
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "system_targets does not match", edits(withDispatch(hostnameRoutes()), func(d doc) {
		at(d, "gateway", "routes", "system-api", "target")["virtual_ip"] = "100.64.0.9"
	}))
}

func TestTwoRoutesMayNotShareADispatchHostname(t *testing.T) {
	routes := hostnameRoutes()
	routes["system-api"]["hostname"] = "dash.sly.test"
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "share hostname", withDispatch(routes))
}
