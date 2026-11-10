//go:build linux

package workshop

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	bkclient "github.com/moby/buildkit/client"
	"github.com/moby/buildkit/session"
	"github.com/moby/buildkit/session/secrets/secretsprovider"
	"github.com/moby/buildkit/util/progress/progressui"
	"github.com/tonistiigi/fsutil"
	"golang.org/x/sync/errgroup"

	"github.com/harshjv/stationly/go/internal/depot"
	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/ids"
	"github.com/harshjv/stationly/go/internal/protocol"
)

const (
	provenanceAttr  = "mode=max,version=v1"
	prepareAttempts = 3
	exitTransient   = 75
	maxPlanBytes    = 4 << 20
)

type Request struct {
	ProjectID    string `json:"project_id"`
	ServiceID    string `json:"service_id"`
	SourceDir    string `json:"source_dir"`
	Dockerfile   string `json:"dockerfile,omitempty"`
	Railpack     bool   `json:"railpack,omitempty"`
	BuildCmd     string `json:"build_cmd,omitempty"`
	StartCmd     string `json:"start_cmd,omitempty"`
	BuildID      string `json:"build_id,omitempty"`
	DeploymentID string `json:"deployment_id,omitempty"`
}

type Progress func(step, detail string)

type BuildError struct {
	Failure protocol.BuildResultBodyFailure
	Record  Record
}

func (e *BuildError) Error() string {
	return e.Failure.Code + ": " + e.Failure.Summary
}

func failure(code protocol.ErrorCode, summary string) protocol.BuildResultBodyFailure {
	return protocol.BuildResultBodyFailure{Code: string(code), Phase: protocol.DiagnosisPhaseBuild, Summary: summary}
}

