//go:build linux

package deploy

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/verify"
)

const (
	alphaEnv    = "env_01JCAAAAAAAAAAAAAAAAAAAAAA"
	betaEnv     = "env_01JCBBBBBBBBBBBBBBBBBBBBBB"
	alphaWhoami = "svc_01JCWH0AM1AAAAAAAAAAAAAAAA"
	alphaClient = "svc_01JCC11ENTAAAAAAAAAAAAAAAA"
	betaWhoami  = "svc_01JCWH0AM1BBBBBBBBBBBBBBBB"
)

type doc = map[string]any

func fixtureDoc(t *testing.T) doc {
	t.Helper()
	raw, err := os.ReadFile("../protocol/testdata/generation.json")
	if err != nil {
		t.Fatal(err)
	}
	var d doc
	if err := json.Unmarshal(raw, &d); err != nil {
		t.Fatal(err)
	}
	return d
}

func at(d doc, path ...string) doc {
	cur := d
	for _, p := range path {
		cur = cur[p].(map[string]any)
	}
	return cur
}

func generation(t *testing.T, edit func(d doc)) *protocol.Generation {
	t.Helper()
	d := fixtureDoc(t)
	if edit != nil {
		edit(d)
	}
	raw, err := json.Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	var g protocol.Generation
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatalf("fixture edit no longer matches the schema: %v", err)
	}
	return &g
}

func build(t *testing.T, g *protocol.Generation, applied *protocol.Generation) (*Plan, error) {
	t.Helper()
	return BuildPlan(g, applied, t.TempDir(), verify.ReleaseTrust())
}

