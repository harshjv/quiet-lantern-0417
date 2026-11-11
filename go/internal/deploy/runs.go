//go:build linux

package deploy

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/moby/moby/api/types/container"

	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/ids"
	"github.com/harshjv/stationly/go/internal/protocol"
)

const (
	runDir      = "runs"
	logDir      = "logs"
	runLogCap   = 4 << 20
	runsShown   = 20
	runStopWait = 10 * time.Second
)

const (
	phaseQueued   = ""
	phaseStarting = "starting"
	phaseStarted  = "started"
)

type runRecord struct {
	ID           string                 `json:"run_id"`
	SandboxID    string                 `json:"sandbox_id,omitempty"`
	ServiceID    string                 `json:"service_id"`
	EnvID        string                 `json:"environment_id"`
	DeploymentID string                 `json:"deployment_id"`
	Kind         protocol.RunKind       `json:"kind"`
	Command      []string               `json:"command"`
	Spec         protocol.ContainerSpec `json:"spec,omitzero"`
	Status       protocol.RunStatus     `json:"status"`
	Phase        string                 `json:"phase"`
	ExitCode     *int                   `json:"exit_code"`
	OOMKilled    bool                   `json:"oom_killed"`
	Failure      *protocol.Diagnosis    `json:"failure"`
	LogRef       string                 `json:"log_ref"`
	CouplerID    string                 `json:"coupler_id,omitempty"`
	ContainerID  string                 `json:"container_id,omitempty"`
	Address      string                 `json:"address,omitempty"`
	ScheduledAt  *string                `json:"scheduled_at"`
	CreatedAt    string                 `json:"created_at"`
	StartedAt    *string                `json:"started_at"`
	FinishedAt   *string                `json:"finished_at"`
	Detail       map[string]any         `json:"detail"`
	Requested    bool                   `json:"requested,omitempty"`
	Attach       bool                   `json:"attach,omitempty"`
	TTY          bool                   `json:"tty,omitempty"`
	Rows         int                    `json:"rows,omitempty"`
	Cols         int                    `json:"cols,omitempty"`
	Reported     protocol.RunStatus     `json:"reported,omitempty"`
}

func (rr *runRecord) terminal() bool {
	switch rr.Status {
	case protocol.RunStatusSucceeded, protocol.RunStatusFailed, protocol.RunStatusSkipped, protocol.RunStatusCancelled:
		return true
	}
	return false
}

func (rr *runRecord) phase() protocol.DiagnosisPhase {
	if rr.Kind == protocol.RunKindPreDeploy {
		return protocol.DiagnosisPhasePreDeploy
	}
	return protocol.DiagnosisPhaseRun
}

func loadRuns(stateDir string) (map[string]*runRecord, error) {
	loaded, err := readJSONDir[runRecord](filepath.Join(stateDir, runDir))
	if err != nil {
		return nil, err
	}
	out := map[string]*runRecord{}
	for _, rr := range loaded {
		if rr.Detail == nil {
			rr.Detail = map[string]any{}
		}
		out[rr.ID] = rr
	}
	return out, nil
}

func (s *Station) reportRun(rr *runRecord) {
	if rr.Reported == rr.Status {
		return
	}
	if rr.Reported == "" && !rr.Requested {
		s.emit(protocol.MessageRunCreated, protocol.RunCreatedBody{Run: protocol.RunRow{
			Id: rr.ID, ServiceId: rr.ServiceID, DeploymentId: nilIfEmpty(rr.DeploymentID), Kind: rr.Kind, Command: rr.Command,
			Status: rr.Status, ExitCode: rr.ExitCode, Failure: (*protocol.RunRowFailure)(rr.Failure), LogRef: rr.LogRef, StartedAt: rr.StartedAt, FinishedAt: rr.FinishedAt,
		}})
	}
	if rr.Reported != "" || rr.Requested || rr.terminal() {
		typ := protocol.MessageRunStatus
		if rr.terminal() {
			typ = protocol.MessageRunExited
		}
		s.emit(typ, protocol.RunStatusBody{RunId: rr.ID, Status: rr.Status, ExitCode: rr.ExitCode, StartedAt: rr.StartedAt, FinishedAt: rr.FinishedAt, Failure: (*protocol.RunStatusBodyFailure)(rr.Failure)})
	}
	rr.Reported = rr.Status
}

func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func (s *Station) saveRun(rr *runRecord) {
	s.reportRun(rr)
	s.runTerminal.Store(rr.ID, rr.terminal())
	if rr.terminal() {
		s.finishAttachment(rr)
	}
	if err := writeJSON(filepath.Join(s.opts.StateDir, runDir, rr.ID+".json"), rr); err != nil {
		s.log.Error("persist run", "run", rr.ID, "error", err)
	}
}

