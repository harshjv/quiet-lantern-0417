//go:build linux

package deploy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/harshjv/stationly/go/internal/cidr"
	"github.com/harshjv/stationly/go/internal/dns"
	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/fsx"
	"github.com/harshjv/stationly/go/internal/netns"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/sandbox/runsc"
	"github.com/harshjv/stationly/go/internal/sandbox/store"
	"github.com/harshjv/stationly/go/internal/secrets"
	vipswitch "github.com/harshjv/stationly/go/internal/switch"
)

const (
	sandboxRecords     = "sandboxes.json"
	sandboxBundles     = "/run/stationly/sandboxes"
	sandboxStopGrace   = 10 * time.Second
	sandboxSecretsWait = 60 * time.Second
	sandboxMaxRuns     = 16
	sandboxMaxForwards = 16
	sandboxInfoEvery   = 30 * time.Second
	sandboxUsageEvery  = 15 * time.Second
	sandboxStaleEvery  = 60 * time.Second
	sandboxCleanEvery  = 60 * time.Second
	sandboxStartLimit  = 3 * time.Minute
	sandboxBaseRetry   = 5 * time.Minute
	sandboxOOMWindow   = 15 * time.Second
)

type sbxRecord struct {
	ID         string                             `json:"id"`
	Hash       string                             `json:"hash"`
	Status     protocol.SandboxReportStatus       `json:"status"`
	Reason     *protocol.SandboxStatusReason      `json:"reason"`
	ExitCode   *int                               `json:"exit_code"`
	OOM        bool                               `json:"oom_killed"`
	StartedAt  *string                            `json:"started_at"`
	StoppedAt  *string                            `json:"stopped_at"`
	Runsc      string                             `json:"runsc_version,omitempty"`
	Address    string                             `json:"address,omitempty"`
	Coupler    string                             `json:"coupler,omitempty"`
	Cgroup     string                             `json:"cgroup,omitempty"`
	Failure    *protocol.SandboxStatusBodyFailure `json:"failure,omitempty"`
	HeldHash   string                             `json:"held_hash,omitempty"`
	DiskReady  bool                               `json:"disk_ready"`
	Limit      uint64                             `json:"limit_bytes"`
	Reported   string                             `json:"reported,omitempty"`
	ImageUser  string                             `json:"image_user,omitempty"`
	ImageCwd   string                             `json:"image_cwd,omitempty"`
	ImageEnv   []string                           `json:"image_env,omitempty"`
	LogOffsets map[string]int64                   `json:"log_offsets,omitempty"`
}

type snapRecord struct {
	ID        string                                     `json:"id"`
	SandboxID string                                     `json:"sandbox_id"`
	Hash      string                                     `json:"hash"`
	Status    protocol.SandboxSnapshotReportStatus       `json:"status"`
	TakenAt   *string                                    `json:"taken_at"`
	Failure   *protocol.SandboxSnapshotStatusBodyFailure `json:"failure,omitempty"`
	Reported  string                                     `json:"reported,omitempty"`
}

type sbxFile struct {
	Sandboxes map[string]*sbxRecord  `json:"sandboxes"`
	Snapshots map[string]*snapRecord `json:"snapshots"`
}

type sbxState struct {
	rec          *sbxRecord
	busy         bool
	stopping     *protocol.SandboxStatusReason
	waitCancel   context.CancelFunc
	oom          *atomic.Int64
	pid          int
	inode        uint64
	secretsAsked string
	secretsSince time.Time
	wasRunning   bool
	baseline     netns.SandboxBaseline
	shape        string
	forwards     *forwardSet
	startedOp    time.Time
	syncedAt     time.Time
}

type baseState struct {
	unpacking bool
	failure   *protocol.ErrorBody
	failedAt  time.Time
}

type sbxVars struct {
	digest string
	env    []string
	known  []secrets.Known
}

type sbxNetEntry struct {
	id     string
	pid    int
	ports  map[uint16]bool
	mirror *dns.AllowMirror
}

type sbxNetIndex struct {
	mu     sync.Mutex
	byAddr map[netip.Addr]*sbxNetEntry
}

type sandboxRuntime struct {
	fs        store.FS
	info      store.Info
	infoErr   error
	infoAt    time.Time
	probing   bool
	kernel    string
	kernelOK  bool
	states    map[string]*sbxState
	snaps     map[string]*snapRecord
	bases     map[string]*baseState
	vars      map[string]*sbxVars
	execs     map[string]*sbxExec
	index     *sbxNetIndex
	usage     map[string]store.Usage
	usageAt   time.Time
	usageBusy bool
	staleAt   time.Time
	cleanAt   time.Time
	unknown   []protocol.UnknownObject
	netID     string
	netFail   *protocol.ErrorBody
	logBusy   atomic.Bool
	adopted   bool
}

func newSandboxRuntime() sandboxRuntime {
	return sandboxRuntime{
		fs:     store.Open(store.Mount),
		states: map[string]*sbxState{},
		snaps:  map[string]*snapRecord{},
		bases:  map[string]*baseState{},
		vars:   map[string]*sbxVars{},
		execs:  map[string]*sbxExec{},
		index:  &sbxNetIndex{byAddr: map[netip.Addr]*sbxNetEntry{}},
		usage:  map[string]store.Usage{},
	}
}

