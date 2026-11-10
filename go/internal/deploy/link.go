//go:build linux

package deploy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/gowebpki/jcs"

	"github.com/harshjv/stationly/go/internal/dispatch"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/secrets"
)

const observedUpdateEvery = 5 * time.Second

var observedMaps = []string{"components", "environments", "services", "deployments", "volumes", "runs", "port_allocations", "workshops", "system_targets", "sandboxes", "sandbox_snapshots", "sandbox_bases"}

var hashedMaps = []string{"environments", "services", "deployments", "volumes", "port_allocations", "workshops", "system_targets", "sandboxes", "sandbox_snapshots"}

func canonicalHash(obj map[string]any) (string, error) {
	stripped := make(map[string]any, len(obj))
	for k, v := range obj {
		if k != "hash" {
			stripped[k] = v
		}
	}
	raw, err := json.Marshal(stripped)
	if err != nil {
		return "", err
	}
	canonical, err := jcs.Transform(raw)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(canonical)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

func checkHash(where string, obj map[string]any) error {
	want, _ := obj["hash"].(string)
	got, err := canonicalHash(obj)
	if err != nil {
		return fmt.Errorf("%s: %w", where, err)
	}
	if got != want {
		return fmt.Errorf("%s hash is %s, the content hashes to %s", where, want, got)
	}
	return nil
}

func VerifyGenerationHashes(raw []byte) error {
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	var doc map[string]any
	if err := dec.Decode(&doc); err != nil {
		return err
	}
	for _, name := range hashedMaps {
		m, _ := doc[name].(map[string]any)
		for key, v := range m {
			obj, ok := v.(map[string]any)
			if !ok {
				return fmt.Errorf("%s/%s is not an object", name, key)
			}
			if err := checkHash(name+"/"+key, obj); err != nil {
				return err
			}
		}
	}
	gw, ok := doc["gateway"].(map[string]any)
	if !ok {
		return fmt.Errorf("gateway is not an object")
	}
	routes, _ := gw["routes"].(map[string]any)
	for key, v := range routes {
		obj, ok := v.(map[string]any)
		if !ok {
			return fmt.Errorf("gateway/routes/%s is not an object", key)
		}
		if err := checkHash("gateway/routes/"+key, obj); err != nil {
			return err
		}
	}
	if err := checkHash("gateway", gw); err != nil {
		return err
	}
	return checkHash("document", doc)
}

func (s *Station) send(typ string, ref *string, body any) {
	if err := s.link.Send(typ, ref, body); err != nil {
		s.log.Warn("send to Dispatch", "type", typ, "error", err)
	}
}

func (s *Station) emit(typ string, body any) {
	if seq, err := s.link.Emit(typ, body); err == nil {
		s.log.Debug("outbox record", "type", typ, "seq", seq)
	}
}

func protocolError(code protocol.ErrorCode, fix, format string, args ...any) *protocol.ErrorBody {
	return &protocol.ErrorBody{Code: string(code), Explanation: fmt.Sprintf(format, args...), Fix: fix}
}

func (s *Station) replyError(m dispatch.Message, e *protocol.ErrorBody) {
	ref := m.ID
	s.send(protocol.MessageError, &ref, e)
}

type handler func(s *Station, ctx context.Context, m dispatch.Message)

func typed[T any](fn func(*Station, context.Context, dispatch.Message, T)) handler {
	return func(s *Station, ctx context.Context, m dispatch.Message) {
		var b T
		if err := json.Unmarshal(m.Body, &b); err != nil {
			s.replyError(m, protocolError(protocol.ErrorCodeProtocolInvalidMessage, "Send a "+m.Type+" body that matches its schema.", "%v", err))
			return
		}
		fn(s, ctx, m, b)
	}
}

func ignore(*Station, context.Context, dispatch.Message) {}

var handlers = map[string]handler{
	protocol.MessageGeneration:          (*Station).applyGeneration,
	protocol.MessageGenerationAvailable: (*Station).generationAvailable,
	protocol.MessageSecretsDeliver:      typed((*Station).secretsDeliver),
	protocol.MessageBuildStart:          typed((*Station).startBuild),
	protocol.MessageBuildCancel:         typed((*Station).cancelBuild),
	protocol.MessageRunStart:            typed((*Station).startRequestedRun),
	protocol.MessageRunCancel:           typed((*Station).cancelRequestedRun),
	protocol.MessageLogsQuery:           typed((*Station).queryLogs),
	protocol.MessageLogsFollow:          typed((*Station).followLogs),
	protocol.MessageMetricsSample:       typed((*Station).sampleMetrics),
	protocol.MessageMetricsSubscribe:    typed((*Station).subscribeMetrics),
	protocol.MessageNetworkSample:       typed((*Station).sampleNetwork),
	protocol.MessageNetworkSubscribe:    typed((*Station).subscribeNetwork),
	protocol.MessageNetworkInspect:      typed((*Station).inspectNetwork),
	protocol.MessageNetworkProbe:        typed((*Station).probeNetwork),
	protocol.MessageDnsLog:              typed((*Station).dnsLog),
	protocol.MessageExecResize:          typed((*Station).resizeExec),
	protocol.MessageRegistryDelete:      typed((*Station).registryDelete),
	protocol.MessageRegistryGc:          typed((*Station).registryGC),
	protocol.MessagePlatformVerify:      typed((*Station).platformVerify),
	protocol.MessageVolumeBackup:        typed((*Station).volumeBackup),
	protocol.MessageVolumeRestore:       typed((*Station).volumeRestore),
	protocol.MessageVolumeBackupDelete:  typed((*Station).volumeBackupDelete),
	protocol.MessageDoctorRun:           typed((*Station).doctorRun),
	protocol.MessageForwardOpen:         typed((*Station).openForward),
	protocol.MessageSandboxStorageGrow:  typed((*Station).growSandboxStorage),
	protocol.MessageError:               (*Station).dispatchError,
	protocol.MessageWelcome:             ignore,
	protocol.MessageChallenge:           ignore,
	protocol.MessageEnrolled:            ignore,
}

func capabilityMissing(typ string, capability protocol.Capability) *protocol.ErrorBody {
	return protocolError(protocol.ErrorCodeProtocolCapabilityMissing, "Negotiate the capability in welcome first.", "%s needs the %s capability, which welcome did not grant", typ, capability)
}

func route(typ string, negotiated func(protocol.Capability) bool) (handler, *protocol.ErrorBody) {
	if _, known := protocol.MessageBodies[typ]; !known {
		return nil, protocolError(protocol.ErrorCodeProtocolUnknownType, "Send a type from the station protocol catalog.", "unknown message type %s", typ)
	}
	if capability, gated := protocol.MessageCapabilities[typ]; gated && !negotiated(capability) {
		return nil, capabilityMissing(typ, capability)
	}
	h, ok := handlers[typ]
	if !ok {
		return nil, protocolError(protocol.ErrorCodeProtocolCapabilityMissing, "Send only messages whose capability was negotiated in welcome.", "this stationd does not handle %s", typ)
	}
	return h, nil
}

func (s *Station) handle(ctx context.Context, m dispatch.Message) {
	if m.Connected {
		s.onConnected()
		return
	}
	h, failure := route(m.Type, s.link.Negotiated)
	if failure != nil {
		s.replyError(m, failure)
		return
	}
	h(s, ctx, m)
}

func (s *Station) requireCapability(m dispatch.Message, capability protocol.Capability) bool {
	if s.link.Negotiated(capability) {
		return true
	}
	s.replyError(m, capabilityMissing(m.Type, capability))
	return false
}

func (s *Station) dispatchError(_ context.Context, m dispatch.Message) {
	var e protocol.ErrorBody
	_ = json.Unmarshal(m.Body, &e)
	s.log.Warn("Dispatch answered with an error", "ref", deref(m.Ref), "code", e.Code, "explanation", e.Explanation)
}

func (s *Station) secretsDeliver(ctx context.Context, m dispatch.Message, b protocol.SecretsDeliverBody) {
	ack, failure := s.deliverSecrets(ctx, b)
	if failure != nil {
		s.replyError(m, failure)
		return
	}
	ref := m.ID
	s.send(protocol.MessageSecretsAck, &ref, ack)
}

func (s *Station) onConnected() {
	for depID, req := range s.secretRequests {
		id := depID
		s.send(protocol.MessageSecretsRequest, nil, protocol.SecretsRequestBody{Target: protocol.SecretTarget{DeploymentId: &id}, EnvDigest: req.EnvDigest, Purpose: req.Purpose})
	}
}

type pendingAck struct {
	ref    string
	number int
	hash   string
	start  time.Time
}

func (s *Station) applyGeneration(ctx context.Context, m dispatch.Message) {
	start := time.Now()
	ref := m.ID
	refuse := func(number int, hash string, failure *protocol.ErrorBody) {
		s.log.Error("generation rejected", "number", number, "code", failure.Code, "explanation", failure.Explanation)
		if hash == "" {
			hash = "sha256:" + strings.Repeat("0", 64)
		}
		s.send(protocol.MessageGenerationAck, &ref, protocol.GenerationAckBody{Number: number, Hash: hash, Status: protocol.AppliedStatusRejected, Results: []protocol.GenerationResult{}, Failure: failure, DurationMs: int(time.Since(start).Milliseconds())})
	}
	var g protocol.Generation
	if err := json.Unmarshal(m.Body, &g); err != nil {
		refuse(m.Generation, "", protocolError(protocol.ErrorCodeGenerationInvalid, "Send a generation that matches the schema.", "%v", err))
		return
	}
	if err := VerifyGenerationHashes(m.Body); err != nil {
		refuse(g.Number, g.Hash, protocolError(protocol.ErrorCodeGenerationInvalid, "Recompute the hashes with JCS and SHA-256.", "%v", err))
		return
	}
	if g.StationId != s.opts.Identity.StationID || g.InstanceId != s.opts.Identity.InstanceID {
		refuse(g.Number, g.Hash, protocolError(protocol.ErrorCodeGenerationInvalid, "Send the generation to the station it was built for.", "generation is for station %s of instance %s, identity/ holds %s of %s", g.StationId, g.InstanceId, s.opts.Identity.StationID, s.opts.Identity.InstanceID))
		return
	}
	if s.applied != nil && g.Number <= s.applied.Number && g.Resolution == nil && (g.Number != s.applied.Number || g.Hash != s.applied.Hash) {
		refuse(g.Number, g.Hash, protocolError(protocol.ErrorCodeGenerationStale, "Send a generation numbered above the applied one.", "generation %d is not newer than applied generation %d", g.Number, s.applied.Number))
		return
	}
	if failure := s.verifyComponents(ctx, &g); failure != nil {
		refuse(g.Number, g.Hash, failure)
		return
	}
	plan, err := BuildPlan(&g, s.appliedForCheck(&g), s.opts.StateDir, s.trust())
	if err != nil {
		var rej *Rejection
		if !errors.As(err, &rej) {
			rej = reject(protocol.ErrorCodeGenerationInvalid, "Fix the generation and send it again.", "%v", err)
		}
		failure := rej.Body
		s.log.Error("generation rejected", "number", g.Number, "code", failure.Code, "explanation", failure.Explanation)
		s.send(protocol.MessageGenerationAck, &ref, protocol.GenerationAckBody{Number: g.Number, Hash: g.Hash, Status: protocol.AppliedStatusRejected, Results: []protocol.GenerationResult{}, Failure: &failure, DurationMs: int(time.Since(start).Milliseconds())})
		return
	}
	s.log.Info("generation received", "number", g.Number, "hash", g.Hash, "services", len(g.Services), "deployments", len(g.Deployments))
	s.plan, s.rejection = plan, nil
	s.status = protocol.AppliedStatusApplied
	s.syncRollouts()
	s.configurePlatform(ctx)
	s.reconcile(ctx)
	s.commit()
	s.advance(ctx)
	s.advanceGateway(ctx)
	s.reconcileSandboxes(ctx, time.Now())
	s.writeObserved()
	s.reportComponents(&g)
	s.writeLockMirror(&g)
	results := s.ackResults()
	status := s.status
	if status == protocol.AppliedStatusPartial {
		s.pendingAck = &pendingAck{ref: ref, number: g.Number, hash: g.Hash, start: start}
	} else {
		s.pendingAck = nil
	}
	s.send(protocol.MessageGenerationAck, &ref, protocol.GenerationAckBody{Number: g.Number, Hash: g.Hash, Status: status, Results: results, DurationMs: int(time.Since(start).Milliseconds())})
	s.log.Info("generation acknowledged", "number", g.Number, "status", status, "failed_or_blocked", len(results), "duration_ms", time.Since(start).Milliseconds())
}

func (s *Station) appliedForCheck(g *protocol.Generation) *protocol.Generation {
	if g.Resolution != nil {
		return nil
	}
	return s.applied
}

func (s *Station) settlePendingAck() {
	p := s.pendingAck
	if p == nil || s.plan == nil || s.plan.Generation.Number != p.number || s.status != protocol.AppliedStatusApplied {
		return
	}
	s.pendingAck = nil
	ref := p.ref
	s.send(protocol.MessageGenerationAck, &ref, protocol.GenerationAckBody{Number: p.number, Hash: p.hash, Status: protocol.AppliedStatusApplied, Results: []protocol.GenerationResult{}, DurationMs: int(time.Since(p.start).Milliseconds())})
	s.log.Info("generation acknowledged again: every object applied", "number", p.number)
}

func (s *Station) ackResults() []protocol.GenerationResult {
	out := []protocol.GenerationResult{}
	failed := func(key string, f *protocol.ErrorBody) {
		out = append(out, protocol.GenerationResult{Key: key, Status: protocol.GenerationResultStatusFailed, Failure: f})
	}
	blocked := func(key, by string) {
		b := by
		out = append(out, protocol.GenerationResult{Key: key, Status: protocol.GenerationResultStatusBlocked, BlockedBy: &b})
	}
	for id, st := range s.envs {
		if st.failure != nil {
			failed("environments/"+id, st.failure)
		}
	}
	for id, st := range s.services {
		sp := s.plan.Services[id]
		switch {
		case sp != nil && s.envs[sp.EnvID] != nil && s.envs[sp.EnvID].failure != nil:
			blocked("services/"+id, "environments/"+sp.EnvID)
		case st.blockedBy != "":
			blocked("services/"+id, st.blockedBy)
		case st.failure != nil && !st.exhausted:
			failed("services/"+id, st.failure)
		case st.nsFailure != nil:
			failed("services/"+id, st.nsFailure)
		}
	}
	for id, st := range s.volumes {
		if st.failure != nil {
			failed("volumes/"+id, st.failure)
		}
	}
	for id, st := range s.gw.routes {
		switch st.result {
		case protocol.ObjectResultFailed:
			failed("gateway/routes/"+id, st.failure)
		case protocol.ObjectResultBlocked:
			blocked("gateway/routes/"+id, st.blockedBy)
		}
	}
	for id, st := range s.gw.ports {
		switch st.result {
		case protocol.ObjectResultFailed:
			failed("port_allocations/"+id, st.failure)
		case protocol.ObjectResultBlocked:
			blocked("port_allocations/"+id, st.blockedBy)
		}
	}
	if s.gw.failure != nil {
		failed("gateway", s.gw.failure)
	}
	s.sandboxAckResults(failed)
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out
}

func (s *Station) publish(o protocol.Observed) {
	services := protocol.HeartbeatBodyServices{}
	for id, svc := range o.Services {
		services[id] = protocol.ServiceHeartbeat{StatusHint: svc.StatusHint, Health: svc.Health}
	}
	o.ObservedAt = time.Now().UTC().Format(timestampLayout)
	s.link.Publish(dispatch.Snapshot{Applied: o.Applied, Resources: o.Station.Resources, Services: services, Observed: &o})
	s.sendObservedUpdate(o)
}

type observedBaseline struct {
	entries map[string]map[string]json.RawMessage
	whole   map[string]json.RawMessage
	at      time.Time
}

func splitObserved(o protocol.Observed) observedBaseline {
	raw, _ := json.Marshal(o)
	var top map[string]json.RawMessage
	_ = json.Unmarshal(raw, &top)
	b := observedBaseline{entries: map[string]map[string]json.RawMessage{}, whole: map[string]json.RawMessage{"station": top["station"], "gateway": top["gateway"]}, at: time.Now()}
	for _, name := range observedMaps {
		var m map[string]json.RawMessage
		_ = json.Unmarshal(top[name], &m)
		b.entries[name] = m
	}
	return b
}

func (s *Station) sendObservedUpdate(o protocol.Observed) {
	if !s.link.Connected() {
		s.observedSent = nil
		return
	}
	next := splitObserved(o)
	if s.observedSent == nil {
		s.observedSent = &observedBaseline{entries: map[string]map[string]json.RawMessage{}, whole: map[string]json.RawMessage{}}
	}
	if time.Since(s.observedSent.at) < observedUpdateEvery {
		return
	}
	update := map[string]any{}
	for _, name := range observedMaps {
		changed := map[string]json.RawMessage{}
		for key, value := range next.entries[name] {
			if string(s.observedSent.entries[name][key]) != string(value) {
				changed[key] = value
			}
		}
		if len(changed) > 0 {
			update[name] = changed
		}
	}
	for name, value := range next.whole {
		if string(s.observedSent.whole[name]) != string(value) {
			update[name] = value
		}
	}
	if len(update) == 0 {
		return
	}
	update["observed_at"] = o.ObservedAt
	s.send(protocol.MessageObservedUpdate, nil, update)
	s.observedSent = &next
}

func (s *Station) deliverSecrets(ctx context.Context, body protocol.SecretsDeliverBody) (*protocol.SecretsAckBody, *protocol.ErrorBody) {
	if body.Target.BuildId != nil {
		s.buildSecrets[*body.Target.BuildId] = body
		s.log.Info("build secrets delivered", "build", *body.Target.BuildId, "values", len(body.Values))
		return &protocol.SecretsAckBody{Target: body.Target, EnvDigest: body.EnvDigest}, nil
	}
	if body.Target.SnapshotId != nil {
		creds, err := decodeBackupCredentials(body)
		if err != nil {
			return nil, protocolError(protocol.ErrorCodeProtocolInvalidMessage, "Deliver the S3 access key id and secret access key for the backup.", "%v", err)
		}
		s.storeBackupCredentials(*body.Target.SnapshotId, creds, time.Now())
		s.log.Info("backup credentials delivered", "snapshot", *body.Target.SnapshotId)
		return &protocol.SecretsAckBody{Target: body.Target, EnvDigest: body.EnvDigest}, nil
	}
	if body.Target.SandboxId != nil {
		return s.deliverSandboxSecrets(body)
	}
	if body.Target.RunId != nil {
		rr := s.runs[*body.Target.RunId]
		if rr != nil && rr.SandboxID != "" {
			return &protocol.SecretsAckBody{Target: body.Target, EnvDigest: body.EnvDigest}, nil
		}
		if rr == nil {
			s.pendingRunSecrets[*body.Target.RunId] = body
			return &protocol.SecretsAckBody{Target: body.Target, EnvDigest: body.EnvDigest}, nil
		}
		return s.deliverRunSecrets(ctx, rr, body)
	}
	if body.Target.DeploymentId == nil {
		return nil, unavailable("this stationd accepts secrets.deliver for deployments, runs and builds")
	}
	depID := *body.Target.DeploymentId
	spec, ok := s.specFor(depID)
	if !ok {
		return nil, &protocol.ErrorBody{Code: string(protocol.ErrorCodeSecretsMismatch), Explanation: "deployment " + depID + " is not in the applied generation", Fix: "Send the generation that contains the deployment first."}
	}
	set, failure := secrets.Verify(depID, spec, body, time.Now())
	if failure != nil {
		s.log.Warn("secrets.deliver refused", "deployment", depID, "code", failure.Code, "explanation", failure.Explanation)
		return nil, failure
	}
	s.secrets.Put(set)
	delete(s.secretRequests, depID)
	s.log.Info("secrets delivered", "deployment", depID, "purpose", body.Purpose, "values", len(set.Entries), "files", len(set.Files()), "redaction_patterns", set.Redactor.Patterns(), "env_digest", set.Digest)
	if r := s.rollouts[depID]; r != nil && !r.terminal() {
		s.drive(ctx, r)
	}
	s.resync = true
	return &protocol.SecretsAckBody{Target: body.Target, EnvDigest: set.Digest}, nil
}