func (s *Station) newRun(kind protocol.RunKind, envID, svcID, deploymentID string, spec protocol.ContainerSpec, cmd []string, scheduled time.Time, status protocol.RunStatus) *runRecord {
	return s.newRunWithID(ids.New("run"), kind, envID, svcID, deploymentID, spec, cmd, scheduled, status, false)
}

func (s *Station) newRunWithID(id string, kind protocol.RunKind, envID, svcID, deploymentID string, spec protocol.ContainerSpec, cmd []string, scheduled time.Time, status protocol.RunStatus, requested bool) *runRecord {
	now := time.Now()
	if cmd == nil {
		cmd = []string{}
	}
	rr := &runRecord{
		ID:           id,
		ServiceID:    svcID,
		EnvID:        envID,
		DeploymentID: deploymentID,
		Kind:         kind,
		Command:      cmd,
		Spec:         spec,
		Status:       status,
		LogRef:       runLogRef(svcID, deploymentID, id),
		ScheduledAt:  stamp(scheduled),
		CreatedAt:    *stamp(now),
		Detail:       map[string]any{},
		Requested:    requested,
	}
	if status == protocol.RunStatusSkipped {
		rr.StartedAt, rr.FinishedAt = stamp(now), stamp(now)
	}
	s.runs[id] = rr
	s.saveRun(rr)
	s.log.Info("run created", "run", id, "service", svcID, "deployment", deploymentID, "kind", kind, "status", status, "command", strings.Join(cmd, " "))
	return rr
}

func (s *Station) activeRun(svcID string, kind protocol.RunKind) *runRecord {
	for _, rr := range s.orderedRuns() {
		if rr.ServiceID == svcID && rr.Kind == kind && !rr.terminal() {
			return rr
		}
	}
	return nil
}

func (s *Station) hasRun(svcID, deploymentID string, kind protocol.RunKind) bool {
	for _, rr := range s.runs {
		if rr.ServiceID == svcID && rr.DeploymentID == deploymentID && rr.Kind == kind {
			return true
		}
	}
	return false
}

