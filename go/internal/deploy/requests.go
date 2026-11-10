//go:build linux

package deploy

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/harshjv/stationly/go/internal/dispatch"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/workshop"
)

const (
	buildsDir      = "builds-inflight"
	sourcesDir     = "sources"
	blobFetchLimit = 512 << 20
)

type inflightBuild struct {
	BuildID      string `json:"build_id"`
	DeploymentID string `json:"deployment_id"`
	StartedAt    string `json:"started_at"`
}

func (s *Station) buildMarker(id string) string {
	return filepath.Join(s.opts.StateDir, buildsDir, id+".json")
}

func (s *Station) recoverBuilds() {
	dir := filepath.Join(s.opts.StateDir, buildsDir)
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		var ib inflightBuild
		if err != nil || json.Unmarshal(b, &ib) != nil {
			os.Remove(filepath.Join(dir, e.Name()))
			continue
		}
		s.emit(protocol.MessageBuildResult, map[string]any{
			"build_id": ib.BuildID, "status": protocol.BuildStatusFailed, "image_ref": nil, "index_digest": nil, "duration_s": 0,
			"railpack_version": nil, "base_images": []any{}, "attestations": []any{},
			"failure": map[string]any{"phase": protocol.DiagnosisPhaseRecovery, "code": protocol.ErrorCodeBuildFailed, "summary": "stationd restarted while the build was running; Dispatch may start it again"},
		})
		s.log.Warn("build in progress at restart reported failed", "build", ib.BuildID)
		os.Remove(filepath.Join(dir, e.Name()))
		os.RemoveAll(filepath.Join(s.opts.StateDir, sourcesDir, ib.BuildID))
	}
}

func (s *Station) startBuild(ctx context.Context, m dispatch.Message, b protocol.BuildStartBody) {
	if s.plan == nil {
		s.replyError(m, protocolError(protocol.ErrorCodeBuildFailed, "Send a generation before build.start.", "no generation is applied"))
		return
	}
	if _, ok := s.plan.Generation.Workshops[b.ProjectId]; !ok {
		s.replyError(m, protocolError(protocol.ErrorCodeBuildFailed, "Add the project's Workshop to the generation first.", "project %s has no Workshop entry in the applied generation", b.ProjectId))
		return
	}
	if (b.Source.Type != "blob" || b.Source.Blob == nil) && (b.Source.Type != "git" || b.Source.Url == nil || b.Source.Sha == nil) {
		s.replyError(m, protocolError(protocol.ErrorCodeSourceUnreachable, "Send a blob source, or a git source with url and sha.", "source type %s is incomplete", b.Source.Type))
		return
	}
	if b.Builder == protocol.BuilderImage {
		s.replyError(m, protocolError(protocol.ErrorCodeBuildFailed, "Image sources need no build.", "builder image has nothing to build"))
		return
	}
	if _, running := s.builds[b.BuildId]; running {
		s.replyError(m, protocolError(protocol.ErrorCodeBuildFailed, "Wait for the running build.", "build %s is already running", b.BuildId))
		return
	}
	if len(b.BuildSecretKeys) > 0 {
		if _, ok := s.buildSecrets[b.BuildId]; !ok {
			s.replyError(m, unavailable("build %s names build secrets %v but no secrets.deliver for it arrived", b.BuildId, b.BuildSecretKeys))
			return
		}
	}
	if s.link.OutboxFull() {
		s.replyError(m, protocolError(protocol.ErrorCodeProtocolLimit, "Wait until the outbox drains to Dispatch.", "the outbox is at its bound; stationd starts no build until it drains"))
		return
	}
	marker, _ := json.Marshal(inflightBuild{BuildID: b.BuildId, DeploymentID: b.DeploymentId, StartedAt: *stamp(time.Now())})
	if err := os.MkdirAll(filepath.Dir(s.buildMarker(b.BuildId)), 0o700); err == nil {
		writeAtomic(s.buildMarker(b.BuildId), marker)
	}
	bctx, cancel := context.WithCancel(ctx)
	s.builds[b.BuildId] = cancel
	s.buildLogs.Store(b.BuildId, filepath.Join(logDir, b.ServiceId, b.DeploymentId, "build.log"))
	s.runningBuilds.Store(b.BuildId, true)
	ref := m.ID
	s.send(protocol.MessageBuildAccepted, &ref, protocol.BuildRefBody{BuildId: b.BuildId})
	s.log.Info("build accepted", "build", b.BuildId, "deployment", b.DeploymentId, "service", b.ServiceId, "builder", b.Builder, "source", b.Source.Type)
	delivery, delivered := s.buildSecrets[b.BuildId]
	go func() {
		s.runBuild(bctx, b, delivery, delivered)
		s.runningBuilds.Delete(b.BuildId)
		cancel()
		select {
		case s.inspections <- func() { delete(s.builds, b.BuildId); delete(s.buildSecrets, b.BuildId) }:
		case <-ctx.Done():
		}
	}()
}

