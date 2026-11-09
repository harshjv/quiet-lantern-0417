//go:build linux

package deploy

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/harshjv/stationly/go/internal/dispatch"
	"github.com/harshjv/stationly/go/internal/netns"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/sandbox/diskfs"
	"github.com/harshjv/stationly/go/internal/sandbox/runsc"
	"github.com/harshjv/stationly/go/internal/secrets"
)

const (
	sandboxRunTimeout    = 1800 * time.Second
	sandboxRunTimeoutMax = 86400 * time.Second
	sandboxRunRole       = "run"
)

type sbxExec struct {
	runID     string
	sandboxID string
	exec      *runsc.Exec
	cancelled string
	timer     *time.Timer
}

type forwardSet struct {
	mu    sync.Mutex
	conns map[*forwardConn]struct{}
}

type forwardConn struct {
	conn   *netns.StreamConn
	stream *dispatch.Stream
	once   sync.Once
}

func newForwardSet() *forwardSet {
	return &forwardSet{conns: map[*forwardConn]struct{}{}}
}

func (f *forwardSet) add(c *forwardConn) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.conns) >= sandboxMaxForwards {
		return false
	}
	f.conns[c] = struct{}{}
	return true
}

func (f *forwardSet) remove(c *forwardConn) {
	f.mu.Lock()
	delete(f.conns, c)
	f.mu.Unlock()
}

func (f *forwardSet) closeAll() {
	f.mu.Lock()
	all := make([]*forwardConn, 0, len(f.conns))
	for c := range f.conns {
		all = append(all, c)
	}
	f.conns = map[*forwardConn]struct{}{}
	f.mu.Unlock()
	for _, c := range all {
		c.end("sandbox_stopped")
	}
}

func (c *forwardConn) end(reason string) {
	c.once.Do(func() {
		c.conn.Close()
		c.stream.End(reason, nil)
	})
}

func sandboxRunLogRef(sandboxID, runID string) string {
	return filepath.Join(logDir, sandboxID, "runs", runID+".jsonl")
}

func (s *Station) sandboxRunning(id string) (*sbxState, bool) {
	st := s.sbx.states[id]
	return st, st != nil && st.rec.Status == protocol.SandboxReportStatusRunning && st.stopping == nil
}

func (s *Station) activeSandboxRuns(id string) int {
	n := 0
	for _, e := range s.sbx.execs {
		if e.sandboxID == id {
			n++
		}
	}
	return n
}

func decodeDelivered(body protocol.SecretsDeliverBody) ([]string, []secrets.Known, error) {
	var env []string
	var known []secrets.Known
	for _, v := range body.Values {
		value, err := base64.RawURLEncoding.DecodeString(v.Value)
		if err != nil {
			return nil, nil, fmt.Errorf("value of %s is not base64url: %w", v.Key, err)
		}
		env = append(env, v.Key+"="+string(value))
		if body.Purpose == protocol.SecretPurposeRun {
			known = append(known, secrets.Known{Key: v.Key, Value: string(value)})
		}
	}
	for _, r := range body.Redaction {
		value, err := base64.RawURLEncoding.DecodeString(r.Value)
		if err != nil {
			return nil, nil, fmt.Errorf("redaction value for %s is not base64url: %w", r.Key, err)
		}
		known = append(known, secrets.Known{Key: r.Key, Value: string(value)})
	}
	return env, known, nil
}

func secretsDigest(values []protocol.SecretValue) (string, error) {
	entries := make([]protocol.EnvEntry, 0, len(values))
	for _, v := range values {
		entries = append(entries, protocol.EnvEntry{Key: v.Key, Injection: v.Injection, Refs: v.Refs, Platform: false})
	}
	return secrets.Digest(entries)
}

