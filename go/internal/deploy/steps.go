//go:build linux

package deploy

import (
	"context"
	"fmt"
	"net/netip"
	"time"

	"github.com/moby/moby/api/types/container"

	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/millis"
	"github.com/harshjv/stationly/go/internal/netns"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/secrets"
)

type progress int

const (
	waiting progress = iota
	advanced
	stopped
)

const (
	drainPoll    = time.Second
	drainSettle  = time.Second
	cutoverTries = 3
	killWait     = 10 * time.Second
)

func (s *Station) advance(ctx context.Context) {
	for _, r := range s.orderedRollouts() {
		if !r.terminal() {
			s.drive(ctx, r)
		}
	}
}

func (s *Station) drive(ctx context.Context, r *rollout) {
	if r.rt.loaded {
		r.rt.loaded = false
		s.recover(ctx, r)
	}
	for range len(r.Steps) + 1 {
		if r.terminal() {
			return
		}
		row := r.current()
		if row == nil {
			return
		}
		if !r.pastCutover(row) {
			if reason := s.cancelReason(r); reason != nil {
				s.cancel(ctx, r, row, *reason)
				return
			}
			if r.started() && r.Budget.TotalS > 0 && time.Since(parseStamp(r.Steps[0].StartedAt)) > time.Duration(r.Budget.TotalS)*time.Second {
				s.fail(ctx, r, row, phaseOf(row.Step), budgetCode(row.Step), fmt.Sprintf("the deployment exceeded its total budget of %ds before cutover, during %s", r.Budget.TotalS, row.Step), nil)
				return
			}
		} else if reason := s.cancelReason(r); reason != nil && !r.rt.cancelLogged {
			r.rt.cancelLogged = true
			row.Detail["cancel_refused"] = string(*reason)
			s.saveRollout(r)
			s.log.Warn("cancel refused: the deployment is at or past cutover and finishes; roll back instead", "deployment", r.ID, "reason", *reason, "step", row.Step)
		}
		if row.Status == statusPending {
			if !s.mayStart(r, row) {
				return
			}
			s.begin(r, row)
		}
		switch s.runStep(ctx, r, row) {
		case waiting, stopped:
			return
		}
	}
}

func (s *Station) mayStart(r *rollout, row *stepRow) bool {
	if !r.started() {
		running := 0
		for _, o := range s.rollouts {
			if o != r && !o.terminal() && o.started() && s.cancelReason(o) == nil {
				running++
			}
		}
		if running >= s.plan.Generation.Station.ConcurrencyCap {
			return false
		}
	}
	if row.Step == stepPull {
		return true
	}
	for _, o := range s.rollouts {
		if o == r || o.ServiceID != r.ServiceID || o.terminal() {
			continue
		}
		if o.started() && (o.Number < r.Number || (r.Supersedes != nil && *r.Supersedes == o.ID)) {
			return false
		}
	}
	return true
}

func (s *Station) runStep(ctx context.Context, r *rollout, row *stepRow) progress {
	switch row.Step {
	case stepPull:
		return s.stepPull(ctx, r, row)
	case stepPreDeploy:
		return s.stepPreDeploy(ctx, r, row)
	}
	if sp := s.plan.Services[r.ServiceID]; sp != nil && runsOnly(sp.Kind) {
		return s.stepRunsOnly(r, row, sp)
	}
	switch row.Step {
	case stepGuard:
		row.Detail["reason"] = "the Guard arrives in phase 1b"
		s.finish(r, row, statusSkipped)
		return advanced
	case stepNamespace:
		return s.stepNamespace(ctx, r, row)
	case stepBaseline:
		return s.stepBaseline(ctx, r, row)
	case stepService:
		return s.stepService(ctx, r, row)
	case stepHealth:
		return s.stepHealth(ctx, r, row)
	case stepCutover:
		return s.stepCutover(ctx, r, row)
	case stepDrain:
		return s.stepDrain(ctx, r, row)
	case stepCleanup:
		return s.stepCleanup(ctx, r, row)
	}
	return stopped
}

func (s *Station) stepRunsOnly(r *rollout, row *stepRow, sp *ServicePlan) progress {
	if row.Step != stepCleanup {
		row.Detail["reason"] = fmt.Sprintf("a %s service starts no long-running container; its runs use this deployment from now on", sp.Kind)
		s.finish(r, row, statusSkipped)
		return advanced
	}
	if r.Blue == nil {
		r.Blue = &sideRef{}
		if sp.DeploymentID != r.ID {
			r.Blue.DeploymentID = sp.DeploymentID
		}
	}
	s.finish(r, row, statusDone)
	s.settle(r, protocol.DeploymentOutcomeActive)
	return stopped
}

