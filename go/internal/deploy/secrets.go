//go:build linux

package deploy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/imageuser"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/secrets"
)

const runSecretsWait = 120 * time.Second

func unavailable(format string, args ...any) *protocol.ErrorBody {
	return &protocol.ErrorBody{
		Code:        string(protocol.ErrorCodeSecretsUnavailable),
		Explanation: fmt.Sprintf(format, args...),
		Fix:         "Dispatch sends secrets.deliver for the deployment; after a stationd restart stationd requests it with secrets.request.",
	}
}

func (s *Station) specFor(deploymentID string) (protocol.ContainerSpec, bool) {
	if s.plan != nil {
		if d, ok := s.plan.Generation.Deployments[deploymentID]; ok {
			return d.Target, true
		}
		for _, svc := range s.plan.Generation.Services {
			if svc.Current != nil && svc.Current.DeploymentId == deploymentID {
				return svc.Current.Spec, true
			}
		}
	}
	if r := s.rollouts[deploymentID]; r != nil && !r.terminal() {
		return r.Target, true
	}
	return protocol.ContainerSpec{}, false
}

func (s *Station) requestSecrets(depID, envDigest string, purpose protocol.SecretPurpose, reason string) {
	if _, done := s.secretRequests[depID]; done {
		return
	}
	s.secretRequests[depID] = secretRequest{EnvDigest: envDigest, Purpose: purpose, Reason: reason, At: *stamp(time.Now())}
	if s.link.Connected() {
		id := depID
		s.send(protocol.MessageSecretsRequest, nil, protocol.SecretsRequestBody{Target: protocol.SecretTarget{DeploymentId: &id}, EnvDigest: envDigest, Purpose: purpose})
	}
	s.log.Warn("secrets.request: values for this deployment are not in memory; waiting for Dispatch to resend", "deployment", depID, "env_digest", envDigest, "purpose", purpose, "reason", reason)
}

type secretRequest struct {
	EnvDigest string                 `json:"env_digest"`
	Purpose   protocol.SecretPurpose `json:"purpose"`
	Reason    string                 `json:"reason"`
	At        string                 `json:"requested_at"`
}

func (s *Station) opSecretsStatus(_ context.Context, _ json.RawMessage, _ func(string, string)) (any, *protocol.ErrorBody) {
	reply := make(chan any, 1)
	s.inspections <- func() {
		mounted, _ := secrets.MountedDeployments()
		requests := map[string]secretRequest{}
		for k, v := range s.secretRequests {
			requests[k] = v
		}
		reply <- map[string]any{"held": s.secrets.Held(), "requested": requests, "tmpfs": mounted}
	}
	return <-reply, nil
}

func (s *Station) opLogs(ctx context.Context, params json.RawMessage, _ func(string, string)) (any, *protocol.ErrorBody) {
	var p protocol.RootSocketLogsParams
	if err := json.Unmarshal(params, &p); err != nil || p.DeploymentId == "" {
		return nil, invalidParams(errors.New("deployment_id is required"))
	}
	tail := 200
	if p.Tail != nil && *p.Tail > 0 {
		tail = *p.Tail
	}
	lines, err := s.docker.LogTail(ctx, docker.ServiceName(p.DeploymentId), tail)
	if err != nil {
		return nil, &protocol.ErrorBody{Code: string(protocol.ErrorCodeNotFound), Explanation: err.Error(), Fix: "Name a deployment whose service container exists."}
	}
	red := s.redactorFor(p.DeploymentId)
	return map[string]any{"deployment_id": p.DeploymentId, "redaction_patterns": red.Patterns(), "lines": red.Lines(lines)}, nil
}

func (s *Station) redactorFor(deploymentID string) *secrets.Redactor {
	if set := s.secrets.Get(deploymentID); set != nil {
		return set.Redactor
	}
	return nil
}