func mustBuild(t *testing.T, edit func(d doc)) *Plan {
	t.Helper()
	p, err := build(t, generation(t, edit), nil)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func rejection(t *testing.T, err error) *Rejection {
	t.Helper()
	var rej *Rejection
	if !errors.As(err, &rej) {
		t.Fatalf("want a *Rejection, got %T: %v", err, err)
	}
	return rej
}

func expectRejected(t *testing.T, code protocol.ErrorCode, contains string, edit func(d doc)) {
	t.Helper()
	_, err := build(t, generation(t, edit), nil)
	if err == nil {
		t.Fatalf("generation was accepted, want %s", code)
	}
	rej := rejection(t, err)
	if rej.Body.Code != string(code) {
		t.Fatalf("code %s, want %s (%s)", rej.Body.Code, code, rej.Body.Explanation)
	}
	if !strings.Contains(rej.Body.Explanation, contains) {
		t.Fatalf("explanation %q does not mention %q", rej.Body.Explanation, contains)
	}
	if rej.Body.Fix == "" {
		t.Fatal("a rejection must tell the sender how to fix it")
	}
}

func TestPlanCreatesOneNetworkPerEnvironmentAndOneContainerSetPerRunningService(t *testing.T) {
	p := mustBuild(t, nil)
	if len(p.Networks) != 2 || p.Networks[alphaEnv].Name != "sly-aaaaaaaaaaa" || p.Networks[betaEnv].Name != "sly-bbbbbbbbbbb" {
		t.Fatalf("networks %v", p.Networks)
	}
	if got := p.ServiceIDs(); len(got) != 3 || got[0] > got[1] || got[1] > got[2] {
		t.Fatalf("service ids %v", got)
	}
	for _, id := range p.ServiceIDs() {
		sp := p.Services[id]
		if !sp.Run || !sp.Wanted || sp.Unsupported != nil {
			t.Errorf("%s: run %v wanted %v unsupported %v", id, sp.Run, sp.Wanted, sp.Unsupported)
		}
		if sp.Coupler.Name == "" || sp.Service.Name == "" || sp.Hash != sp.Coupler.Hash+sp.Service.Hash {
			t.Errorf("%s: incomplete container set", id)
		}
	}
	sp := p.Services[alphaWhoami]
	if sp.NetworkName != "sly-aaaaaaaaaaa" || sp.EnvID != alphaEnv || sp.Kind != protocol.ServiceKindWeb {
		t.Fatalf("whoami plan %+v", sp)
	}
}

func TestPlanNamesContainersAfterTheirDeploymentAndPinsTheCouplerByDigest(t *testing.T) {
	p := mustBuild(t, nil)
	sp := p.Services[alphaWhoami]
	if sp.Coupler.Name != docker.CouplerName(sp.DeploymentID) || sp.Service.Name != docker.ServiceName(sp.DeploymentID) {
		t.Fatalf("names %s %s for %s", sp.Coupler.Name, sp.Service.Name, sp.DeploymentID)
	}
	want := protocol.CouplerImageSource + "@sha256:f548e0e8e3dc1896ca956272154dde3314e8cc4fde0a57577ee9fa1c63f5baf4"
	if got := sp.Coupler.Create.Config.Image; got != want {
		t.Fatalf("coupler image %s", got)
	}
}

func TestPlanIsDeterministic(t *testing.T) {
	a, b := mustBuild(t, nil), mustBuild(t, nil)
	for _, id := range a.ServiceIDs() {
		if a.Services[id].Hash != b.Services[id].Hash {
			t.Errorf("%s: hash differs between two plans of one generation", id)
		}
	}
}

func TestServiceWithoutACurrentDeploymentIsCreatedIdleWithNoContainers(t *testing.T) {
	p := mustBuild(t, func(d doc) { at(d, "services", alphaClient)["current"] = nil })
	sp := p.Services[alphaClient]
	if sp.Run || sp.DeploymentID != "" || sp.Coupler.Name != "" || sp.Service.Name != "" || sp.NetworkName != "sly-aaaaaaaaaaa" {
		t.Fatalf("got %+v", sp)
	}
	if !p.Services[alphaWhoami].Run {
		t.Fatal("its neighbour must be unaffected")
	}
}

func TestStoppedServiceKeepsItsPlanButDoesNotRun(t *testing.T) {
	p := mustBuild(t, func(d doc) { at(d, "services", alphaClient)["desired_state"] = "stopped" })
	sp := p.Services[alphaClient]
	if sp.Run || sp.Wanted || sp.Service.Name == "" {
		t.Fatalf("got run %v wanted %v", sp.Run, sp.Wanted)
	}
}

func TestChangingTheImageUpdatesTheServiceContainerAndKeepsTheCoupler(t *testing.T) {
	before := mustBuild(t, nil).Services[alphaWhoami]
	after := mustBuild(t, func(d doc) {
		at(d, "services", alphaWhoami, "current", "spec")["image_ref"] = "docker.io/traefik/whoami@sha256:" + strings.Repeat("a", 64)
	}).Services[alphaWhoami]
	if before.Service.Hash == after.Service.Hash {
		t.Error("a new image must change the service container hash")
	}
	if before.Coupler.Hash != after.Coupler.Hash {
		t.Error("the Coupler holds the namespace and must not change with the image")
	}
}

func TestChangingAnEnvironmentVariableChangesOnlyTheServiceHash(t *testing.T) {
	before := mustBuild(t, nil).Services[alphaWhoami]
	after := mustBuild(t, func(d doc) {
		env := at(d, "services", alphaWhoami, "current", "spec")["env"].([]any)
		env[0].(map[string]any)["value"] = "8080"
	}).Services[alphaWhoami]
	if before.Service.Hash == after.Service.Hash || before.Coupler.Hash != after.Coupler.Hash {
		t.Fatalf("service %v coupler %v", before.Service.Hash == after.Service.Hash, before.Coupler.Hash == after.Coupler.Hash)
	}
}

func TestChangingLimitsChangesTheServiceHash(t *testing.T) {
	before := mustBuild(t, nil).Services[alphaWhoami]
	after := mustBuild(t, func(d doc) {
		at(d, "services", alphaWhoami, "current", "spec", "limits")["memory_bytes"] = float64(134217728)
	}).Services[alphaWhoami]
	if before.Service.Hash == after.Service.Hash {
		t.Fatal("limits are part of the container spec")
	}
}

func TestANewDeploymentReplacesBothContainersUnderNewNames(t *testing.T) {
	before := mustBuild(t, nil).Services[alphaWhoami]
	after := mustBuild(t, func(d doc) {
		cur := at(d, "services", alphaWhoami, "current")
		cur["deployment_id"] = "dep_01JCWH0AM1AAAAAAAAAAAAAAA2"
		cur["number"] = float64(2)
	}).Services[alphaWhoami]
	if before.Coupler.Name == after.Coupler.Name || before.Service.Name == after.Service.Name {
		t.Fatal("a new deployment gets new container names")
	}
	if before.Hash == after.Hash {
		t.Fatal("a replaced set hashes differently")
	}
	if after.DeploymentID != "dep_01JCWH0AM1AAAAAAAAAAAAAAA2" {
		t.Fatalf("deployment %s", after.DeploymentID)
	}
}

func TestChangingTheCouplerImageReplacesTheCouplerOnly(t *testing.T) {
	before := mustBuild(t, nil).Services[alphaWhoami]
	after := mustBuild(t, func(d doc) {
		at(d, "components", "coupler_image")["digest"] = "sha256:" + strings.Repeat("b", 64)
	}).Services[alphaWhoami]
	if before.Coupler.Hash != after.Coupler.Hash {
		t.Error("the Coupler image is excluded from the Coupler hash so an image pin never recreates a namespace")
	}
	if before.Coupler.Create.Config.Image == after.Coupler.Create.Config.Image {
		t.Error("the new digest must reach the container spec")
	}
}

func TestOneOffServicesHaveNoCouplerAndNeverRunAsLongRunningContainers(t *testing.T) {
	p := mustBuild(t, func(d doc) { at(d, "services", alphaClient)["kind"] = "one_off" })
	sp := p.Services[alphaClient]
	if sp.Run || sp.Coupler.Name != "" || sp.Service.Name == "" || sp.Hash != sp.Service.Hash {
		t.Fatalf("got run %v coupler %q service %q", sp.Run, sp.Coupler.Name, sp.Service.Name)
	}
}

func TestHealthCheckOfTypeImageIsReportedAsAMissingCapability(t *testing.T) {
	p := mustBuild(t, func(d doc) {
		spec := at(d, "services", alphaWhoami, "current", "spec")
		spec["health"] = map[string]any{"type": "image", "interval_s": 2, "timeout_s": 1, "startup_timeout_s": 30, "passes": 2, "failures": 3}
	})
	sp := p.Services[alphaWhoami]
	if sp.Run || sp.Unsupported == nil || sp.Unsupported.Code != string(protocol.ErrorCodeStationCapabilityMissing) {
		t.Fatalf("got run %v unsupported %+v", sp.Run, sp.Unsupported)
	}
}

func TestEnvironmentNetworkSpecCarriesTheDeclaredSubnetGatewayAndBridge(t *testing.T) {
	p := mustBuild(t, nil)
	n := p.Networks[alphaEnv]
	if n.Options.Options["com.docker.network.bridge.name"] != "sly-aaaaaaaaaaa" || n.Options.Options["com.docker.network.bridge.gateway_mode_ipv4"] != "nat" {
		t.Fatalf("options %v", n.Options.Options)
	}
	cfg := n.Options.IPAM.Config[0]
	if cfg.Subnet.String() != "10.200.10.0/24" || cfg.Gateway.String() != "10.200.10.1" {
		t.Fatalf("ipam %+v", cfg)
	}
	if p.Networks[alphaEnv].Hash == p.Networks[betaEnv].Hash {
		t.Fatal("different environments must hash differently")
	}
}

func TestAVirtualIPHeldInTwoEnvironmentsRefusesTheWholeGeneration(t *testing.T) {
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "unique across the instance", func(d doc) {
		at(d, "environments", betaEnv)["virtual_ips"].([]any)[0].(map[string]any)["address"] = "100.64.10.2"
	})
}