func (s *Station) cancelBuild(_ context.Context, m dispatch.Message, b protocol.BuildRefBody) {
	if cancel, ok := s.builds[b.BuildId]; ok {
		cancel()
	}
	ref := m.ID
	s.send(protocol.MessageBuildCancelled, &ref, protocol.BuildRefBody{BuildId: b.BuildId})
}

func (s *Station) buildStatus(id string, status protocol.BuildStatus, detail map[string]any) {
	s.emit(protocol.MessageBuildStatus, map[string]any{"build_id": id, "status": status, "detail": detail})
}

func (s *Station) runBuild(ctx context.Context, b protocol.BuildStartBody, delivery protocol.SecretsDeliverBody, delivered bool) {
	defer os.Remove(s.buildMarker(b.BuildId))
	src := filepath.Join(s.opts.StateDir, sourcesDir, b.BuildId)
	defer os.RemoveAll(src)
	start := time.Now()
	result := func(res protocol.BuildResultBody) {
		body, _ := json.Marshal(res)
		var fields map[string]any
		json.Unmarshal(body, &fields)
		delete(fields, "seq")
		s.emit(protocol.MessageBuildResult, fields)
	}
	failed := func(code protocol.ErrorCode, format string, args ...any) {
		f := protocol.BuildResultBodyFailure{Code: string(code), Phase: protocol.DiagnosisPhaseBuild, Summary: fmt.Sprintf(format, args...)}
		result(protocol.BuildResultBody{BuildId: b.BuildId, Status: protocol.BuildStatusFailed, Attestations: []protocol.BuildAttestation{}, BaseImages: []protocol.BaseImage{}, DurationS: int(time.Since(start).Seconds()), Failure: &f})
		s.log.Error("build failed", "build", b.BuildId, "code", code, "summary", f.Summary)
	}
	if b.Source.Type == "git" {
		s.buildStatus(b.BuildId, protocol.BuildStatusRunning, map[string]any{"step": "fetch", "repo": deref(b.Source.Repo), "sha": deref(b.Source.Sha), "ref": deref((*string)(b.Source.Ref))})
		token, err := gitToken(delivery, delivered)
		if err != nil {
			failed(protocol.ErrorCodeSecretsUnavailable, "%v", err)
			return
		}
		fetched, err := fetchGit(ctx, b.Source, token, src)
		var mismatch *shaMismatch
		if errors.As(err, &mismatch) {
			failed(protocol.ErrorCodeSourceShaMismatch, "%s fetched %s at %s, not the approved %s", deref(b.Source.Repo), deref((*string)(b.Source.Ref)), mismatch.fetched, mismatch.expected)
			return
		}
		if err != nil {
			failed(protocol.ErrorCodeSourceUnreachable, "clone %s: %v", deref(b.Source.Repo), err)
			return
		}
		s.log.Info("build source cloned", "build", b.BuildId, "repo", deref(b.Source.Repo), "sha", fetched, "ref", deref((*string)(b.Source.Ref)), "credential", token != "", "took_ms", time.Since(start).Milliseconds())
	} else {
		s.buildStatus(b.BuildId, protocol.BuildStatusRunning, map[string]any{"step": "fetch", "blob_id": b.Source.Blob.BlobId, "size": b.Source.Blob.Size})
		if err := s.fetchSource(ctx, *b.Source.Blob, src); err != nil {
			failed(protocol.ErrorCodeSourceUnreachable, "fetch source blob %s: %v", b.Source.Blob.BlobId, err)
			return
		}
		s.log.Info("build source fetched", "build", b.BuildId, "blob", b.Source.Blob.BlobId, "bytes", b.Source.Blob.Size, "took_ms", time.Since(start).Milliseconds())
	}
	dir := src
	if b.Source.Path != "" && b.Source.Path != "." {
		dir = filepath.Join(src, filepath.Clean("/"+b.Source.Path))
	}
	req := workshop.Request{
		ProjectID:    b.ProjectId,
		ServiceID:    b.ServiceId,
		SourceDir:    dir,
		Railpack:     b.Builder == protocol.BuilderRailpack,
		BuildID:      b.BuildId,
		DeploymentID: b.DeploymentId,
	}
	if b.Source.Dockerfile != nil {
		req.Dockerfile = *b.Source.Dockerfile
	}
	if b.Railpack != nil {
		if b.Railpack.BuildCmd != nil {
			req.BuildCmd = *b.Railpack.BuildCmd
		}
		if b.Railpack.StartCmd != nil {
			req.StartCmd = *b.Railpack.StartCmd
		}
	}
	last := ""
	rec, err := s.workshops.Build(ctx, req, func(step, detail string) {
		if step+detail == last {
			return
		}
		last = step + detail
		status := protocol.BuildStatusRunning
		if step == "queued" {
			status = protocol.BuildStatusQueued
		}
		s.buildStatus(b.BuildId, status, map[string]any{"step": step, "detail": detail})
	})
	var be *workshop.BuildError
	if errors.As(err, &be) {
		result(be.Record.Result)
		s.log.Error("build failed", "build", b.BuildId, "code", be.Failure.Code, "summary", be.Failure.Summary)
		return
	}
	if err != nil {
		failed(protocol.ErrorCodeBuildFailed, "%v", err)
		return
	}
	result(rec.Result)
	s.log.Info("build result reported", "build", b.BuildId, "image_ref", deref(rec.Result.ImageRef))
}