func (s *Station) ownerFor(ctx context.Context, spec protocol.ContainerSpec) (secrets.Owner, error) {
	if spec.SecretsOwner != nil {
		return secrets.Owner{UID: spec.SecretsOwner.Uid, GID: spec.SecretsOwner.Gid}, nil
	}
	if o, ok := s.owners[spec.ImageRef]; ok {
		return o, nil
	}
	if err := s.docker.EnsureImage(ctx, spec.ImageRef); err != nil {
		return secrets.Owner{}, err
	}
	user, err := s.docker.ImageUser(ctx, spec.ImageRef)
	if err != nil {
		return secrets.Owner{}, err
	}
	var files map[string][]byte
	if !numericUserGroup(user) {
		files, err = s.docker.ReadImageFiles(ctx, spec.ImageRef, s.plan.Generation.StationId, "/etc/passwd", "/etc/group")
		if err != nil {
			return secrets.Owner{}, fmt.Errorf("read /etc/passwd from %s: %w", spec.ImageRef, err)
		}
	}
	uid, gid, _, err := imageuser.Resolve(user, files["/etc/passwd"], files["/etc/group"])
	if err != nil {
		return secrets.Owner{}, fmt.Errorf("image %s: %w", spec.ImageRef, err)
	}
	o := secrets.Owner{UID: uid, GID: gid}
	s.owners[spec.ImageRef] = o
	s.log.Info("secrets owner resolved from the image", "image", spec.ImageRef, "user", user, "uid", o.UID, "gid", o.GID)
	return o, nil
}

func numericUserGroup(user string) bool {
	if user == "" {
		return true
	}
	u, g, hasGroup := strings.Cut(user, ":")
	if _, err := strconv.Atoi(u); err != nil || !hasGroup {
		return false
	}
	_, err := strconv.Atoi(g)
	return err == nil
}

func (s *Station) prepareSecrets(ctx context.Context, depID string, spec protocol.ContainerSpec) (*secrets.Set, *protocol.ErrorBody) {
	if !secrets.NeedsValues(spec) {
		return nil, nil
	}
	set := s.secrets.Get(depID)
	if set == nil || set.Digest != spec.EnvDigest {
		return nil, unavailable("the values for deployment %s (env_digest %s) are not in stationd's memory", depID, spec.EnvDigest)
	}
	if !secrets.HasFiles(spec) {
		return set, nil
	}
	owner, err := s.ownerFor(ctx, spec)
	if err != nil {
		return nil, &protocol.ErrorBody{Code: string(protocol.ErrorCodeNamespaceSetupFailed), Explanation: "resolve the secrets owner: " + err.Error(), Fix: "Set service.secrets_owner to the uid and gid the process runs as."}
	}
	created, err := secrets.Mount(depID, owner, set.Files())
	if err != nil {
		return nil, &protocol.ErrorBody{Code: string(protocol.ErrorCodeNamespaceSetupFailed), Explanation: err.Error(), Fix: "Check that stationd runs as root in the host mount namespace."}
	}
	if created {
		s.log.Info("secrets tmpfs mounted", "deployment", depID, "path", secrets.Dir(depID), "uid", owner.UID, "gid", owner.GID, "files", len(set.Files()))
	}
	return set, nil
}

func envOf(set *secrets.Set) []string {
	if set == nil {
		return nil
	}
	return set.Env()
}

func (s *Station) releaseSecrets(depID string) {
	mounted := secrets.Mounted(depID)
	if err := secrets.Unmount(depID); err != nil {
		s.log.Error("unmount secrets tmpfs", "deployment", depID, "error", err)
		return
	}
	dropped := s.secrets.Drop(depID)
	delete(s.secretRequests, depID)
	if mounted || dropped {
		s.log.Info("secrets released", "deployment", depID, "tmpfs_unmounted", mounted, "values_dropped", dropped)
	}
}

