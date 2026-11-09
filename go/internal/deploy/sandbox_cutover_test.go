//go:build linux

package deploy

import (
	"context"
	"errors"
	"net/netip"
	"testing"
	"time"

	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/netns"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/sandbox/store"
	"github.com/moby/moby/api/types/container"
)

const (
	joinedSbx   = "sbx_01JCJ0INED0000000000000000"
	isolatedSbx = "sbx_01JC1S0LATED00000000000000"
	otherEnvSbx = "sbx_01JC0THERENV00000000000000"
	stoppedSbx  = "sbx_01JCST0PPED0000000000000000"
	whoamiVIP   = "vip_01JCWH0AM1AAAAAAAAAAAAAAAA"
)

func cutoverStation(t *testing.T) (*Station, *rollout) {
	t.Helper()
	s := rolloutTestStation(t)
	g := s.plan.Generation
	g.Environments[alphaEnv] = protocol.DesiredEnvironment{VirtualIps: []protocol.EnvironmentVirtualIp{{Id: whoamiVIP, ServiceId: alphaWhoami, Address: "100.64.0.3"}}}
	g.Environments[betaEnv] = protocol.DesiredEnvironment{}
	joined := func(env string) protocol.DesiredSandbox {
		return protocol.DesiredSandbox{EnvironmentId: env, Network: protocol.SandboxNetworkEnvironment, Reach: []string{whoamiVIP}}
	}
	g.Sandboxes = map[string]protocol.DesiredSandbox{
		joinedSbx:   joined(alphaEnv),
		isolatedSbx: {EnvironmentId: alphaEnv, Network: protocol.SandboxNetworkIsolated},
		otherEnvSbx: joined(betaEnv),
		stoppedSbx:  joined(alphaEnv),
	}
	s.sbx = newSandboxRuntime()
	running := func(id string, pid int, b netns.SandboxBaseline, status protocol.SandboxReportStatus) {
		s.sbx.states[id] = &sbxState{rec: &sbxRecord{ID: id, Status: status}, pid: pid, inode: uint64(pid) * 10, baseline: b}
	}
	running(joinedSbx, 4101, netns.SandboxBaseline{Joined: true, Self: netip.MustParseAddr("10.210.0.20")}, protocol.SandboxReportStatusRunning)
	running(isolatedSbx, 4102, netns.SandboxBaseline{Self: netip.MustParseAddr("10.220.0.21")}, protocol.SandboxReportStatusRunning)
	running(otherEnvSbx, 4103, netns.SandboxBaseline{Joined: true, Self: netip.MustParseAddr("10.211.0.22")}, protocol.SandboxReportStatusRunning)
	running(stoppedSbx, 0, netns.SandboxBaseline{Joined: true}, protocol.SandboxReportStatusStopped)
	s.plan.Services[alphaWhoami].Run = true
	s.services = map[string]*serviceState{alphaWhoami: {coupler: view{state: string(container.StateRunning), address: netip.MustParseAddr("10.210.0.8")}}}
	s.syncRollouts()
	r := s.rollouts["dep_01JCROLLOUT0000000000000A"]
	r.Green.Address = "10.210.0.9"
	return s, r
}

func TestCutoverWritesJoinedSandboxNamespacesInTheSamePass(t *testing.T) {
	s, r := cutoverStation(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	targets := s.envNamespaces(ctx, alphaEnv)
	if len(targets) != 1 {
		t.Fatalf("the cutover pass for %s must hold exactly the running joined sandbox, got %+v", alphaEnv, targets)
	}
	tg := targets[0]
	if tg.sandbox != joinedSbx || tg.name != docker.SandboxCouplerName(joinedSbx) || tg.pid != 4101 || tg.inode != 41010 || tg.self != netip.MustParseAddr("10.210.0.20") {
		t.Fatalf("sandbox target %+v", tg)
	}
	vip := netip.MustParseAddr("100.64.0.3")
	if got := s.consumerFor(tg.envID, tg.reach).Switch[vip]; got != netip.MustParseAddr("10.210.0.8") {
		t.Fatalf("before cutover the sandbox reaches blue, got %v", got)
	}
	r.row(stepCutover).Status = statusRunning
	if got := s.consumerFor(tg.envID, tg.reach).Switch[vip]; got != netip.MustParseAddr("10.210.0.9") {
		t.Fatalf("the cutover write into the sandbox namespace must carry green, got %v", got)
	}
	if other := s.envNamespaces(ctx, betaEnv); len(other) != 1 || other[0].sandbox != otherEnvSbx {
		t.Fatalf("a joined sandbox belongs to its own environment's cutover only, got %+v", other)
	}
}

func TestARefreshFailureKeepsTheSandboxCapability(t *testing.T) {
	x := newSandboxRuntime()
	x.kernelOK = true
	good := store.Info{Mounted: true, Btrfs: true, SimpleQuota: true, Bytes: 16 << 30, FreeBytes: 8 << 30}
	if kept := x.recordInfo(good, nil, time.Now()); kept != nil || !x.ready() {
		t.Fatalf("a good inspection makes the filesystem ready, kept %v", kept)
	}
	busy := errors.New("btrfs device stats: context deadline exceeded")
	if kept := x.recordInfo(store.Info{Mounted: true, Btrfs: true}, busy, time.Now()); !errors.Is(kept, busy) {
		t.Fatalf("a failed refresh of a ready filesystem is reported as kept, got %v", kept)
	}
	if !x.ready() || x.info.Bytes != good.Bytes || x.probing {
		t.Fatalf("a failed refresh must keep the last figures and the capability, got ready=%v info=%+v", x.ready(), x.info)
	}
	if kept := x.recordInfo(store.Info{Mounted: false}, nil, time.Now()); kept != nil || x.ready() {
		t.Fatal("an inspection that finds the filesystem unmounted drops the capability")
	}
	fresh := newSandboxRuntime()
	fresh.kernelOK = true
	if fresh.recordInfo(store.Info{}, busy, time.Now()); fresh.ready() || fresh.infoErr == nil {
		t.Fatal("a station whose first inspection failed reports no capability")
	}
}
