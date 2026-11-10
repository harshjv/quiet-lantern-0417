//go:build linux

package deploy

import (
	"encoding/json"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/harshjv/stationly/go/internal/protocol"
)

var planNow = time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)

func desiredBox(state protocol.DesiredState, stopIn time.Duration) protocol.DesiredSandbox {
	d := protocol.DesiredSandbox{Hash: "sha256:a", Status: protocol.DesiredSandboxStatusActive, DesiredState: state}
	if stopIn != 0 {
		at := planNow.Add(stopIn).Format(time.RFC3339)
		d.StopAt = &at
	}
	return d
}

func reasonText(r *protocol.SandboxStatusReason) string {
	if r == nil {
		return ""
	}
	return string(*r)
}

func TestDecideSandbox(t *testing.T) {
	destroy := desiredBox(protocol.DesiredStateStopped, 0)
	destroy.Status = protocol.DesiredSandboxStatusDestroy
	cases := []struct {
		name   string
		facts  sbxFacts
		action sbxAction
		reason string
	}{
		{"new sandbox makes its disk", sbxFacts{desired: desiredBox(protocol.DesiredStateRunning, time.Hour)}, sbxMakeDisk, ""},
		{"disk ready and running wanted starts", sbxFacts{desired: desiredBox(protocol.DesiredStateRunning, time.Hour), diskReady: true, status: protocol.SandboxReportStatusCreating}, sbxStart, ""},
		{"created stopped reports created_stopped", sbxFacts{desired: desiredBox(protocol.DesiredStateStopped, 0), diskReady: true, status: protocol.SandboxReportStatusCreating}, sbxReportStopped, "created_stopped"},
		{"running and wanted does nothing", sbxFacts{desired: desiredBox(protocol.DesiredStateRunning, time.Hour), diskReady: true, running: true, status: protocol.SandboxReportStatusRunning, everStarted: true}, sbxNothing, ""},
		{"stop_at in the past stops with ttl", sbxFacts{desired: desiredBox(protocol.DesiredStateRunning, -time.Second), diskReady: true, running: true, status: protocol.SandboxReportStatusRunning, everStarted: true}, sbxStop, "ttl"},
		{"stop_at exactly now stops", sbxFacts{desired: func() protocol.DesiredSandbox {
			d := desiredBox(protocol.DesiredStateRunning, time.Hour)
			at := planNow.Format(time.RFC3339)
			d.StopAt = &at
			return d
		}(), diskReady: true, running: true, status: protocol.SandboxReportStatusRunning}, sbxStop, "ttl"},
		{"desired stopped stops with user", sbxFacts{desired: desiredBox(protocol.DesiredStateStopped, 0), diskReady: true, running: true, status: protocol.SandboxReportStatusRunning, everStarted: true}, sbxStop, "user"},
		{"running with no stop_at stops", sbxFacts{desired: desiredBox(protocol.DesiredStateRunning, 0), diskReady: true, running: true, status: protocol.SandboxReportStatusRunning}, sbxStop, "ttl"},
		{"exited with the same hash is not restarted", sbxFacts{desired: desiredBox(protocol.DesiredStateRunning, time.Hour), diskReady: true, status: protocol.SandboxReportStatusStopped, heldHash: "sha256:a", everStarted: true}, sbxNothing, ""},
		{"failed with the same hash is not retried", sbxFacts{desired: desiredBox(protocol.DesiredStateRunning, time.Hour), diskReady: true, status: protocol.SandboxReportStatusFailed, heldHash: "sha256:a"}, sbxNothing, ""},
		{"a new hash after a failure starts again", sbxFacts{desired: desiredBox(protocol.DesiredStateRunning, time.Hour), diskReady: true, status: protocol.SandboxReportStatusFailed, heldHash: "sha256:old"}, sbxStart, ""},
		{"after a reboot it starts with station_restart", sbxFacts{desired: desiredBox(protocol.DesiredStateRunning, time.Hour), diskReady: true, status: protocol.SandboxReportStatusStopped, everStarted: true, wasRunning: true}, sbxStart, "station_restart"},
		{"after a reboot past stop_at it stays stopped with ttl", sbxFacts{desired: desiredBox(protocol.DesiredStateRunning, -time.Minute), diskReady: true, status: protocol.SandboxReportStatusStarting, everStarted: true, wasRunning: true}, sbxReportStopped, "ttl"},
		{"stopped stays stopped", sbxFacts{desired: desiredBox(protocol.DesiredStateStopped, 0), diskReady: true, status: protocol.SandboxReportStatusStopped, everStarted: true}, sbxNothing, ""},
		{"destroy of a running sandbox stops it first", sbxFacts{desired: destroy, diskReady: true, running: true, status: protocol.SandboxReportStatusRunning}, sbxStop, "user"},
		{"destroy of a stopped sandbox deletes it", sbxFacts{desired: destroy, diskReady: true, status: protocol.SandboxReportStatusStopped}, sbxDestroy, ""},
		{"destroy without a disk deletes it", sbxFacts{desired: destroy}, sbxDestroy, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := decideSandbox(c.facts, planNow)
			if got.action != c.action || reasonText(got.reason) != c.reason {
				t.Fatalf("decideSandbox = %v/%q, want %v/%q", got.action, reasonText(got.reason), c.action, c.reason)
			}
		})
	}
}