func (s *Station) deliverSandboxSecrets(body protocol.SecretsDeliverBody) (*protocol.SecretsAckBody, *protocol.ErrorBody) {
	id := *body.Target.SandboxId
	got, err := secretsDigest(body.Values)
	if err != nil || got != body.EnvDigest {
		return nil, &protocol.ErrorBody{Code: string(protocol.ErrorCodeSecretsMismatch), Explanation: fmt.Sprintf("the delivered keys, injections and refs hash to %s, the delivery says %s", got, body.EnvDigest), Fix: "Resend secrets.deliver built from the sandbox's variables."}
	}
	if s.plan != nil {
		if d, ok := s.plan.Generation.Sandboxes[id]; ok && d.EnvDigest != body.EnvDigest {
			s.log.Warn("sandbox secrets delivered for another env_digest than the applied generation", "sandbox", id, "delivered", body.EnvDigest, "generation", d.EnvDigest)
		}
	}
	env, known, err := decodeDelivered(body)
	if err != nil {
		return nil, &protocol.ErrorBody{Code: string(protocol.ErrorCodeSecretsMismatch), Explanation: err.Error(), Fix: "Resend secrets.deliver with base64url values."}
	}
	s.sbx.vars[id] = &sbxVars{digest: body.EnvDigest, env: env, known: known}
	if st := s.sbx.states[id]; st != nil {
		st.secretsAsked = ""
	}
	s.resync = true
	s.log.Info("sandbox variables delivered", "sandbox", id, "values", len(body.Values), "redaction", len(body.Redaction), "env_digest", body.EnvDigest)
	return &protocol.SecretsAckBody{Target: body.Target, EnvDigest: body.EnvDigest}, nil
}

func (s *Station) sandboxRedactor(id string, extra []secrets.Known) *secrets.Redactor {
	var known []secrets.Known
	if v := s.sbx.vars[id]; v != nil {
		known = append(known, v.known...)
	}
	return secrets.NewRedactor(append(known, extra...))
}