func kernelRelease() string {
	b, err := os.ReadFile("/proc/sys/kernel/osrelease")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func sandboxHeld(kind, id string) bool {
	fs := store.Open(store.Mount)
	if kind == "snapshot" {
		return fs.SnapshotExists(id)
	}
	return fs.DiskExists(id)
}

func (s *Station) loadSandboxes() error {
	s.sbx = newSandboxRuntime()
	s.sbx.kernel = kernelRelease()
	s.sbx.kernelOK = store.KernelSupported(s.sbx.kernel)
	b, err := os.ReadFile(filepath.Join(s.opts.StateDir, sandboxRecords))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var f sbxFile
	if err := json.Unmarshal(b, &f); err != nil {
		return err
	}
	for id, rec := range f.Sandboxes {
		rec.ID = id
		s.sbx.states[id] = &sbxState{rec: rec, oom: &atomic.Int64{}, forwards: newForwardSet(), wasRunning: rec.Status == protocol.SandboxReportStatusRunning || rec.Status == protocol.SandboxReportStatusStarting}
	}
	for id, rec := range f.Snapshots {
		rec.ID = id
		s.sbx.snaps[id] = rec
	}
	return nil
}

func (s *Station) saveSandboxes() {
	f := sbxFile{Sandboxes: map[string]*sbxRecord{}, Snapshots: s.sbx.snaps}
	for id, st := range s.sbx.states {
		f.Sandboxes[id] = st.rec
	}
	b, err := json.MarshalIndent(f, "", "  ")
	if err == nil {
		err = writeAtomic(filepath.Join(s.opts.StateDir, sandboxRecords), b)
	}
	if err != nil {
		s.log.Error("persist sandboxes.json", "error", err)
	}
}

func inspectSandboxStorage(ctx context.Context, fs store.FS) (store.Info, error) {
	ictx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	info, err := fs.Inspect(ictx)
	if err == nil && info.Mounted && info.Btrfs {
		if lerr := fs.EnsureLayout(); lerr != nil {
			err = lerr
		}
		if info.Backing == store.BackingLoopFile && !info.DirectIO {
			if derr := fs.EnableDirectIO(ictx); derr == nil {
				info.DirectIO = true
			}
		}
	}
	return info, err
}

func (s *Station) probeSandboxStorage(ctx context.Context) {
	if !s.sbx.kernelOK {
		return
	}
	s.sbx.info, s.sbx.infoErr = inspectSandboxStorage(ctx, s.sbx.fs)
	s.sbx.infoAt = time.Now()
	if s.sandboxStorageReady() {
		if err := s.sbx.fs.CleanPartial(ctx); err != nil {
			s.log.Warn("clean partial sandbox subvolumes", "error", err)
		}
		return
	}
	s.log.Warn("no usable sandbox filesystem; this station reports no sandbox capability", "reason", s.sandboxUnavailable())
}

func (s *Station) refreshSandboxInfo(ctx context.Context, now time.Time) {
	if s.sbx.probing || (!s.sbx.infoAt.IsZero() && now.Sub(s.sbx.infoAt) < sandboxInfoEvery) || !s.sbx.kernelOK {
		return
	}
	s.sbx.probing = true
	fs := s.sbx.fs
	go func() {
		info, err := inspectSandboxStorage(ctx, fs)
		s.post(ctx, func() {
			if kept := s.sbx.recordInfo(info, err, time.Now()); kept != nil {
				s.log.Warn("refresh the sandbox filesystem figures; keeping the last ones", "error", kept)
			}
		})
	}()
}

func (s *Station) sandboxStorageReady() bool {
	return s.sbx.ready()
}

func (x *sandboxRuntime) ready() bool {
	i := x.info
	return x.kernelOK && x.infoErr == nil && i.Mounted && i.Btrfs && i.SimpleQuota
}

func (x *sandboxRuntime) recordInfo(info store.Info, err error, now time.Time) error {
	x.infoAt, x.probing = now, false
	if err != nil && x.ready() {
		return err
	}
	x.info, x.infoErr = info, err
	return nil
}

func (s *Station) pinnedRunsc() (string, bool) {
	rec, ok := s.comps["runsc"]
	if !ok || rec.Version == "" {
		return "", false
	}
	versions, _ := runsc.Installed(runsc.LibDir)
	return rec.Version, slices.Contains(versions, rec.Version)
}

func (s *Station) sandboxCapability() *protocol.StationCapabilitiesSandboxes {
	if !s.sandboxStorageReady() {
		return nil
	}
	v, ok := s.pinnedRunsc()
	if !ok {
		return nil
	}
	i := s.sbx.info
	backing := protocol.SandboxFilesystemBackingLoopFile
	if i.Backing == store.BackingDevice {
		backing = protocol.SandboxFilesystemBackingDevice
	}
	maxBytes := i.Bytes
	if i.Backing == store.BackingLoopFile {
		if free, err := rootFree(s.opts.StateDir); err == nil {
			maxBytes = store.MaxGrow(i.Bytes, free)
		}
	}
	return &protocol.StationCapabilitiesSandboxes{RunscVersion: v, Platform: "systrap", FilesystemBacking: backing, FilesystemBytes: int(i.Bytes), FilesystemFreeBytes: int(i.FreeBytes), FilesystemMaxBytes: int(maxBytes)}
}

func rootFree(path string) (uint64, error) {
	_, _, free, err := usedPct(path)
	return free, err
}

func (s *Station) sandboxState(id string) *sbxState {
	st := s.sbx.states[id]
	if st == nil {
		st = &sbxState{rec: &sbxRecord{ID: id, Status: protocol.SandboxReportStatusCreating}, oom: &atomic.Int64{}, forwards: newForwardSet()}
		s.sbx.states[id] = st
	}
	return st
}

func baseKey(digest string) string {
	return digest + "-" + runtime.GOARCH
}

func (s *Station) reportSandbox(st *sbxState, status protocol.SandboxReportStatus, reason *protocol.SandboxStatusReason) {
	rec := st.rec
	rec.Status, rec.Reason = status, reason
	key := string(status)
	if reason != nil {
		key += "|" + string(*reason)
	}
	if status == protocol.SandboxReportStatusStopped && rec.ExitCode != nil {
		key += fmt.Sprintf("|%d", *rec.ExitCode)
	}
	if rec.Reported == key {
		s.saveSandboxes()
		return
	}
	rec.Reported = key
	body := map[string]any{
		"sandbox_id": rec.ID, "status": status, "reason": reason, "exit_code": nil, "oom_killed": rec.OOM,
		"started_at": rec.StartedAt, "stopped_at": rec.StoppedAt, "failure": nil,
	}
	if status == protocol.SandboxReportStatusStopped || status == protocol.SandboxReportStatusFailed {
		body["exit_code"] = rec.ExitCode
	}
	if status == protocol.SandboxReportStatusFailed {
		body["failure"] = rec.Failure
	}
	s.emit(protocol.MessageSandboxStatus, body)
	s.log.Info("sandbox status", "sandbox", rec.ID, "status", status, "reason", deref((*string)(reason)), "exit_code", rec.ExitCode, "oom_killed", rec.OOM)
	s.saveSandboxes()
}

func sandboxFailure(phase protocol.DiagnosisPhase, code protocol.ErrorCode, step, format string, args ...any) *protocol.SandboxStatusBodyFailure {
	summary := fmt.Sprintf(format, args...)
	details := protocol.DiagnosisDetails{"step": step, "error": lastLines(summary, 20, "\n")}
	return &protocol.SandboxStatusBodyFailure{Code: string(code), Phase: phase, Summary: firstLine(summary), Details: details}
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(s), "\n")
	if len(line) > 500 {
		line = line[:500]
	}
	return line
}

func (s *Station) failSandbox(st *sbxState, f *protocol.SandboxStatusBodyFailure) {
	st.rec.Failure = f
	st.rec.HeldHash = st.rec.Hash
	st.rec.StoppedAt = stamp(time.Now())
	s.reportSandbox(st, protocol.SandboxReportStatusFailed, nil)
	s.log.Error("sandbox failed", "sandbox", st.rec.ID, "code", f.Code, "phase", f.Phase, "summary", f.Summary)
}

func (s *Station) reconcileSandboxes(ctx context.Context, now time.Time) {
	if s.plan == nil {
		return
	}
	s.refreshSandboxInfo(ctx, now)
	g := s.plan.Generation
	if !s.sbx.adopted && !s.sbx.infoAt.IsZero() {
		s.sbx.adopted = true
		s.adoptSandboxes(ctx)
	}
	if !s.sbx.adopted {
		return
	}
	s.ensureSandboxNetwork(ctx)
	ready := s.sandboxStorageReady()
	if ready {
		s.prefetchToolchain(ctx)
	}
	for _, id := range slices.Sorted(maps.Keys(g.Sandboxes)) {
		d := g.Sandboxes[id]
		st := s.sandboxState(id)
		if st.busy {
			if !st.startedOp.IsZero() && now.Sub(st.startedOp) > sandboxStartLimit {
				s.log.Warn("sandbox operation is taking long", "sandbox", id, "since", st.startedOp)
			}
			continue
		}
		if !ready {
			if d.Status == protocol.DesiredSandboxStatusActive && st.rec.Status != protocol.SandboxReportStatusFailed {
				st.rec.Hash = d.Hash
				s.failSandbox(st, sandboxFailure(protocol.DiagnosisPhaseDisk, protocol.ErrorCodeStationCapabilityMissing, "disk", "this station has no usable sandbox filesystem: %s", s.sandboxUnavailable()))
			}
			continue
		}
		s.driveSandbox(ctx, st, d, now)
	}
	pruned := false
	for id, st := range s.sbx.states {
		if _, ok := g.Sandboxes[id]; ok || st.busy {
			continue
		}
		if st.rec.Status == protocol.SandboxReportStatusDeleted {
			delete(s.sbx.states, id)
			pruned = true
			continue
		}
		if st.rec.Status == protocol.SandboxReportStatusRunning {
			s.stopSandbox(ctx, st, reasonOf(protocol.SandboxStatusReasonUser), nil)
		}
	}
	for id, rec := range s.sbx.snaps {
		if _, ok := g.SandboxSnapshots[id]; !ok && rec.Status == protocol.SandboxSnapshotReportStatusDeleted {
			delete(s.sbx.snaps, id)
			pruned = true
		}
	}
	if pruned {
		s.saveSandboxes()
	}
	if ready {
		s.reconcileSnapshots(ctx)
		s.sandboxHousekeeping(ctx, now)
	}
}

func (s *Station) sandboxUnavailable() string {
	switch {
	case !s.sbx.kernelOK:
		return fmt.Sprintf("kernel %s is older than 6.7, which btrfs simple quotas need", s.sbx.kernel)
	case s.sbx.infoErr != nil:
		return s.sbx.infoErr.Error()
	case !s.sbx.info.Mounted || !s.sbx.info.Btrfs:
		return store.Mount + " is not a mounted btrfs filesystem"
	case !s.sbx.info.SimpleQuota:
		return "simple quotas are off on " + store.Mount
	}
	return "unknown"
}

func (s *Station) driveSandbox(ctx context.Context, st *sbxState, d protocol.DesiredSandbox, now time.Time) {
	rec := st.rec
	if rec.Hash != d.Hash {
		rec.Hash = d.Hash
		s.saveSandboxes()
	}
	running := rec.Status == protocol.SandboxReportStatusRunning
	if running {
		s.assertOOMGroup(st)
		s.syncRunningSandbox(ctx, st, d)
		if _, held := s.sandboxEnv(rec.ID, d); !held {
			s.requestSandboxSecrets(st, d.EnvDigest)
		}
	}
	if rec.DiskReady && d.Status == protocol.DesiredSandboxStatusActive && uint64(d.Size.DiskBytes) != rec.Limit {
		if err := s.sbx.fs.SetLimit(ctx, s.sbx.fs.DiskPath(rec.ID), uint64(d.Size.DiskBytes)); err != nil {
			s.log.Warn("set sandbox disk limit", "sandbox", rec.ID, "error", err)
		} else {
			rec.Limit = uint64(d.Size.DiskBytes)
			s.saveSandboxes()
		}
	}
	dec := decideSandbox(sbxFacts{desired: d, diskReady: rec.DiskReady, running: running, status: rec.Status, heldHash: rec.HeldHash, everStarted: rec.StartedAt != nil, wasRunning: st.wasRunning}, now)
	switch dec.action {
	case sbxMakeDisk:
		s.makeSandboxDisk(ctx, st, d)
	case sbxStart:
		s.startSandbox(ctx, st, d, dec.reason)
	case sbxStop:
		s.stopSandbox(ctx, st, dec.reason, nil)
	case sbxDestroy:
		s.destroySandbox(ctx, st)
	case sbxReportStopped:
		st.wasRunning = false
		if rec.StoppedAt == nil {
			rec.StoppedAt = stamp(now)
		}
		s.reportSandbox(st, protocol.SandboxReportStatusStopped, dec.reason)
	}
}

