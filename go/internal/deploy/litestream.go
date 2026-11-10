//go:build linux

package deploy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/fsx"
	"github.com/harshjv/stationly/go/internal/hostconfig"
	"github.com/harshjv/stationly/go/internal/litestream"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/moby/moby/api/types/container"
)

const (
	litestreamTaskTimeout = 5 * time.Minute
	litestreamLtxTimeout  = 45 * time.Second
	litestreamStopS       = 30
	configDir             = "config"
	litestreamConfigFile  = "litestream.yml"
	dispatchUID           = 1000
	dispatchGID           = 1000
)

type litestreamPlan struct {
	host   hostconfig.Litestream
	image  string
	files  docker.LitestreamFiles
	config []byte
	env    []string
}

func (l dispatchLaunch) litestreamImage() (string, error) {
	source := l.trust.Source("litestream", docker.LitestreamSource)
	if l.litestreamPin != nil {
		return source + "@" + l.litestreamPin.Digest, nil
	}
	comps, err := loadComponents(l.stateDir)
	if err != nil {
		return "", err
	}
	if rec, ok := comps["litestream"]; ok && rec.Digest != "" {
		return source + "@" + rec.Digest, nil
	}
	raw, err := os.ReadFile(filepath.Join(ReleaseDir(l.stateDir), manifestFile))
	if err != nil {
		return "", fmt.Errorf("read the installed release manifest: %w", err)
	}
	m, err := ParseReleaseManifest(raw)
	if err != nil {
		return "", err
	}
	c, ok := m.Components["litestream"]
	if !ok {
		return "", errors.New("the installed release has no litestream component")
	}
	return source + "@" + pinOf(c), nil
}

func (l dispatchLaunch) replicated() bool {
	host, err := hostconfig.Load(l.etcDir)
	return err == nil && host.BucketConfigured()
}

func (l dispatchLaunch) litestreamPlan() (*litestreamPlan, error) {
	host, err := hostconfig.Load(l.etcDir)
	if err != nil {
		return nil, fmt.Errorf("read host.toml: %w", err)
	}
	if !host.BucketConfigured() {
		return nil, nil
	}
	config, err := litestream.Config(host.Litestream, docker.DispatchDatabase)
	if err != nil {
		return nil, err
	}
	image, err := l.litestreamImage()
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(config)
	env := append(litestream.Env(host.Litestream), docker.LitestreamConfigHash+"="+hex.EncodeToString(sum[:]))
	return &litestreamPlan{
		host:   host.Litestream,
		image:  image,
		files:  docker.LitestreamFiles{ConfigHost: filepath.Join(l.stateDir, configDir, litestreamConfigFile), ConfigTarget: litestream.ConfigTarget},
		config: config,
		env:    env,
	}, nil
}

func (p *litestreamPlan) writeConfig() error {
	if err := os.MkdirAll(filepath.Dir(p.files.ConfigHost), 0o755); err != nil {
		return err
	}
	return fsx.WriteFile(p.files.ConfigHost, p.config, 0o644)
}