func (s *Station) stepPreDeploy(ctx context.Context, r *rollout, row *stepRow) progress {
	if r.Target.PreDeploy == nil || len(*r.Target.PreDeploy) == 0 {
		row.Detail["reason"] = "no pre_deploy command"
		s.finish(r, row, statusSkipped)
		return advanced
	}
	id, _ := row.Detail["run_id"].(string)
	rr := s.runs[id]
	if rr == nil {
		if _, p := s.waitSecrets(ctx, r, row); p != advanced {
			return p
		}
		rr = s.newRun(protocol.RunKindPreDeploy, r.EnvID, r.ServiceID, r.ID, r.Target, *r.Target.PreDeploy, time.Time{}, protocol.RunStatusQueued)
		row.Detail["run_id"] = rr.ID
		row.Detail["command"] = rr.Command
		s.saveRollout(r)
	}
	s.driveRun(ctx, rr)
	if !rr.terminal() {
		if rr.Status == protocol.RunStatusRunning && row.Detail["run_started_at"] == nil {
			row.Detail["run_started_at"] = deref(rr.StartedAt)
			s.saveRollout(r)
		}
		return waiting
	}
	row.Detail["run_status"] = string(rr.Status)
	row.Detail["log_ref"] = rr.LogRef
	if rr.ExitCode != nil {
		row.Detail["exit_code"] = *rr.ExitCode
	}
	if d, ok := rr.Detail["duration_ms"]; ok {
		row.Detail["run_ms"] = d
	}
	if rr.Status == protocol.RunStatusSucceeded {
		s.finish(r, row, statusDone)
		return advanced
	}
	code := protocol.ErrorCodeExitNonzero
	summary := fmt.Sprintf("the pre_deploy command %s did not succeed (run %s %s)", commandText(rr.Command), rr.ID, rr.Status)
	if rr.Failure != nil {
		code = protocol.ErrorCode(rr.Failure.Code)
		summary = "pre_deploy: " + rr.Failure.Summary
	}
	s.fail(ctx, r, row, protocol.DiagnosisPhasePreDeploy, code, summary, &failureFacts{exitCode: rr.ExitCode, oom: rr.OOMKilled, logs: s.runLogLines(rr), noGreen: true})
	return stopped
}

func (s *Station) stopPreDeployRun(ctx context.Context, r *rollout, reason string) {
	if row := r.row(stepPreDeploy); row != nil {
		id, _ := row.Detail["run_id"].(string)
		if rr := s.runs[id]; rr != nil && !rr.terminal() {
			s.stopRun(ctx, rr, reason)
		}
	}
}

func budgetCode(step protocol.DeploymentStepName) protocol.ErrorCode {
	switch step {
	case stepPull:
		return protocol.ErrorCodeSourceUnreachable
	case stepHealth:
		return protocol.ErrorCodeHealthTimeout
	}
	return protocol.ErrorCodeNamespaceSetupFailed
}

func phaseOf(step protocol.DeploymentStepName) protocol.DiagnosisPhase {
	switch step {
	case stepPreDeploy:
		return protocol.DiagnosisPhasePreDeploy
	case stepHealth:
		return protocol.DiagnosisPhaseHealth
	case stepCutover, stepDrain, stepCleanup:
		return protocol.DiagnosisPhaseCutover
	}
	return protocol.DiagnosisPhaseStart
}

func (s *Station) recover(ctx context.Context, r *rollout) {
	if r.terminal() {
		return
	}
	r.rt.restarted = true
	svc := r.row(stepService)
	if svc.Status != statusPending {
		for i := range r.Steps {
			if r.Steps[i].Status == statusRunning {
				r.Steps[i].Attempt++
				r.Steps[i].Detail["resumed_after_restart"] = true
			}
		}
		s.saveRollout(r)
		s.log.Info("deployment resumes after restart", "deployment", r.ID, "step", r.current().Step)
		return
	}
	partial := false
	for _, step := range []protocol.DeploymentStepName{stepNamespace, stepBaseline, stepGuard} {
		row := r.row(step)
		if row.Status != statusPending {
			partial = true
			row.Status = statusPending
			row.Detail = map[string]any{"reset_after_restart": true}
			row.FinishedAt = nil
		}
	}
	if !partial {
		return
	}
	s.removeGreen(ctx, r)
	r.Green = sideRef{DeploymentID: r.ID}
	r.Recoveries++
	s.saveRollout(r)
	s.log.Warn("deployment was before its service step at restart: removed the partial green and re-running from namespace", "deployment", r.ID)
}

