//go:build linux

package deploy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/sandbox"
	"github.com/harshjv/stationly/go/internal/sandbox/store"
)

type fakeRuntime struct {
	mu       sync.Mutex
	calls    []string
	versions []string
	states   map[string][]sandbox.State
	problems []string
	probeErr error
	strays   []string
}

func (f *fakeRuntime) record(format string, args ...any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, fmt.Sprintf(format, args...))
}

func (f *fakeRuntime) Name() protocol.SandboxRuntime { return "gvisor" }

func (f *fakeRuntime) Versions() []string { return slices.Clone(f.versions) }

func (f *fakeRuntime) Install(_ context.Context, version string, _ io.Reader) error {
	f.record("install %s", version)
	f.versions = append(f.versions, version)
	return nil
}

func (f *fakeRuntime) Verify(version string) ([]string, error) {
	f.record("verify %s", version)
	return f.problems, nil
}

func (f *fakeRuntime) Probe(_ context.Context, version string) error {
	f.record("probe %s", version)
	return f.probeErr
}

func (f *fakeRuntime) Remove(version string) error {
	f.record("remove %s", version)
	f.versions = slices.DeleteFunc(f.versions, func(v string) bool { return v == version })
	return nil
}

func (f *fakeRuntime) Create(_ context.Context, version string, spec sandbox.Spec) error {
	f.record("create %s %s", version, spec.ID)
	return nil
}

func (f *fakeRuntime) Start(_ context.Context, version string, spec sandbox.Spec) (string, error) {
	f.record("start %s %s", version, spec.ID)
	return "/stationly.slice/stationly-sandboxes.slice/sbx-" + spec.ID + ".scope", nil
}