func runLitestreamTask(ctx context.Context, dc *docker.Client, spec docker.ContainerSpec, stateDir string, timeout time.Duration) (string, error) {
	if err := docker.CheckInvariants(spec, stateDir); err != nil {
		return "", err
	}
	if c, ok, _ := dc.ContainerByName(ctx, spec.Name); ok {
		dc.Remove(ctx, c.ID)
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	id, err := dc.CreateContainer(ctx, spec.Create)
	if err != nil {
		return "", err
	}
	defer dc.Remove(context.WithoutCancel(ctx), id)
	if err := dc.Start(ctx, id); err != nil {
		return "", err
	}
	code, err := dc.Wait(ctx, id)
	if err != nil {
		return "", err
	}
	logs, _ := dc.Logs(ctx, id)
	logs = strings.TrimSpace(logs)
	if code != 0 {
		return logs, fmt.Errorf("exited %d: %s", code, logs)
	}
	return logs, nil
}

func ownDispatchVolume(ctx context.Context, dc *docker.Client) error {
	v, err := dc.InspectVolume(ctx, docker.DispatchVolume)
	if err != nil {
		return err
	}
	return os.Chown(v.Mountpoint, dispatchUID, dispatchGID)
}

func ensureLitestream(ctx context.Context, dc *docker.Client, l dispatchLaunch) error {
	plan, err := l.litestreamPlan()
	if err != nil {
		return err
	}
	current, exists, err := dc.ContainerByName(ctx, docker.LitestreamName)
	if err != nil {
		return err
	}
	if plan == nil {
		if exists {
			dc.Stop(ctx, current.ID, litestreamStopS)
			dc.Remove(ctx, current.ID)
			l.log.Info("Litestream sidecar removed: host.toml has no litestream.bucket")
		}
		return nil
	}
	if err := plan.writeConfig(); err != nil {
		return fmt.Errorf("write %s: %w", plan.files.ConfigHost, err)
	}
	spec := docker.Litestream(l.stationID, plan.image, plan.files, plan.env)
	if err := docker.CheckInvariants(spec, l.stateDir); err != nil {
		return err
	}
	if exists && current.State == container.StateRunning && current.Labels[docker.LabelHash] == spec.Hash {
		return nil
	}
	if exists {
		dc.Stop(ctx, current.ID, litestreamStopS)
		dc.Remove(ctx, current.ID)
	}
	if err := dc.EnsureImage(ctx, plan.image); err != nil {
		return fmt.Errorf("pull %s: %w", plan.image, err)
	}
	if err := ownDispatchVolume(ctx, dc); err != nil {
		return fmt.Errorf("give the Dispatch volume to uid %d: %w", dispatchUID, err)
	}
	started := time.Now()
	restore := docker.LitestreamTask(l.stationID, plan.image, plan.files, plan.env, "restore", []string{"-if-db-not-exists", "-if-replica-exists"}, docker.DispatchDatabase)
	out, err := runLitestreamTask(ctx, dc, restore, l.stateDir, litestreamTaskTimeout)
	if err != nil {
		return fmt.Errorf("litestream restore: %w", err)
	}
	l.log.Info("Litestream restore finished", "took_ms", time.Since(started).Milliseconds(), "bucket", plan.host.Bucket, "output", lastLines(out, 3))
	id, err := dc.CreateContainer(ctx, spec.Create)
	if err != nil {
		return fmt.Errorf("create %s: %w", spec.Name, err)
	}
	if err := dc.Start(ctx, id); err != nil {
		return fmt.Errorf("start %s: %w", spec.Name, err)
	}
	l.log.Info("Litestream sidecar started", "id", shortID(id), "image", plan.image, "bucket", plan.host.Bucket)
	return nil
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, " | ")
}

func (s *Station) ensureLitestream(ctx context.Context) {
	if p := s.procs["litestream"]; p != nil && p.Running {
		return
	}
	if err := ensureLitestream(ctx, s.docker, s.dispatchLaunch()); err != nil {
		s.litestreamFailure = err.Error()
		s.log.Error("Litestream sidecar", "error", err)
		return
	}
	s.litestreamFailure = ""
}

func (s *Station) litestreamProcedure(ctx context.Context, name string, p *procState, step func(string, map[string]any)) error {
	ref := s.sourceOf(name) + "@" + p.To.Digest
	step("pull", map[string]any{"ref": ref})
	t := time.Now()
	if err := s.docker.EnsureImage(ctx, ref); err != nil {
		return fmt.Errorf("pull %s: %w", ref, err)
	}
	step("restart", map[string]any{"pull_ms": time.Since(t).Milliseconds()})
	l := s.dispatchLaunch()
	l.litestreamPin = &p.To
	t = time.Now()
	if err := ensureLitestream(ctx, s.docker, l); err != nil {
		return err
	}
	step("restarted", map[string]any{"restart_ms": time.Since(t).Milliseconds()})
	return nil
}