func (s *Station) removeNamed(ctx context.Context, name string) {
	if name == "" {
		return
	}
	if err := s.docker.Remove(ctx, name); err != nil {
		s.log.Warn("remove container", "name", name, "error", err)
	}
}

func (s *Station) removeGreen(ctx context.Context, r *rollout) {
	s.removeNamed(ctx, docker.ServiceName(r.ID))
	s.removeNamed(ctx, docker.CouplerName(r.ID))
}

func (s *Station) settle(r *rollout, outcome protocol.DeploymentOutcome) {
	now := time.Now()
	r.Outcome = &outcome
	r.FinishedAt = stamp(now)
	s.saveRollout(r)
	s.emit(protocol.MessageDeploymentFinished, map[string]any{
		"deployment_id": r.ID, "status": outcome, "failure": r.Failure, "cancel_reason": r.CancelReason,
	})
	s.log.Info("deployment finished", "deployment", r.ID, "service", r.ServiceID, "outcome", outcome)
	s.applyOverrides()
	s.resync = true
}

func (s *Station) cancel(ctx context.Context, r *rollout, row *stepRow, reason protocol.CancelReason) {
	s.stopPreDeployRun(ctx, r, "deployment cancelled: "+string(reason))
	s.removeGreen(ctx, r)
	s.releaseSecrets(r.ID)
	if row.Status == statusRunning {
		row.Detail["cancelled"] = string(reason)
		s.finish(r, row, statusSkipped)
	}
	r.CancelReason = &reason
	s.log.Info("deployment cancelled before cutover; blue keeps serving", "deployment", r.ID, "reason", reason, "step", row.Step)
	s.settle(r, protocol.DeploymentOutcomeCancelled)
}

func (s *Station) fail(ctx context.Context, r *rollout, row *stepRow, phase protocol.DiagnosisPhase, code protocol.ErrorCode, summary string, facts *failureFacts) {
	r.Failure = s.diagnose(ctx, r, row, phase, code, summary, facts)
	s.stopPreDeployRun(ctx, r, "deployment failed")
	s.removeGreen(ctx, r)
	s.releaseSecrets(r.ID)
	row.Detail["code"] = string(code)
	s.finish(r, row, statusFailed)
	s.log.Error("deployment failed", "deployment", r.ID, "service", r.ServiceID, "phase", phase, "code", code, "summary", summary)
	s.settle(r, protocol.DeploymentOutcomeFailed)
}

func (s *Station) stepPull(ctx context.Context, r *rollout, row *stepRow) progress {
	if res := r.rt.pullResult; res != nil {
		r.rt.pullResult, r.rt.pulling = nil, false
		if *res != nil {
			s.fail(ctx, r, row, protocol.DiagnosisPhaseStart, protocol.ErrorCodeSourceUnreachable, "pull "+r.Target.ImageRef+": "+(*res).Error(), nil)
			return stopped
		}
		row.Detail["image_ref"] = r.Target.ImageRef
		s.finish(r, row, statusDone)
		return advanced
	}
	if r.rt.pulling {
		return waiting
	}
	r.rt.pulling = true
	timeout := time.Duration(max(r.Budget.PullS, 1)) * time.Second
	id, ref := r.ID, r.Target.ImageRef
	go func() {
		pctx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		err := s.docker.EnsureImage(pctx, ref)
		select {
		case s.rolloutEvents <- rolloutEvent{id: id, pull: &err}:
		case <-ctx.Done():
		}
	}()
	return waiting
}

func (s *Station) startContext(ctx context.Context, r *rollout) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, time.Duration(max(r.Budget.StartS, 1))*time.Second)
}