func (s *Station) makeSandboxDisk(ctx context.Context, st *sbxState, d protocol.DesiredSandbox) {
	rec := st.rec
	if rec.Status == protocol.SandboxReportStatusFailed && rec.HeldHash == d.Hash {
		return
	}
	if rec.Status != protocol.SandboxReportStatusCreating {
		s.reportSandbox(st, protocol.SandboxReportStatusCreating, nil)
	}
	fs := s.sbx.fs
	limit := uint64(d.Size.DiskBytes)
	if fs.DiskExists(rec.ID) {
		rec.DiskReady, rec.Limit = true, 0
		s.saveSandboxes()
		return
	}
	if free := s.sbx.info.FreeBytes; free < s.minFreeBytes() {
		s.failSandbox(st, sandboxFailure(protocol.DiagnosisPhaseDisk, protocol.ErrorCodeSandboxDiskFull, "disk", "the sandbox filesystem has %d bytes free, below min_free_bytes %d", free, s.minFreeBytes()))
		return
	}
	var source string
	switch f := d.Disk.From; {
	case f != nil && f.SnapshotId != nil:
		if !fs.SnapshotExists(*f.SnapshotId) {
			if _, pending := s.plan.Generation.SandboxSnapshots[*f.SnapshotId]; pending {
				return
			}
			s.failSandbox(st, sandboxFailure(protocol.DiagnosisPhaseDisk, protocol.ErrorCodeSandboxStartFailed, "disk", "snapshot %s is not on this station", *f.SnapshotId))
			return
		}
		source = fs.SnapshotPath(*f.SnapshotId)
	case f != nil && f.SandboxId != nil:
		if !fs.DiskExists(*f.SandboxId) {
			if src := s.sbx.states[*f.SandboxId]; src != nil && !src.rec.DiskReady {
				return
			}
			s.failSandbox(st, sandboxFailure(protocol.DiagnosisPhaseDisk, protocol.ErrorCodeSandboxStartFailed, "disk", "sandbox %s has no disk on this station", *f.SandboxId))
			return
		}
		source = fs.DiskPath(*f.SandboxId)
	default:
		key := baseKey(d.Image.Digest)
		if !fs.BaseExists(key) {
			if f := s.ensureBase(ctx, key, d.Image.ImageRef); f != nil {
				s.failSandbox(st, &protocol.SandboxStatusBodyFailure{Code: f.Code, Phase: protocol.DiagnosisPhase("unpack"), Summary: f.Explanation, Details: protocol.DiagnosisDetails{"step": "unpack"}})
			}
			return
		}
		source = fs.BasePath(key)
	}
	start := time.Now()
	if err := fs.MakeDisk(ctx, rec.ID, source, limit); err != nil {
		s.failSandbox(st, sandboxFailure(protocol.DiagnosisPhaseDisk, protocol.ErrorCodeSandboxStartFailed, "disk", "make the disk from %s: %v", source, err))
		return
	}
	if cfg, err := s.docker.ImageConfig(ctx, d.Image.ImageRef); err == nil {
		rec.ImageUser, rec.ImageCwd = cfg.User, cfg.WorkingDir
	}
	rec.DiskReady, rec.Limit = true, limit
	s.saveSandboxes()
	s.log.Info("sandbox disk made", "sandbox", rec.ID, "source", source, "limit_bytes", limit, "took_ms", time.Since(start).Milliseconds())
}

func (s *Station) minFreeBytes() uint64 {
	return s.sbx.info.Bytes / 20
}

func (s *Station) ensureBase(ctx context.Context, key, ref string) *protocol.ErrorBody {
	b := s.sbx.bases[key]
	if b == nil {
		b = &baseState{}
		s.sbx.bases[key] = b
	}
	if b.unpacking {
		return nil
	}
	if b.failure != nil && time.Since(b.failedAt) < sandboxBaseRetry {
		return b.failure
	}
	b.unpacking, b.failure = true, nil
	fs, dc, station := s.sbx.fs, s.docker, s.plan.Generation.StationId
	go func() {
		start := time.Now()
		stats, err := unpackBase(ctx, fs, dc, station, key, ref)
		s.post(ctx, func() {
			b.unpacking = false
			if err != nil {
				b.failure, b.failedAt = unpackFailure(err), time.Now()
				s.log.Error("sandbox base unpack failed", "base", key, "ref", ref, "error", err)
				s.resync = true
				return
			}
			s.log.Info("sandbox base unpacked", "base", key, "ref", ref, "entries", stats.Entries, "bytes", stats.Bytes, "holes", stats.HoleBytes, "took_ms", time.Since(start).Milliseconds())
			s.resync = true
		})
	}()
	return nil
}

func (s *Station) prefetchToolchain(ctx context.Context) {
	pin, ok := s.plan.Generation.Components["sandbox_toolchain"]
	if !ok || pin.Digest == nil {
		return
	}
	if _, ok := s.pinnedRunsc(); !ok {
		return
	}
	key := baseKey(*pin.Digest)
	if s.sbx.fs.BaseExists(key) {
		return
	}
	s.ensureBase(ctx, key, s.sourceOf("sandbox_toolchain")+"@"+*pin.Digest)
}

func (s *Station) ensureSandboxNetwork(ctx context.Context) {
	n := s.plan.Generation.Station.SandboxNetwork
	if n == nil {
		s.sbx.netID = ""
		return
	}
	if s.sbx.netID != "" && bridgeUp(docker.SandboxIface) {
		return
	}
	spec, err := docker.SandboxNetwork(s.plan.Generation.StationId, *n)
	if err != nil {
		s.sbx.netFail = namespaceFailure("sandbox network: %v", err)
		return
	}
	id, created, err := s.docker.EnsureNetwork(ctx, spec, nil)
	if err != nil {
		s.sbx.netFail = dockerError(protocol.ErrorCodeGenerationInvalid, err)
		s.log.Error("sandbox network", "error", err)
		return
	}
	if created {
		s.log.Info("created sandbox network", "name", spec.Name, "id", shortID(id), "subnet", n.Subnet)
	}
	s.sbx.netID, s.sbx.netFail = id, nil
	s.ensureResolver()
}

func (s *Station) sandboxNet() (envNet, bool) {
	n := s.plan.Generation.Station.SandboxNetwork
	if n == nil {
		return envNet{}, false
	}
	subnet, err1 := netip.ParsePrefix(n.Subnet)
	gateway, err2 := netip.ParseAddr(n.Gateway)
	return envNet{subnet: subnet, gateway: gateway, bridge: docker.SandboxIface}, err1 == nil && err2 == nil
}

type sbxPlacement struct {
	networkID   string
	networkName string
	cursorKey   string
	net         envNet
}

func (s *Station) placement(d protocol.DesiredSandbox) (sbxPlacement, *protocol.SandboxStatusBodyFailure) {
	if d.Network == protocol.SandboxNetworkEnvironment {
		env := s.envs[d.EnvironmentId]
		if env == nil || env.networkID == "" {
			return sbxPlacement{}, sandboxFailure(protocol.DiagnosisPhaseNetwork, protocol.ErrorCodeSandboxStartFailed, "coupler", "the network of environment %s is not up", d.EnvironmentId)
		}
		n := s.envNet(d.EnvironmentId)
		return sbxPlacement{networkID: env.networkID, networkName: n.bridge, cursorKey: d.EnvironmentId, net: n}, nil
	}
	n, ok := s.sandboxNet()
	if !ok || s.sbx.netID == "" {
		detail := "station.sandbox_network is not set"
		if s.sbx.netFail != nil {
			detail = s.sbx.netFail.Explanation
		}
		return sbxPlacement{}, sandboxFailure(protocol.DiagnosisPhaseNetwork, protocol.ErrorCodeSandboxStartFailed, "coupler", "the sandbox network is not up: %s", detail)
	}
	return sbxPlacement{networkID: s.sbx.netID, networkName: s.plan.Generation.Station.SandboxNetwork.BridgeName, cursorKey: docker.SandboxBridge, net: n}, nil
}

func (s *Station) sandboxShape(d protocol.DesiredSandbox) string {
	b, _ := json.Marshal([]any{d.Network, d.EnvironmentId, d.Egress, d.Reach})
	return string(b)
}