func TestTheVirtualIPRefusalNamesBothHolders(t *testing.T) {
	_, err := build(t, generation(t, func(d doc) {
		at(d, "environments", betaEnv)["virtual_ips"].([]any)[0].(map[string]any)["address"] = "100.64.10.3"
	}), nil)
	rej := rejection(t, err)
	if !strings.Contains(rej.Body.Explanation, alphaEnv) || !strings.Contains(rej.Body.Explanation, betaEnv) || !strings.Contains(rej.Body.Explanation, "100.64.10.3") {
		t.Fatalf("explanation %q", rej.Body.Explanation)
	}
}

func TestTheSameAddressTwiceInOneEnvironmentIsAlsoRefused(t *testing.T) {
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "100.64.10.2", func(d doc) {
		at(d, "environments", alphaEnv)["virtual_ips"].([]any)[1].(map[string]any)["address"] = "100.64.10.2"
	})
}

func TestServiceVirtualIPOutsideTheVirtualPrefixIsRefused(t *testing.T) {
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "ipam.virtual_prefix", func(d doc) {
		at(d, "services", alphaWhoami)["virtual_ip"] = "192.168.1.1"
	})
}

func TestEnvironmentSubnetOutsideThePoolIsRefused(t *testing.T) {
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "outside ipam.pool", func(d doc) {
		n := at(d, "environments", alphaEnv, "network")
		n["subnet"], n["gateway"] = "192.168.50.0/24", "192.168.50.1"
	})
}

