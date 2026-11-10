//go:build linux

package deploy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/moby/moby/api/types/container"

	"github.com/harshjv/stationly/go/internal/cidr"
	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/verify"
)

const (
	dispatchStateFile   = "dispatch.json"
	dispatchHealthWait  = 60 * time.Second
	dispatchRestartWait = 10 * time.Second
	dispatchBackupDir   = "backups"
)

type dispatchSide struct {
	componentPin
	Image string `json:"image"`
	Since string `json:"since"`
}

type dispatchState struct {
	Current  *dispatchSide `json:"current"`
	Previous *dispatchSide `json:"previous"`
}

type dispatchRuntime struct {
	state       dispatchState
	containerID string
	busy        bool
	failure     string
	lastStart   time.Time
}

type MigrationCheck struct {
	Known          []string `json:"known"`
	Applied        []string `json:"applied"`
	Pending        []string `json:"pending"`
	UnknownApplied []string `json:"unknown_applied"`
	Irreversible   []string `json:"irreversible"`
	Prefix         bool     `json:"prefix"`
}

func dispatchStatePath(stateDir string) string { return filepath.Join(stateDir, dispatchStateFile) }

func loadDispatchState(stateDir string) (dispatchState, error) {
	var st dispatchState
	b, err := os.ReadFile(dispatchStatePath(stateDir))
	if errors.Is(err, fs.ErrNotExist) {
		return st, nil
	}
	if err != nil {
		return st, err
	}
	return st, json.Unmarshal(b, &st)
}

func saveDispatchState(stateDir string, st dispatchState) error {
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(dispatchStatePath(stateDir), b)
}

func dispatchAddress(systemSubnet netip.Prefix) netip.Addr {
	return cidr.Offset(systemSubnet, protocol.NetworkDispatchHost)
}

type dispatchLaunch struct {
	stationID string
	stateDir  string
	etcDir    string
	subnet    netip.Prefix
	trust     verify.Trust
	log       *slog.Logger

	litestreamPin *componentPin
}

func (l dispatchLaunch) env(side *dispatchSide) ([]string, error) {
	env, err := DispatchEnv(l.stateDir, l.etcDir)
	if err != nil {
		return nil, err
	}
	env = append(env,
		"STATIONLY_DATABASE="+docker.DispatchDatabase,
		"STATIONLY_DISPATCH_DIGEST="+side.Digest,
		"STATIONLY_SIGNATURES_REPOSITORY="+l.trust.SignaturesRepository,
		"STATIONLY_SIGSTORE_TUF_MIRROR="+l.trust.TUFMirror,
		"STATIONLY_RELEASES_REPOSITORY="+l.trust.ReleasesRepository,
	)
	if l.replicated() {
		env = append(env, "STATIONLY_LITESTREAM=1")
	}
	if len(l.trust.InsecureRegistries) > 0 {
		env = append(env, "STATIONLY_INSECURE_REGISTRIES="+strings.Join(l.trust.InsecureRegistries, ","))
	}
	return env, nil
}

func (l dispatchLaunch) spec(side *dispatchSide) (docker.ContainerSpec, error) {
	env, err := l.env(side)
	if err != nil {
		return docker.ContainerSpec{}, err
	}
	spec := docker.DispatchContainer(l.stationID, side.Image, dispatchAddress(l.subnet), env, l.replicated())
	return spec, docker.CheckInvariants(spec, l.stateDir)
}

func startDispatch(ctx context.Context, dc *docker.Client, l dispatchLaunch, side *dispatchSide) (string, error) {
	if _, _, err := dc.EnsureVolume(ctx, docker.DispatchVolume, map[string]string{docker.LabelStation: l.stationID, docker.LabelRole: docker.RoleDispatchData, docker.LabelComponent: "dispatch"}); err != nil {
		return "", fmt.Errorf("volume %s: %w", docker.DispatchVolume, err)
	}
	spec, err := l.spec(side)
	if err != nil {
		return "", err
	}
	if err := ensureLitestream(ctx, dc, l); err != nil {
		return "", fmt.Errorf("Litestream before Dispatch: %w", err)
	}
	if c, ok, _ := dc.ContainerByName(ctx, spec.Name); ok {
		_ = dc.Remove(ctx, c.ID)
	}
	id, err := dc.CreateContainer(ctx, spec.Create)
	if err != nil {
		return "", fmt.Errorf("create %s: %w", spec.Name, err)
	}
	if err := dc.Start(ctx, id); err != nil {
		return id, fmt.Errorf("start %s: %w", spec.Name, err)
	}
	return id, nil
}

func dispatchHealthy(ctx context.Context, wait time.Duration) (time.Duration, error) {
	start := time.Now()
	hc := &http.Client{Timeout: time.Second}
	url := fmt.Sprintf("http://%s:%d/v1/healthz", protocol.NetworkDispatchHostAddress, protocol.NetworkDispatchPort)
	var last string
	for time.Since(start) < wait {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		resp, err := hc.Do(req)
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return time.Since(start), nil
			}
			last = resp.Status
		} else {
			last = err.Error()
		}
		select {
		case <-ctx.Done():
			return time.Since(start), ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	return time.Since(start), fmt.Errorf("GET %s did not answer 200 within %s (last: %s)", url, wait, last)
}

