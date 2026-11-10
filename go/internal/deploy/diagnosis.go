//go:build linux

package deploy

import (
	"context"
	"encoding/json"
	"fmt"
	"net/netip"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/harshjv/stationly/go/internal/netns"
	"github.com/harshjv/stationly/go/internal/protocol"
)

const (
	logTail       = 400
	logLastLines  = 40
	logErrorLines = 40
	logLineCap    = 400
)

var (
	errorPattern = regexp.MustCompile(`(?i)error|panic|fatal|exception|EADDRINUSE|ECONNREFUSED|permission denied|out of memory|" 5\d\d |\s5\d\d\s`)
	tokenPattern = regexp.MustCompile(protocol.RedactTokenPattern)
)

type failureFacts struct {
	exitCode *int
	oom      bool
	health   *health
	view     view
	logs     []string
	noGreen  bool
}

func (s *Station) diagnose(ctx context.Context, r *rollout, row *stepRow, phase protocol.DiagnosisPhase, code protocol.ErrorCode, summary string, facts *failureFacts) *protocol.Diagnosis {
	d := &protocol.Diagnosis{
		Entity:  &protocol.DiagnosisEntity{Type: protocol.DiagnosisEntityTypeDeployment, Id: r.ID},
		Phase:   phase,
		Code:    string(code),
		Summary: summary,
	}
	if facts == nil {
		facts = &failureFacts{}
	}
	if facts.view.id == "" && !facts.noGreen {
		sp := s.plan.ServicePlanFor(r.ServiceID, r.ID, r.Number, r.Target)
		facts.view = s.inspectID(ctx, sp.Service.Name, sp.NetworkName)
		if facts.exitCode == nil {
			facts.exitCode = facts.view.exitCode
		}
		facts.oom = facts.oom || facts.view.oom
	}
	d.ExitCode = facts.exitCode
	d.OomKilled = &facts.oom
	if rule := ruleFor(r.Target.Health, r.Target.Ports); rule != nil && phase != protocol.DiagnosisPhasePreDeploy {
		dh := &protocol.DiagnosisHealth{Type: rule.kind, Result: "not_checked"}
		if rule.kind == "http" {
			dh.Path = &rule.path
		}
		if rule.port > 0 {
			dh.Port = &rule.port
		}
		if h := facts.health; h != nil && h.attempts > 0 {
			dh.Result, dh.Attempts = h.lastResult, h.attempts
		}
		d.Health = dh
	}
	if len(facts.logs) > 0 {
		text, truncated := excerpt(facts.logs)
		d.Logs = &protocol.DiagnosisLogs{
			Source:    "run",
			Untrusted: protocol.Untrusted{Source: "pre_deploy run log", Text: text},
			Truncated: truncated,
		}
	} else if facts.view.id != "" && facts.view.state != "" {
		if lines, err := s.docker.LogTail(ctx, facts.view.id, logTail); err == nil {
			text, truncated := excerpt(s.redactorFor(r.ID).Lines(lines))
			d.Logs = &protocol.DiagnosisLogs{
				Source:    "runtime",
				Untrusted: protocol.Untrusted{Source: "runtime log", Text: text},
				Truncated: truncated,
			}
		}
	}
	if blue := s.plan.Services[r.ServiceID]; blue != nil && blue.DeploymentID != "" && blue.DeploymentID != r.ID {
		if diff := configDiff(s.specOf(blue.DeploymentID), r.Target); len(diff) > 0 {
			d.DiffFromLastGood = &protocol.DiagnosisDiffFromLastGood{DeploymentId: blue.DeploymentID, Config: diff}
		}
	}
	d.Fixes = fixesFor(code, r)
	if rule := ruleFor(r.Target.Health, r.Target.Ports); rule != nil && phase == protocol.DiagnosisPhaseHealth && (rule.kind == "http" || rule.kind == "tcp") {
		var socks []netns.Socket
		if facts.view.pid > 0 {
			if got, err := netns.Listening(facts.view.pid, uint16(rule.port), "tcp"); err == nil {
				socks = got
			} else {
				s.log.Warn("read listening sockets for the diagnosis", "deployment", r.ID, "error", err)
			}
		}
		d.Network = &protocol.DiagnosisNetwork{Listening: listeningOf(socks)}
		if facts.view.pid > 0 {
			fact, fixes := listeningFacts(socks, rule.port)
			if fact != "" {
				d.Summary += "; " + fact
			}
			d.Fixes = append(fixes, d.Fixes...)
		}
	}
	if phase == protocol.DiagnosisPhasePreDeploy && code == protocol.ErrorCodeExitNonzero {
		d.Fixes = []protocol.DiagnosisFixesElem{{Code: "READ_LOGS", Text: "The pre_deploy command exited non-zero before green started, so blue kept serving. Read the log excerpt, fix the command or the migration, and deploy again."}}
	}
	d.Events = append([]protocol.DiagnosisEventsElem{}, r.Events...)
	d.Events = append(d.Events, protocol.DiagnosisEventsElem{At: *stamp(time.Now()), Step: row.Step, Status: statusFailed})
	return d
}

func (s *Station) specOf(deploymentID string) *protocol.ContainerSpec {
	g := s.plan.Generation
	for _, svc := range g.Services {
		if svc.Current != nil && svc.Current.DeploymentId == deploymentID {
			return &svc.Current.Spec
		}
	}
	if r := s.rollouts[deploymentID]; r != nil {
		return &r.Target
	}
	return nil
}