func (s *Station) stepNamespace(ctx context.Context, r *rollout, row *stepRow) progress {
	sp := s.plan.ServicePlanFor(r.ServiceID, r.ID, r.Number, r.Target)
	if sp.Unsupported != nil {
		s.fail(ctx, r, row, protocol.DiagnosisPhaseStart, protocol.ErrorCode(sp.Unsupported.Code), sp.Unsupported.Explanation, nil)
		return stopped
	}
	if f := s.volumeBlock(r.Target); f != nil {
		s.fail(ctx, r, row, protocol.DiagnosisPhaseStart, protocol.ErrorCode(f.Code), f.Explanation, nil)
		return stopped
	}
	env := s.envs[r.EnvID]
	if env == nil || env.networkID == "" {
		s.fail(ctx, r, row, protocol.DiagnosisPhaseStart, protocol.ErrorCodeNamespaceSetupFailed, "the environment network "+sp.NetworkName+" is not up", nil)
		return stopped
	}
	sctx, cancel := s.startContext(ctx, r)
	defer cancel()
	s.removeGreen(sctx, r)
	addr, err := s.allocate(sctx, r.EnvID)
	if err != nil {
		s.fail(ctx, r, row, protocol.DiagnosisPhaseStart, protocol.ErrorCodeSubnetExhausted, err.Error(), nil)
		return stopped
	}
	id, err := s.docker.CreateContainer(sctx, sp.Coupler.At(sp.NetworkName, addr))
	if err == nil {
		err = s.docker.Start(sctx, id)
	}
	if err != nil {
		s.fail(ctx, r, row, protocol.DiagnosisPhaseStart, protocol.ErrorCodeNamespaceSetupFailed, "create "+sp.Coupler.Name+": "+err.Error(), nil)
		return stopped
	}
	v := s.inspectID(sctx, id, sp.NetworkName)
	if !v.address.IsValid() {
		v.address = addr
	}
	r.Green.Coupler = sp.Coupler.Name
	r.Green.Service = sp.Service.Name
	r.Green.Address = v.address.String()
	row.Detail["coupler_id"] = shortID(id)
	row.Detail["address"] = v.address.String()
	row.Detail["gw_priority"] = docker.CouplerGwPriority
	s.finish(r, row, statusDone)
	return advanced
}

func (s *Station) rolloutNamespace(ctx context.Context, r *rollout, name string) (nsTarget, bool) {
	svc, listed := s.plan.Generation.Services[r.ServiceID]
	if !listed {
		return nsTarget{}, false
	}
	v := s.inspectID(ctx, name, r.Network)
	if v.pid <= 0 {
		return nsTarget{}, false
	}
	return nsTarget{name: name, pid: v.pid, inode: v.netns, envID: r.EnvID, self: v.address, reach: svc.Reach}, true
}

func (s *Station) stepBaseline(ctx context.Context, r *rollout, row *stepRow) progress {
	t, ok := s.rolloutNamespace(ctx, r, r.Green.Coupler)
	if !ok {
		s.fail(ctx, r, row, protocol.DiagnosisPhaseStart, protocol.ErrorCodeNamespaceSetupFailed, "green Coupler "+r.Green.Coupler+" has no running process", nil)
		return stopped
	}
	result, c, err := s.writeNS(t)
	if err != nil {
		s.fail(ctx, r, row, protocol.DiagnosisPhaseStart, protocol.ErrorCodeNamespaceSetupFailed, "write the baseline into "+t.name+": "+err.Error(), nil)
		return stopped
	}
	row.Detail["result"] = string(result)
	row.Detail["switch"] = switchText(c.Switch)
	row.Detail["netns"] = t.inode
	s.finish(r, row, statusDone)
	return advanced
}

func (s *Station) stepService(ctx context.Context, r *rollout, row *stepRow) progress {
	sp := s.plan.ServicePlanFor(r.ServiceID, r.ID, r.Number, r.Target)
	sctx, cancel := s.startContext(ctx, r)
	defer cancel()
	coupler := s.inspectID(sctx, sp.Coupler.Name, sp.NetworkName)
	if coupler.pid <= 0 {
		s.fail(ctx, r, row, protocol.DiagnosisPhaseStart, protocol.ErrorCodeNamespaceSetupFailed, "green Coupler "+sp.Coupler.Name+" is not running", nil)
		return stopped
	}
	existing, err := s.docker.Inspect(sctx, sp.Service.Name)
	if err == nil {
		if existing.State != nil && existing.State.Running && existing.Config != nil && existing.Config.Labels[docker.LabelHash] == sp.Service.Hash {
			row.Detail["container_id"] = shortID(existing.ID)
			row.Detail["adopted"] = true
			s.finish(r, row, statusDone)
			return advanced
		}
		s.removeNamed(sctx, sp.Service.Name)
	}
	set, p := s.waitSecrets(ctx, r, row)
	if p != advanced {
		return p
	}
	id, failure := s.createAndStart(sctx, sp.Service.WithEnv(envOf(set)), coupler.id)
	if failure != nil {
		s.fail(ctx, r, row, protocol.DiagnosisPhaseStart, protocol.ErrorCode(failure.Code), failure.Explanation, nil)
		return stopped
	}
	row.Detail["container_id"] = shortID(id)
	row.Detail["image_ref"] = r.Target.ImageRef
	s.finish(r, row, statusDone)
	return advanced
}