func (s *Station) litestreamState(ctx context.Context, l dispatchLaunch, plan *litestreamPlan) (litestream.State, error) {
	spec := docker.LitestreamTask(l.stationID, plan.image, plan.files, plan.env, "ltx", []string{"-json", "-level", "all"}, docker.DispatchDatabase)
	out, err := runLitestreamTask(ctx, s.docker, spec, l.stateDir, litestreamLtxTimeout)
	if err != nil {
		return litestream.State{}, fmt.Errorf("list the replica: %w", err)
	}
	replica, err := litestream.ParseReplica([]byte(out))
	if err != nil {
		return litestream.State{}, err
	}
	dir, err := s.dispatchVolumeDir(ctx)
	if err != nil {
		return litestream.State{}, err
	}
	local, err := litestream.LocalFiles(dir, docker.DispatchDatabase)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return litestream.State{}, err
	}
	return litestream.Compute(time.Now(), replica, local), nil
}

func (s *Station) checkLitestream(ctx context.Context) protocol.DoctorCheck {
	c := newCheck("litestream")
	if s.opts.Host == nil || !s.opts.Host.BucketConfigured() {
		c.raise(protocol.DoctorStatusWarn, "no_offhost_backup", "no off-host backup of Dispatch: host.toml has no litestream.bucket", "Configure a Litestream bucket (sly setup, or litestream.* in host.toml) so a lost host does not lose Dispatch.")
		return c.build()
	}
	host := s.opts.Host.Litestream
	c.detail["bucket"] = host.Bucket
	if host.Endpoint != "" {
		c.detail["endpoint"] = host.Endpoint
	}
	if s.litestreamFailure != "" {
		c.raise(protocol.DoctorStatusFail, "litestream_failed", "the Litestream sidecar did not start: "+s.litestreamFailure, "Fix the cause in the stationd log; stationd retries at its next reconcile.")
		return c.build()
	}
	sidecar, ok, err := s.docker.ContainerByName(ctx, docker.LitestreamName)
	switch {
	case err != nil:
		c.raise(protocol.DoctorStatusFail, "litestream_unchecked", "inspect "+docker.LitestreamName+": "+err.Error(), "")
		return c.build()
	case !ok || sidecar.State != container.StateRunning:
		state := "absent"
		if ok {
			state = string(sidecar.State)
		}
		c.raise(protocol.DoctorStatusFail, "litestream_down", "the Litestream sidecar is "+state+"; Dispatch's writes are not leaving this host", "stationd restarts it at its next reconcile; read its log with docker logs "+docker.LitestreamName+".")
		return c.build()
	}
	l := s.dispatchLaunch()
	plan, err := l.litestreamPlan()
	if err != nil || plan == nil {
		c.raise(protocol.DoctorStatusFail, "litestream_unchecked", fmt.Sprintf("cannot plan the replica check: %v", err), "")
		return c.build()
	}
	st, err := s.litestreamState(ctx, l, plan)
	if err != nil {
		c.raise(protocol.DoctorStatusFail, "replica_unreachable", err.Error(), "Check the bucket, its endpoint and the access key in host.toml.")
		return c.build()
	}
	raiseReplica(c, st)
	return c.build()
}

func raiseReplica(c *checkBuilder, st litestream.State) {
	c.detail["replica_txid"], c.detail["local_txid"], c.detail["behind_txids"] = st.ReplicaTXID, st.LocalTXID, st.BehindTXIDs
	c.detail["lag_s"] = st.Lag.Seconds()
	if !st.LastReplicated.IsZero() {
		c.detail["last_replicated_at"] = tstamp(st.LastReplicated)
	}
	switch {
	case st.ReplicaTXID == 0:
		c.raise(protocol.DoctorStatusWarn, "replica_empty", "the bucket holds no replica of Dispatch yet", "Wait a few seconds after the sidecar starts, then run the doctor again.")
	case st.Stalled():
		c.raise(protocol.DoctorStatusFail, "replication_stalled", fmt.Sprintf("%d transactions have waited %s for the bucket; the last replicated change is from %s", st.BehindTXIDs, st.Lag.Round(time.Second), tstamp(st.LastReplicated)), "Read the sidecar's log (docker logs "+docker.LitestreamName+") and check the bucket's reachability and credentials.")
	default:
		c.note(fmt.Sprintf("replica at transaction %d, behind by %d, lag %s, last replicated change %s", st.ReplicaTXID, st.BehindTXIDs, st.Lag.Round(time.Millisecond), tstamp(st.LastReplicated)))
	}
}