func (s *Station) sandboxElements(d protocol.DesiredSandbox) (netns.SandboxBaseline, netns.SandboxElements, []dns.AllowDomain) {
	domains, _ := dns.ParseDomains(allowDomains(d.Egress))
	allowlist := d.Egress.Mode == protocol.SandboxEgressModeAllowlist
	b := netns.SandboxBaseline{Joined: d.Network == protocol.SandboxNetworkEnvironment, Allowlist: allowlist}
	if allowlist {
		b.Ports = allowPorts(domains)
	}
	e := netns.SandboxElements{HostAddrs: s.hostPrefixes()}
	if b.Joined {
		n := s.envNet(d.EnvironmentId)
		b.Resolver, b.Subnet = n.gateway, n.subnet
		c := s.consumerFor(d.EnvironmentId, d.Reach)
		e.Switch, e.Pending, e.Reject = c.Switch, c.Pending, c.Reject
	} else if n, ok := s.sandboxNet(); ok {
		b.Resolver = n.gateway
	}
	return b, e, domains
}

func (s *Station) allocateOn(ctx context.Context, p sbxPlacement) (netip.Addr, error) {
	used, err := s.docker.NetworkAddresses(ctx, p.networkID)
	if err != nil {
		return netip.Addr{}, err
	}
	taken := map[netip.Addr]bool{p.net.gateway: true}
	cursor := s.cursor[p.cursorKey]
	for _, a := range used {
		taken[a] = true
		if !cursor.IsValid() || a.Compare(cursor) > 0 {
			cursor = a
		}
	}
	if !cursor.IsValid() {
		cursor = p.net.gateway
	}
	first, last := p.net.subnet.Masked().Addr(), cidr.Last(p.net.subnet)
	a := cursor
	for range 1 << (32 - p.net.subnet.Bits()) {
		a = a.Next()
		if !p.net.subnet.Contains(a) || a == last {
			a = first
			continue
		}
		if a == first || taken[a] {
			continue
		}
		s.cursor[p.cursorKey] = a
		return a, nil
	}
	return netip.Addr{}, fmt.Errorf("no free address in %s", p.net.subnet)
}

func emptyEnvDigest() string {
	d, _ := secretsDigest(nil)
	return d
}

func (s *Station) sandboxEnv(id string, d protocol.DesiredSandbox) ([]string, bool) {
	if d.EnvDigest == emptyEnvDigest() {
		return nil, true
	}
	v := s.sbx.vars[id]
	if v == nil || v.digest != d.EnvDigest {
		return nil, false
	}
	return v.env, true
}

func (s *Station) requestSandboxSecrets(st *sbxState, digest string) {
	if st.secretsAsked == digest && time.Since(st.secretsSince) < 15*time.Second {
		return
	}
	if st.secretsAsked != digest {
		st.secretsSince = time.Now()
	}
	st.secretsAsked = digest
	id := st.rec.ID
	s.send(protocol.MessageSecretsRequest, nil, protocol.SecretsRequestBody{Target: protocol.SecretTarget{SandboxId: &id}, EnvDigest: digest, Purpose: protocol.SecretPurposeSandbox})
}

func (s *Station) startSandbox(ctx context.Context, st *sbxState, d protocol.DesiredSandbox, reason *protocol.SandboxStatusReason) {
	rec := st.rec
	version, ok := s.pinnedRunsc()
	if !ok {
		s.failSandbox(st, sandboxFailure(protocol.DiagnosisPhase("start"), protocol.ErrorCodeSandboxStartFailed, "create", "the pinned runsc %q is not installed on this station", version))
		return
	}
	env, held := s.sandboxEnv(rec.ID, d)
	if !held {
		if rec.Status != protocol.SandboxReportStatusStarting {
			s.reportSandbox(st, protocol.SandboxReportStatusStarting, reason)
		}
		s.requestSandboxSecrets(st, d.EnvDigest)
		if time.Since(st.secretsSince) > sandboxSecretsWait {
			s.failSandbox(st, sandboxFailure(protocol.DiagnosisPhase("start"), protocol.ErrorCodeSandboxStartFailed, "secrets", "the sandbox's variables (env_digest %s) did not arrive within %s", d.EnvDigest, sandboxSecretsWait))
		}
		return
	}
	p, f := s.placement(d)
	if f != nil {
		s.failSandbox(st, f)
		return
	}
	s.reportSandbox(st, protocol.SandboxReportStatusStarting, reason)
	rec.Failure, rec.ExitCode, rec.OOM = nil, nil, false
	s.removeNamed(ctx, docker.SandboxCouplerName(rec.ID))
	addr, err := s.allocateOn(ctx, p)
	if err != nil {
		s.failSandbox(st, sandboxFailure(protocol.DiagnosisPhaseNetwork, protocol.ErrorCodeSubnetExhausted, "coupler", "%v", err))
		return
	}
	spec := docker.SandboxCoupler(s.plan.Generation.StationId, d.EnvironmentId, rec.ID, s.plan.couplerImage, p.networkName)
	if err := s.docker.EnsureImage(ctx, s.plan.couplerImage); err != nil {
		s.failSandbox(st, sandboxFailure(protocol.DiagnosisPhaseNetwork, protocol.ErrorCodeSandboxStartFailed, "coupler", "pull %s: %v", s.plan.couplerImage, err))
		return
	}
	cid, err := s.docker.CreateContainer(ctx, spec.At(p.networkName, addr))
	if err == nil {
		err = s.docker.Start(ctx, cid)
	}
	if err != nil {
		s.removeNamed(ctx, spec.Name)
		s.failSandbox(st, sandboxFailure(protocol.DiagnosisPhaseNetwork, protocol.ErrorCodeSandboxStartFailed, "coupler", "start the Coupler %s: %v", spec.Name, err))
		return
	}
	v := s.inspectID(ctx, cid, p.networkName)
	if !v.address.IsValid() {
		v.address = addr
	}
	baseline, elements, domains := s.sandboxElements(d)
	baseline.Self = v.address
	st.pid, st.inode, st.baseline, st.shape = v.pid, v.netns, baseline, s.sandboxShape(d)
	rec.Coupler, rec.Address, rec.Runsc = cid, v.address.String(), version
	s.indexSandbox(rec.ID, v.address, v.pid, baseline.Ports, domains)
	s.applySandboxPolicies()
	st.busy, st.startedOp = true, time.Now()
	st.oom.Store(0)
	job := startJob{
		id: rec.ID, rt: runsc.At(runsc.LibDir, runsc.StateBase, version), fs: s.sbx.fs, pid: v.pid, baseline: baseline, elements: elements,
		resolver: baseline.Resolver, name: d.Name, env: env, docker: s.docker, desired: d, oom: st.oom,
	}
	s.saveSandboxes()
	go func() {
		res := job.run(ctx)
		s.post(ctx, func() { s.finishStart(ctx, st, res) })
	}()
}

type startJob struct {
	id       string
	rt       runsc.Runtime
	fs       store.FS
	pid      int
	baseline netns.SandboxBaseline
	elements netns.SandboxElements
	resolver netip.Addr
	name     string
	env      []string
	docker   *docker.Client
	desired  protocol.DesiredSandbox
	oom      *atomic.Int64
}

type startResult struct {
	failure *protocol.SandboxStatusBodyFailure
	env     []string
	cgroup  string
	started time.Time
	took    time.Duration
}