func (s *Station) stepHealth(ctx context.Context, r *rollout, row *stepRow) progress {
	rule := ruleFor(r.Target.Health, r.Target.Ports)
	if rule == nil {
		row.Detail["reason"] = "no health check"
		s.finish(r, row, statusSkipped)
		return advanced
	}
	sp := s.plan.ServicePlanFor(r.ServiceID, r.ID, r.Number, r.Target)
	v := s.inspectID(ctx, sp.Service.Name, sp.NetworkName)
	if v.state != string(container.StateRunning) {
		code := protocol.ErrorCodeExitNonzero
		if v.oom {
			code = protocol.ErrorCodeOomKilled
		}
		summary := fmt.Sprintf("the green container exited before %s passed", rule.describe())
		if v.exitCode != nil {
			summary = fmt.Sprintf("the green container exited with code %d before %s passed", *v.exitCode, rule.describe())
		}
		s.fail(ctx, r, row, protocol.DiagnosisPhaseHealth, code, summary, &failureFacts{exitCode: v.exitCode, oom: v.oom, health: &r.rt.health, view: v})
		return stopped
	}
	h := &r.rt.health
	now := time.Now()
	if h.rule == nil {
		if r.Budget.HealthS > 0 {
			rule.startup = time.Duration(r.Budget.HealthS) * time.Second
		}
		*h = newHealth(rule, now)
		r.rt.healthSeq++
		row.Detail["check"] = rule.describe()
		row.Detail["passes_required"] = rule.passes
		row.Detail["startup_timeout_s"] = int(rule.startup.Seconds())
	}
	if rule.kind == "alive" {
		started := parseDocker(v.startedAt)
		if now.Sub(started) >= rule.alive {
			h.record(true, "alive", now)
		}
	} else {
		h.evaluate(now)
	}
	row.Detail["attempts"] = h.attempts
	row.Detail["consecutive_passes"] = h.passStreak
	row.Detail["last_result"] = h.lastResult
	switch h.state {
	case protocol.HealthStatePassing:
		r.HealthyAt = stamp(h.lastCheck)
		s.finish(r, row, statusDone)
		return advanced
	case protocol.HealthStateFailed:
		summary := rule.describe() + " did not pass within " + rule.startup.String()
		if h.failure != nil {
			summary = h.failure.Explanation
		}
		s.fail(ctx, r, row, protocol.DiagnosisPhaseHealth, protocol.ErrorCodeHealthTimeout, summary, &failureFacts{health: h, view: v})
		return stopped
	}
	if addr := parseAddr(r.Green.Address); h.due(now) && addr.IsValid() {
		h.inflight = true
		h.nextCheck = now.Add(rule.interval)
		id, seq := r.ID, r.rt.healthSeq
		go func() {
			pass, result := probe(ctx, rule, addr)
			select {
			case s.rolloutEvents <- rolloutEvent{id: id, seq: seq, pass: pass, result: result, at: time.Now()}:
			case <-ctx.Done():
			}
		}()
	}
	return waiting
}

func (s *Station) rolloutEvent(ctx context.Context, ev rolloutEvent) {
	r := s.rollouts[ev.id]
	if r == nil || r.terminal() {
		return
	}
	if ev.pull != nil {
		r.rt.pullResult = ev.pull
	} else {
		if ev.seq != r.rt.healthSeq {
			return
		}
		r.rt.health.inflight = false
		r.rt.health.record(ev.pass, ev.result, ev.at)
	}
	s.drive(ctx, r)
}

func (s *Station) determineBlue(ctx context.Context, r *rollout) {
	if r.Blue != nil {
		return
	}
	r.Blue = &sideRef{}
	sp := s.plan.Services[r.ServiceID]
	if sp == nil || sp.DeploymentID == "" || sp.DeploymentID == r.ID || sp.Unsupported != nil {
		return
	}
	v := s.inspectID(ctx, sp.Coupler.Name, sp.NetworkName)
	if v.id == "" || v.state == "" {
		return
	}
	r.Blue = &sideRef{DeploymentID: sp.DeploymentID, Coupler: sp.Coupler.Name, Service: sp.Service.Name}
	if v.address.IsValid() {
		r.Blue.Address = v.address.String()
	}
}