func (s *Station) liveDeployments() map[string]bool {
	live := map[string]bool{}
	for _, sp := range s.plan.Services {
		if sp.DeploymentID != "" {
			live[sp.DeploymentID] = true
		}
	}
	for _, r := range s.rollouts {
		if r.terminal() {
			continue
		}
		live[r.ID] = true
		if r.Blue != nil && r.Blue.DeploymentID != "" {
			live[r.Blue.DeploymentID] = true
		}
	}
	for _, rr := range s.runs {
		if !rr.terminal() {
			live[rr.DeploymentID] = true
		}
	}
	return live
}

func (s *Station) sweepSecrets(_ context.Context, containers map[string]bool) {
	live := s.liveDeployments()
	mounted, err := secrets.MountedDeployments()
	if err != nil {
		s.log.Warn("list secrets tmpfs mounts", "error", err)
	}
	for _, id := range mounted {
		if !live[id] && !containers[id] {
			s.releaseSecrets(id)
		}
	}
	for _, id := range s.secrets.Live(func(id string) bool { return live[id] }) {
		s.log.Info("secrets dropped from memory: the deployment is no longer live", "deployment", id)
	}
	for id := range s.secretRequests {
		if !live[id] {
			delete(s.secretRequests, id)
		}
	}
}

func (s *Station) waitSecrets(ctx context.Context, r *rollout, row *stepRow) (*secrets.Set, progress) {
	set, failure := s.prepareSecrets(ctx, r.ID, r.Target)
	if failure == nil {
		if set != nil && row.Detail["secrets_waited_ms"] == nil && row.Detail["secrets_waiting"] != nil {
			row.Detail["secrets_waited_ms"] = time.Since(parseStamp(row.StartedAt)).Milliseconds()
			delete(row.Detail, "secrets_waiting")
		}
		if set != nil {
			row.Detail["secrets"] = map[string]any{"env_digest": set.Digest, "values": len(set.Entries), "files": len(set.Files())}
		}
		return set, advanced
	}
	if failure.Code != string(protocol.ErrorCodeSecretsUnavailable) {
		s.fail(ctx, r, row, protocol.DiagnosisPhaseStart, protocol.ErrorCode(failure.Code), failure.Explanation, &failureFacts{noGreen: true})
		return nil, stopped
	}
	recovering := r.rt.restarted || r.Recoveries > 0
	if row.Detail["secrets_waiting"] == nil {
		row.Detail["secrets_waiting"] = map[string]any{"code": failure.Code, "env_digest": r.Target.EnvDigest, "since": *stamp(time.Now())}
		s.saveRollout(r)
		reason := "the generation arrived before its secrets.deliver"
		if recovering {
			reason = "stationd restarted before the service step and holds no values"
			s.requestSecrets(r.ID, r.Target.EnvDigest, protocol.SecretPurposeDeploy, reason)
		}
		s.log.Info("deployment waits for its secret values", "deployment", r.ID, "step", row.Step, "code", failure.Code, "reason", reason)
	}
	budget := time.Duration(max(r.Budget.StartS, 1)) * time.Second
	if time.Since(parseStamp(row.StartedAt)) > budget {
		phase := protocol.DiagnosisPhaseStart
		if recovering {
			phase = protocol.DiagnosisPhaseRecovery
		}
		s.fail(ctx, r, row, phase, protocol.ErrorCodeSecretsUnavailable, fmt.Sprintf("secret values did not arrive within the %s step budget of %s: %s", row.Step, budget, failure.Explanation), &failureFacts{noGreen: true})
		return nil, stopped
	}
	return nil, waiting
}

func (s *Station) requestLostRedaction() {
	for _, sp := range s.plan.Services {
		if sp.DeploymentID == "" || !secrets.NeedsValues(sp.Spec) || s.secrets.Get(sp.DeploymentID) != nil {
			continue
		}
		s.requestSecrets(sp.DeploymentID, sp.Spec.EnvDigest, protocol.SecretPurposeRedaction, "stationd restarted; the running deployment keeps its environment and tmpfs, its redaction set is lost")
	}
}