func (s *Station) dispatchLaunch() dispatchLaunch {
	return dispatchLaunch{stationID: s.opts.Identity.StationID, stateDir: s.opts.StateDir, etcDir: s.opts.EtcDir, subnet: s.system.subnet, trust: s.trust(), log: s.log}
}

func (s *Station) trust() verify.Trust {
	if s.verifier != nil {
		return s.verifier.Trust()
	}
	return verify.ReleaseTrust()
}

func (s *Station) ensureDispatch(ctx context.Context) {
	cur := s.disp.state.Current
	if cur == nil || s.disp.busy || !s.hostsDispatch() || s.system.id == "" || s.system.failure != "" {
		return
	}
	s.ensureLitestream(ctx)
	l := s.dispatchLaunch()
	spec, err := l.spec(cur)
	if err != nil {
		s.disp.failure = err.Error()
		return
	}
	c, ok, err := s.docker.ContainerByName(ctx, docker.DispatchName)
	if err != nil {
		return
	}
	if ok && c.State == container.StateRunning && c.Labels[docker.LabelHash] == spec.Hash {
		s.disp.containerID, s.disp.failure = c.ID, ""
		return
	}
	if time.Since(s.disp.lastStart) < dispatchRestartWait {
		return
	}
	s.disp.lastStart = time.Now()
	reason := "absent"
	if ok {
		reason = fmt.Sprintf("state %s, hash %s", c.State, map[bool]string{true: "current", false: "stale"}[c.Labels[docker.LabelHash] == spec.Hash])
	}
	id, err := startDispatch(ctx, s.docker, l, cur)
	if err != nil {
		s.disp.failure = err.Error()
		s.log.Error("start Dispatch", "image", cur.Image, "error", err)
		return
	}
	s.disp.containerID, s.disp.failure = id, ""
	s.log.Info("Dispatch container started", "reason", reason, "id", shortID(id), "version", cur.Version, "image", cur.Image)
}

func (s *Station) startDispatchUpgrade(ctx context.Context, p *procState) {
	from := s.disp.state.Current
	if from == nil {
		p.Running, p.Step = false, "failed"
		p.Failure = &protocol.ErrorBody{Code: string(protocol.ErrorCodeUpgradeFailed), Explanation: "this station has no Dispatch to upgrade", Fix: "Install a release first."}
		return
	}
	s.disp.busy = true
	to := &dispatchSide{componentPin: p.To, Image: s.sourceOf("dispatch") + "@" + p.To.Digest}
	l := s.dispatchLaunch()
	prev := *from
	s.runProcedure(ctx, "dispatch", p, func(ctx context.Context, _ string, _ *procState, step func(string, map[string]any)) error {
		return s.dispatchProcedure(ctx, l, &prev, to, step)
	})
}

func (s *Station) dispatchProcedure(ctx context.Context, l dispatchLaunch, from, to *dispatchSide, step func(string, map[string]any)) error {
	done := func(err error) error {
		select {
		case s.inspections <- func() {
			s.disp.busy = false
			if err == nil {
				prev := *from
				to.Since = *stamp(time.Now())
				s.disp.state = dispatchState{Current: to, Previous: &prev}
				if serr := saveDispatchState(s.opts.StateDir, s.disp.state); serr != nil {
					s.log.Error("persist dispatch.json", "error", serr)
				}
			}
		}:
		case <-ctx.Done():
		}
		return err
	}
	step("pull", map[string]any{"ref": to.Image})
	t := time.Now()
	if err := s.docker.EnsureImage(ctx, to.Image); err != nil {
		return done(fmt.Errorf("pull %s: %w", to.Image, err))
	}
	step("migrate_check", map[string]any{"pull_ms": time.Since(t).Milliseconds()})
	check, err := s.migrateCheck(ctx, l.stationID, to.Image)
	if err != nil {
		return done(fmt.Errorf("dispatch migrate --check: %w", err))
	}
	step("migrate_checked", map[string]any{"pending": check.Pending, "irreversible": check.Irreversible, "unknown_applied": check.UnknownApplied, "prefix": check.Prefix})
	if len(check.Irreversible) > 0 {
		return done(fmt.Errorf("%s: pending migrations %v drop data; a human must accept a staged change that says so", protocol.ErrorCodeMigrationIrreversible, check.Irreversible))
	}
	restore := ""
	if !check.Prefix {
		if restore, err = s.dispatchBackupFor(ctx, to.Version); err != nil {
			return done(err)
		}
	}
	step("stop", map[string]any{"restore": restore})
	stopAt := time.Now()
	if c, ok, _ := s.docker.ContainerByName(ctx, docker.DispatchName); ok {
		_ = s.docker.Stop(ctx, c.ID, 10)
		_ = s.docker.Remove(ctx, c.ID)
	}
	stopped := time.Since(stopAt)
	if restore != "" {
		if err := s.restoreDispatchBackup(ctx, restore); err != nil {
			s.restartDispatch(ctx, l, from)
			return done(err)
		}
	}
	if _, err := startDispatch(ctx, s.docker, l, to); err != nil {
		s.restartDispatch(ctx, l, from)
		return done(fmt.Errorf("start the new Dispatch: %w", err))
	}
	waited, err := dispatchHealthy(ctx, dispatchHealthWait)
	if err != nil {
		logs, _ := s.docker.LogTail(ctx, docker.DispatchName, 20)
		s.restartDispatch(ctx, l, from)
		return done(fmt.Errorf("the new Dispatch failed readiness, rolled back to %s: %w; last log lines: %s", from.Version, err, strings.Join(logs, " | ")))
	}
	step("healthy", map[string]any{"stop_ms": stopped.Milliseconds(), "ready_ms": waited.Milliseconds(), "outage_ms": time.Since(stopAt).Milliseconds()})
	return done(nil)
}