func (j startJob) run(ctx context.Context) startResult {
	start := time.Now()
	fail := func(step string, format string, args ...any) startResult {
		phase := protocol.DiagnosisPhase("start")
		if step == "namespace" || step == "coupler" {
			phase = protocol.DiagnosisPhaseNetwork
		}
		return startResult{failure: sandboxFailure(phase, protocol.ErrorCodeSandboxStartFailed, step, format, args...)}
	}
	coupler, err := netns.Open(j.pid)
	if err != nil {
		return fail("coupler", "open the Coupler namespace: %v", err)
	}
	defer coupler.Close()
	if _, err := coupler.SyncSandbox(j.baseline, j.elements); err != nil {
		return fail("namespace", "write the Coupler ruleset: %v", err)
	}
	inner, err := netns.CreateInner(j.id)
	if err != nil {
		return fail("namespace", "create the inner namespace: %v", err)
	}
	defer inner.Close()
	if err := netns.LinkSandbox(coupler, inner); err != nil {
		return fail("namespace", "link the veth pair: %v", err)
	}
	if err := j.docker.EnsureImage(ctx, j.desired.Image.ImageRef); err != nil {
		return fail("create", "pull %s: %v", j.desired.Image.ImageRef, err)
	}
	cfg, err := j.docker.ImageConfig(ctx, j.desired.Image.ImageRef)
	if err != nil {
		return fail("create", "read the image configuration of %s: %v", j.desired.Image.ImageRef, err)
	}
	bundle := filepath.Join(sandboxBundles, j.id)
	if err := os.MkdirAll(bundle, 0o700); err != nil {
		return fail("create", "bundle directory: %v", err)
	}
	args := slices.Concat(cfg.Entrypoint, cfg.Cmd)
	if j.desired.Command != nil && len(*j.desired.Command) > 0 {
		args = *j.desired.Command
	}
	if len(args) == 0 {
		return fail("create", "the image %s has no entrypoint or command and the sandbox sets none", j.desired.Image.ImageRef)
	}
	extra := []string{}
	if j.desired.Docker {
		extra = append(extra, "STATIONLY_SANDBOX_DOCKER=1")
	}
	spec := runsc.Spec{
		ID: j.id, Hostname: j.name, DiskPath: j.fs.DiskPath(j.id), BundleDir: bundle, NetNSPath: netns.InnerPath(j.id),
		Args: args, ImageEnv: cfg.Env, Env: append(extra, j.env...), Cwd: cfg.WorkingDir,
		MemoryBytes: int64(j.desired.Size.MemoryBytes), CPUMillis: int64(j.desired.Size.CpuMillis),
	}
	config, err := runsc.Config(spec)
	if err != nil {
		return fail("create", "build config.json: %v", err)
	}
	for name, body := range runsc.HostFiles(spec, j.resolver, j.name) {
		if err := fsx.WriteFile(filepath.Join(bundle, name), body, 0o644); err != nil {
			return fail("create", "write %s: %v", name, err)
		}
	}
	if err := fsx.WriteFile(filepath.Join(bundle, "config.json"), config, 0o600); err != nil {
		return fail("create", "write config.json: %v", err)
	}
	defer os.Remove(filepath.Join(bundle, "config.json"))
	if err := netns.Readdr(inner); err != nil {
		return fail("namespace", "address the inner eth0: %v", err)
	}
	logDir := j.fs.LogDir(j.id)
	initLog, err := j.fs.LogFile(j.id, "init.log")
	if err != nil {
		return fail("create", "open init.log: %v", err)
	}
	defer initLog.Close()
	_ = j.rt.Delete(ctx, j.id, true)
	if err := j.rt.Create(ctx, logDir, bundle, j.id, initLog); err != nil {
		return fail("create", "runsc create: %v%s", err, panicLine(logDir))
	}
	if err := j.rt.Start(ctx, logDir, j.id); err != nil {
		_ = j.rt.Delete(ctx, j.id, true)
		return fail("start", "runsc start: %v%s", err, panicLine(logDir))
	}
	cg, err := runsc.ScopeCgroup(ctx, j.id)
	if err == nil && cg == "" {
		err = errors.New("the scope has no control group")
	}
	if err == nil {
		err = runsc.GroupOOM(cg)
	}
	if err != nil {
		_ = j.rt.Stop(ctx, j.id, 0)
		_ = runsc.KillScope(ctx, j.id)
		return fail("start", "set memory.oom.group on %s: %v", runsc.ScopeUnit(j.id), err)
	}
	return startResult{cgroup: cg, env: append(slices.Clone(cfg.Env), "HOSTNAME="+j.name, "STATIONLY_SANDBOX_ID="+j.id), started: time.Now(), took: time.Since(start)}
}

func panicLine(logDir string) string {
	b, err := os.ReadFile(filepath.Join(logDir, "panic.log"))
	if err != nil || len(b) == 0 {
		return ""
	}
	return "; " + firstLine(string(b))
}

func (s *Station) finishStart(ctx context.Context, st *sbxState, res startResult) {
	st.busy, st.startedOp = false, time.Time{}
	rec := st.rec
	if res.failure != nil {
		s.teardownSandbox(ctx, st)
		s.failSandbox(st, res.failure)
		return
	}
	st.wasRunning, st.syncedAt = false, time.Time{}
	rec.StartedAt, rec.StoppedAt, rec.Cgroup, rec.ImageEnv = stamp(res.started), nil, res.cgroup, res.env
	s.watchSandbox(ctx, st)
	s.reportSandbox(st, protocol.SandboxReportStatusRunning, rec.Reason)
	s.log.Info("sandbox started", "sandbox", rec.ID, "runsc", rec.Runsc, "address", rec.Address, "cgroup", rec.Cgroup, "took_ms", res.took.Milliseconds())
}

func (s *Station) watchSandbox(ctx context.Context, st *sbxState) {
	if st.waitCancel != nil {
		st.waitCancel()
	}
	wctx, cancel := context.WithCancel(ctx)
	st.waitCancel = cancel
	id := st.rec.ID
	rt := runsc.At(runsc.LibDir, runsc.StateBase, st.rec.Runsc)
	if st.rec.Cgroup != "" {
		go watchOOM(wctx, filepath.Join(runsc.CgroupRoot, st.rec.Cgroup, "memory.events"), st.oom, func() {
			s.log.Warn("sandbox reached its memory limit; ending it as a whole", "sandbox", id, "scope", runsc.ScopeUnit(id))
			s.killScope(ctx, id)
		})
	}
	go func() {
		code, err := waitSandbox(wctx, rt, id)
		if wctx.Err() != nil {
			return
		}
		s.post(ctx, func() { s.sandboxEnded(ctx, st, code, err) })
	}()
}

func waitSandbox(ctx context.Context, rt runsc.Runtime, id string) (*int, error) {
	out, err := rt.Command(ctx, "", "wait", id).Output()
	if err != nil {
		return nil, err
	}
	var w struct {
		ExitStatus *int `json:"exitStatus"`
	}
	if jerr := json.Unmarshal(out, &w); jerr != nil {
		return nil, fmt.Errorf("runsc wait answered %q: %w", strings.TrimSpace(string(out)), jerr)
	}
	if w.ExitStatus != nil && *w.ExitStatus > 255 {
		code := *w.ExitStatus >> 8
		return &code, nil
	}
	return w.ExitStatus, nil
}

func (s *Station) sandboxEnded(ctx context.Context, st *sbxState, code *int, err error) {
	if st.stopping != nil || st.rec.Status != protocol.SandboxReportStatusRunning {
		return
	}
	rec := st.rec
	oom := recentOOM(st.oom.Load(), time.Now()) || journalOOM(rec.ID, time.Now().Add(-sandboxOOMWindow))
	reason := protocol.SandboxStatusReasonExited
	if oom {
		reason = protocol.SandboxStatusReasonOom
	}
	rec.ExitCode, rec.OOM = code, oom
	rec.StoppedAt = stamp(time.Now())
	rec.HeldHash = rec.Hash
	line := panicLine(s.sbx.fs.LogDir(rec.ID))
	s.log.Warn("sandbox ended without being asked to", "sandbox", rec.ID, "exit_code", code, "oom_killed", oom, "wait_error", err, "panic", strings.TrimPrefix(line, "; "))
	st.busy = true
	go func() {
		s.stopRuntime(ctx, st, false)
		s.post(ctx, func() {
			st.busy = false
			s.teardownSandbox(ctx, st)
			s.endSandboxRuns(ctx, rec.ID, "the sandbox stopped")
			s.reportSandbox(st, protocol.SandboxReportStatusStopped, reasonOf(reason))
		})
	}()
}

func (s *Station) assertOOMGroup(st *sbxState) {
	if st.rec.Cgroup == "" || runsc.GroupsOOM(st.rec.Cgroup) {
		return
	}
	if err := runsc.GroupOOM(st.rec.Cgroup); err != nil {
		s.log.Warn("set memory.oom.group on the sandbox scope", "sandbox", st.rec.ID, "error", err)
		return
	}
	s.log.Info("memory.oom.group re-asserted on the sandbox scope", "sandbox", st.rec.ID)
}

func recentOOM(at int64, now time.Time) bool {
	return at > 0 && now.Sub(time.Unix(0, at)) <= sandboxOOMWindow
}

func journalOOM(id string, since time.Time) bool {
	args := []string{"-q", "--no-pager", "-o", "cat", "-u", runsc.ScopeUnit(id), "-g", "killed by the OOM killer", "--since", "@" + fmt.Sprint(since.Unix())}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "journalctl", args...).Output()
	return err == nil && strings.Contains(string(out), "OOM")
}

func (s *Station) stopSandbox(ctx context.Context, st *sbxState, reason *protocol.SandboxStatusReason, done func()) {
	rec := st.rec
	if rec.Status != protocol.SandboxReportStatusRunning {
		if done != nil {
			done()
		}
		return
	}
	st.stopping = reason
	st.busy = true
	if st.waitCancel != nil {
		st.waitCancel()
		st.waitCancel = nil
	}
	s.reportSandbox(st, protocol.SandboxReportStatusStopping, reason)
	go func() {
		start := time.Now()
		st.forwards.closeAll()
		s.stopRuntime(ctx, st, true)
		s.post(ctx, func() {
			st.busy, st.stopping = false, nil
			s.endSandboxRuns(ctx, rec.ID, "the sandbox stopped")
			s.teardownSandbox(ctx, st)
			rec.StoppedAt = stamp(time.Now())
			if reason != nil && *reason == protocol.SandboxStatusReasonTtl {
				rec.HeldHash = rec.Hash
			}
			s.reportSandbox(st, protocol.SandboxReportStatusStopped, reason)
			s.log.Info("sandbox stopped", "sandbox", rec.ID, "reason", deref((*string)(reason)), "took_ms", time.Since(start).Milliseconds())
			if done != nil {
				done()
			}
		})
	}()
}