func TestEnvironmentSubnetWiderThanThePoolIsRefused(t *testing.T) {
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "outside ipam.pool", func(d doc) {
		n := at(d, "environments", alphaEnv, "network")
		n["subnet"], n["gateway"] = "10.200.0.0/15", "10.200.0.1"
	})
}

func TestEnvironmentSubnetsThatOverlapEachOtherAreRefused(t *testing.T) {
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "overlaps", func(d doc) {
		n := at(d, "environments", betaEnv, "network")
		n["subnet"], n["gateway"] = "10.200.10.128/25", "10.200.10.129"
	})
}

func TestEnvironmentSubnetOverlappingAPlatformNetworkIsRefused(t *testing.T) {
	cases := map[string]string{"system network": "10.200.0.0/25", "ingress network": "10.200.1.0/24", "registry subnet": "10.200.3.0/24"}
	for name, subnet := range cases {
		t.Run(name, func(t *testing.T) {
			expectRejected(t, protocol.ErrorCodeGenerationInvalid, name, func(d doc) {
				n := at(d, "environments", alphaEnv, "network")
				base := strings.TrimSuffix(subnet, subnet[strings.Index(subnet, "/"):])
				n["subnet"], n["gateway"] = subnet, base[:len(base)-1]+"1"
			})
		})
	}
}

func TestEnvironmentGatewayOutsideItsSubnetIsRefused(t *testing.T) {
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "gateway", func(d doc) {
		at(d, "environments", alphaEnv, "network")["gateway"] = "10.200.99.1"
	})
}

func TestTwoEnvironmentsSharingABridgeNameAreRefused(t *testing.T) {
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "share bridge_name", func(d doc) {
		at(d, "environments", betaEnv, "network")["bridge_name"] = "sly-aaaaaaaaaaa"
	})
}

func TestBridgeNameLongerThanTheKernelLimitIsRefused(t *testing.T) {
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "bridge_name", func(d doc) {
		at(d, "environments", alphaEnv, "network")["bridge_name"] = "sly-0123456789abcdef"
	})
}

func TestServiceNamingAnUnknownEnvironmentIsRefused(t *testing.T) {
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "env_01JCZZZZZZZZZZZZZZZZZZZZZZ", func(d doc) {
		at(d, "services", alphaClient)["environment_id"] = "env_01JCZZZZZZZZZZZZZZZZZZZZZZ"
	})
}