func sandboxGeneration() *protocol.Generation {
	digest := "sha256:" + strings.Repeat("a", 64)
	ref := protocol.SandboxToolchainRepository + "@" + digest
	return &protocol.Generation{
		Station: protocol.DesiredStation{SandboxNetwork: &protocol.DesiredStationSandboxNetwork{BridgeName: "sly-sandbox", Subnet: "10.200.20.0/24", Gateway: "10.200.20.1"}},
		Environments: protocol.GenerationEnvironments{
			"env_01": {Network: protocol.EnvironmentNetwork{Subnet: "10.200.10.0/24", Gateway: "10.200.10.1", BridgeName: "sly-env1"}},
		},
		Sandboxes: protocol.GenerationSandboxes{
			"sbx_01JCB4ABCDEF": {
				Hash: "sha256:x", Status: protocol.DesiredSandboxStatusActive, EnvironmentId: "env_01", Network: protocol.SandboxNetworkIsolated,
				Image: protocol.DesiredSandboxImage{Digest: digest, ImageRef: ref}, Size: protocol.SandboxSize{CpuMillis: 1000, MemoryBytes: 1 << 30, DiskBytes: 10 << 30},
				Egress: protocol.SandboxEgress{Mode: protocol.SandboxEgressModeAllowlist, Domains: []protocol.SandboxEgressDomain{{Domain: "github.com", Ports: []int{443, 22}}, {Domain: "githubusercontent.com", Wildcard: true}}},
			},
		},
		SandboxSnapshots: protocol.GenerationSandboxSnapshots{},
	}
}