func (s *Station) stopRuntime(ctx context.Context, st *sbxState, graceful bool) {
	rec := st.rec
	rt := runsc.At(runsc.LibDir, runsc.StateBase, rec.Runsc)
	grace := sandboxStopGrace
	if !graceful {
		grace = 0
	}
	sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), grace+30*time.Second)
	defer cancel()
	if err := rt.Stop(sctx, rec.ID, grace); err != nil {
		s.log.Warn("stop the sandbox through runsc", "sandbox", rec.ID, "runsc", rec.Runsc, "error", err)
	}
	s.killScope(ctx, rec.ID)
}

func (s *Station) killScope(ctx context.Context, id string) {
	kctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), runsc.ScopeKillLimit)
	defer cancel()
	if err := runsc.KillScope(kctx, id); err != nil {
		s.log.Error("kill the sandbox scope", "sandbox", id, "scope", runsc.ScopeUnit(id), "error", err)
	}
}

func (s *Station) teardownSandbox(ctx context.Context, st *sbxState) {
	rec := st.rec
	st.forwards.closeAll()
	if err := netns.RemoveInner(rec.ID); err != nil {
		s.log.Warn("remove the inner namespace", "sandbox", rec.ID, "error", err)
	}
	s.removeNamed(ctx, docker.SandboxCouplerName(rec.ID))
	os.RemoveAll(filepath.Join(sandboxBundles, rec.ID))
	s.unindexSandbox(rec.ID)
	s.applySandboxPolicies()
	if st.waitCancel != nil {
		st.waitCancel()
		st.waitCancel = nil
	}
	rec.Address, rec.Coupler, rec.Cgroup = "", "", ""
	st.pid, st.inode = 0, 0
	s.metrics.mu.Lock()
	delete(s.metrics.latest, rec.ID)
	s.metrics.mu.Unlock()
}

func (s *Station) destroySandbox(ctx context.Context, st *sbxState) {
	rec := st.rec
	if rec.Status == protocol.SandboxReportStatusDeleted {
		return
	}
	s.teardownSandbox(ctx, st)
	fs := s.sbx.fs
	if fs.DiskExists(rec.ID) {
		if err := fs.Delete(ctx, fs.DiskPath(rec.ID)); err != nil {
			s.log.Error("delete sandbox disk", "sandbox", rec.ID, "error", err)
			return
		}
	}
	os.RemoveAll(fs.LogDir(rec.ID))
	delete(s.sbx.vars, rec.ID)
	rec.DiskReady = false
	s.reportSandbox(st, protocol.SandboxReportStatusDeleted, nil)
	s.log.Info("sandbox deleted", "sandbox", rec.ID)
}

func (s *Station) syncRunningSandbox(_ context.Context, st *sbxState, d protocol.DesiredSandbox) {
	baseline, elements, domains := s.sandboxElements(d)
	addr, _ := netip.ParseAddr(st.rec.Address)
	baseline.Self = addr
	shape := s.sandboxShape(d)
	if st.pid <= 0 || (shape == st.shape && time.Since(st.syncedAt) < 5*time.Second) {
		return
	}
	st.syncedAt = time.Now()
	entry := s.sbx.index.get(addr)
	if shape != st.shape && entry != nil {
		elements.Allow = toNetnsAllow(entry.mirror.Elements(time.Now()))
	}
	ns, err := netns.OpenChecked(st.pid, st.inode)
	if err != nil {
		s.log.Warn("open the sandbox Coupler namespace", "sandbox", st.rec.ID, "error", err)
		return
	}
	defer ns.Close()
	result, err := ns.SyncSandbox(baseline, elements)
	if err != nil {
		s.log.Warn("sync the sandbox Coupler ruleset", "sandbox", st.rec.ID, "error", err)
		return
	}
	if result != netns.Unchanged {
		s.log.Info("sandbox ruleset synced", "sandbox", st.rec.ID, "result", result)
	}
	if shape == st.shape {
		return
	}
	st.shape, st.baseline = shape, baseline
	s.indexSandbox(st.rec.ID, addr, st.pid, baseline.Ports, domains)
	s.applySandboxPolicies()
	if entry == nil {
		return
	}
	remove, gone := entry.mirror.Retain(domains, time.Now())
	for port, addrs := range remove {
		if !slices.Contains(baseline.Ports, port) {
			continue
		}
		if err := ns.RemoveAllow(port, addrs); err != nil {
			s.log.Warn("remove sandbox allow set elements", "sandbox", st.rec.ID, "port", port, "error", err)
		}
	}
	if len(gone) > 0 {
		rep, err := ns.EvictSandboxFlows(gone)
		s.log.Info("sandbox allowlist narrowed", "sandbox", st.rec.ID, "addresses", len(gone), "evicted", rep.Deleted, "error", err)
	}
}

func (s *Station) sandboxNamespaces(envID string) []nsTarget {
	var out []nsTarget
	for _, id := range slices.Sorted(maps.Keys(s.sbx.states)) {
		st := s.sbx.states[id]
		d, ok := s.plan.Generation.Sandboxes[id]
		if !ok || st.pid <= 0 || st.rec.Status != protocol.SandboxReportStatusRunning || !st.baseline.Joined || d.Network != protocol.SandboxNetworkEnvironment || d.EnvironmentId != envID {
			continue
		}
		out = append(out, nsTarget{name: docker.SandboxCouplerName(id), pid: st.pid, inode: st.inode, envID: envID, self: st.baseline.Self, reach: d.Reach, sandbox: id})
	}
	return out
}

func (s *Station) writeSandboxNS(t nsTarget) (netns.Result, vipswitch.Consumer, error) {
	c := s.consumerFor(t.envID, t.reach)
	st := s.sbx.states[t.sandbox]
	if st == nil {
		return netns.Unchanged, c, fmt.Errorf("sandbox %s is not on this station", t.sandbox)
	}
	ns, err := netns.OpenChecked(t.pid, t.inode)
	if err != nil {
		return netns.Unchanged, c, fmt.Errorf("open the namespace of %s: %w", t.name, err)
	}
	defer ns.Close()
	e := netns.SandboxElements{HostAddrs: s.hostPrefixes(), Switch: c.Switch, Pending: c.Pending, Reject: c.Reject}
	if entry := s.sbx.index.get(t.self); entry != nil {
		e.Allow = toNetnsAllow(entry.mirror.Elements(time.Now()))
	}
	result, err := ns.SyncSandbox(st.baseline, e)
	if err != nil {
		return result, c, fmt.Errorf("write table inet %s into %s: %w", netns.TableName, t.name, err)
	}
	if result != netns.Unchanged {
		s.log.Info("sandbox ruleset synced", "sandbox", t.sandbox, "result", result, "switch", switchText(c.Switch))
	}
	return result, c, nil
}

func toNetnsAllow(m map[uint16][]dns.AllowEntry) map[uint16][]netns.AllowElement {
	out := map[uint16][]netns.AllowElement{}
	for port, els := range m {
		for _, e := range els {
			out[port] = append(out[port], netns.AllowElement{Addr: e.Addr, Timeout: e.Timeout})
		}
	}
	return out
}

func (x *sbxNetIndex) get(a netip.Addr) *sbxNetEntry {
	x.mu.Lock()
	defer x.mu.Unlock()
	return x.byAddr[a]
}

func (s *Station) indexSandbox(id string, addr netip.Addr, pid int, ports []uint16, _ []dns.AllowDomain) {
	x := s.sbx.index
	x.mu.Lock()
	defer x.mu.Unlock()
	for a, e := range x.byAddr {
		if e.id == id && a != addr {
			delete(x.byAddr, a)
		}
	}
	e := x.byAddr[addr]
	if e == nil || e.id != id {
		e = &sbxNetEntry{id: id, mirror: dns.NewAllowMirror()}
		x.byAddr[addr] = e
	}
	e.pid = pid
	e.ports = map[uint16]bool{}
	for _, p := range ports {
		e.ports[p] = true
	}
}

func (s *Station) unindexSandbox(id string) {
	x := s.sbx.index
	x.mu.Lock()
	defer x.mu.Unlock()
	for a, e := range x.byAddr {
		if e.id == id {
			delete(x.byAddr, a)
		}
	}
}