func (s *Station) envNamespaces(ctx context.Context, envID string) []nsTarget {
	g := s.plan.Generation
	seen := map[string]bool{}
	var out []nsTarget
	add := func(t nsTarget) {
		if t.pid > 0 && !seen[t.name] {
			seen[t.name] = true
			out = append(out, t)
		}
	}
	for _, id := range s.plan.ServiceIDs() {
		sp := s.plan.Services[id]
		if sp.EnvID != envID || !sp.Run || sp.Coupler.Name == "" {
			continue
		}
		v := s.inspectID(ctx, sp.Coupler.Name, sp.NetworkName)
		add(nsTarget{name: sp.Coupler.Name, pid: v.pid, inode: v.netns, envID: envID, self: v.address, reach: g.Services[id].Reach})
	}
	for _, r := range s.orderedRollouts() {
		if r.terminal() || r.EnvID != envID {
			continue
		}
		for _, name := range []string{r.Green.Coupler, blueCoupler(r)} {
			if name == "" || seen[name] {
				continue
			}
			if t, ok := s.rolloutNamespace(ctx, r, name); ok {
				add(t)
			}
		}
	}
	for _, t := range s.runNamespaces(ctx, envID) {
		add(t)
	}
	for _, t := range s.sandboxNamespaces(envID) {
		add(t)
	}
	return out
}

func blueCoupler(r *rollout) string {
	if r.Blue == nil {
		return ""
	}
	return r.Blue.Coupler
}

func (s *Station) switchNamespaces(ctx context.Context, r *rollout, row *stepRow) bool {
	start := time.Now()
	var written []nsTarget
	var report []map[string]any
	rollback := func(failed string, err error) bool {
		row.Detail["failed_namespace"] = failed
		row.Detail["error"] = err.Error()
		row.Status = statusFailed
		for _, w := range written {
			if _, _, rerr := s.writeNS(w); rerr != nil {
				s.log.Error("roll back switch write", "deployment", r.ID, "namespace", w.name, "error", rerr)
			}
		}
		row.Detail["rolled_back"] = len(written)
		return false
	}
	for _, t := range s.envNamespaces(ctx, r.EnvID) {
		var err error
		var result netns.Result
		for try := 1; try <= cutoverTries; try++ {
			t0 := time.Now()
			result, _, err = s.writeNS(t)
			if err == nil {
				report = append(report, map[string]any{"namespace": t.name, "result": string(result), "ms": millis.Of(time.Since(t0)), "tries": try})
				break
			}
			s.log.Warn("switch write failed, retrying", "deployment", r.ID, "namespace", t.name, "try", try, "error", err)
		}
		if err != nil {
			return rollback(t.name, err)
		}
		written = append(written, t)
	}
	t0 := time.Now()
	result, err := s.syncHost("cutover " + r.ID)
	if err != nil {
		return rollback("host", err)
	}
	row.Detail["namespaces"] = report
	row.Detail["switch_ms"] = millis.Of(time.Since(start))
	row.Detail["host_namespace"] = s.hostDetail(r.ServiceID, result, time.Since(t0))
	return true
}

func (s *Station) hostDetail(svcID string, result netns.Result, took time.Duration) map[string]any {
	_, el, _ := s.hostState()
	gp := s.plan.Gateway
	d := map[string]any{"table": "inet " + netns.HostTableName, "result": string(result), "ms": millis.Of(took)}
	var ports []string
	for _, pp := range gp.Ports {
		if pp.ServiceID == svcID {
			if a, ok := el.Ports[pp.HostPort]; ok {
				ports = append(ports, fmt.Sprintf("%d->%s", pp.HostPort, a))
			} else {
				ports = append(ports, fmt.Sprintf("%d->absent", pp.HostPort))
			}
		}
	}
	if ports != nil {
		d["port_switch"] = ports
	}
	for _, rp := range gp.Routes {
		if rp.ServiceID == svcID {
			if a, ok := el.Switch[rp.Upstream.Addr()]; ok {
				d["switch"] = rp.Upstream.Addr().String() + "->" + a.String()
			} else {
				d["switch"] = rp.Upstream.Addr().String() + "->absent"
			}
		}
	}
	return d
}