func TestCheckSandboxes(t *testing.T) {
	pool := netip.MustParsePrefix("10.200.0.0/16")
	taken := func() map[string]netip.Prefix {
		return map[string]netip.Prefix{"system network": netip.MustParsePrefix("10.200.0.0/24"), "environment env_01": netip.MustParsePrefix("10.200.10.0/24")}
	}
	none := func(string, string) bool { return false }
	if r := checkSandboxes(sandboxGeneration(), pool, taken(), none); r != nil {
		t.Fatalf("valid generation rejected: %v", r)
	}
	cases := []struct {
		name   string
		mutate func(g *protocol.Generation)
		want   string
	}{
		{"isolated without a sandbox network", func(g *protocol.Generation) { g.Station.SandboxNetwork = nil }, "needs station.sandbox_network"},
		{"sandbox network overlaps an environment", func(g *protocol.Generation) {
			g.Station.SandboxNetwork.Subnet, g.Station.SandboxNetwork.Gateway = "10.200.10.0/24", "10.200.10.1"
		}, "overlaps"},
		{"sandbox network outside the pool", func(g *protocol.Generation) {
			g.Station.SandboxNetwork.Subnet, g.Station.SandboxNetwork.Gateway = "10.9.0.0/24", "10.9.0.1"
		}, "outside ipam.pool"},
		{"gateway outside the subnet", func(g *protocol.Generation) { g.Station.SandboxNetwork.Gateway = "10.200.21.1" }, "is not inside"},
		{"image by tag", func(g *protocol.Generation) {
			s := g.Sandboxes["sbx_01JCB4ABCDEF"]
			s.Image.ImageRef = "ghcr.io/x/y:latest"
			g.Sandboxes["sbx_01JCB4ABCDEF"] = s
		}, "not a digest reference"},
		{"joined to a missing environment", func(g *protocol.Generation) {
			s := g.Sandboxes["sbx_01JCB4ABCDEF"]
			s.Network, s.EnvironmentId = protocol.SandboxNetworkEnvironment, "env_gone"
			g.Sandboxes["sbx_01JCB4ABCDEF"] = s
		}, "which the generation does not contain"},
		{"egress domain that does not parse", func(g *protocol.Generation) {
			s := g.Sandboxes["sbx_01JCB4ABCDEF"]
			s.Egress.Domains = []protocol.SandboxEgressDomain{{Domain: "not a domain"}}
			g.Sandboxes["sbx_01JCB4ABCDEF"] = s
		}, "egress"},
		{"nine distinct ports", func(g *protocol.Generation) {
			s := g.Sandboxes["sbx_01JCB4ABCDEF"]
			s.Egress.Domains = []protocol.SandboxEgressDomain{{Domain: "example.com", Ports: []int{1, 2, 3, 4, 5, 6, 7, 8, 9}}}
			g.Sandboxes["sbx_01JCB4ABCDEF"] = s
		}, "egress"},
		{"fork of a snapshot not on the station", func(g *protocol.Generation) {
			s := g.Sandboxes["sbx_01JCB4ABCDEF"]
			id := "sbs_01JCB9ABCDEF"
			s.Disk.From = &protocol.SandboxDiskFrom{SnapshotId: &id}
			g.Sandboxes["sbx_01JCB4ABCDEF"] = s
		}, "not on this station"},
		{"snapshot of an unknown sandbox", func(g *protocol.Generation) {
			g.SandboxSnapshots["sbs_01JCB9ABCDEF"] = protocol.DesiredSandboxSnapshot{SandboxId: "sbx_01JCB4GONE00", Status: protocol.DesiredSandboxSnapshotStatusActive}
		}, "neither in the generation"},
		{"zero size", func(g *protocol.Generation) {
			s := g.Sandboxes["sbx_01JCB4ABCDEF"]
			s.Size.DiskBytes = 0
			g.Sandboxes["sbx_01JCB4ABCDEF"] = s
		}, "size must be positive"},
		{"key that is not a sandbox id", func(g *protocol.Generation) { g.Sandboxes["../etc"] = g.Sandboxes["sbx_01JCB4ABCDEF"] }, "is not a sandbox id"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			g := sandboxGeneration()
			c.mutate(g)
			r := checkSandboxes(g, pool, taken(), none)
			if r == nil || !strings.Contains(r.Body.Explanation, c.want) {
				t.Fatalf("checkSandboxes = %v, want a rejection containing %q", r, c.want)
			}
			if r.Body.Code != string(protocol.ErrorCodeGenerationInvalid) {
				t.Fatalf("code %s", r.Body.Code)
			}
		})
	}
	held := func(kind, id string) bool { return kind == "snapshot" && id == "sbs_01JCB9ABCDEF" }
	g := sandboxGeneration()
	s := g.Sandboxes["sbx_01JCB4ABCDEF"]
	id := "sbs_01JCB9ABCDEF"
	s.Disk.From = &protocol.SandboxDiskFrom{SnapshotId: &id}
	g.Sandboxes["sbx_01JCB4ABCDEF"] = s
	if r := checkSandboxes(g, pool, taken(), held); r != nil {
		t.Fatalf("fork of a snapshot held on the station rejected: %v", r)
	}
	g = sandboxGeneration()
	s = g.Sandboxes["sbx_01JCB4ABCDEF"]
	gone := "sbx_01JCB4GONE00"
	s.Disk.From = &protocol.SandboxDiskFrom{SandboxId: &gone}
	g.Sandboxes["sbx_01JCB4ABCDEF"] = s
	if r := checkSandboxes(g, pool, taken(), none); r == nil {
		t.Fatalf("a new fork of a sandbox that is not on the station was accepted")
	}
	diskHeld := func(kind, id string) bool { return kind == "sandbox" && id == "sbx_01JCB4ABCDEF" }
	if r := checkSandboxes(g, pool, taken(), diskHeld); r != nil {
		t.Fatalf("an existing fork whose source was deleted was rejected: %v", r)
	}
}