func (m *Manager) Build(ctx context.Context, req Request, progress Progress) (Record, error) {
	start := time.Now()
	g := m.Generation()
	if g == nil {
		return Record{}, fmt.Errorf("no generation applied")
	}
	if req.BuildID == "" {
		req.BuildID = ids.New("bld")
	}
	if req.DeploymentID == "" {
		req.DeploymentID = ids.New("dep")
	}
	registry := g.Station.Registry.Address
	repo := depot.RepositoryFor(req.ProjectID, req.ServiceID)
	rec := Record{
		BuildID:      req.BuildID,
		DeploymentID: req.DeploymentID,
		ProjectID:    req.ProjectID,
		ServiceID:    req.ServiceID,
		Builder:      protocol.BuilderDockerfile,
		Source:       map[string]string{"dir": req.SourceDir},
		ExportName:   registry + "/" + repo + ":" + req.DeploymentID,
		Platform:     "linux/" + m.arch,
		LogRef:       filepath.Join("logs", req.ServiceID, req.DeploymentID, "build.log"),
		StartedAt:    start.UTC().Format(time.RFC3339Nano),
		Tokens:       []TokenEvent{},
		Result: protocol.BuildResultBody{
			BuildId:      req.BuildID,
			Status:       protocol.BuildStatusFailed,
			Attestations: []protocol.BuildAttestation{},
			BaseImages:   []protocol.BaseImage{},
		},
	}
	if req.Railpack {
		rec.Builder = protocol.BuilderRailpack
	} else {
		rec.Source["dockerfile"] = req.Dockerfile
	}
	fail := func(code protocol.ErrorCode, format string, args ...any) (Record, error) {
		f := failure(code, fmt.Sprintf(format, args...))
		rec.Result.Failure = &f
		rec.FinishedAt = time.Now().UTC().Format(time.RFC3339Nano)
		rec.Timings.TotalS = seconds(time.Since(start))
		rec.Result.DurationS = int(time.Since(start).Round(time.Second).Seconds())
		if err := SaveRecord(m.stateDir, rec); err != nil {
			m.log.Error("save build record", "build", rec.BuildID, "error", err)
		}
		return rec, &BuildError{Failure: f, Record: rec}
	}

	ws, ok := g.Workshops[req.ProjectID]
	if !ok {
		return fail(protocol.ErrorCodeBuildFailed, "project %s has no Workshop entry in the applied generation", req.ProjectID)
	}
	pins, err := PinsFrom(g)
	if err != nil {
		return fail(protocol.ErrorCodeBuildFailed, "%v", err)
	}
	if req.Railpack {
		rec.Result.RailpackVersion = &pins.RailpackVersion
	}
	if err := checkSource(&req); err != nil {
		return fail(protocol.ErrorCodeSourceUnreachable, "%v", err)
	}

	progress("queued", "")
	if err := m.depot.WaitWritable(ctx, func() { progress("queued", "waiting_for_registry") }); err != nil {
		return fail(protocol.ErrorCodeBuildFailed, "%v", err)
	}
	p := m.project(req.ProjectID, ws.MaxBuilds)
	select {
	case p.slots <- struct{}{}:
	default:
		progress("queued", "waiting_for_build_slot")
		select {
		case p.slots <- struct{}{}:
		case <-ctx.Done():
			return fail(protocol.ErrorCodeBuildFailed, "%v", ctx.Err())
		}
	}
	defer func() { <-p.slots }()
	if err := m.reserveDaemon(ctx, p, func() { progress("queued", "waiting_for_workshop") }); err != nil {
		return fail(protocol.ErrorCodeBuildFailed, "%v", err)
	}
	defer m.release(p)
	rec.Timings.QueuedS = seconds(time.Since(start))

	progress("running", "workshop")
	t := time.Now()
	p.ensure.Lock()
	w, err := m.ensure(ctx, req.ProjectID, ws, pins)
	p.ensure.Unlock()
	if err != nil {
		return fail(protocol.ErrorCodeBuildFailed, "start the Workshop: %v", err)
	}
	rec.Timings.WorkshopS = seconds(time.Since(t))
	rec.WorkshopStart = map[bool]string{true: "cold", false: "warm"}[w.Started]

	frontend := "dockerfile.v0"
	attrs := map[string]string{
		"platform":          rec.Platform,
		"attest:sbom":       "generator=" + pins.SyftScanner,
		"attest:provenance": provenanceAttr,
	}
	mounts := map[string]string{"context": req.SourceDir}
	if req.Railpack {
		progress("running", "railpack prepare")
		t = time.Now()
		planDir, err := m.prepare(ctx, req, pins, w.CouplerID, g.StationId)
		rec.Timings.PrepareS = seconds(time.Since(t))
		if err != nil {
			return fail(protocol.ErrorCodeBuildFailed, "railpack prepare: %v", err)
		}
		if sum, err := fileSHA(filepath.Join(planDir, "railpack-plan.json")); err == nil {
			rec.Source["plan_sha256"] = sum
		}
		key, err := m.secretsKey(req.ProjectID)
		if err != nil {
			return fail(protocol.ErrorCodeBuildFailed, "secrets hash key: %v", err)
		}
		frontend = "gateway.v0"
		attrs["source"] = pins.Railpack
		attrs["build-arg:secrets-hash"] = secretsHash(key, nil)
		attrs["build-arg:cache-key"] = req.ProjectID
		mounts["dockerfile"] = planDir
	} else {
		mounts["dockerfile"] = filepath.Join(req.SourceDir, filepath.Dir(req.Dockerfile))
		attrs["filename"] = filepath.Base(req.Dockerfile)
	}

	progress("running", "solve")
	t = time.Now()
	resp, ap, vertices, cached, err := m.solve(ctx, w.Socket, rec, registry, repo, frontend, attrs, mounts, progress)
	rec.Timings.SolveS = seconds(time.Since(t))
	rec.Vertices, rec.CachedVertices = vertices, cached
	if ap != nil {
		rec.Tokens = ap.Events()
	}
	if err != nil {
		return fail(protocol.ErrorCodeBuildFailed, "%v", err)
	}
	digest := resp.ExporterResponse["containerimage.digest"]
	if digest == "" {
		return fail(protocol.ErrorCodeBuildFailed, "the image exporter returned no containerimage.digest")
	}
	ref := registry + "/" + repo + "@" + digest
	rec.Result.IndexDigest = &digest
	rec.Result.ImageRef = &ref

	progress("running", "attestations")
	t = time.Now()
	ex, err := extract(ctx, m.depot.Client(), m.stateDir, req.BuildID, repo, digest, m.arch, []string{repositoryPath(protocol.SyftScannerSource), repositoryPath(protocol.RailpackFrontendSource)})
	rec.Timings.AttestS = seconds(time.Since(t))
	if err != nil {
		return fail(protocol.ErrorCodeBuildFailed, "read attestations: %v", err)
	}
	rec.PlatformDigest = ex.PlatformDigest
	rec.Children = ex.Children
	rec.Result.Attestations = ex.Attestations
	rec.Result.BaseImages = ex.BaseImages
	rec.GeneratorVersion = ex.GeneratorVersion
	rec.Result.Status = protocol.BuildStatusSucceeded
	rec.FinishedAt = time.Now().UTC().Format(time.RFC3339Nano)
	rec.Timings.TotalS = seconds(time.Since(start))
	rec.Result.DurationS = int(time.Since(start).Round(time.Second).Seconds())
	if err := SaveRecord(m.stateDir, rec); err != nil {
		return rec, err
	}
	m.log.Info("build succeeded", "build", rec.BuildID, "image_ref", ref, "attestations", len(rec.Result.Attestations), "base_images", len(rec.Result.BaseImages), "total_s", rec.Timings.TotalS)
	return rec, nil
}