func (s *Station) stepCutover(ctx context.Context, r *rollout, row *stepRow) progress {
	s.determineBlue(ctx, r)
	if r.Blue.DeploymentID != "" {
		row.Detail["from"] = r.Blue.Address
	}
	row.Detail["to"] = r.Green.Address
	s.saveRollout(r)
	if !s.switchNamespaces(ctx, r, row) {
		s.fail(ctx, r, row, protocol.DiagnosisPhaseCutover, protocol.ErrorCodeNamespaceSetupFailed, fmt.Sprintf("cutover could not write namespace %v; written namespaces were rolled back to blue", row.Detail["failed_namespace"]), nil)
		return stopped
	}
	now := time.Now()
	r.CutoverAt = stamp(now)
	if r.HealthyAt != nil {
		row.Detail["healthy_to_cutover_ms"] = millis.Of(now.Sub(parseStamp(r.HealthyAt)))
	}
	if r.Strategy == protocol.StrategyReplace {
		if d := r.row(stepDrain); d.StartedAt != nil {
			row.Detail["downtime_ms"] = millis.Of(now.Sub(parseStamp(d.StartedAt)))
		}
	}
	s.finish(r, row, statusDone)
	s.applyOverrides()
	s.seedServiceState(ctx, r)
	s.resync = true
	return advanced
}

func (s *Station) seedServiceState(ctx context.Context, r *rollout) {
	sp := s.plan.Services[r.ServiceID]
	if sp == nil || sp.DeploymentID != r.ID {
		return
	}
	st := &serviceState{hash: sp.Hash, health: r.rt.health}
	st.health.inflight = false
	if st.health.rule == nil {
		st.health = newHealth(ruleFor(sp.Health, sp.Ports), time.Now())
	}
	st.coupler = s.inspectID(ctx, sp.Coupler.Name, sp.NetworkName)
	st.service = s.inspectID(ctx, sp.Service.Name, sp.NetworkName)
	st.service.address = st.coupler.address
	st.ownAddr = st.coupler.address
	st.healthFor = st.service.id + st.service.startedAt
	st.switchAddr = st.coupler.address
	s.services[r.ServiceID] = st
}

func (s *Station) blueFlows(ctx context.Context, r *rollout, evict bool) (netns.FlowReport, error) {
	var total netns.FlowReport
	blue := parseAddr(r.Blue.Address)
	vip := parseAddr(s.plan.Generation.Services[r.ServiceID].VirtualIp)
	if !blue.IsValid() || !vip.IsValid() {
		return total, nil
	}
	var firstErr error
	for _, t := range s.envNamespaces(ctx, r.EnvID) {
		ns, err := netns.Open(t.pid)
		if err != nil {
			firstErr = err
			continue
		}
		rep, err := ns.Flows(netns.FlowMatch{Destination: vip, ReplySource: blue}, evict)
		ns.Close()
		if err != nil {
			firstErr = err
			continue
		}
		total.Add(rep)
	}
	var host []netns.FlowMatch
	gp := s.plan.Gateway
	for _, rp := range gp.Routes {
		if rp.ServiceID == r.ServiceID {
			host = append(host, netns.FlowMatch{Destination: vip, ReplySource: blue})
			break
		}
	}
	for _, pp := range gp.Ports {
		if pp.ServiceID == r.ServiceID && gp.Public.IsValid() {
			host = append(host, netns.FlowMatch{Destination: gp.Public, Port: pp.HostPort, ReplySource: blue})
		}
	}
	if len(host) > 0 {
		rep, err := netns.HostFlows(host, evict)
		if err != nil && firstErr == nil {
			firstErr = err
		}
		total.Add(rep)
	}
	return total, firstErr
}

