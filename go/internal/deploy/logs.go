//go:build linux

package deploy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/moby/moby/api/pkg/stdcopy"
	"github.com/moby/moby/api/types/container"

	"github.com/harshjv/stationly/go/internal/dispatch"
	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/logstore"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/workshop"
)

const (
	queryTimeout   = 10 * time.Second
	followEvery    = 200 * time.Millisecond
	followBatch    = 64 << 10
	pageBytes      = 900 << 10
	sweepEvery     = time.Hour
	captureWait    = 3 * time.Second
	roleBuild      = "build"
	defaultRunDays = 30
)

type captureSet struct {
	mu     sync.Mutex
	active map[string]chan struct{}
}

func (c *captureSet) start(name string) (chan struct{}, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.active[name]; ok {
		return nil, false
	}
	done := make(chan struct{})
	c.active[name] = done
	return done, true
}

func (c *captureSet) finish(name string, done chan struct{}) {
	c.mu.Lock()
	if c.active[name] == done {
		delete(c.active, name)
	}
	c.mu.Unlock()
	close(done)
}

func (c *captureSet) waitAll(d time.Duration) {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		c.mu.Lock()
		n := len(c.active)
		c.mu.Unlock()
		if n == 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (c *captureSet) wait(name string, d time.Duration) {
	c.mu.Lock()
	done, ok := c.active[name]
	c.mu.Unlock()
	if !ok {
		return
	}
	select {
	case <-done:
	case <-time.After(d):
	}
}

func runLogRef(svcID, deploymentID, runID string) string {
	return filepath.Join(logDir, svcID, deploymentID, runID+".jsonl")
}

func runtimeDir(svcID, deploymentID string) string {
	return filepath.Join(logDir, svcID, deploymentID)
}

type lineSink struct {
	buf     []byte
	stamped bool
	emit    func(at time.Time, text string)
}

func (l *lineSink) Write(p []byte) (int, error) {
	l.buf = append(l.buf, p...)
	for {
		i := bytes.IndexByte(l.buf, '\n')
		if i < 0 {
			break
		}
		l.line(l.buf[:i])
		l.buf = l.buf[i+1:]
	}
	if len(l.buf) > logstore.MaxLineBytes {
		l.line(l.buf)
		l.buf = nil
	}
	return len(p), nil
}

func (l *lineSink) line(b []byte) {
	text := strings.TrimRight(string(b), "\r")
	at := time.Now().UTC()
	if !l.stamped {
		l.emit(at, text)
		return
	}
	if sp := strings.IndexByte(text, ' '); sp > 0 {
		if t, err := time.Parse(time.RFC3339Nano, text[:sp]); err == nil {
			at, text = t, text[sp+1:]
		}
	} else if t, err := time.Parse(time.RFC3339Nano, text); err == nil {
		at, text = t, ""
	}
	l.emit(at, text)
}

func (l *lineSink) Flush() {
	if len(l.buf) > 0 {
		l.line(l.buf)
		l.buf = nil
	}
}

func (s *Station) copyDockerLogs(ctx context.Context, name, deploymentID, role string, w *logstore.Writer, follow bool, tap func(string)) error {
	since := w.Last()
	rc, err := s.docker.FollowLogs(ctx, name, since, follow)
	if err != nil {
		return err
	}
	defer rc.Close()
	sink := func(stream string) *lineSink {
		return &lineSink{stamped: true, emit: func(at time.Time, text string) {
			if !since.IsZero() && !at.After(since) {
				return
			}
			if err := w.Write(at, role, stream, s.redactorFor(deploymentID).Redact(text)); err != nil {
				s.log.Warn("log store write", "container", name, "error", err)
			}
			if tap != nil {
				tap(text)
			}
		}}
	}
	out, errs := sink(string(protocol.LogStreamStdout)), sink(string(protocol.LogStreamStderr))
	_, err = stdcopy.StdCopy(out, errs, rc)
	out.Flush()
	errs.Flush()
	return err
}

func (s *Station) startCaptures(ctx context.Context) {
	s.capCtx, s.capCancel = context.WithCancel(ctx)
}

func (s *Station) syncCaptures(_ context.Context) {
	if s.handingOver {
		return
	}
	ctx := s.capCtx
	list, err := s.docker.Containers(ctx)
	if err != nil {
		return
	}
	for _, c := range list {
		if c.State != "running" {
			continue
		}
		role := c.Labels[docker.LabelRole]
		svc, dep := c.Labels[docker.LabelService], c.Labels[docker.LabelDeployment]
		if component, ok := systemComponents[role]; ok {
			s.captureSystem(ctx, c, component)
			continue
		}
		if svc == "" || dep == "" {
			continue
		}
		var w *logstore.Writer
		switch role {
		case docker.RoleService:
			w = s.logs.Segmented(runtimeDir(svc, dep), "runtime")
		case docker.RoleCoupler, roleGuard:
			w = s.logs.Segmented(runtimeDir(svc, dep), role)
		case docker.RoleRun:
			runID := c.Labels[docker.LabelRun]
			if runID == "" || s.attached[runID] != nil {
				continue
			}
			w = s.logs.Single(runLogRef(svc, dep, runID), runLogCap)
		default:
			continue
		}
		name := containerName(c)
		done, ok := s.captures.start(name)
		if !ok {
			continue
		}
		go func() {
			defer s.captures.finish(name, done)
			if err := s.copyDockerLogs(ctx, name, dep, role, w, true, nil); err != nil && ctx.Err() == nil {
				s.log.Debug("log capture ended", "container", name, "error", err)
			}
		}()
	}
	if time.Since(s.lastSweep) >= sweepEvery {
		s.lastSweep = time.Now()
		r := s.retention()
		go func() {
			if out := logstore.Sweep(s.opts.StateDir, r, time.Now()); out.Files > 0 {
				s.log.Info("log retention", "files_deleted", out.Files, "bytes_freed", out.Bytes)
			}
		}()
	}
}

const (
	roleGuard  = "guard"
	systemDir  = "system"
	selfName   = "stationd"
	systemFile = "system"
)

var systemComponents = map[string]string{
	docker.RoleDispatch:   "dispatch",
	docker.RoleDepot:      "depot",
	docker.RoleGateway:    "gateway",
	docker.RoleWorkshop:   "buildkit",
	docker.RoleLitestream: "litestream",
}

func systemLogDir(component string) string { return filepath.Join(logDir, systemDir, component) }

func (s *Station) captureSystem(ctx context.Context, c container.Summary, component string) {
	name := containerName(c)
	w := s.logs.Segmented(systemLogDir(component), systemFile)
	done, ok := s.captures.start(name)
	if !ok {
		return
	}
	var tap func(string)
	if component == systemComponents[docker.RoleGateway] {
		tap = func(text string) { s.tapGatewayLog(ctx, text) }
	}
	go func() {
		defer s.captures.finish(name, done)
		if err := s.copyDockerLogs(ctx, name, "", name, w, true, tap); err != nil && ctx.Err() == nil {
			s.log.Debug("system log capture ended", "container", name, "error", err)
		}
	}()
}

type selfLog struct {
	w    *logstore.Writer
	sink *lineSink
	mu   sync.Mutex
}

func SelfLog(stateDir string) io.Writer {
	l := &selfLog{w: logstore.New(stateDir).Segmented(systemLogDir(selfName), systemFile)}
	l.sink = &lineSink{emit: func(at time.Time, text string) { _ = l.w.Write(at, selfName, string(protocol.LogStreamStderr), text) }}
	return l
}

func (l *selfLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.sink.Write(p)
}

func (s *Station) retention() logstore.Retention {
	r := logstore.Retention{RuntimeDays: 14, RuntimeBytesService: 2 << 30, RunDays: defaultRunDays, BuildDays: 30, SystemDays: 7}
	if s.plan == nil {
		return r
	}
	st := s.plan.Generation.Station.Settings
	if st.LogsRetentionRuntimeDays != nil {
		r.RuntimeDays = *st.LogsRetentionRuntimeDays
	}
	if st.LogsRetentionRuntimeBytesPerService != nil {
		r.RuntimeBytesService = int64(*st.LogsRetentionRuntimeBytesPerService)
	}
	if st.LogsRetentionRunDays != nil {
		r.RunDays = *st.LogsRetentionRunDays
	}
	if st.LogsRetentionBuildDays != nil {
		r.BuildDays = *st.LogsRetentionBuildDays
	}
	if st.LogsRetentionSystemDays != nil {
		r.SystemDays = *st.LogsRetentionSystemDays
	}
	return r
}

func (s *Station) glob(pattern string, plain bool, role string) []logstore.Source {
	matches, _ := filepath.Glob(filepath.Join(s.opts.StateDir, pattern))
	out := make([]logstore.Source, 0, len(matches))
	for _, m := range matches {
		rel, err := filepath.Rel(s.opts.StateDir, m)
		if err == nil {
			out = append(out, logstore.Source{Path: rel, Plain: plain, Role: role})
		}
	}
	return out
}

type logTarget struct {
	sources  func() []logstore.Source
	finished func() bool
	reason   string
	complete bool
}

func (s *Station) logTarget(sel protocol.LogSelector) (logTarget, *protocol.ErrorBody) {
	order := func(f func() []logstore.Source) func() []logstore.Source {
		return func() []logstore.Source { return logstore.Order(s.opts.StateDir, f()) }
	}
	never := func() bool { return false }
	switch {
	case sel.RunId != nil:
		id := *sel.RunId
		return logTarget{sources: func() []logstore.Source {
			out := s.glob(filepath.Join(logDir, "*", "*", id+".jsonl"), false, docker.RoleRun)
			return append(out, s.glob(filepath.Join(logDir, "*", "*", id+".log"), true, docker.RoleRun)...)
		}, finished: func() bool {
			v, ok := s.runTerminal.Load(id)
			return ok && v.(bool)
		}, reason: "run_finished", complete: true}, nil
	case sel.SandboxId != nil:
		if strings.ContainsAny(*sel.SandboxId, "/.*") {
			return logTarget{}, protocolError(protocol.ErrorCodeProtocolInvalidMessage, "Name a sandbox id.", "sandbox_id %q is not an id", *sel.SandboxId)
		}
		return s.sandboxLogTarget(*sel.SandboxId, sel.Role), nil
	case sel.BuildId != nil:
		id := *sel.BuildId
		return logTarget{sources: func() []logstore.Source {
			if ref, ok := s.buildLogs.Load(id); ok {
				return []logstore.Source{{Path: ref.(string), Plain: true, Role: roleBuild}}
			}
			records, _ := workshop.Records(s.opts.StateDir)
			for _, r := range records {
				if r.BuildID == id && r.LogRef != "" {
					return []logstore.Source{{Path: r.LogRef, Plain: true, Role: roleBuild}}
				}
			}
			return nil
		}, finished: func() bool {
			_, running := s.runningBuilds.Load(id)
			return !running
		}, reason: "build_finished", complete: true}, nil
	case sel.DeploymentId != nil:
		id := *sel.DeploymentId
		return logTarget{sources: order(func() []logstore.Source { return s.runtimeSources("*", id, sel.Role) }), finished: never}, nil
	case sel.ServiceId != nil:
		id := *sel.ServiceId
		return logTarget{sources: order(func() []logstore.Source { return s.runtimeSources(id, "*", sel.Role) }), finished: never}, nil
	case sel.Source == protocol.LogSourceSystem:
		component := ""
		if sel.Component != nil {
			component = *sel.Component
		}
		if component == "" || strings.ContainsAny(component, "/.*") {
			return logTarget{}, protocolError(protocol.ErrorCodeProtocolInvalidMessage, "Name a component: stationd, depot, gateway or buildkit.", "a system selector needs a component")
		}
		return logTarget{sources: order(func() []logstore.Source {
			return s.glob(filepath.Join(systemLogDir(component), systemFile+".*.jsonl"), false, "")
		}), finished: never}, nil
	}
	return logTarget{}, protocolError(protocol.ErrorCodeProtocolInvalidMessage, "Name exactly one of service_id, deployment_id, build_id or run_id.", "the log selector names no source")
}

func (s *Station) runtimeSources(svc, dep string, role *protocol.LogRole) []logstore.Source {
	prefixes := map[string]string{"runtime": docker.RoleService, docker.RoleCoupler: docker.RoleCoupler, roleGuard: roleGuard}
	var out []logstore.Source
	for prefix, r := range prefixes {
		if role != nil && string(*role) != r {
			continue
		}
		out = append(out, s.glob(filepath.Join(logDir, svc, dep, prefix+".*.jsonl"), false, r)...)
	}
	return out
}

func (s *Station) retireCoupler(ctx context.Context, name string) {
	if name == "" {
		return
	}
	if err := s.docker.Stop(ctx, name, 2); err == nil {
		s.captures.wait(name, 2*time.Second)
	}
	s.removeNamed(ctx, name)
}

func parseOptTime(v *string) (time.Time, error) {
	if v == nil || *v == "" {
		return time.Time{}, nil
	}
	return time.Parse(time.RFC3339Nano, *v)
}

func selectorFilter(sel protocol.LogSelector) (logstore.Filter, *logstore.Cursor, *protocol.ErrorBody) {
	invalid := func(err error) *protocol.ErrorBody {
		return protocolError(protocol.ErrorCodeProtocolInvalidMessage, "Correct the log selector.", "%v", err)
	}
	since, err := parseOptTime(sel.Since)
	if err != nil {
		return logstore.Filter{}, nil, invalid(err)
	}
	until, err := parseOptTime(sel.Until)
	if err != nil {
		return logstore.Filter{}, nil, invalid(err)
	}
	f, err := logstore.NewFilter(since, until, deref(sel.Grep), deref(sel.Level))
	if err != nil {
		return f, nil, invalid(err)
	}
	if sel.Role != nil && sel.Source == protocol.LogSourceRuntime {
		f.Role = string(*sel.Role)
	}
	if sel.Cursor == nil || *sel.Cursor == "" {
		return f, nil, nil
	}
	c, err := logstore.DecodeCursor(*sel.Cursor)
	if err != nil {
		return f, nil, invalid(err)
	}
	return f, &c, nil
}

func wireLine(e logstore.Entry) protocol.LogLine {
	l := protocol.LogLine{At: logstore.FormatTime(e.At), Stream: protocol.LogStream(e.Stream), Text: e.Text, Cursor: logstore.Cursor{F: e.File, O: e.End}.Encode()}
	if l.Stream != protocol.LogStreamStderr {
		l.Stream = protocol.LogStreamStdout
	}
	if e.Role != "" {
		l.Role = protocol.LogLineRole(ptr(e.Role))
	}
	if e.Level != "" {
		l.Level = protocol.LogLineLevel(ptr(e.Level))
	}
	return l
}

func (s *Station) queryLogs(_ context.Context, m dispatch.Message, sel protocol.LogSelector) {
	target, failure := s.logTarget(sel)
	if failure != nil {
		s.replyError(m, failure)
		return
	}
	filter, cursor, failure := selectorFilter(sel)
	if failure != nil {
		s.replyError(m, failure)
		return
	}
	tail := 0
	if sel.Tail != nil {
		tail = *sel.Tail
	}
	go func() {
		done := make(chan logstore.Page, 1)
		go func() { done <- logstore.Read(s.opts.StateDir, target.sources(), filter, tail, cursor) }()
		var page logstore.Page
		select {
		case page = <-done:
		case <-time.After(queryTimeout):
			s.replyError(m, protocolError(protocol.ErrorCodeProtocolLimit, "Narrow the selector with since, until or grep.", "the log query did not finish within %s", queryTimeout))
			return
		}
		body := protocol.LogsPageBody{Lines: make([]protocol.LogLine, 0, len(page.Lines)), Truncated: page.Truncated}
		for _, e := range page.Lines {
			body.Lines = append(body.Lines, wireLine(e))
		}
		if page.Next != nil {
			body.NextCursor = protocol.LogsPageBodyNextCursor(ptr(page.Next.Encode()))
		}
		for len(body.Lines) > 0 {
			b, _ := json.Marshal(body)
			if len(b) <= pageBytes {
				break
			}
			body.Lines = body.Lines[max(1, len(body.Lines)/10):]
		}
		ref := m.ID
		s.send(protocol.MessageLogsPage, &ref, body)
	}()
}

func streamFailure(err error) *protocol.ErrorBody {
	var se *dispatch.StreamError
	if errors.As(err, &se) {
		return protocolError(se.Code, "Close another stream and retry.", "%s", se.Explanation)
	}
	return protocolError(protocol.ErrorCodeProtocolLimit, "Retry.", "%v", err)
}

func (s *Station) openItemStream(m dispatch.Message) (*dispatch.Stream, bool) {
	st, err := s.link.OpenStream(protocol.LimitStreamWindowBytes, nil, nil)
	if err != nil {
		s.replyError(m, streamFailure(err))
		return nil, false
	}
	if err := st.Opened(m.ID, protocol.LimitStreamWindowBytes); err != nil {
		st.End("send failed", nil)
		return nil, false
	}
	return st, true
}

func (s *Station) followLogs(ctx context.Context, m dispatch.Message, sel protocol.LogSelector) {
	target, failure := s.logTarget(sel)
	if failure != nil {
		s.replyError(m, failure)
		return
	}
	filter, cursor, failure := selectorFilter(sel)
	if failure != nil {
		s.replyError(m, failure)
		return
	}
	st, ok := s.openItemStream(m)
	if !ok {
		return
	}
	go func() {
		f := logstore.NewFollower(s.opts.StateDir, target.sources(), cursor, target.complete)
		t := time.NewTicker(followEvery)
		defer t.Stop()
		for {
			finished := target.finished()
			entries := f.Poll(target.sources(), filter, 2000)
			batch := make([]protocol.LogLine, 0, len(entries))
			n := 0
			flush := func() bool {
				if len(batch) == 0 {
					return true
				}
				err := st.SendItems(ctx, batch)
				batch, n = batch[:0], 0
				return err == nil
			}
			for _, e := range entries {
				l := wireLine(e)
				batch = append(batch, l)
				n += len(l.Text) + len(l.Cursor) + 96
				if n >= followBatch && !flush() {
					return
				}
			}
			if !flush() {
				return
			}
			if finished && len(entries) == 0 {
				st.End(target.reason, nil)
				return
			}
			select {
			case <-st.Done():
				return
			case <-ctx.Done():
				st.End("stationd shutting down", nil)
				return
			case <-t.C:
			}
		}
	}()
}

func (s *Station) runLogText(rr *runRecord) []string {
	if !strings.HasSuffix(rr.LogRef, ".jsonl") {
		b, err := os.ReadFile(filepath.Join(s.opts.StateDir, rr.LogRef))
		if err != nil {
			return nil
		}
		text := strings.TrimRight(string(b), "\n")
		if text == "" {
			return nil
		}
		return strings.Split(text, "\n")
	}
	var lines []string
	_, _ = logstore.Scan(s.opts.StateDir, logstore.Source{Path: rr.LogRef, Role: docker.RoleRun}, 0, func(e logstore.Entry) bool {
		lines = append(lines, e.Text)
		if len(lines) > 4*logTail {
			lines = lines[len(lines)-logTail:]
		}
		return true
	})
	return lines
}
