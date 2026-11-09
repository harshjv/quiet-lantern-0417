//go:build linux

package deploy

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/harshjv/stationly/go/internal/gateway"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/verify"
)

const (
	publicAddress = "198.51.100.10"
	dispatchVIP   = "100.64.0.1"
	testDigest    = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
)

func dispatchRoute(hostname, resolver string) doc {
	return doc{
		"hash":          testDigest,
		"hostname":      hostname,
		"ingress":       "direct",
		"target":        doc{"system": "dispatch", "virtual_ip": dispatchVIP, "port": 7900},
		"tls":           doc{"resolver": resolver},
		"redirect_http": true,
	}
}

func withDispatch(routes map[string]doc) func(d doc) {
	return func(d doc) {
		st := at(d, "station")
		st["hosts_dispatch"] = true
		st["public_address"] = publicAddress
		if len(routes) > 0 {
			at(d, "station", "inbound")["web_ports"] = "open"
		}
		d["system_targets"] = doc{"dispatch": doc{"hash": testDigest, "component": "dispatch", "virtual_ip": dispatchVIP, "port": 7900}}
		rs := at(d, "gateway", "routes")
		for id, r := range routes {
			rs[id] = r
		}
	}
}

func hostnameRoutes() map[string]doc {
	return map[string]doc{
		"system-api":       dispatchRoute("api.sly.test", "letsencrypt"),
		"system-dashboard": dispatchRoute("dash.sly.test", "letsencrypt"),
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
		if rp.System != systemDispatch || rp.ServiceID != "" || !rp.Direct || rp.Resolver != gateway.ResolverClassic || rp.Upstream.String() != dispatchVIP+":7900" {
			t.Errorf("route %s: %+v", rp.ID, rp)
		}
		cfg := string(rp.Config)
		if !strings.Contains(cfg, "http://"+dispatchVIP+":7900") || !strings.Contains(cfg, rp.ID+"-redirect") || !strings.Contains(cfg, "certResolver: letsencrypt\n") {
			t.Errorf("route %s config:\n%s", rp.ID, cfg)
		}
		if strings.Contains(cfg, "defaultGeneratedCert") {
			t.Errorf("route %s sets the default certificate:\n%s", rp.ID, cfg)
		}
	}
	st, ok := gp.SystemTargets[systemDispatch]
	if !ok || st.VIP.String() != dispatchVIP || st.Port != 7900 {
		t.Fatalf("system targets %+v", gp.SystemTargets)
	}
}

func TestADomainlessStationRoutesItsAddressWithTheShortlivedResolverAndDefaultCertificate(t *testing.T) {
	p := mustBuild(t, withDispatch(map[string]doc{"system-address": dispatchRoute(publicAddress, "letsencrypt-shortlived")}))
	rp := p.Gateway.Routes[0]
	if rp.Resolver != gateway.ResolverShortlived || rp.Hostname != publicAddress {
		t.Fatalf("route %+v", rp)
	}
	cfg := string(rp.Config)
	for _, want := range []string{"defaultGeneratedCert", "resolver: letsencrypt-shortlived", "main: " + publicAddress} {
		if !strings.Contains(cfg, want) {
			t.Errorf("config lacks %q:\n%s", want, cfg)
		}
	}
}

func TestTheAddressRouteRefusesTheClassicResolver(t *testing.T) {
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "letsencrypt-shortlived", withDispatch(map[string]doc{"system-address": dispatchRoute(publicAddress, "letsencrypt")}))
}

func TestSystemRoutesNeedTheStationPublicAddress(t *testing.T) {
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "public_address", edits(withDispatch(hostnameRoutes()), func(d doc) { at(d, "station")["public_address"] = nil }))
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
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "7900", edits(withDispatch(nil), func(d doc) {
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

func testRoot(t *testing.T) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test ACME root"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

func testTrust(t *testing.T, extra map[string]any) verify.Trust {
	t.Helper()
	doc := map[string]any{
		"name":                  "ci",
		"identity":              map[string]any{"san_regex": "^x$", "issuer": "https://issuer.test"},
		"signatures_repository": "registry.test/signatures",
		"tuf_mirror":            "https://tuf.test",
		"releases_repository":   "registry.test/stationly/release",
		"tuf_root":              json.RawMessage(`{"signed":{}}`),
	}
	for k, v := range extra {
		doc[k] = v
	}
	b, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	tr, err := verify.ParseTestTrust(b, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return tr
}

func planWith(t *testing.T, trust verify.Trust, edit func(d doc)) *GatewayPlan {
	t.Helper()
	p, err := BuildPlan(generation(t, edit), nil, t.TempDir(), trust)
	if err != nil {
		t.Fatal(err)
	}
	return p.Gateway
}

func TestTheACMEDirectoryFollowsTheInstallsTrust(t *testing.T) {
	pebble := "https://198.51.100.20/dir"
	cases := []struct {
		name    string
		trust   verify.Trust
		setting any
		want    string
	}{
		{"production, no setting", verify.ReleaseTrust(), nil, ""},
		{"production, setting", verify.ReleaseTrust(), "https://acme.example/dir", "https://acme.example/dir"},
		{"test, no setting", testTrust(t, nil), nil, verify.LetsEncryptStaging},
		{"test trust naming pebble", testTrust(t, map[string]any{"acme_ca_server": pebble}), nil, pebble},
		{"test, production setting", testTrust(t, nil), verify.LetsEncryptProduction, verify.LetsEncryptStaging},
	}
	for _, c := range cases {
		gp := planWith(t, c.trust, func(d doc) { at(d, "gateway", "acme")["ca_server"] = c.setting })
		if gp.Static.CAServer != c.want {
			t.Errorf("%s: caServer %q, want %q", c.name, gp.Static.CAServer, c.want)
		}
	}
}

func TestATestTrustsACMERootsReachTheResolversAndTheGatewayInputs(t *testing.T) {
	root := testRoot(t)
	plain := planWith(t, testTrust(t, map[string]any{"acme_ca_server": "https://198.51.100.20/dir"}), nil)
	withRoots := planWith(t, testTrust(t, map[string]any{"acme_ca_server": "https://198.51.100.20/dir", "acme_ca_certificates": root}), nil)
	if plain.Static.CACertificates || len(plain.ACMERoots) != 0 {
		t.Fatalf("no roots configured but plan has %+v", plain.Static)
	}
	if !withRoots.Static.CACertificates || string(withRoots.ACMERoots) != root {
		t.Fatalf("roots did not reach the plan: %+v", withRoots.Static)
	}
	if plain.Inputs == withRoots.Inputs {
		t.Fatal("adding ACME roots must change the Gateway inputs, so the Gateway restarts through its upgrade procedure")
	}
	other := planWith(t, testTrust(t, map[string]any{"acme_ca_server": "https://198.51.100.20/dir", "acme_ca_certificates": testRoot(t)}), nil)
	if other.Inputs == withRoots.Inputs {
		t.Fatal("different ACME roots must change the Gateway inputs")
	}
	body, err := gateway.StaticConfig(withRoots.Static, withRoots.ClassicHours)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), gateway.DataTarget+"/"+gateway.CAFileName) {
		t.Fatalf("static config lacks caCertificates:\n%s", body)
	}
}

func TestTheProductionTrustNeverCarriesACMERoots(t *testing.T) {
	gp := planWith(t, verify.ReleaseTrust(), nil)
	if gp.Static.CACertificates || gp.ACMERoots != nil {
		t.Fatalf("%+v", gp.Static)
	}
}