func TestMissingCouplerDigestIsRefused(t *testing.T) {
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "coupler_image", func(d doc) {
		delete(at(d, "components"), "coupler_image")
	})
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "coupler_image", func(d doc) {
		at(d, "components", "coupler_image")["digest"] = nil
	})
}

func TestLiteralValueOnANonPlatformVariableIsRefused(t *testing.T) {
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "not a platform entry", func(d doc) {
		env := at(d, "services", alphaWhoami, "current", "spec")["env"].([]any)
		env = append(env, map[string]any{"key": "DATABASE_URL", "injection": "env", "refs": []any{}, "value": "postgres://x", "platform": false})
		at(d, "services", alphaWhoami, "current", "spec")["env"] = env
	})
}

func TestGenerationForAnotherStationOrInstanceIsRefused(t *testing.T) {
	applied := generation(t, nil)
	for name, edit := range map[string]func(d doc){
		"station":  func(d doc) { d["station_id"] = "stn_01JCDDDDDDDDDDDDDDDDDDDDDD" },
		"instance": func(d doc) { d["instance_id"] = "ins_01JCDDDDDDDDDDDDDDDDDDDDDD" },
	} {
		g := generation(t, func(d doc) { d["number"] = float64(2); edit(d) })
		_, err := build(t, g, applied)
		if rej := rejection(t, err); rej.Body.Code != string(protocol.ErrorCodeGenerationInvalid) {
			t.Errorf("%s: code %s", name, rej.Body.Code)
		}
	}
}

func TestGenerationNotNewerThanTheAppliedOneIsStale(t *testing.T) {
	applied := generation(t, func(d doc) { d["number"] = float64(5) })
	older := generation(t, func(d doc) { d["number"] = float64(4) })
	if _, err := build(t, older, applied); rejection(t, err).Body.Code != string(protocol.ErrorCodeGenerationStale) {
		t.Fatalf("older: %v", err)
	}
	sameNumber := generation(t, func(d doc) { d["number"] = float64(5); d["hash"] = "sha256:" + strings.Repeat("f", 64) })
	if _, err := build(t, sameNumber, applied); rejection(t, err).Body.Code != string(protocol.ErrorCodeGenerationStale) {
		t.Fatalf("same number, other content: %v", err)
	}
}

func TestResendOfTheAppliedGenerationIsAcceptedAndNewerOnesToo(t *testing.T) {
	applied := generation(t, func(d doc) { d["number"] = float64(5) })
	if _, err := build(t, generation(t, func(d doc) { d["number"] = float64(5) }), applied); err != nil {
		t.Fatalf("replay: %v", err)
	}
	if _, err := build(t, generation(t, func(d doc) { d["number"] = float64(6) }), applied); err != nil {
		t.Fatalf("newer: %v", err)
	}
}

func deploymentDoc(d doc, serviceID string, number int, cancel bool) doc {
	spec := at(d, "services", serviceID, "current", "spec")
	dep := doc{
		"hash": "sha256:" + strings.Repeat("0", 64), "service_id": serviceID, "number": float64(number), "strategy": "overlap",
		"from_deployment_id": nil, "supersedes": nil, "cancel": nil, "target": spec,
		"budget": doc{"pull_s": 60, "start_s": 30, "health_s": 60, "drain_s": 30, "total_s": 300},
	}
	if cancel {
		dep["cancel"] = doc{"reason": "superseded"}
	}
	return dep
}

func addDeployment(d doc, id string, dep doc) {
	d["deployments"].(map[string]any)[id] = dep
}

func TestDeploymentOfAnUnknownServiceIsRefused(t *testing.T) {
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "svc_01JCZZZZZZZZZZZZZZZZZZZZZZ", func(d doc) {
		dep := deploymentDoc(d, alphaWhoami, 2, false)
		dep["service_id"] = "svc_01JCZZZZZZZZZZZZZZZZZZZZZZ"
		addDeployment(d, "dep_01JCWH0AM1AAAAAAAAAAAAAAA2", dep)
	})
}