func (s *Station) stepDrain(ctx context.Context, r *rollout, row *stepRow) progress {
	s.determineBlue(ctx, r)
	if r.Blue.DeploymentID == "" {
		row.Detail["reason"] = "no blue deployment"
		s.finish(r, row, statusSkipped)
		return advanced
	}
	now := time.Now()
	if _, ok := row.Detail["sigterm_at"]; !ok {
		if r.Strategy != protocol.StrategyReplace && r.CutoverAt != nil && now.Sub(parseStamp(r.CutoverAt)) < drainSettle {
			row.Detail["settle_ms"] = drainSettle.Milliseconds()
			return waiting
		}
		if r.Strategy == protocol.StrategyReplace {
			if !s.switchNamespaces(ctx, r, row) {
				s.fail(ctx, r, row, protocol.DiagnosisPhaseStart, protocol.ErrorCodeNamespaceSetupFailed, fmt.Sprintf("could not install the reject entry in namespace %v", row.Detail["failed_namespace"]), nil)
				return stopped
			}
			row.Detail["reject_installed_at"] = *stamp(time.Now())
		}
		if err := s.docker.Signal(ctx, r.Blue.Service, "SIGTERM"); err != nil {
			row.Detail["sigterm_error"] = err.Error()
		}
		row.Detail["sigterm_at"] = *stamp(time.Now())
		row.Detail["drain_timeout_s"] = r.drainTimeout()
		s.saveRollout(r)
		s.log.Info("drain: SIGTERM sent to blue", "deployment", r.ID, "blue", r.Blue.Service, "address", r.Blue.Address)
	}
	if !r.rt.lastPoll.IsZero() && now.Sub(r.rt.lastPoll) < drainPoll {
		return waiting
	}
	r.rt.lastPoll = now
	v := s.inspectID(ctx, r.Blue.Service, r.Network)
	exited := v.state != string(container.StateRunning)
	count, err := s.blueFlows(ctx, r, false)
	if err != nil {
		row.Detail["conntrack_error"] = err.Error()
	}
	row.Detail["conntrack"] = count.Matched
	row.Detail["established"] = count.Established
	series, _ := row.Detail["established_series"].([]any)
	row.Detail["established_series"] = append(series, count.Established)
	deadline := parseStamp(row.StartedAt).Add(time.Duration(r.drainTimeout()) * time.Second)
	if !exited && now.Before(deadline) {
		s.saveRollout(r)
		return waiting
	}
	ev, err := s.blueFlows(ctx, r, true)
	if err != nil {
		row.Detail["evict_error"] = err.Error()
	}
	row.Detail["evicted"] = ev.Deleted
	row.Detail["evict_gone"] = ev.Gone
	row.Detail["evict_failed"] = ev.Failed
	row.Detail["evict_ms"] = ev.DumpMS + ev.DeleteMS
	if !exited {
		row.Detail["forced_kill"] = true
		if err := s.docker.Signal(ctx, r.Blue.Service, "SIGKILL"); err != nil {
			row.Detail["sigkill_error"] = err.Error()
		}
		for wait := time.Now(); time.Since(wait) < killWait; time.Sleep(100 * time.Millisecond) {
			if v = s.inspectID(ctx, r.Blue.Service, r.Network); v.state != string(container.StateRunning) {
				break
			}
		}
		s.log.Warn("drain timeout: evicted conntrack entries bound to blue, then SIGKILL", "deployment", r.ID, "evicted", ev.Deleted, "blue", r.Blue.Service)
	} else {
		row.Detail["forced_kill"] = false
	}
	if v.exitCode != nil {
		row.Detail["exit_code"] = *v.exitCode
	}
	row.Detail["drain_ms"] = millis.Of(time.Since(parseStamp(row.StartedAt)))
	s.finish(r, row, statusDone)
	return advanced
}

func (r *rollout) drainTimeout() int {
	if r.Budget.DrainS > 0 {
		return r.Budget.DrainS
	}
	if r.Target.DrainTimeoutS > 0 {
		return r.Target.DrainTimeoutS
	}
	return 30
}

func (s *Station) stepCleanup(ctx context.Context, r *rollout, row *stepRow) progress {
	s.determineBlue(ctx, r)
	if r.Blue.DeploymentID != "" {
		s.removeNamed(ctx, r.Blue.Service)
		s.retireCoupler(ctx, r.Blue.Coupler)
		row.Detail["removed"] = []string{r.Blue.Service, r.Blue.Coupler}
		row.Detail["secrets_tmpfs_was_mounted"] = secrets.Mounted(r.Blue.DeploymentID)
		s.releaseSecrets(r.Blue.DeploymentID)
	}
	s.finish(r, row, statusDone)
	s.settle(r, protocol.DeploymentOutcomeActive)
	return stopped
}

func parseAddr(s string) netip.Addr {
	a, _ := netip.ParseAddr(s)
	return a
}

func parseStamp(p *string) time.Time {
	if p == nil {
		return time.Time{}
	}
	t, _ := time.Parse(timestampLayout, *p)
	return t
}

func parseDocker(s string) time.Time {
	t, _ := time.Parse(time.RFC3339Nano, s)
	return t
}