func (s *Station) restartDispatch(ctx context.Context, l dispatchLaunch, side *dispatchSide) {
	if c, ok, _ := s.docker.ContainerByName(ctx, docker.DispatchName); ok {
		_ = s.docker.Remove(ctx, c.ID)
	}
	if _, err := startDispatch(ctx, s.docker, l, side); err != nil {
		s.log.Error("restart the previous Dispatch", "image", side.Image, "error", err)
		return
	}
	if took, err := dispatchHealthy(ctx, dispatchHealthWait); err != nil {
		s.log.Error("the previous Dispatch did not become healthy", "error", err)
	} else {
		s.log.Info("previous Dispatch serving again", "version", side.Version, "ready_ms", took.Milliseconds())
	}
}

func (s *Station) migrateCheck(ctx context.Context, stationID, image string) (MigrationCheck, error) {
	var out MigrationCheck
	spec := docker.DispatchCheck(stationID, image, []string{"migrate", "--check"})
	if err := docker.CheckInvariants(spec, s.opts.StateDir); err != nil {
		return out, err
	}
	if c, ok, _ := s.docker.ContainerByName(ctx, spec.Name); ok {
		_ = s.docker.Remove(ctx, c.ID)
	}
	id, err := s.docker.CreateContainer(ctx, spec.Create)
	if err != nil {
		return out, err
	}
	defer func() { _ = s.docker.Remove(context.WithoutCancel(ctx), id) }()
	if err := s.docker.Start(ctx, id); err != nil {
		return out, err
	}
	code, err := s.docker.Wait(ctx, id)
	if err != nil {
		return out, err
	}
	logs, _ := s.docker.Logs(ctx, id)
	if code != 0 {
		return out, fmt.Errorf("exited %d: %s", code, strings.TrimSpace(logs))
	}
	for _, line := range strings.Split(logs, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "{") && json.Unmarshal([]byte(line), &out) == nil {
			return out, nil
		}
	}
	return out, fmt.Errorf("no JSON report in the output: %s", strings.TrimSpace(logs))
}

func (s *Station) dispatchVolumeDir(ctx context.Context) (string, error) {
	v, err := s.docker.InspectVolume(ctx, docker.DispatchVolume)
	if err != nil {
		return "", err
	}
	return v.Mountpoint, nil
}

func (s *Station) dispatchBackupFor(ctx context.Context, version string) (string, error) {
	dir, err := s.dispatchVolumeDir(ctx)
	if err != nil {
		return "", err
	}
	entries, _ := os.ReadDir(filepath.Join(dir, dispatchBackupDir))
	var names []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "pre-upgrade-"+version+"-") && strings.HasSuffix(e.Name(), ".sqlite") {
			names = append(names, e.Name())
		}
	}
	if len(names) == 0 {
		return "", fmt.Errorf("Dispatch %s does not know every applied migration and no pre-upgrade backup written by %s exists to restore", version, version)
	}
	sort.Strings(names)
	return filepath.Join(dir, dispatchBackupDir, names[len(names)-1]), nil
}

func (s *Station) restoreDispatchBackup(ctx context.Context, backup string) error {
	dir, err := s.dispatchVolumeDir(ctx)
	if err != nil {
		return err
	}
	db := filepath.Join(dir, filepath.Base(docker.DispatchDatabase))
	b, err := os.ReadFile(backup)
	if err != nil {
		return err
	}
	info, err := os.Stat(db)
	if err != nil {
		return err
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		os.Remove(db + suffix)
	}
	if err := os.WriteFile(db+".restore", b, info.Mode()); err != nil {
		return err
	}
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		if err := os.Chown(db+".restore", int(st.Uid), int(st.Gid)); err != nil {
			return err
		}
	}
	s.log.Warn("restoring Dispatch's pre-upgrade backup: rows written after it are lost", "backup", backup)
	return os.Rename(db+".restore", db)
}