func TestTwoDeploymentsWithoutCancelForOneServiceAreRefused(t *testing.T) {
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "at most one", func(d doc) {
		addDeployment(d, "dep_01JCWH0AM1AAAAAAAAAAAAAAA2", deploymentDoc(d, alphaWhoami, 2, false))
		addDeployment(d, "dep_01JCWH0AM1AAAAAAAAAAAAAAA3", deploymentDoc(d, alphaWhoami, 3, false))
	})
}

func TestCancelledDeploymentsDoNotCountAgainstTheServiceOrTheCap(t *testing.T) {
	p := mustBuild(t, func(d doc) {
		addDeployment(d, "dep_01JCWH0AM1AAAAAAAAAAAAAAA2", deploymentDoc(d, alphaWhoami, 2, true))
		addDeployment(d, "dep_01JCWH0AM1AAAAAAAAAAAAAAA3", deploymentDoc(d, alphaWhoami, 3, false))
	})
	if len(p.Generation.Deployments) != 2 {
		t.Fatalf("deployments %d", len(p.Generation.Deployments))
	}
}

func TestMoreUncancelledDeploymentsThanTheConcurrencyCapAreRefused(t *testing.T) {
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "concurrency_cap 2", func(d doc) {
		addDeployment(d, "dep_01JCWH0AM1AAAAAAAAAAAAAAA2", deploymentDoc(d, alphaWhoami, 2, false))
		addDeployment(d, "dep_01JCC11ENTAAAAAAAAAAAAAAA2", deploymentDoc(d, alphaClient, 2, false))
		addDeployment(d, "dep_01JCWH0AM1BBBBBBBBBBBBBBB2", deploymentDoc(d, betaWhoami, 2, false))
	})
}

func TestARaisedConcurrencyCapAdmitsMoreUncancelledDeployments(t *testing.T) {
	p := mustBuild(t, func(d doc) {
		at(d, "station")["concurrency_cap"] = float64(3)
		addDeployment(d, "dep_01JCWH0AM1AAAAAAAAAAAAAAA2", deploymentDoc(d, alphaWhoami, 2, false))
		addDeployment(d, "dep_01JCC11ENTAAAAAAAAAAAAAAA2", deploymentDoc(d, alphaClient, 2, false))
		addDeployment(d, "dep_01JCWH0AM1BBBBBBBBBBBBBBB2", deploymentDoc(d, betaWhoami, 2, false))
	})
	if len(p.Generation.Deployments) != 3 {
		t.Fatalf("deployments %d", len(p.Generation.Deployments))
	}
}

func TestALoweredConcurrencyCapRefusesTwoUncancelledDeployments(t *testing.T) {
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "concurrency_cap 1", func(d doc) {
		at(d, "station")["concurrency_cap"] = float64(1)
		addDeployment(d, "dep_01JCWH0AM1AAAAAAAAAAAAAAA2", deploymentDoc(d, alphaWhoami, 2, false))
		addDeployment(d, "dep_01JCC11ENTAAAAAAAAAAAAAAA2", deploymentDoc(d, alphaClient, 2, false))
	})
}

func TestSupersedesMustNameACancelledDeploymentOfTheSameService(t *testing.T) {
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "must be a cancelled deployment of the same service", func(d doc) {
		addDeployment(d, "dep_01JCWH0AM1AAAAAAAAAAAAAAA2", deploymentDoc(d, alphaWhoami, 2, false))
		next := deploymentDoc(d, alphaWhoami, 3, true)
		next["supersedes"] = "dep_01JCWH0AM1AAAAAAAAAAAAAAA2"
		addDeployment(d, "dep_01JCWH0AM1AAAAAAAAAAAAAAA3", next)
	})
}