func (s *Station) startSandboxRun(ctx context.Context, m dispatch.Message, b protocol.RunStartBody) {
	id := *b.SandboxId
	refuse := func(code protocol.ErrorCode, fix, format string, args ...any) {
		s.replyError(m, protocolError(code, fix, format, args...))
	}
	st, ok := s.sandboxRunning(id)
	if !ok {
		refuse(protocol.ErrorCodeSandboxNotRunning, "Start the sandbox first.", "sandbox %s is not running on this station", id)
		return
	}
	if s.activeSandboxRuns(id) >= sandboxMaxRuns {
		refuse(protocol.ErrorCodeRateLimited, "Wait for a run of the sandbox to finish.", "sandbox %s already has %d active runs", id, sandboxMaxRuns)
		return
	}
	if len(b.Command) == 0 {
		refuse(protocol.ErrorCodeProtocolInvalidMessage, "Name the command to run.", "run.start for a sandbox needs a command")
		return
	}
	if s.link.OutboxFull() {
		refuse(protocol.ErrorCodeProtocolLimit, "Wait until the outbox drains to Dispatch.", "the outbox is at its bound; stationd starts no run until it drains")
		return
	}
	user := st.rec.ImageUser
	if b.User != nil && *b.User != "" {
		user = *b.User
	}
	uid, gid := 0, 0
	if user != "" && user != "root" && user != "0" && user != "0:0" {
		var err error
		if uid, gid, err = diskfs.LookupUser(s.sbx.fs.DiskPath(id), user); err != nil {
			refuse(protocol.ErrorCodeValidationFailed, "Name a user the sandbox's /etc/passwd knows, or a uid:gid.", "user %q: %v", user, err)
			return
		}
	}
	cwd := st.rec.ImageCwd
	if b.Cwd != nil && *b.Cwd != "" {
		cwd = *b.Cwd
	}
	if cwd == "" {
		cwd = "/"
	}
	var stdin []byte
	if b.Stdin != nil && *b.Stdin != "" {
		raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(*b.Stdin, "="))
		if err != nil {
			refuse(protocol.ErrorCodeProtocolInvalidMessage, "Send stdin as base64url.", "stdin: %v", err)
			return
		}
		stdin = raw
	}
	timeout := sandboxRunTimeout
	if b.TimeoutS != nil && *b.TimeoutS > 0 {
		timeout = min(time.Duration(*b.TimeoutS)*time.Second, sandboxRunTimeoutMax)
	}
	if _, exists := s.runs[b.RunId]; exists {
		ref := m.ID
		s.send(protocol.MessageRunAccepted, &ref, protocol.RunAcceptedBody{RunId: b.RunId})
		return
	}
	now := time.Now()
	rr := &runRecord{
		ID: b.RunId, SandboxID: id, EnvID: s.plan.Generation.Sandboxes[id].EnvironmentId, Kind: b.Kind, Command: b.Command,
		Status: protocol.RunStatusQueued, LogRef: sandboxRunLogRef(id, b.RunId), CreatedAt: *stamp(now), Detail: map[string]any{"actor": b.Actor}, Requested: true,
	}
	s.runs[rr.ID] = rr
	accepted := protocol.RunAcceptedBody{RunId: b.RunId}
	tty := b.Tty
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
			delete(s.runs, rr.ID)
			s.replyError(m, streamFailure(err))
			return
		}
		accepted.Stream = protocol.RunAcceptedBodyStream(ptr(att.stream.Number))
	}
	var runEnv []string
	var runKnown []secrets.Known
	if pending, ok := s.pendingRunSecrets[b.RunId]; ok {
		delete(s.pendingRunSecrets, b.RunId)
		env, known, err := decodeDelivered(pending)
		if err == nil {
			runEnv, runKnown = env, known
		}
	}
	base := append([]string{}, st.rec.ImageEnv...)
	if tty && rr.Attach {
		base = append(base, "TERM=xterm-256color")
	}
	if v := s.sbx.vars[id]; v != nil {
		base = append(base, v.env...)
	}
	redactor := s.sandboxRedactor(id, runKnown)
	spec := runsc.ExecSpec{ID: id, BundleDir: filepath.Join(sandboxBundles, id), Args: b.Command, Env: append(append([]string{}, base...), runEnv...), Cwd: cwd, UID: uid, GID: gid, TTY: tty && rr.Attach, Rows: rr.Rows, Cols: rr.Cols}
	rt := runsc.At(runsc.LibDir, runsc.StateBase, st.rec.Runsc)
	ex, err := rt.Exec(context.WithoutCancel(ctx), spec)
	ref := m.ID
	s.send(protocol.MessageRunAccepted, &ref, accepted)
	if err != nil {
		s.saveRun(rr)
		s.failSandboxRun(rr, protocol.ErrorCodeExitNonzero, "runsc exec: "+err.Error())
		return
	}
	rr.Status, rr.Phase, rr.StartedAt = protocol.RunStatusRunning, phaseStarted, stamp(time.Now())
	s.saveRun(rr)
	se := &sbxExec{runID: rr.ID, sandboxID: id, exec: ex}
	s.sbx.execs[rr.ID] = se
	se.timer = time.AfterFunc(timeout, func() {
		s.post(ctx, func() {
			if s.sbx.execs[rr.ID] == se {
				se.cancelled = fmt.Sprintf("timed out after %s", timeout)
				ex.Kill()
			}
		})
	})
	s.log.Info("sandbox run started", "run", rr.ID, "sandbox", id, "kind", rr.Kind, "tty", spec.TTY, "attach", rr.Attach, "user", user, "cwd", cwd, "command", strings.Join(b.Command, " "))
	att := s.attached[rr.ID]
	go s.pumpSandboxRun(ctx, rr, se, att, redactor, stdin)
}