func (s *Station) fetchSource(ctx context.Context, grant protocol.BlobGrant, dst string) error {
	if grant.Size > blobFetchLimit {
		return fmt.Errorf("blob is %d bytes, above the %d-byte limit", grant.Size, blobFetchLimit)
	}
	tmp, err := os.CreateTemp(s.opts.StateDir, ".blob-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	err = s.fetchBlob(ctx, grant, tmp)
	if errors.Is(err, errGrantRefused) {
		fresh, gerr := s.regrant(ctx, grant.BlobId)
		if gerr != nil {
			return gerr
		}
		if err := tmp.Truncate(0); err != nil {
			return err
		}
		if _, err := tmp.Seek(0, io.SeekStart); err != nil {
			return err
		}
		err = s.fetchBlob(ctx, fresh, tmp)
	}
	if err != nil {
		return err
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return err
	}
	return extractTarGz(tmp, dst)
}

func extractTarGz(r io.Reader, dst string) error {
	if err := os.MkdirAll(dst, 0o700); err != nil {
		return err
	}
	root, err := os.OpenRoot(dst)
	if err != nil {
		return err
	}
	defer root.Close()
	gz, err := gzip.NewReader(r)
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		name := filepath.Clean(strings.TrimPrefix(h.Name, "./"))
		if name == "." {
			continue
		}
		switch h.Typeflag {
		case tar.TypeDir:
			if err := root.MkdirAll(name, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := root.MkdirAll(filepath.Dir(name), 0o755); err != nil {
				return err
			}
			f, err := root.OpenFile(name, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(h.Mode&0o755)|0o400)
			if err != nil {
				return err
			}
			if _, err := io.Copy(f, tr); err != nil {
				f.Close()
				return err
			}
			if err := f.Close(); err != nil {
				return err
			}
		}
	}
}

func (s *Station) startRequestedRun(ctx context.Context, m dispatch.Message, b protocol.RunStartBody) {
	if (b.Attach || b.Tty) && !s.requireCapability(m, protocol.CapabilityExecTty) {
		return
	}
	if _, exists := s.runs[b.RunId]; exists {
		ref := m.ID
		s.send(protocol.MessageRunAccepted, &ref, protocol.RunAcceptedBody{RunId: b.RunId})
		return
	}
	if b.SandboxId != nil {
		if !s.requireCapability(m, protocol.CapabilitySandboxV1) {
			return
		}
		s.startSandboxRun(ctx, m, b)
		return
	}
	if b.ServiceId == nil || b.DeploymentId == nil {
		s.replyError(m, protocolError(protocol.ErrorCodeProtocolInvalidMessage, "Name a service and a deployment, or a sandbox.", "run.start names neither a sandbox nor both a service and a deployment"))
		return
	}
	serviceID, deploymentID := string(*b.ServiceId), string(*b.DeploymentId)
	spec, ok := s.specFor(deploymentID)
	sp := s.plan.Services[serviceID]
	if !ok || sp == nil {
		s.replyError(m, protocolError(protocol.ErrorCodeRunDeploymentUnknown, "Start the run against a deployment in the applied generation.", "deployment %s of service %s is not held by this station", deploymentID, serviceID))
		return
	}
	if s.link.OutboxFull() {
		s.replyError(m, protocolError(protocol.ErrorCodeProtocolLimit, "Wait until the outbox drains to Dispatch.", "the outbox is at its bound; stationd starts no run until it drains"))
		return
	}
	cmd := b.Command
	if len(cmd) == 0 {
		cmd = commandOf(spec)
	}
	rr := s.newRunWithID(b.RunId, b.Kind, sp.EnvID, serviceID, deploymentID, spec, cmd, time.Time{}, protocol.RunStatusQueued, true)
	rr.Detail["actor"] = b.Actor
	accepted := protocol.RunAcceptedBody{RunId: b.RunId}
	if b.Attach {
		rr.Attach, rr.TTY = true, b.Tty
		if b.Rows != nil {
			rr.Rows = *b.Rows
		}
		if b.Cols != nil {
			rr.Cols = *b.Cols
		}
		att, err := s.openAttachment(ctx, rr)
		if err != nil {
			s.failRun(ctx, rr, protocol.ErrorCodeProtocolLimit, "open the attach stream: "+err.Error())
			s.replyError(m, streamFailure(err))
			return
		}
		accepted.Stream = protocol.RunAcceptedBodyStream(ptr(att.stream.Number))
	}
	s.saveRun(rr)
	if pending, ok := s.pendingRunSecrets[b.RunId]; ok {
		delete(s.pendingRunSecrets, b.RunId)
		s.deliverRunSecrets(ctx, rr, pending)
	}
	ref := m.ID
	s.send(protocol.MessageRunAccepted, &ref, accepted)
	s.driveRun(ctx, rr)
}

func (s *Station) cancelRequestedRun(ctx context.Context, m dispatch.Message, b protocol.RunRefBody) {
	if rr := s.runs[b.RunId]; rr != nil && !rr.terminal() {
		if rr.SandboxID != "" {
			s.cancelSandboxRun(rr, "cancelled by Dispatch")
		} else {
			s.stopRun(ctx, rr, "cancelled by Dispatch")
		}
	}
	ref := m.ID
	s.send(protocol.MessageRunCancelled, &ref, protocol.RunRefBody{RunId: b.RunId})
}

func (s *Station) deliverRunSecrets(ctx context.Context, rr *runRecord, body protocol.SecretsDeliverBody) (*protocol.SecretsAckBody, *protocol.ErrorBody) {
	dep := rr.DeploymentID
	target := body.Target
	body.Target = protocol.SecretTarget{DeploymentId: &dep}
	ack, failure := s.deliverSecrets(ctx, body)
	if ack != nil {
		ack.Target = target
	}
	return ack, failure
}