func volumeDoc(name string, status string, owner string, serviceID any) doc {
	return doc{"hash": "sha256:" + strings.Repeat("0", 64), "docker_name": name, "owner": owner, "status": status, "service_id": serviceID, "retain_until": nil}
}

func mountVolume(d doc, serviceID, volumeID, path string) {
	spec := at(d, "services", serviceID, "current", "spec")
	spec["volumes"] = append(spec["volumes"].([]any), doc{"volume_id": volumeID, "mount_path": path})
}

func TestActiveVolumeMountedByItsOwnerIsPlannedAsAMount(t *testing.T) {
	p := mustBuild(t, func(d doc) {
		d["volumes"].(map[string]any)["vol_01JCGGGGGGGGGGGGGGGGGGGGGG"] = volumeDoc("sly-vol-data", "active", "service", alphaWhoami)
		mountVolume(d, alphaWhoami, "vol_01JCGGGGGGGGGGGGGGGGGGGGGG", "/var/lib/data")
	})
	sp := p.Services[alphaWhoami]
	if len(sp.Mounts) != 1 || sp.Mounts[0].Source != "sly-vol-data" || sp.Mounts[0].Target != "/var/lib/data" {
		t.Fatalf("mounts %+v", sp.Mounts)
	}
}

func TestVolumeProblemsAreRefused(t *testing.T) {
	const vol = "vol_01JCGGGGGGGGGGGGGGGGGGGGGG"
	cases := map[string]struct {
		contains string
		edit     func(d doc)
	}{
		"invalid docker name": {"docker_name", func(d doc) {
			d["volumes"].(map[string]any)[vol] = volumeDoc("-bad name", "active", "service", alphaWhoami)
		}},
		"duplicate docker name": {"share docker_name", func(d doc) {
			d["volumes"].(map[string]any)[vol] = volumeDoc("sly-vol-data", "active", "service", alphaWhoami)
			d["volumes"].(map[string]any)["vol_01JCGGGGGGGGGGGGGGGGGGGGGH"] = volumeDoc("sly-vol-data", "active", "service", alphaClient)
		}},
		"mount of a missing volume": {"does not contain", func(d doc) { mountVolume(d, alphaWhoami, vol, "/data") }},
		"mount of a retained volume": {"only active volumes", func(d doc) {
			d["volumes"].(map[string]any)[vol] = volumeDoc("sly-vol-data", "retained", "service", nil)
			mountVolume(d, alphaWhoami, vol, "/data")
		}},
		"mount of another service's volume": {"belongs to service", func(d doc) {
			d["volumes"].(map[string]any)[vol] = volumeDoc("sly-vol-data", "active", "service", alphaClient)
			mountVolume(d, alphaWhoami, vol, "/data")
		}},
		"relative mount path": {"absolute path", func(d doc) {
			d["volumes"].(map[string]any)[vol] = volumeDoc("sly-vol-data", "active", "service", alphaWhoami)
			mountVolume(d, alphaWhoami, vol, "data")
		}},
		"mount at the root": {"absolute path", func(d doc) {
			d["volumes"].(map[string]any)[vol] = volumeDoc("sly-vol-data", "active", "service", alphaWhoami)
			mountVolume(d, alphaWhoami, vol, "/")
		}},
		"two volumes at one path": {"two volumes", func(d doc) {
			d["volumes"].(map[string]any)[vol] = volumeDoc("sly-vol-a", "active", "service", alphaWhoami)
			d["volumes"].(map[string]any)["vol_01JCGGGGGGGGGGGGGGGGGGGGGH"] = volumeDoc("sly-vol-b", "active", "service", alphaWhoami)
			mountVolume(d, alphaWhoami, vol, "/data")
			mountVolume(d, alphaWhoami, "vol_01JCGGGGGGGGGGGGGGGGGGGGGH", "/data/")
		}},
		"retained volume still naming a service": {"retained volume", func(d doc) {
			d["volumes"].(map[string]any)[vol] = volumeDoc("sly-vol-data", "retained", "service", alphaWhoami)
		}},
		"active service volume without a service": {"names no service", func(d doc) {
			d["volumes"].(map[string]any)[vol] = volumeDoc("sly-vol-data", "active", "service", nil)
		}},
		"volume naming an unknown service": {"does not contain", func(d doc) {
			d["volumes"].(map[string]any)[vol] = volumeDoc("sly-vol-data", "active", "service", "svc_01JCZZZZZZZZZZZZZZZZZZZZZZ")
		}},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) { expectRejected(t, protocol.ErrorCodeGenerationInvalid, c.contains, c.edit) })
	}
}