func (f *fakeRuntime) Wait(ctx context.Context, _, _ string) (*int, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

func (f *fakeRuntime) Stop(_ context.Context, version, id string, grace time.Duration) error {
	f.record("stop %s %s %s", version, id, grace)
	return nil
}

func (f *fakeRuntime) Kill(_ context.Context, id string) error {
	f.record("kill %s", id)
	return nil
}

func (f *fakeRuntime) List(_ context.Context, version string) ([]sandbox.State, error) {
	return f.states[version], nil
}

func (f *fakeRuntime) Exec(_ context.Context, version string, spec sandbox.ExecSpec) (sandbox.Process, error) {
	f.record("exec %s %s", version, spec.ID)
	return nil, errors.New("the fake runtime runs no processes")
}

func (f *fakeRuntime) Unit(id string) string { return "unit-" + id }

func (f *fakeRuntime) Cgroup(_ context.Context, id string) (string, error) {
	return "/cg/" + id, nil
}

func (f *fakeRuntime) AssertOOMGroup(cgroup string) (bool, error) {
	f.record("oom-group %s", cgroup)
	return false, nil
}

func (f *fakeRuntime) Strays(map[string]bool) []string { return f.strays }

func (f *fakeRuntime) LogFiles(string) []string { return []string{"runtime.log", "crash.log"} }

func (f *fakeRuntime) Panic(string) string { return "" }

const fakeSbx = "sbx_01JCFAKERUNT1ME00000000000"

func fakeRuntimeStation(t *testing.T, rt *fakeRuntime) *Station {
	t.Helper()
	s := &Station{
		log:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		opts:  Options{StateDir: t.TempDir()},
		comps: map[string]componentRecord{"runsc": {componentPin: componentPin{Version: "20261102.0"}}},
	}
	s.sbx = newSandboxSet(rt)
	s.sbx.kernelOK = true
	s.sbx.info = store.Info{Mounted: true, Btrfs: true, SimpleQuota: true, Backing: store.BackingDevice, Bytes: 100 << 30, FreeBytes: 60 << 30}
	return s
}

func TestTheSandboxCapabilityNamesTheRuntimeOnlyWhenItsPinIsInstalled(t *testing.T) {
	rt := &fakeRuntime{}
	s := fakeRuntimeStation(t, rt)
	if c := s.sandboxCapability(); c != nil {
		t.Fatalf("a station whose pinned runtime is not installed offers no sandboxes, got %+v", c)
	}
	rt.versions = []string{"20261102.0"}
	c := s.sandboxCapability()
	if c == nil || !slices.Equal(c.Runtimes, []protocol.SandboxRuntime{"gvisor"}) || c.RunscVersion != "20261102.0" {
		t.Fatalf("the capability must name the runtime and its pinned version, got %+v", c)
	}
}

func TestAStopUsesTheVersionThatStartedTheSandboxThenKillsItsScope(t *testing.T) {
	rt := &fakeRuntime{}
	s := fakeRuntimeStation(t, rt)
	st := &sbxState{rec: &sbxRecord{ID: fakeSbx, Runsc: "20260901.0"}, oom: &atomic.Int64{}, forwards: newForwardSet()}
	s.stopRuntime(context.Background(), st, true)
	s.stopRuntime(context.Background(), st, false)
	want := []string{
		"stop 20260901.0 " + fakeSbx + " 10s", "kill " + fakeSbx,
		"stop 20260901.0 " + fakeSbx + " 0s", "kill " + fakeSbx,
	}
	if !slices.Equal(rt.calls, want) {
		t.Fatalf("calls\n got %q\nwant %q", rt.calls, want)
	}
}

func TestCleaningRuntimesKeepsThePinAndEveryVersionARunningSandboxUses(t *testing.T) {
	rt := &fakeRuntime{versions: []string{"20260801.0", "20260901.0", "20261102.0"}}
	s := fakeRuntimeStation(t, rt)
	s.sbx.states[fakeSbx] = &sbxState{rec: &sbxRecord{ID: fakeSbx, Status: protocol.SandboxReportStatusRunning, Runsc: "20260901.0"}}
	s.cleanRuntimes(context.Background())
	if !slices.Equal(rt.calls, []string{"remove 20260801.0"}) {
		t.Fatalf("only the unused version goes, got %q", rt.calls)
	}
}

func TestAdoptionEndsWhatTheRuntimeRunsWithoutARecord(t *testing.T) {
	rt := &fakeRuntime{
		versions: []string{"20261102.0"},
		states: map[string][]sandbox.State{"20261102.0": {
			{ID: "sbx_01JCLEFT0VER0000000000000A", Running: true},
			{ID: "sbx_01JCEXITED000000000000000B"},
		}},
	}
	s := fakeRuntimeStation(t, rt)
	s.adoptSandboxes(context.Background())
	want := []string{
		"stop 20261102.0 sbx_01JCEXITED000000000000000B 0s",
		"kill sbx_01JCLEFT0VER0000000000000A",
		"stop 20261102.0 sbx_01JCLEFT0VER0000000000000A 0s",
	}
	if !slices.Equal(rt.calls, want) {
		t.Fatalf("calls\n got %q\nwant %q", rt.calls, want)
	}
}

func TestSandboxLogsPutInitFirstAndTheRuntimeLogsAfter(t *testing.T) {
	s := fakeRuntimeStation(t, &fakeRuntime{})
	got := s.sandboxLogFiles(t.TempDir())
	want := []sbxLogFile{
		{"init.log", string(protocol.LogRoleInit)},
		{"runtime.log", string(protocol.LogRoleRuntime)},
		{"crash.log", string(protocol.LogRoleRuntime)},
	}
	if !slices.Equal(got, want) {
		t.Fatalf("log files\n got %v\nwant %v", got, want)
	}
}

func TestTheRuntimeDoctorRowReportsWhatTheRuntimeFinds(t *testing.T) {
	rt := &fakeRuntime{versions: []string{"20261102.0"}, problems: []string{"missing gvisor-bin", "checksum of runsc differs"}, probeErr: errors.New("probe exited 1"), strays: []string{"gvisor_sentry pid 7 in /x"}}
	s := fakeRuntimeStation(t, rt)
	c := s.checkSandboxRuntime(context.Background())
	if c.Status != protocol.DoctorStatusFail || c.Code == nil || *c.Code != "runsc_missing" {
		t.Fatalf("status %s code %v", c.Status, c.Code)
	}
	for _, part := range []string{"missing gvisor-bin", "checksum of runsc differs", "probe exited 1", "gvisor_sentry pid 7 in /x"} {
		if !strings.Contains(c.Finding, part) {
			t.Errorf("the finding must carry %q, got %q", part, c.Finding)
		}
	}
}

func TestInstallingAVersionThatVerifiesReusesItWithoutDownloading(t *testing.T) {
	rt := &fakeRuntime{versions: []string{"20261102.0"}}
	check, err := InstallRunsc(context.Background(), rt, nil, nil, "20261102.0", "")
	if err != nil || !check.Reused {
		t.Fatalf("check %+v err %v", check, err)
	}
	if !slices.Equal(rt.calls, []string{"verify 20261102.0"}) {
		t.Fatalf("calls %q", rt.calls)
	}
}
