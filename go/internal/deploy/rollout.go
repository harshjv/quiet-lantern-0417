//go:build linux

package deploy

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"time"

	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/protocol"
	vipswitch "github.com/harshjv/stationly/go/internal/switch"
)

const rolloutDir = "deployments"

const (
	stepPull      = protocol.DeploymentStepNamePull
	stepPreDeploy = protocol.DeploymentStepNamePreDeploy
	stepNamespace = protocol.DeploymentStepNameNamespace
	stepBaseline  = protocol.DeploymentStepNameBaseline
	stepGuard     = protocol.DeploymentStepNameGuard
	stepService   = protocol.DeploymentStepNameService
	stepHealth    = protocol.DeploymentStepNameHealth
	stepCutover   = protocol.DeploymentStepNameCutover
	stepDrain     = protocol.DeploymentStepNameDrain
	stepCleanup   = protocol.DeploymentStepNameCleanup

	statusPending = protocol.DeploymentStepStatusPending
	statusRunning = protocol.DeploymentStepStatusRunning
	statusDone    = protocol.DeploymentStepStatusDone
	statusFailed  = protocol.DeploymentStepStatusFailed
	statusSkipped = protocol.DeploymentStepStatusSkipped
)

var (
	overlapOrder = []protocol.DeploymentStepName{stepPull, stepPreDeploy, stepNamespace, stepBaseline, stepGuard, stepService, stepHealth, stepCutover, stepDrain, stepCleanup}
	replaceOrder = []protocol.DeploymentStepName{stepPull, stepPreDeploy, stepDrain, stepNamespace, stepBaseline, stepGuard, stepService, stepHealth, stepCutover, stepCleanup}
)

type stepRow struct {
	Step       protocol.DeploymentStepName   `json:"step"`
	Status     protocol.DeploymentStepStatus `json:"status"`
	Attempt    int                           `json:"attempt"`
	Detail     map[string]any                `json:"detail"`
	StartedAt  *string                       `json:"started_at"`
	FinishedAt *string                       `json:"finished_at"`
}

type sideRef struct {
	DeploymentID string `json:"deployment_id"`
	Coupler      string `json:"coupler,omitempty"`
	Service      string `json:"service,omitempty"`
	Address      string `json:"address,omitempty"`
}

type rollout struct {
	ID           string                         `json:"deployment_id"`
	ServiceID    string                         `json:"service_id"`
	EnvID        string                         `json:"environment_id"`
	Network      string                         `json:"network"`
	Number       int                            `json:"number"`
	Hash         string                         `json:"hash"`
	Strategy     protocol.Strategy              `json:"strategy"`
	Target       protocol.ContainerSpec         `json:"target"`
	Budget       protocol.DeploymentBudget      `json:"budget"`
	From         *string                        `json:"from_deployment_id"`
	Supersedes   *string                        `json:"supersedes"`
	Steps        []stepRow                      `json:"steps"`
	Blue         *sideRef                       `json:"blue"`
	Green        sideRef                        `json:"green"`
	Outcome      *protocol.DeploymentOutcome    `json:"outcome"`
	CancelReason *protocol.CancelReason         `json:"cancel_reason"`
	Failure      *protocol.Diagnosis            `json:"failure"`
	Events       []protocol.DiagnosisEventsElem `json:"events"`
	ReceivedAt   string                         `json:"received_at"`
	HealthyAt    *string                        `json:"healthy_at"`
	CutoverAt    *string                        `json:"cutover_at"`
	FinishedAt   *string                        `json:"finished_at"`
	Recoveries   int                            `json:"recoveries"`

	rt rolloutRuntime
}

type rolloutRuntime struct {
	loaded       bool
	restarted    bool
	pulling      bool
	pullResult   *error
	health       health
	healthSeq    int
	lastPoll     time.Time
	cancelLogged bool
}

type rolloutEvent struct {
	id     string
	seq    int
	pull   *error
	pass   bool
	result string
	at     time.Time
}

func newRollout(id string, d protocol.DesiredDeployment, envID, network string, now time.Time) *rollout {
	order := overlapOrder
	if d.Strategy == protocol.StrategyReplace {
		order = replaceOrder
	}
	r := &rollout{
		ID:         id,
		ServiceID:  d.ServiceId,
		EnvID:      envID,
		Network:    network,
		Number:     d.Number,
		Hash:       d.Hash,
		Strategy:   d.Strategy,
		Target:     d.Target,
		Budget:     d.Budget,
		From:       d.FromDeploymentId,
		Supersedes: d.Supersedes,
		ReceivedAt: now.UTC().Format(timestampLayout),
		Green:      sideRef{DeploymentID: id},
		Events:     []protocol.DiagnosisEventsElem{},
	}
	for _, step := range order {
		r.Steps = append(r.Steps, stepRow{Step: step, Status: statusPending, Detail: map[string]any{}})
	}
	return r
}