func (s *Station) pumpSandboxRun(ctx context.Context, rr *runRecord, se *sbxExec, att *attachment, redactor *secrets.Redactor, stdin []byte) {
	w := s.logs.Single(rr.LogRef, runLogCap)
	sink := func(stream string) *lineSink {
		return &lineSink{emit: func(_ time.Time, text string) {
			w.Write(time.Now(), sandboxRunRole, stream, redactor.Redact(text))
		}}
	}
	outLine, errLine := sink(string(protocol.LogStreamStdout)), sink(string(protocol.LogStreamStderr))
	var stdout, stderr io.Writer = outLine, errLine
	bg := context.Background()
	if att != nil {
		att.started = true
		stdout = &streamWriter{ctx: bg, stream: att.stream, channel: dispatch.ChannelStdout, line: outLine}
		stderr = &streamWriter{ctx: bg, stream: att.stream, channel: dispatch.ChannelStderr, line: errLine}
	}
	ex := se.exec
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		io.Copy(stdout, ex.Stdout)
	}()
	if ex.Stderr != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			io.Copy(stderr, ex.Stderr)
		}()
	}
	switch {
	case att != nil:
		go func() {
			for {
				p, eof, ok := att.stdin.pop()
				switch {
				case ok:
					if _, err := ex.Stdin.Write(p); err != nil {
						return
					}
					att.stream.Grant(len(p))
					continue
				case eof:
					if !rr.TTY {
						ex.Stdin.Close()
					}
					return
				}
				select {
				case <-att.stdin.wake:
				case <-att.stream.Done():
					return
				case <-att.outputDone:
					return
				}
			}
		}()
	case ex.Stdin != nil:
		go func() {
			if len(stdin) > 0 {
				ex.Stdin.Write(stdin)
			}
			ex.Stdin.Close()
		}()
	}
	wg.Wait()
	outLine.Flush()
	errLine.Flush()
	code, err := ex.Wait()
	s.logs.Release(w)
	if att != nil {
		close(att.outputDone)
	}
	s.post(ctx, func() { s.finishSandboxRun(rr, se, code, err) })
}

func (s *Station) finishSandboxRun(rr *runRecord, se *sbxExec, code int, err error) {
	delete(s.sbx.execs, rr.ID)
	if se.timer != nil {
		se.timer.Stop()
	}
	if rr.terminal() {
		return
	}
	rr.FinishedAt = stamp(time.Now())
	rr.Detail["duration_ms"] = parseStamp(rr.FinishedAt).Sub(parseStamp(rr.StartedAt)).Milliseconds()
	if se.cancelled != "" && !strings.HasPrefix(se.cancelled, "timed out") {
		rr.Status = protocol.RunStatusCancelled
		rr.Detail["cancelled"] = se.cancelled
		s.saveRun(rr)
		s.log.Info("sandbox run cancelled", "run", rr.ID, "sandbox", rr.SandboxID, "reason", se.cancelled)
		return
	}
	rr.ExitCode = &code
	if err == nil && code == 0 {
		rr.Status = protocol.RunStatusSucceeded
		s.saveRun(rr)
		s.log.Info("sandbox run succeeded", "run", rr.ID, "sandbox", rr.SandboxID, "duration_ms", rr.Detail["duration_ms"])
		return
	}
	summary := fmt.Sprintf("%s %s exited with code %d", rr.Kind, commandText(rr.Command), code)
	if se.cancelled != "" {
		summary = fmt.Sprintf("%s %s %s", rr.Kind, commandText(rr.Command), se.cancelled)
	}
	if err != nil && !errors.Is(err, io.EOF) {
		summary += ": " + err.Error()
	}
	rr.Status = protocol.RunStatusFailed
	rr.Failure = s.runDiagnosis(rr, protocol.ErrorCodeExitNonzero, summary, s.runLogLines(rr))
	s.saveRun(rr)
	s.log.Warn("sandbox run failed", "run", rr.ID, "sandbox", rr.SandboxID, "exit_code", code, "error", err)
}

func (s *Station) failSandboxRun(rr *runRecord, code protocol.ErrorCode, summary string) {
	rr.Status = protocol.RunStatusFailed
	if rr.StartedAt == nil {
		rr.StartedAt = stamp(time.Now())
	}
	rr.FinishedAt = stamp(time.Now())
	rr.Failure = s.runDiagnosis(rr, code, summary, s.runLogLines(rr))
	s.saveRun(rr)
	s.log.Error("sandbox run failed", "run", rr.ID, "sandbox", rr.SandboxID, "code", code, "summary", summary)
}

func (s *Station) cancelSandboxRun(rr *runRecord, reason string) {
	if se := s.sbx.execs[rr.ID]; se != nil {
		se.cancelled = reason
		se.exec.Kill()
		return
	}
	if !rr.terminal() {
		rr.Status = protocol.RunStatusCancelled
		rr.FinishedAt = stamp(time.Now())
		rr.Detail["cancelled"] = reason
		s.saveRun(rr)
	}
}