func (s *Station) applySandboxPolicies() {
	if s.plan == nil {
		return
	}
	policies := map[netip.Addr]dns.SandboxPolicy{}
	blocked := s.hostPrefixes()
	for id, st := range s.sbx.states {
		d, ok := s.plan.Generation.Sandboxes[id]
		addr, err := netip.ParseAddr(st.rec.Address)
		if !ok || err != nil {
			continue
		}
		domains, _ := dns.ParseDomains(allowDomains(d.Egress))
		policies[addr] = dns.SandboxPolicy{Joined: d.Network == protocol.SandboxNetworkEnvironment, Allowlist: d.Egress.Mode == protocol.SandboxEgressModeAllowlist, Domains: domains, Blocked: blocked}
	}
	s.resolver.SetSandboxes(policies)
}

func (s *Station) onAllow(a dns.AllowAnswer) {
	e := s.sbx.index.get(a.Source)
	if e == nil {
		return
	}
	refresh := e.mirror.Observe(a, time.Now())
	if len(refresh) == 0 {
		return
	}
	ns, err := netns.Open(e.pid)
	if err != nil {
		s.log.Warn("open the sandbox Coupler namespace for the allow set", "sandbox", e.id, "error", err)
		return
	}
	defer ns.Close()
	for port, els := range refresh {
		if !e.ports[port] {
			continue
		}
		out := make([]netns.AllowElement, 0, len(els))
		for _, el := range els {
			out = append(out, netns.AllowElement{Addr: el.Addr, Timeout: el.Timeout})
		}
		if err := ns.RefreshAllow(port, out); err != nil {
			s.log.Warn("write the sandbox allow set", "sandbox", e.id, "port", port, "name", a.Name, "error", err)
		}
	}
}

func (s *Station) adoptSandboxes(ctx context.Context) {
	versions, _ := runsc.Installed(runsc.LibDir)
	running := map[string]string{}
	for _, v := range versions {
		rt := runsc.At(runsc.LibDir, runsc.StateBase, v)
		lctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		states, err := rt.List(lctx)
		cancel()
		if err != nil {
			s.log.Warn("list runsc sandboxes", "runsc", v, "error", err)
			continue
		}
		for _, state := range states {
			if state.Status == "running" {
				running[state.ID] = v
				continue
			}
			dctx, dcancel := context.WithTimeout(ctx, 20*time.Second)
			_ = rt.Delete(dctx, state.ID, true)
			dcancel()
		}
	}
	for id, st := range s.sbx.states {
		v, alive := running[id]
		if !alive {
			if st.rec.Status == protocol.SandboxReportStatusRunning || st.rec.Status == protocol.SandboxReportStatusStarting || st.rec.Status == protocol.SandboxReportStatusStopping {
				s.teardownSandbox(ctx, st)
				st.rec.Status = protocol.SandboxReportStatusStopped
				st.wasRunning = true
			}
			continue
		}
		delete(running, id)
		st.rec.Runsc = v
		c, err := s.docker.Inspect(ctx, docker.SandboxCouplerName(id))
		if err != nil || c.State == nil || !c.State.Running {
			s.log.Warn("adopted sandbox has no running Coupler; stopping it", "sandbox", id)
			st.rec.Status = protocol.SandboxReportStatusRunning
			go s.stopRuntime(ctx, st, false)
			st.rec.Status = protocol.SandboxReportStatusStopped
			s.teardownSandbox(ctx, st)
			st.wasRunning = true
			continue
		}
		st.pid = c.State.Pid
		if ino, err := netns.Inode(st.pid); err == nil {
			st.inode = ino
		}
		st.rec.Status = protocol.SandboxReportStatusRunning
		st.wasRunning = false
		if st.rec.Cgroup == "" {
			st.rec.Cgroup, _ = runsc.ScopeCgroup(ctx, id)
		}
		if d, ok := s.plan.Generation.Sandboxes[id]; ok {
			b, _, domains := s.sandboxElements(d)
			addr, _ := netip.ParseAddr(st.rec.Address)
			b.Self = addr
			st.shape, st.baseline = s.sandboxShape(d), b
			s.indexSandbox(id, addr, st.pid, b.Ports, domains)
		}
		s.watchSandbox(ctx, st)
		s.log.Info("adopted running sandbox", "sandbox", id, "runsc", v, "address", st.rec.Address)
	}
	for id, v := range running {
		s.log.Warn("stopping a runsc sandbox unknown to stationd", "sandbox", id, "runsc", v)
		rt := runsc.At(runsc.LibDir, runsc.StateBase, v)
		kctx, cancel := context.WithTimeout(ctx, runsc.ScopeKillLimit)
		s.killScope(kctx, id)
		_ = rt.Delete(kctx, id, true)
		cancel()
	}
	s.applySandboxPolicies()
	s.saveSandboxes()
}

func (s *Station) reconcileSnapshots(ctx context.Context) {
	g := s.plan.Generation
	fs := s.sbx.fs
	for _, id := range slices.Sorted(maps.Keys(g.SandboxSnapshots)) {
		d := g.SandboxSnapshots[id]
		rec := s.sbx.snaps[id]
		if rec == nil {
			rec = &snapRecord{ID: id, SandboxID: d.SandboxId}
			s.sbx.snaps[id] = rec
		}
		rec.Hash = d.Hash
		if d.Status == protocol.DesiredSandboxSnapshotStatusDestroy {
			if rec.Status == protocol.SandboxSnapshotReportStatusDeleted {
				continue
			}
			if fs.SnapshotExists(id) {
				if err := fs.Delete(ctx, fs.SnapshotPath(id)); err != nil {
					s.log.Error("delete sandbox snapshot", "snapshot", id, "error", err)
					continue
				}
			}
			rec.Status = protocol.SandboxSnapshotReportStatusDeleted
			s.reportSnapshot(rec)
			continue
		}
		if rec.Status == protocol.SandboxSnapshotReportStatusReady || rec.Status == protocol.SandboxSnapshotReportStatusFailed {
			continue
		}
		if fs.SnapshotExists(id) {
			rec.Status = protocol.SandboxSnapshotReportStatusReady
			if rec.TakenAt == nil {
				rec.TakenAt = stamp(time.Now())
			}
			s.reportSnapshot(rec)
			continue
		}
		src := s.sbx.states[d.SandboxId]
		if src != nil && src.busy {
			continue
		}
		if !fs.DiskExists(d.SandboxId) {
			if src != nil && !src.rec.DiskReady && src.rec.Status != protocol.SandboxReportStatusFailed {
				continue
			}
			rec.Status = protocol.SandboxSnapshotReportStatusFailed
			rec.Failure = &protocol.SandboxSnapshotStatusBodyFailure{Code: string(protocol.ErrorCodeSandboxStateConflict), Phase: protocol.DiagnosisPhaseDisk, Summary: "sandbox " + d.SandboxId + " has no disk on this station"}
			s.reportSnapshot(rec)
			continue
		}
		if free := s.sbx.info.FreeBytes; free < s.minFreeBytes() {
			rec.Status = protocol.SandboxSnapshotReportStatusFailed
			rec.Failure = &protocol.SandboxSnapshotStatusBodyFailure{Code: string(protocol.ErrorCodeSandboxDiskFull), Phase: protocol.DiagnosisPhaseDisk, Summary: fmt.Sprintf("the sandbox filesystem has %d bytes free, below min_free_bytes %d", free, s.minFreeBytes())}
			s.reportSnapshot(rec)
			continue
		}
		start := time.Now()
		if err := fs.Snapshot(ctx, d.SandboxId, id); err != nil {
			rec.Status = protocol.SandboxSnapshotReportStatusFailed
			rec.Failure = &protocol.SandboxSnapshotStatusBodyFailure{Code: string(protocol.ErrorCodeSandboxStartFailed), Phase: protocol.DiagnosisPhaseDisk, Summary: err.Error()}
			s.reportSnapshot(rec)
			continue
		}
		rec.Status, rec.TakenAt = protocol.SandboxSnapshotReportStatusReady, stamp(time.Now())
		s.reportSnapshot(rec)
		s.log.Info("sandbox snapshot taken", "snapshot", id, "sandbox", d.SandboxId, "took_ms", time.Since(start).Milliseconds())
	}
}

func (s *Station) reportSnapshot(rec *snapRecord) {
	key := string(rec.Status)
	if rec.Reported != key {
		rec.Reported = key
		u := s.sbx.usage["snapshots/"+rec.ID]
		body := map[string]any{"snapshot_id": rec.ID, "status": rec.Status, "taken_at": rec.TakenAt, "exclusive_bytes": int(u.Exclusive), "referenced_bytes": int(u.Exclusive), "failure": rec.Failure}
		s.emit(protocol.MessageSandboxSnapshotStatus, body)
		s.log.Info("sandbox snapshot status", "snapshot", rec.ID, "status", rec.Status)
	}
	s.saveSandboxes()
}