func rolloutPath(stateDir, id string) string {
	return filepath.Join(stateDir, rolloutDir, id+".json")
}

func loadRollouts(stateDir string) (map[string]*rollout, error) {
	loaded, err := readJSONDir[rollout](filepath.Join(stateDir, rolloutDir))
	if err != nil {
		return nil, err
	}
	out := map[string]*rollout{}
	for _, r := range loaded {
		r.rt.loaded = true
		out[r.ID] = r
	}
	return out, nil
}

func (s *Station) saveRollout(r *rollout) {
	if err := writeJSON(rolloutPath(s.opts.StateDir, r.ID), r); err != nil {
		s.log.Error("persist deployment state", "deployment", r.ID, "error", err)
	}
}

func (s *Station) dropRollout(r *rollout) {
	delete(s.rollouts, r.ID)
	if err := os.Remove(rolloutPath(s.opts.StateDir, r.ID)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		s.log.Warn("remove deployment state", "deployment", r.ID, "error", err)
	}
	s.log.Info("deployment record pruned", "deployment", r.ID)
}

func (r *rollout) terminal() bool {
	return r.Outcome != nil
}

func (r *rollout) row(step protocol.DeploymentStepName) *stepRow {
	for i := range r.Steps {
		if r.Steps[i].Step == step {
			return &r.Steps[i]
		}
	}
	return nil
}

func (r *rollout) index(step protocol.DeploymentStepName) int {
	for i := range r.Steps {
		if r.Steps[i].Step == step {
			return i
		}
	}
	return -1
}

func (r *rollout) current() *stepRow {
	for i := range r.Steps {
		if st := r.Steps[i].Status; st == statusPending || st == statusRunning || st == statusFailed {
			return &r.Steps[i]
		}
	}
	return nil
}

func (r *rollout) reached(step protocol.DeploymentStepName) bool {
	row := r.row(step)
	return row != nil && (row.Status == statusRunning || row.Status == statusDone)
}

func (r *rollout) started() bool {
	for _, row := range r.Steps {
		if row.Status != statusPending {
			return true
		}
	}
	return false
}

func (r *rollout) switched() bool {
	return !r.terminal() && r.reached(stepCutover)
}

func (r *rollout) rejecting() bool {
	return !r.terminal() && r.Strategy == protocol.StrategyReplace && r.reached(stepDrain) && !r.reached(stepCutover)
}

func (r *rollout) ownsBlue() bool {
	return !r.terminal() && r.Blue != nil && r.Blue.DeploymentID != "" && (r.reached(stepCutover) || (r.Strategy == protocol.StrategyReplace && r.reached(stepDrain)))
}

func (r *rollout) pastCutover(row *stepRow) bool {
	cut := r.index(stepCutover)
	return r.index(row.Step) >= cut || r.reached(stepCutover)
}

func (r *rollout) blueID() string {
	if r.Blue == nil {
		return ""
	}
	return r.Blue.DeploymentID
}

func (r *rollout) event(row *stepRow, at time.Time) {
	r.Events = append(r.Events, protocol.DiagnosisEventsElem{At: at.UTC().Format(timestampLayout), Step: row.Step, Status: row.Status})
}

func (s *Station) begin(r *rollout, row *stepRow) {
	now := time.Now()
	row.Status = statusRunning
	row.Attempt++
	row.StartedAt = stamp(now)
	row.FinishedAt = nil
	r.event(row, now)
	s.saveRollout(r)
	s.reportStep(r, row)
	s.log.Info("deployment step", "deployment", r.ID, "service", r.ServiceID, "step", row.Step, "status", row.Status, "attempt", row.Attempt)
}

func (s *Station) reportStep(r *rollout, row *stepRow) {
	detail := row.Detail
	if detail == nil {
		detail = map[string]any{}
	}
	s.emit(protocol.MessageDeploymentStep, protocol.DeploymentStepBody{
		DeploymentId: r.ID, Step: row.Step, Status: row.Status, Attempt: max(row.Attempt, 1),
		Detail: detail, StartedAt: row.StartedAt, FinishedAt: row.FinishedAt,
	})
}

func (s *Station) finish(r *rollout, row *stepRow, status protocol.DeploymentStepStatus) {
	now := time.Now()
	row.Status = status
	if row.StartedAt == nil {
		row.StartedAt = stamp(now)
	}
	row.FinishedAt = stamp(now)
	r.event(row, now)
	s.saveRollout(r)
	s.reportStep(r, row)
	detail, _ := json.Marshal(row.Detail)
	s.log.Info("deployment step", "deployment", r.ID, "service", r.ServiceID, "step", row.Step, "status", row.Status, "attempt", row.Attempt, "detail", string(detail))
}