func (s *Station) endSandboxRuns(ctx context.Context, sandboxID, reason string) {
	for _, rr := range s.orderedRuns() {
		if rr.SandboxID == sandboxID && !rr.terminal() {
			s.cancelSandboxRun(rr, reason)
		}
	}
}

func (s *Station) recoverSandboxRuns() {
	for _, rr := range s.orderedRuns() {
		if rr.SandboxID == "" || rr.terminal() {
			continue
		}
		rr.Status = protocol.RunStatusFailed
		rr.FinishedAt = stamp(time.Now())
		rr.Failure = &protocol.Diagnosis{Entity: &protocol.DiagnosisEntity{Type: protocol.DiagnosisEntityTypeRun, Id: rr.ID}, Phase: protocol.DiagnosisPhaseRecovery, Code: string(protocol.ErrorCodeExitNonzero), Summary: "stationd restarted while the sandbox run was running; the process it started may keep running inside the sandbox until the sandbox stops"}
		s.saveRun(rr)
		s.log.Warn("sandbox run in progress at restart reported failed", "run", rr.ID, "sandbox", rr.SandboxID)
	}
}

func (s *Station) resizeSandboxRun(runID string, rows, cols int) (bool, error) {
	se := s.sbx.execs[runID]
	if se == nil {
		return false, nil
	}
	return true, se.exec.Resize(rows, cols)
}

func (s *Station) openForward(ctx context.Context, m dispatch.Message) {
	if !s.requireCapability(m, protocol.CapabilitySandboxV1) {
		return
	}
	var b protocol.ForwardOpenBody
	if err := json.Unmarshal(m.Body, &b); err != nil {
		s.replyError(m, protocolError(protocol.ErrorCodeProtocolInvalidMessage, "Send a forward.open body that matches its schema.", "%v", err))
		return
	}
	if b.SandboxId == nil {
		s.replyError(m, protocolError(protocol.ErrorCodeProtocolCapabilityMissing, "Forward to a sandbox port.", "this stationd forwards only to sandboxes"))
		return
	}
	if b.Port < 1 || b.Port > 65535 {
		s.replyError(m, protocolError(protocol.ErrorCodeValidationFailed, "Name a port from 1 to 65535.", "port %d is out of range", b.Port))
		return
	}
	st, ok := s.sandboxRunning(*b.SandboxId)
	if !ok || st.pid <= 0 {
		s.replyError(m, protocolError(protocol.ErrorCodeSandboxNotRunning, "Start the sandbox first.", "sandbox %s is not running on this station", *b.SandboxId))
		return
	}
	pid, inode, set, id := st.pid, st.inode, st.forwards, *b.SandboxId
	port := uint16(b.Port)
	var fc *forwardConn
	var mu sync.Mutex
	pending := [][]byte{}
	stream, err := s.link.OpenStream(protocol.LimitStreamWindowBytes, func(ch byte, p []byte) {
		mu.Lock()
		c := fc
		if c == nil {
			pending = append(pending, append([]byte(nil), p...))
			mu.Unlock()
			return
		}
		mu.Unlock()
		if len(p) == 0 {
			return
		}
		if _, err := c.conn.Write(p); err != nil {
			c.end("closed")
			return
		}
		c.stream.Grant(len(p))
	}, func() {
		mu.Lock()
		c := fc
		mu.Unlock()
		if c != nil {
			c.once.Do(func() { c.conn.Close() })
			set.remove(c)
		}
	})
	if err != nil {
		s.replyError(m, streamFailure(err))
		return
	}
	ref := m.ID
	go func() {
		ns, err := netns.OpenChecked(pid, inode)
		if err != nil {
			stream.Opened(ref, protocol.LimitStreamWindowBytes)
			stream.End("connect_failed", nil)
			return
		}
		dctx, cancel := context.WithTimeout(ctx, netns.SandboxDialTimeout)
		conn, err := ns.DialSandbox(dctx, port)
		cancel()
		ns.Close()
		if err := stream.Opened(ref, protocol.LimitStreamWindowBytes); err != nil {
			if conn != nil {
				conn.Close()
			}
			stream.End("send failed", nil)
			return
		}
		if err != nil {
			s.log.Info("sandbox forward could not connect", "sandbox", id, "port", port, "error", err)
			stream.End("connect_failed", nil)
			return
		}
		c := &forwardConn{conn: conn, stream: stream}
		if !set.add(c) {
			conn.Close()
			stream.End(string(protocol.ErrorCodeRateLimited), nil)
			return
		}
		mu.Lock()
		fc = c
		queued := pending
		pending = nil
		mu.Unlock()
		for _, p := range queued {
			if _, err := conn.Write(p); err != nil {
				c.end("closed")
				set.remove(c)
				return
			}
			stream.Grant(len(p))
		}
		s.log.Info("sandbox forward open", "sandbox", id, "port", port, "stream", stream.Number)
		buf := make([]byte, protocol.LimitBinaryPayloadBytes)
		for {
			n, rerr := conn.Read(buf)
			if n > 0 {
				if err := stream.SendBinary(ctx, dispatch.ChannelStdin, buf[:n]); err != nil {
					c.end("closed")
					break
				}
			}
			if rerr != nil {
				reason := "closed"
				if !errors.Is(rerr, io.EOF) && !errors.Is(rerr, net.ErrClosed) {
					reason = "connection_error"
				}
				c.end(reason)
				break
			}
		}
		set.remove(c)
	}()
}