func TestAllowPorts(t *testing.T) {
	g := sandboxGeneration()
	got := allowPorts(allowDomains(g.Sandboxes["sbx_01JCB4ABCDEF"].Egress))
	if len(got) != 2 || got[0] != 22 || got[1] != 443 {
		t.Fatalf("allowPorts = %v, want [22 443]", got)
	}
}

func TestForwardSetLimit(t *testing.T) {
	f := newForwardSet()
	for i := range sandboxMaxForwards {
		if !f.add(&forwardConn{}) {
			t.Fatalf("forward %d refused below the limit", i)
		}
	}
	if f.add(&forwardConn{}) {
		t.Fatalf("forward above %d accepted", sandboxMaxForwards)
	}
}

func TestBaseKeyAndRunLogRef(t *testing.T) {
	if k := baseKey("sha256:abc"); !strings.HasPrefix(k, "sha256:abc-") {
		t.Fatalf("baseKey = %s", k)
	}
	if ref := sandboxRunLogRef("sbx_1", "run_2"); ref != "logs/sbx_1/runs/run_2.jsonl" {
		t.Fatalf("sandboxRunLogRef = %s", ref)
	}
}

func TestSandboxRunRecordRoundTrips(t *testing.T) {
	dir := t.TempDir()
	rr := &runRecord{ID: "run_01", SandboxID: "sbx_01JCB4ABCDEF", Kind: protocol.RunKindExec, Command: []string{"true"}, Status: protocol.RunStatusSucceeded, LogRef: sandboxRunLogRef("sbx_01JCB4ABCDEF", "run_01"), Detail: map[string]any{}}
	b, err := json.Marshal(rr)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), `"spec"`) {
		t.Fatalf("a sandbox run carries a container spec: %s", b)
	}
	if err := os.MkdirAll(filepath.Join(dir, runDir), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, runDir, rr.ID+".json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
	runs, err := loadRuns(dir)
	if err != nil {
		t.Fatalf("loadRuns: %v", err)
	}
	if got := runs["run_01"]; got == nil || got.SandboxID != rr.SandboxID {
		t.Fatalf("loaded %+v", got)
	}
}

func TestRecentOOM(t *testing.T) {
	now := time.Now()
	if recentOOM(0, now) {
		t.Fatal("no OOM kill counted as recent")
	}
	if !recentOOM(now.Add(-5*time.Second).UnixNano(), now) {
		t.Fatal("an OOM kill 5 s before the end was not counted")
	}
	if recentOOM(now.Add(-time.Minute).UnixNano(), now) {
		t.Fatal("an OOM kill a minute before the end was counted")
	}
}