func (s *Station) desiredDeployment(id string) (protocol.DesiredDeployment, bool) {
	d, ok := s.plan.Generation.Deployments[id]
	return d, ok
}

func (s *Station) cancelReason(r *rollout) *protocol.CancelReason {
	d, ok := s.desiredDeployment(r.ID)
	if !ok {
		reason := protocol.CancelReasonSuperseded
		return &reason
	}
	if d.Cancel != nil {
		return &d.Cancel.Reason
	}
	return nil
}

func (s *Station) syncRollouts() {
	g := s.plan.Generation
	now := time.Now()
	for _, id := range sortedKeys(g.Deployments) {
		if _, ok := s.rollouts[id]; ok {
			continue
		}
		d := g.Deployments[id]
		envID := g.Services[d.ServiceId].EnvironmentId
		r := newRollout(id, d, envID, s.plan.Networks[envID].Name, now)
		s.rollouts[id] = r
		s.saveRollout(r)
		s.log.Info("deployment received", "deployment", id, "service", d.ServiceId, "number", d.Number, "strategy", d.Strategy, "from", deref(d.FromDeploymentId), "supersedes", deref(d.Supersedes), "cancel", d.Cancel != nil)
	}
	chain := s.chains()
	for _, r := range s.orderedRollouts() {
		if !r.terminal() {
			continue
		}
		if _, listed := g.Deployments[r.ID]; listed || chain[r.ID] {
			continue
		}
		s.dropRollout(r)
	}
	s.applyOverrides()
}

func (s *Station) orderedRollouts() []*rollout {
	out := make([]*rollout, 0, len(s.rollouts))
	for _, r := range s.rollouts {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ServiceID != out[j].ServiceID {
			return out[i].ServiceID < out[j].ServiceID
		}
		if out[i].Number != out[j].Number {
			return out[i].Number < out[j].Number
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func (s *Station) chains() map[string]bool {
	keep := map[string]bool{}
	for svcID := range s.plan.Generation.Services {
		for _, r := range s.activeChain(svcID) {
			keep[r.ID] = true
		}
	}
	return keep
}

func (s *Station) activeChain(svcID string) []*rollout {
	svc, ok := s.plan.Generation.Services[svcID]
	if !ok {
		return nil
	}
	current := ""
	if svc.Current != nil {
		current = svc.Current.DeploymentId
	}
	var chain []*rollout
	for {
		var next *rollout
		for _, r := range s.orderedRollouts() {
			if r.ServiceID != svcID || r.Outcome == nil || *r.Outcome != protocol.DeploymentOutcomeActive || r.ID == current || slices.Contains(chain, r) {
				continue
			}
			if r.blueID() == current {
				next = r
			}
		}
		if next == nil {
			return chain
		}
		chain = append(chain, next)
		current = next.ID
	}
}

func (s *Station) servingRollout(svcID string) *rollout {
	for _, r := range s.orderedRollouts() {
		if r.ServiceID == svcID && r.switched() {
			return r
		}
	}
	if chain := s.activeChain(svcID); len(chain) > 0 {
		return chain[len(chain)-1]
	}
	return nil
}

func (s *Station) applyOverrides() {
	for svcID := range s.plan.Generation.Services {
		r := s.servingRollout(svcID)
		if r == nil {
			continue
		}
		sp := s.plan.ServicePlanFor(svcID, r.ID, r.Number, r.Target)
		if cur := s.plan.Services[svcID]; cur != nil && cur.Hash == sp.Hash {
			continue
		}
		s.plan.Services[svcID] = sp
		s.log.Info("service now runs its deployment", "service", svcID, "deployment", r.ID)
	}
}

func (s *Station) heldByRollout(svcID string) bool {
	for _, r := range s.rollouts {
		if r.ServiceID == svcID && r.rejecting() {
			return true
		}
	}
	return false
}

func (s *Station) rolloutContainers() map[string]bool {
	out := map[string]bool{}
	for _, r := range s.rollouts {
		if r.terminal() {
			continue
		}
		out[docker.CouplerName(r.ID)] = true
		out[docker.ServiceName(r.ID)] = true
		if r.ownsBlue() {
			out[r.Blue.Coupler] = true
			out[r.Blue.Service] = true
		}
	}
	return out
}

func (s *Station) switchTarget(svcID string) vipswitch.Target {
	for _, r := range s.orderedRollouts() {
		if r.ServiceID != svcID {
			continue
		}
		switch {
		case r.switched():
			if a := parseAddr(r.Green.Address); a.IsValid() {
				return vipswitch.Target{Addr: a}
			}
		case r.rejecting():
			return vipswitch.Target{Reject: true}
		}
	}
	if sp := s.plan.Services[svcID]; sp != nil && !sp.Run {
		return vipswitch.Target{Reject: true}
	}
	return vipswitch.Target{Addr: s.realAddress(svcID)}
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