func TestCronServiceWithoutAValidScheduleIsRefused(t *testing.T) {
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "without a schedule", func(d doc) {
		at(d, "services", alphaClient)["kind"] = "cron"
	})
	expectRejected(t, protocol.ErrorCodeGenerationInvalid, "schedule", func(d doc) {
		at(d, "services", alphaClient)["kind"] = "cron"
		at(d, "services", alphaClient, "current", "spec")["schedule"] = doc{"cron": "not a cron", "timezone": "UTC", "concurrency": "skip"}
	})
}

func TestRejectionReportsItsCodeAndExplanationAsTheErrorText(t *testing.T) {
	r := reject(protocol.ErrorCodeGenerationStale, "fix it", "generation %d is old", 3)
	if r.Error() != "GENERATION_STALE: generation 3 is old" || r.Body.Fix != "fix it" {
		t.Fatalf("got %q %+v", r.Error(), r.Body)
	}
}

func TestEveryRefusalIsAProtocolRejectionNotAPlainError(t *testing.T) {
	_, err := build(t, generation(t, func(d doc) { at(d, "services", alphaWhoami)["virtual_ip"] = "1.1.1.1" }), nil)
	var rej *Rejection
	if !errors.As(err, &rej) {
		t.Fatalf("got %T", err)
	}
}

func TestSealedGenerationVerifiesAndTamperingIsDetected(t *testing.T) {
	d := fixtureDoc(t)
	sealAll(t, d)
	raw, _ := json.Marshal(d)
	if err := VerifyGenerationHashes(raw); err != nil {
		t.Fatalf("sealed document: %v", err)
	}
	at(d, "services", alphaWhoami)["name"] = "renamed"
	raw, _ = json.Marshal(d)
	err := VerifyGenerationHashes(raw)
	if err == nil || !strings.Contains(err.Error(), "services/"+alphaWhoami) {
		t.Fatalf("tampered service: %v", err)
	}
	sealAll(t, d)
	d["number"] = float64(9)
	raw, _ = json.Marshal(d)
	if err := VerifyGenerationHashes(raw); err == nil || !strings.Contains(err.Error(), "document") {
		t.Fatalf("tampered envelope: %v", err)
	}
}

func sealAll(t *testing.T, d doc) {
	t.Helper()
	seal := func(obj doc) {
		h, err := canonicalHash(obj)
		if err != nil {
			t.Fatal(err)
		}
		obj["hash"] = h
	}
	for _, name := range hashedMaps {
		m, _ := d[name].(map[string]any)
		for _, v := range m {
			seal(v.(map[string]any))
		}
	}
	for _, v := range at(d, "gateway")["routes"].(map[string]any) {
		seal(v.(map[string]any))
	}
	seal(at(d, "gateway"))
	seal(d)
}

func TestCanonicalHashIsSHA256OfTheKeySortedCompactObjectWithoutItsHashField(t *testing.T) {
	got, err := canonicalHash(map[string]any{"b": 2, "a": []any{1, "x"}, "hash": "sha256:ignored"})
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(`{"a":[1,"x"],"b":2}`))
	if want := "sha256:" + hex.EncodeToString(sum[:]); got != want {
		t.Fatalf("got %s want %s", got, want)
	}
}