func (s *Station) growSandboxStorage(ctx context.Context, m dispatch.Message) {
	if !s.requireCapability(m, protocol.CapabilitySandboxV1) {
		return
	}
	var b protocol.SandboxStorageGrowBody
	if err := json.Unmarshal(m.Body, &b); err != nil {
		s.replyError(m, protocolError(protocol.ErrorCodeProtocolInvalidMessage, "Send a sandbox.storage.grow body that matches its schema.", "%v", err))
		return
	}
	if !s.sandboxStorageReady() {
		s.replyError(m, protocolError(protocol.ErrorCodeStationCapabilityMissing, "Provision the sandbox filesystem with stationd install --sandbox-size or --sandbox-device.", "%s", s.sandboxUnavailable()))
		return
	}
	ref := m.ID
	fs, stateDir, etcDir := s.sbx.fs, s.opts.StateDir, s.opts.EtcDir
	go func() {
		gctx, cancel := context.WithTimeout(ctx, 110*time.Second)
		defer cancel()
		free, err := rootFree(stateDir)
		var res storeGrowResult
		if err == nil {
			res.bytes, res.free, err = growStorage(gctx, fs, uint64(b.SizeBytes), free)
		}
		reply := protocol.SandboxStorageGrownBody{Status: protocol.SandboxStorageGrowStatusGrown, FilesystemBytes: int(res.bytes), FilesystemFreeBytes: int(res.free)}
		if err != nil {
			var ge interface{ GrowStep() string }
			step := growStepOf(err)
			if errors.As(err, &ge) {
				step = ge.GrowStep()
			}
			if step == "" {
				s.send(protocol.MessageError, &ref, protocolError(protocol.ErrorCodeValidationFailed, "Ask for a size larger than the current one that leaves 10 GiB free on the root filesystem.", "%v", err))
				return
			}
			st := protocol.SandboxStorageGrowStep(step)
			msg := err.Error()
			reply.Status, reply.Step, reply.Error = protocol.SandboxStorageGrowStatusFailed, &st, protocol.SandboxStorageGrownBodyError(&msg)
		} else {
			recordStorageSize(etcDir, res.bytes)
		}
		s.send(protocol.MessageSandboxStorageGrown, &ref, reply)
		s.post(ctx, func() { s.sbx.infoAt = time.Time{} })
		s.log.Info("sandbox filesystem grow", "size_bytes", b.SizeBytes, "status", reply.Status, "filesystem_bytes", res.bytes, "error", err)
	}()
}

type storeGrowResult struct {
	bytes, free uint64
}