func (s *Station) orderedRuns() []*runRecord {
	out := make([]*runRecord, 0, len(s.runs))
	for _, rr := range s.runs {
		out = append(out, rr)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt != out[j].CreatedAt {
			return out[i].CreatedAt < out[j].CreatedAt
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func (s *Station) advanceRuns(ctx context.Context, now time.Time) {
	for _, id := range s.plan.ServiceIDs() {
		sp := s.plan.Services[id]
		if sp.Kind != protocol.ServiceKindOneOff || !sp.Wanted || sp.DeploymentID == "" || sp.Unsupported != nil {
			continue
		}
		if !s.hasRun(id, sp.DeploymentID, protocol.RunKindOneOff) {
			rr := s.newRun(protocol.RunKindOneOff, sp.EnvID, id, sp.DeploymentID, sp.Spec, commandOf(sp.Spec), time.Time{}, protocol.RunStatusQueued)
			s.log.Info("one_off service deployed: starting its run", "service", id, "deployment", sp.DeploymentID, "run", rr.ID)
		}
	}
	s.tickCron(ctx, now)
	for _, rr := range s.orderedRuns() {
		if !rr.terminal() {
			s.driveRun(ctx, rr)
		}
	}
}

func (s *Station) driveRun(ctx context.Context, rr *runRecord) {
	if rr.terminal() || rr.SandboxID != "" {
		return
	}
	if _, ok := s.plan.Generation.Services[rr.ServiceID]; !ok {
		s.stopRun(ctx, rr, "the service is no longer in the generation")
		return
	}
	if rr.Attach && s.attached[rr.ID] == nil {
		s.stopRun(ctx, rr, "the attached session is gone")
		return
	}
	if rr.Status == protocol.RunStatusQueued {
		s.startRun(ctx, rr)
		return
	}
	s.pollRun(ctx, rr)
}

func (s *Station) runSpecs(rr *runRecord) (*ServicePlan, docker.ContainerSpec, docker.ContainerSpec) {
	sp := s.plan.Services[rr.ServiceID]
	return sp, s.plan.RunCoupler(sp, rr.DeploymentID, rr.ID), s.plan.RunSpec(sp, rr.DeploymentID, rr.ID, rr.Spec, rr.Command)
}

func (s *Station) startRun(ctx context.Context, rr *runRecord) {
	sp, couplerSpec, runSpec := s.runSpecs(rr)
	env := s.envs[rr.EnvID]
	if env == nil || env.networkID == "" {
		if env != nil && env.failure != nil {
			s.failRun(ctx, rr, protocol.ErrorCode(env.failure.Code), "the environment network is not up: "+env.failure.Explanation)
		}
		return
	}
	if f := s.volumeBlock(rr.Spec); f != nil {
		s.failRun(ctx, rr, protocol.ErrorCode(f.Code), f.Explanation)
		return
	}
	sctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	set, failure := s.prepareSecrets(sctx, rr.DeploymentID, rr.Spec)
	if failure != nil {
		if failure.Code == string(protocol.ErrorCodeSecretsUnavailable) && rr.Kind != protocol.RunKindCron && time.Since(parseStamp(&rr.CreatedAt)) < runSecretsWait {
			return
		}
		s.failRun(ctx, rr, protocol.ErrorCode(failure.Code), failure.Explanation)
		return
	}
	runSpec = runSpec.WithEnv(envOf(set))
	if rr.Attach {
		runSpec = runSpec.Interactive(rr.TTY, rr.Rows, rr.Cols)
	}
	if rr.Phase == phaseStarting {
		if full, err := s.docker.Inspect(sctx, runSpec.Name); err == nil && full.State != nil && parseDocker(full.State.StartedAt).Year() > 2000 {
			rr.Status, rr.Phase = protocol.RunStatusRunning, phaseStarted
			rr.StartedAt = dockerStamp(full.State.StartedAt)
			rr.ContainerID = full.ID
			rr.Detail["adopted_after_restart"] = true
			s.saveRun(rr)
			s.log.Info("run had started before the restart: adopted", "run", rr.ID)
			return
		}
	}
	s.removeNamed(sctx, runSpec.Name)
	s.removeNamed(sctx, couplerSpec.Name)
	if err := s.docker.EnsureImage(sctx, rr.Spec.ImageRef); err != nil {
		s.failRun(ctx, rr, protocol.ErrorCodeSourceUnreachable, "pull "+rr.Spec.ImageRef+": "+err.Error())
		return
	}
	addr, err := s.allocate(sctx, rr.EnvID)
	if err != nil {
		s.failRun(ctx, rr, protocol.ErrorCodeSubnetExhausted, err.Error())
		return
	}
	couplerID, err := s.docker.CreateContainer(sctx, couplerSpec.At(sp.NetworkName, addr))
	if err == nil {
		err = s.docker.Start(sctx, couplerID)
	}
	if err != nil {
		s.failRun(ctx, rr, protocol.ErrorCodeNamespaceSetupFailed, "create "+couplerSpec.Name+": "+err.Error())
		return
	}
	v := s.inspectID(sctx, couplerID, sp.NetworkName)
	if !v.address.IsValid() {
		v.address = addr
	}
	rr.CouplerID, rr.Address = couplerID, v.address.String()
	t := nsTarget{name: couplerSpec.Name, pid: v.pid, inode: v.netns, envID: rr.EnvID, self: v.address, reach: s.plan.Generation.Services[rr.ServiceID].Reach}
	if _, _, err := s.writeNS(t); err != nil {
		s.failRun(ctx, rr, protocol.ErrorCodeNamespaceSetupFailed, "write the baseline into "+couplerSpec.Name+": "+err.Error())
		return
	}
	id, err := s.docker.CreateContainer(sctx, runSpec.JoinedTo(couplerID))
	if err != nil {
		s.failRun(ctx, rr, protocol.ErrorCodeExitNonzero, "create "+runSpec.Name+": "+err.Error())
		return
	}
	rr.ContainerID, rr.Phase = id, phaseStarting
	s.saveRun(rr)
	if rr.Attach {
		if f := s.attachRun(sctx, rr, id); f != nil {
			s.failRun(ctx, rr, protocol.ErrorCode(f.Code), f.Explanation)
			return
		}
	}
	if err := s.docker.Start(sctx, id); err != nil {
		s.failRun(ctx, rr, protocol.ErrorCodeExitNonzero, "start "+runSpec.Name+": "+err.Error())
		return
	}
	rr.Status, rr.Phase = protocol.RunStatusRunning, phaseStarted
	rr.StartedAt = stamp(time.Now())
	if full, err := s.docker.Inspect(sctx, id); err == nil && full.State != nil {
		if at := dockerStamp(full.State.StartedAt); at != nil {
			rr.StartedAt = at
		}
	}
	s.saveRun(rr)
	s.log.Info("run started", "run", rr.ID, "service", rr.ServiceID, "kind", rr.Kind, "container", shortID(id), "address", rr.Address)
}

func (s *Station) pollRun(ctx context.Context, rr *runRecord) {
	name := docker.RunName(rr.ID)
	full, err := s.docker.Inspect(ctx, name)
	if err != nil || full.State == nil {
		s.failRun(ctx, rr, protocol.ErrorCodeExitNonzero, "the run container "+name+" disappeared before stationd saw it exit")
		return
	}
	if full.State.Running {
		coupler, cerr := s.docker.Inspect(ctx, docker.CouplerName(rr.ID))
		if cerr != nil || coupler.State == nil || !coupler.State.Running {
			s.collectLogs(ctx, rr)
			s.failRun(ctx, rr, protocol.ErrorCodeNamespaceSetupFailed, "the run's Coupler exited while the run was running")
			return
		}
		return
	}
	if full.State.Status == container.StateCreated {
		return
	}
	code := full.State.ExitCode
	rr.ExitCode = &code
	rr.OOMKilled = full.State.OOMKilled
	rr.FinishedAt = dockerStamp(full.State.FinishedAt)
	if rr.FinishedAt == nil {
		rr.FinishedAt = stamp(time.Now())
	}
	rr.Detail["duration_ms"] = parseStamp(rr.FinishedAt).Sub(parseStamp(rr.StartedAt)).Milliseconds()
	lines := s.collectLogs(ctx, rr)
	s.removeRunContainers(ctx, rr)
	if code == 0 && !rr.OOMKilled {
		rr.Status = protocol.RunStatusSucceeded
		s.saveRun(rr)
		s.log.Info("run succeeded", "run", rr.ID, "service", rr.ServiceID, "kind", rr.Kind, "duration_ms", rr.Detail["duration_ms"])
		return
	}
	errCode := protocol.ErrorCodeExitNonzero
	if rr.OOMKilled {
		errCode = protocol.ErrorCodeOomKilled
	}
	rr.Status = protocol.RunStatusFailed
	rr.Failure = s.runDiagnosis(rr, errCode, fmt.Sprintf("%s run %s exited with code %d", rr.Kind, commandText(rr.Command), code), lines)
	s.saveRun(rr)
	s.log.Warn("run failed", "run", rr.ID, "service", rr.ServiceID, "kind", rr.Kind, "exit_code", code, "oom_killed", rr.OOMKilled)
}

func commandText(cmd []string) string {
	if len(cmd) == 0 {
		return "(image default command)"
	}
	return strings.Join(cmd, " ")
}

func (s *Station) failRun(ctx context.Context, rr *runRecord, code protocol.ErrorCode, summary string) {
	s.removeRunContainers(ctx, rr)
	rr.Status = protocol.RunStatusFailed
	if rr.StartedAt == nil {
		rr.StartedAt = stamp(time.Now())
	}
	rr.FinishedAt = stamp(time.Now())
	rr.Failure = s.runDiagnosis(rr, code, summary, s.runLogLines(rr))
	s.saveRun(rr)
	s.log.Error("run failed", "run", rr.ID, "service", rr.ServiceID, "kind", rr.Kind, "code", code, "summary", summary)
}

func (s *Station) stopRun(ctx context.Context, rr *runRecord, reason string) {
	if rr.SandboxID != "" {
		s.cancelSandboxRun(rr, reason)
		return
	}
	if rr.Status == protocol.RunStatusRunning {
		_ = s.docker.Signal(ctx, docker.RunName(rr.ID), "SIGKILL")
		for wait := time.Now(); time.Since(wait) < runStopWait; time.Sleep(100 * time.Millisecond) {
			if full, err := s.docker.Inspect(ctx, docker.RunName(rr.ID)); err != nil || full.State == nil || !full.State.Running {
				break
			}
		}
		s.collectLogs(ctx, rr)
	}
	s.removeRunContainers(ctx, rr)
	rr.Status = protocol.RunStatusCancelled
	rr.FinishedAt = stamp(time.Now())
	rr.Detail["cancelled"] = reason
	s.saveRun(rr)
	s.log.Info("run cancelled", "run", rr.ID, "service", rr.ServiceID, "reason", reason)
}

func (s *Station) removeRunContainers(ctx context.Context, rr *runRecord) {
	s.removeNamed(ctx, docker.RunName(rr.ID))
	s.removeNamed(ctx, docker.CouplerName(rr.ID))
}

func (s *Station) collectLogs(ctx context.Context, rr *runRecord) []string {
	if att := s.attached[rr.ID]; att != nil {
		select {
		case <-att.outputDone:
		case <-time.After(captureWait):
		}
	} else if strings.HasSuffix(rr.LogRef, ".jsonl") {
		name := docker.RunName(rr.ID)
		s.captures.wait(name, captureWait)
		w := s.logs.Single(rr.LogRef, runLogCap)
		if err := s.copyDockerLogs(ctx, name, rr.DeploymentID, docker.RoleRun, w, false, nil); err != nil {
			s.log.Warn("copy run log", "run", rr.ID, "error", err)
		}
		if w.Dropped > 0 {
			rr.Detail["log_truncated_bytes"] = w.Dropped
		}
		s.logs.Release(w)
	}
	if st, err := os.Stat(filepath.Join(s.opts.StateDir, rr.LogRef)); err == nil {
		rr.Detail["log_bytes"] = st.Size()
	}
	return s.runLogLines(rr)
}

func (s *Station) runLogLines(rr *runRecord) []string {
	lines := s.runLogText(rr)
	return lines[max(0, len(lines)-logTail):]
}

func (s *Station) runDiagnosis(rr *runRecord, code protocol.ErrorCode, summary string, lines []string) *protocol.Diagnosis {
	d := &protocol.Diagnosis{
		Entity:    &protocol.DiagnosisEntity{Type: protocol.DiagnosisEntityTypeRun, Id: rr.ID},
		Phase:     rr.phase(),
		Code:      string(code),
		Summary:   summary,
		ExitCode:  rr.ExitCode,
		OomKilled: ptr(rr.OOMKilled),
	}
	if len(lines) > 0 {
		text, truncated := excerpt(lines)
		d.Logs = &protocol.DiagnosisLogs{Source: "run", Untrusted: protocol.Untrusted{Source: "run log", Text: text}, Truncated: truncated}
	}
	switch code {
	case protocol.ErrorCodeOomKilled:
		next := rr.Spec.Limits.MemoryBytes * 2
		d.Fixes = []protocol.DiagnosisFixesElem{{Code: "RAISE_MEMORY", Text: fmt.Sprintf("The kernel killed the run at the memory limit. Raise limits.memory_bytes to at least %d.", next)}}
	case protocol.ErrorCodeExitNonzero:
		d.Fixes = []protocol.DiagnosisFixesElem{{Code: "READ_LOGS", Text: fmt.Sprintf("The command %s exited non-zero. Read the log excerpt for the cause.", commandText(rr.Command))}}
	}
	return d
}

func (s *Station) runNamespaces(ctx context.Context, envID string) []nsTarget {
	var out []nsTarget
	for _, rr := range s.orderedRuns() {
		if rr.terminal() || rr.EnvID != envID || rr.CouplerID == "" {
			continue
		}
		svc, ok := s.plan.Generation.Services[rr.ServiceID]
		if !ok {
			continue
		}
		v := s.inspectID(ctx, docker.CouplerName(rr.ID), s.plan.Networks[envID].Name)
		if v.pid <= 0 {
			continue
		}
		out = append(out, nsTarget{name: docker.CouplerName(rr.ID), pid: v.pid, inode: v.netns, envID: envID, self: v.address, reach: svc.Reach})
	}
	return out
}

func (s *Station) syncRunNamespaces(ctx context.Context) {
	for envID := range s.plan.Generation.Environments {
		for _, t := range s.runNamespaces(ctx, envID) {
			if _, _, err := s.writeNS(t); err != nil {
				s.log.Warn("sync run namespace", "coupler", t.name, "error", err)
			}
		}
	}
}

func (s *Station) observedRuns() protocol.ObservedRuns {
	out := protocol.ObservedRuns{}
	shown := map[string]int{}
	runs := s.orderedRuns()
	for i := len(runs) - 1; i >= 0; i-- {
		rr := runs[i]
		if rr.SandboxID != "" {
			continue
		}
		if rr.terminal() {
			if shown[rr.ServiceID] >= runsShown {
				continue
			}
			shown[rr.ServiceID]++
		}
		or := protocol.ObservedRun{
			ServiceId:   rr.ServiceID,
			Kind:        rr.Kind,
			Command:     rr.Command,
			Status:      rr.Status,
			ExitCode:    rr.ExitCode,
			LogRef:      rr.LogRef,
			ScheduledAt: rr.ScheduledAt,
			StartedAt:   rr.StartedAt,
			FinishedAt:  rr.FinishedAt,
		}
		if rr.DeploymentID != "" {
			or.DeploymentId = ptr(rr.DeploymentID)
		}
		if rr.Failure != nil {
			f := protocol.ObservedRunFailure(*rr.Failure)
			or.Failure = &f
		}
		out[rr.ID] = or
	}
	return out
}