func configDiff(from *protocol.ContainerSpec, to protocol.ContainerSpec) []protocol.DiagnosisDiffFromLastGoodConfigElem {
	if from == nil {
		return nil
	}
	flat := func(spec protocol.ContainerSpec) map[string]any {
		spec.Env, spec.EnvDigest = nil, ""
		b, _ := json.Marshal(spec)
		var m any
		_ = json.Unmarshal(b, &m)
		out := map[string]any{}
		var walk func(prefix string, v any)
		walk = func(prefix string, v any) {
			if obj, ok := v.(map[string]any); ok {
				for k, child := range obj {
					p := k
					if prefix != "" {
						p = prefix + "." + k
					}
					walk(p, child)
				}
				return
			}
			out[prefix] = v
		}
		walk("", m)
		return out
	}
	a, b := flat(*from), flat(to)
	keys := map[string]bool{}
	for k := range a {
		keys[k] = true
	}
	for k := range b {
		keys[k] = true
	}
	var diff []protocol.DiagnosisDiffFromLastGoodConfigElem
	for _, k := range sortedKeys(keys) {
		if x, y := a[k], b[k]; !jsonEqual(x, y) {
			diff = append(diff, protocol.DiagnosisDiffFromLastGoodConfigElem{Path: k, From: x, To: y})
		}
	}
	return diff
}

func jsonEqual(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

func excerpt(lines []string) (string, bool) {
	last := lines[max(0, len(lines)-logLastLines):]
	earlier := lines[:max(0, len(lines)-logLastLines)]
	var matched []string
	for i := len(earlier) - 1; i >= 0 && len(matched) < logErrorLines; i-- {
		if errorPattern.MatchString(earlier[i]) {
			matched = append([]string{earlier[i]}, matched...)
		}
	}
	var out []string
	if len(matched) > 0 {
		out = append(out, matched...)
		out = append(out, fmt.Sprintf("[... %d earlier lines omitted ...]", len(earlier)-len(matched)))
	}
	out = append(out, last...)
	for i, l := range out {
		l = tokenPattern.ReplaceAllLiteralString(l, protocol.RedactTokenReplacement)
		if len(l) > logLineCap {
			l = l[:logLineCap]
		}
		out[i] = l
	}
	return strings.Join(out, "\n"), len(earlier) > len(matched)
}

func fixesFor(code protocol.ErrorCode, r *rollout) []protocol.DiagnosisFixesElem {
	switch code {
	case protocol.ErrorCodeHealthTimeout:
		text := "The health check never passed. Confirm the app listens on all interfaces"
		if rule := ruleFor(r.Target.Health, r.Target.Ports); rule != nil {
			text = fmt.Sprintf("%s never passed within %s. Confirm the app listens on 0.0.0.0:%d", rule.describe(), rule.startup, rule.port)
			if rule.kind == "http" {
				text += " and answers " + rule.path + " with 200 to 399"
			}
		}
		return []protocol.DiagnosisFixesElem{{Code: "CHECK_HEALTH_PATH", Text: text + "."}, {Code: "RAISE_STARTUP_TIMEOUT", Text: "If the app needs longer to start, raise health.startup_timeout_s."}}
	case protocol.ErrorCodeOomKilled:
		next := r.Target.Limits.MemoryBytes * 2
		return []protocol.DiagnosisFixesElem{{
			Code: "RAISE_MEMORY",
			Text: fmt.Sprintf("The kernel killed the process at the memory limit. Raise limits.memory_bytes to at least %d.", next),
			Action: &protocol.DiagnosisFixesElemAction{Tool: "update_service", Input: protocol.DiagnosisFixesElemActionInput{
				"service": r.ServiceID, "limits": map[string]any{"memory_bytes": next},
			}},
		}}
	case protocol.ErrorCodeExitNonzero:
		return []protocol.DiagnosisFixesElem{{Code: "READ_LOGS", Text: "The process exited before it became healthy. Read the log excerpt for the cause."}}
	}
	return nil
}

func listeningFacts(socks []netns.Socket, port int) (string, []protocol.DiagnosisFixesElem) {
	var onPort, others []string
	for _, k := range socks {
		if k.Proto != "tcp" {
			continue
		}
		text := netip.AddrPortFrom(k.Address, k.Port).String()
		if int(k.Port) == port {
			onPort = append(onPort, text)
		} else if !slices.Contains(others, text) {
			others = append(others, text)
		}
	}
	switch {
	case netns.LoopbackOnly(socks, uint16(port), "tcp"):
		return "listens on " + strings.Join(onPort, " and ") + " only", []protocol.DiagnosisFixesElem{{
			Code: "BIND_ALL_INTERFACES",
			Text: fmt.Sprintf("The app listens on %s only, so the health check from outside its namespace cannot reach it. Make the server listen on 0.0.0.0:%d instead, then redeploy.", strings.Join(onPort, " and "), port),
		}}
	case len(onPort) == 0 && len(others) > 0:
		return fmt.Sprintf("listens on %s, the check uses %d", strings.Join(others, ", "), port), []protocol.DiagnosisFixesElem{{
			Code: "USE_DECLARED_PORT",
			Text: fmt.Sprintf("Nothing listens on port %d, the port the health check uses; the app listens on %s. Make the app listen on %d, or declare the port it uses and point the health check at it.", port, strings.Join(others, ", "), port),
		}}
	case len(onPort) == 0:
		return "nothing listens on a TCP port", nil
	}
	return "", nil
}