func seconds(d time.Duration) float64 {
	return float64(d.Milliseconds()) / 1000
}

func checkSource(req *Request) error {
	if !filepath.IsAbs(req.SourceDir) {
		return fmt.Errorf("source %q must be an absolute path", req.SourceDir)
	}
	info, err := os.Stat(req.SourceDir)
	if err != nil || !info.IsDir() {
		return fmt.Errorf("source %s is not a directory", req.SourceDir)
	}
	if req.Railpack {
		return nil
	}
	if req.Dockerfile == "" {
		req.Dockerfile = "Dockerfile"
	}
	clean := filepath.Clean(req.Dockerfile)
	if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, "../") {
		return fmt.Errorf("dockerfile %q must be a path inside the source", req.Dockerfile)
	}
	req.Dockerfile = clean
	if _, err := os.Stat(filepath.Join(req.SourceDir, clean)); err != nil {
		return fmt.Errorf("failed to read dockerfile: %s does not exist in the source", clean)
	}
	return nil
}

func secretsHash(key []byte, secrets map[string]string) string {
	keys := make([]string, 0, len(secrets))
	for k := range secrets {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	lines := make([]string, len(keys))
	for i, k := range keys {
		lines[i] = k + "=" + secrets[k]
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(strings.Join(lines, "\n")))
	return hex.EncodeToString(mac.Sum(nil))
}

func fileSHA(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}

func (m *Manager) solve(ctx context.Context, socket string, rec Record, registry, repo, frontend string, attrs, mounts map[string]string, progress Progress) (*bkclient.SolveResponse, *depotAuth, int, int, error) {
	c, err := bkclient.New(ctx, socket)
	if err != nil {
		return nil, nil, 0, 0, err
	}
	defer c.Close()
	local := map[string]fsutil.FS{}
	for name, dir := range mounts {
		fs, err := fsutil.NewFS(dir)
		if err != nil {
			return nil, nil, 0, 0, fmt.Errorf("local %s: %w", name, err)
		}
		local[name] = fs
	}
	ap := newDepotAuth(m.log, m.depot.Signer(), registry, rec.ProjectID, repo)
	cacheRef := registry + "/" + depot.RepositoryFor(rec.ProjectID, "cache") + ":" + strings.ToLower(rec.ServiceID)
	opt := bkclient.SolveOpt{
		Frontend:      frontend,
		FrontendAttrs: attrs,
		LocalMounts:   local,
		Exports: []bkclient.ExportEntry{{Type: bkclient.ExporterImage, Attrs: map[string]string{
			"name":           rec.ExportName,
			"push":           "true",
			"oci-mediatypes": "true",
		}}},
		CacheImports: []bkclient.CacheOptionsEntry{{Type: "registry", Attrs: map[string]string{"ref": cacheRef}}},
		CacheExports: []bkclient.CacheOptionsEntry{{Type: "registry", Attrs: map[string]string{"ref": cacheRef, "mode": "max", "oci-mediatypes": "true", "image-manifest": "true"}}},
		Session:      []session.Attachable{ap, secretsprovider.FromMap(map[string][]byte{})},
	}
	logPath := filepath.Join(m.stateDir, rec.LogRef)
	if err := os.MkdirAll(filepath.Dir(logPath), 0o700); err != nil {
		return nil, ap, 0, 0, err
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, ap, 0, 0, err
	}
	defer logFile.Close()

	statusCh := make(chan *bkclient.SolveStatus)
	displayCh := make(chan *bkclient.SolveStatus)
	seen := map[string]bool{}
	cachedSet := map[string]bool{}
	var tail []string
	eg, ectx := errgroup.WithContext(ctx)
	var resp *bkclient.SolveResponse
	eg.Go(func() error {
		var err error
		resp, err = c.Solve(ectx, nil, opt, statusCh)
		return err
	})
	eg.Go(func() error {
		defer close(displayCh)
		for st := range statusCh {
			for _, v := range st.Vertexes {
				key := v.Digest.String()
				if v.Completed != nil && !seen[key] {
					seen[key] = true
					if v.Cached {
						cachedSet[key] = true
					}
					if v.Error == "" {
						progress("vertex", v.Name)
					}
				}
			}
			for _, l := range st.Logs {
				for _, line := range strings.Split(strings.TrimRight(string(l.Data), "\n"), "\n") {
					tail = append(tail, line)
					if len(tail) > 80 {
						tail = tail[1:]
					}
				}
			}
			displayCh <- st
		}
		return nil
	})
	eg.Go(func() error {
		d, err := progressui.NewDisplay(logFile, progressui.PlainMode)
		if err != nil {
			for range displayCh {
			}
			return err
		}
		_, err = d.UpdateFrom(context.WithoutCancel(ectx), displayCh)
		return err
	})
	err = eg.Wait()
	if err != nil && len(tail) > 0 {
		err = fmt.Errorf("%w; last log lines: %s", err, strings.Join(tail[max(len(tail)-10, 0):], " | "))
	}
	return resp, ap, len(seen), len(cachedSet), err
}

func (m *Manager) prepare(ctx context.Context, req Request, pins Pins, couplerID, stationID string) (string, error) {
	vols := docker.PrepareVolumeNames(req.BuildID, req.ProjectID)
	labels := map[string]string{docker.LabelStation: stationID, docker.LabelRole: docker.RolePrepare, docker.LabelProject: req.ProjectID}
	defer func() {
		bg := context.WithoutCancel(ctx)
		_ = m.docker.RemoveVolume(bg, vols.Context)
		_ = m.docker.RemoveVolume(bg, vols.Plan)
	}()
	ctxVol, _, err := m.docker.EnsureVolume(ctx, vols.Context, labels)
	if err != nil {
		return "", err
	}
	planVol, _, err := m.docker.EnsureVolume(ctx, vols.Plan, labels)
	if err != nil {
		return "", err
	}
	if err := copyTree(req.SourceDir, ctxVol.Mountpoint); err != nil {
		return "", fmt.Errorf("copy the context into %s: %w", vols.Context, err)
	}
	args := []string{"prepare", "/app", "--plan-out", "/plan/railpack-plan.json", "--info-out", "/plan/railpack-info.json"}
	if req.BuildCmd != "" {
		args = append(args, "--build-cmd", req.BuildCmd)
	}
	if req.StartCmd != "" {
		args = append(args, "--start-cmd", req.StartCmd)
	}
	spec := docker.Prepare(stationID, req.ProjectID, req.BuildID, pins.Railpack, args, vols)
	if err := docker.CheckInvariants(spec, m.stateDir); err != nil {
		return "", err
	}
	var last string
	for attempt := 1; attempt <= prepareAttempts; attempt++ {
		code, logs, err := m.runOnce(ctx, spec, couplerID)
		if err != nil {
			return "", err
		}
		m.log.Info("railpack prepare finished", "build", req.BuildID, "attempt", attempt, "exit_code", code)
		if code == 0 {
			break
		}
		last = strings.TrimSpace(logs)
		if code != exitTransient {
			info, _ := os.ReadFile(filepath.Join(planVol.Mountpoint, "railpack-info.json"))
			return "", fmt.Errorf("exit %d: %s %s", code, last, strings.TrimSpace(string(info)))
		}
		if attempt == prepareAttempts {
			return "", fmt.Errorf("exit 75 (transient) %d times: %s", prepareAttempts, last)
		}
	}
	dir := filepath.Join(m.stateDir, "builds", req.BuildID, "plan")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	for _, name := range []string{"railpack-plan.json", "railpack-info.json"} {
		b, err := readLimited(filepath.Join(planVol.Mountpoint, name), maxPlanBytes)
		if err != nil {
			return "", err
		}
		if name == "railpack-plan.json" && !json.Valid(b) {
			return "", fmt.Errorf("railpack-plan.json is not JSON")
		}
		if err := os.WriteFile(filepath.Join(dir, name), b, 0o600); err != nil {
			return "", err
		}
	}
	return dir, nil
}

func (m *Manager) runOnce(ctx context.Context, spec docker.ContainerSpec, couplerID string) (int64, string, error) {
	if c, ok, _ := m.docker.ContainerByName(ctx, spec.Name); ok {
		_ = m.docker.Remove(ctx, c.ID)
	}
	id, err := m.docker.CreateContainer(ctx, spec.JoinedTo(couplerID))
	if err != nil {
		return 0, "", err
	}
	defer func() { _ = m.docker.Remove(context.WithoutCancel(ctx), id) }()
	if err := m.docker.Start(ctx, id); err != nil {
		return 0, "", err
	}
	code, err := m.docker.Wait(ctx, id)
	if err != nil {
		return 0, "", err
	}
	logs, _ := m.docker.Logs(ctx, id)
	return code, logs, nil
}

func readLimited(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, limit))
}

func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		info, err := d.Info()
		if err != nil {
			return err
		}
		switch {
		case d.IsDir():
			return os.MkdirAll(target, info.Mode().Perm()|0o700)
		case d.Type()&fs.ModeSymlink != 0:
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(link, target)
		case d.Type().IsRegular():
			in, err := os.Open(path)
			if err != nil {
				return err
			}
			defer in.Close()
			out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode().Perm())
			if err != nil {
				return err
			}
			if _, err := io.Copy(out, in); err != nil {
				out.Close()
				return err
			}
			return out.Close()
		}
		return errors.New("unsupported file type at " + rel)
	})
}