func (s *Station) sandboxHousekeeping(ctx context.Context, now time.Time) {
	fs := s.sbx.fs
	if !s.sbx.usageBusy && now.Sub(s.sbx.usageAt) >= sandboxUsageEvery {
		s.sbx.usageBusy = true
		clearStale := now.Sub(s.sbx.staleAt) >= sandboxStaleEvery
		if clearStale {
			s.sbx.staleAt = now
		}
		go func() {
			uctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
			defer cancel()
			if clearStale {
				if err := fs.ClearStale(uctx); err != nil {
					s.log.Debug("clear stale qgroups", "error", err)
				}
			}
			usage, err := fs.Usage(uctx)
			subvols, serr := fs.Subvolumes(uctx)
			s.post(ctx, func() {
				s.sbx.usageBusy, s.sbx.usageAt = false, time.Now()
				if err == nil {
					s.sbx.usage = usage
				} else {
					s.log.Warn("read sandbox quota usage", "error", err)
				}
				if serr == nil {
					s.sbx.unknown = s.unknownSubvolumes(subvols)
				}
			})
		}()
	}
	if now.Sub(s.sbx.cleanAt) >= sandboxCleanEvery {
		s.sbx.cleanAt = now
		s.cleanRuntimes(ctx)
		s.cleanBases(ctx)
		s.cleanCouplers(ctx)
	}
	s.collectSandboxLogs(ctx)
}

func (s *Station) unknownSubvolumes(subvols map[string]bool) []protocol.UnknownObject {
	g := s.plan.Generation
	var out []protocol.UnknownObject
	for path := range subvols {
		kind, id, _ := strings.Cut(path, "/")
		switch kind {
		case "disks":
			if _, ok := g.Sandboxes[id]; !ok {
				out = append(out, protocol.UnknownObject{Kind: protocol.UnknownObjectKindSandboxDisk, Id: ptr(id)})
			}
		case "snapshots":
			if _, ok := g.SandboxSnapshots[id]; !ok {
				out = append(out, protocol.UnknownObject{Kind: protocol.UnknownObjectKindSandboxSnapshot, Id: ptr(id)})
			}
		}
	}
	slices.SortFunc(out, func(a, b protocol.UnknownObject) int { return strings.Compare(*a.Id, *b.Id) })
	return out
}

func (s *Station) cleanRuntimes(_ context.Context) {
	pinned, _ := s.pinnedRunsc()
	used := map[string]bool{pinned: true}
	for _, st := range s.sbx.states {
		if st.rec.Status == protocol.SandboxReportStatusRunning || st.busy {
			used[st.rec.Runsc] = true
		}
	}
	versions, _ := runsc.Installed(runsc.LibDir)
	for _, v := range versions {
		if used[v] || pinned == "" {
			continue
		}
		if err := runsc.Remove(runsc.LibDir, runsc.StateBase, v); err != nil {
			s.log.Warn("remove unused runsc version", "runsc", v, "error", err)
			continue
		}
		s.log.Info("removed unused runsc version", "runsc", v)
	}
}

func (s *Station) cleanBases(ctx context.Context) {
	keep := map[string]bool{}
	if pin, ok := s.plan.Generation.Components["sandbox_toolchain"]; ok && pin.Digest != nil {
		keep[baseKey(*pin.Digest)] = true
	}
	for _, d := range s.plan.Generation.Sandboxes {
		keep[baseKey(d.Image.Digest)] = true
	}
	subvols, err := s.sbx.fs.Subvolumes(ctx)
	if err != nil {
		return
	}
	for path := range subvols {
		kind, key, _ := strings.Cut(path, "/")
		if kind != "bases" || keep[key] {
			continue
		}
		if b := s.sbx.bases[key]; b != nil && b.unpacking {
			continue
		}
		if err := s.sbx.fs.Delete(ctx, s.sbx.fs.BasePath(key)); err != nil {
			s.log.Warn("delete unused sandbox base", "base", key, "error", err)
			continue
		}
		s.log.Info("deleted unused sandbox base", "base", key)
	}
}

func (s *Station) cleanCouplers(ctx context.Context) {
	containers, err := s.docker.Containers(ctx)
	if err != nil {
		return
	}
	for _, c := range containers {
		role := c.Labels[docker.LabelRole]
		if role == docker.RoleSandboxExport {
			key := c.Labels[docker.LabelSandbox]
			if b := s.sbx.bases[key]; b == nil || !b.unpacking {
				s.remove(ctx, c.ID)
			}
			continue
		}
		if role != docker.RoleSandboxCoupler {
			continue
		}
		st := s.sbx.states[c.Labels[docker.LabelSandbox]]
		if st == nil || (!st.busy && st.rec.Status != protocol.SandboxReportStatusRunning) {
			s.log.Info("removing a sandbox Coupler without a running sandbox", "name", containerName(c))
			s.remove(ctx, c.ID)
		}
	}
}

func (s *Station) observedSandboxes() (protocol.ObservedSandboxes, protocol.ObservedSandboxSnapshots, protocol.ObservedSandboxBases) {
	boxes := protocol.ObservedSandboxes{}
	snaps := protocol.ObservedSandboxSnapshots{}
	bases := protocol.ObservedSandboxBases{}
	if s.plan == nil {
		return boxes, snaps, bases
	}
	g := s.plan.Generation
	for id, st := range s.sbx.states {
		rec := st.rec
		if rec.Status == protocol.SandboxReportStatusDeleted {
			continue
		}
		u := s.sbx.usage["disks/"+id]
		o := protocol.ObservedSandbox{
			Status: rec.Status, Reason: rec.Reason, Result: protocol.ObjectResultOk,
			StartedAt: protocol.ObservedSandboxStartedAt(rec.StartedAt),
			Disk:      protocol.ObservedSandboxDisk{ReferencedBytes: int(u.Exclusive), ExclusiveBytes: int(u.Exclusive), LimitBytes: int(rec.Limit)},
		}
		if d, ok := g.Sandboxes[id]; ok {
			o.AppliedHash = protocol.ObservedSandboxAppliedHash(ptr(d.Hash))
			o.StopAt = protocol.ObservedSandboxStopAt(d.StopAt)
		}
		if rec.Address != "" {
			o.Address = protocol.ObservedSandboxAddress(ptr(rec.Address))
		}
		if rec.Runsc != "" {
			o.RunscVersion = protocol.ObservedSandboxRunscVersion(ptr(rec.Runsc))
		}
		if rec.Status == protocol.SandboxReportStatusFailed && rec.Failure != nil {
			o.Result = protocol.ObjectResultFailed
			o.Failure = &protocol.ErrorBody{Code: rec.Failure.Code, Explanation: rec.Failure.Summary, Fix: "Read the sandbox's runtime log, then start it again."}
		}
		boxes[id] = o
	}
	for id, rec := range s.sbx.snaps {
		if rec.Status == protocol.SandboxSnapshotReportStatusDeleted {
			continue
		}
		u := s.sbx.usage["snapshots/"+id]
		o := protocol.ObservedSandboxSnapshot{Result: protocol.ObjectResultOk, TakenAt: protocol.ObservedSandboxSnapshotTakenAt(rec.TakenAt), ExclusiveBytes: int(u.Exclusive), ReferencedBytes: int(u.Exclusive)}
		if d, ok := g.SandboxSnapshots[id]; ok {
			o.AppliedHash = protocol.ObservedSandboxSnapshotAppliedHash(ptr(d.Hash))
		}
		if rec.Status == protocol.SandboxSnapshotReportStatusFailed && rec.Failure != nil {
			o.Result = protocol.ObjectResultFailed
			o.Failure = &protocol.ErrorBody{Code: rec.Failure.Code, Explanation: rec.Failure.Summary, Fix: "Take the snapshot again."}
		}
		snaps[id] = o
	}
	for key, b := range s.sbx.bases {
		state := protocol.SandboxBaseStateReady
		switch {
		case b.unpacking:
			state = protocol.SandboxBaseStateUnpacking
		case b.failure != nil:
			state = protocol.SandboxBaseStateFailed
		case !s.sbx.fs.BaseExists(key):
			continue
		}
		bases[key] = protocol.ObservedSandboxBase{State: state, ReferencedBytes: int(s.sbx.usage["bases/"+key].Referenced)}
	}
	return boxes, snaps, bases
}

func (s *Station) sandboxAckResults(failed func(string, *protocol.ErrorBody)) {
	for id, st := range s.sbx.states {
		if st.rec.Status == protocol.SandboxReportStatusFailed && st.rec.Failure != nil && s.plan != nil {
			if d, ok := s.plan.Generation.Sandboxes[id]; ok && d.Hash == st.rec.HeldHash {
				failed("sandboxes/"+id, &protocol.ErrorBody{Code: st.rec.Failure.Code, Explanation: st.rec.Failure.Summary, Fix: "Read the sandbox's failure and start it again."})
			}
		}
	}
}
