//go:build linux

package deploy

import (
	"context"
	"time"

	"github.com/harshjv/stationly/go/internal/depot"
	"github.com/harshjv/stationly/go/internal/dispatch"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/workshop"
	cron "github.com/netresearch/go-cron"
)

const registryDeleteTimeout = 120 * time.Second

type gcSchedule struct {
	spec  string
	sched cron.Schedule
	next  time.Time
}

func (s *Station) markPruned(res protocol.RegistryDeleteResultBody) {
	gone := map[string]bool{}
	for _, it := range res.Items {
		if it.Status == protocol.RegistryDeleteStatusDeleted || it.Status == protocol.RegistryDeleteStatusAbsent {
			gone[it.Digest] = true
		}
	}
	if len(gone) == 0 {
		return
	}
	records, err := workshop.Records(s.opts.StateDir)
	if err != nil {
		return
	}
	for _, r := range records {
		if r.Pruned || r.Result.IndexDigest == nil || !gone[*r.Result.IndexDigest] {
			continue
		}
		r.Pruned = true
		if err := workshop.SaveRecord(s.opts.StateDir, r); err != nil {
			s.log.Error("mark build record pruned", "build", r.BuildID, "error", err)
		}
	}
}

func (s *Station) registryDelete(_ context.Context, m dispatch.Message, b protocol.RegistryDeleteBody) {
	ref := m.ID
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), registryDeleteTimeout)
		defer cancel()
		res := s.deleteItems(ctx, b.Items)
		s.markPruned(res)
		s.send(protocol.MessageRegistryDeleteResult, &ref, res)
	}()
}

func (s *Station) maintenance(ctx context.Context, reason string, progress func(string, string)) (depot.GCResult, *protocol.ErrorBody) {
	if !s.depot.BeginMaintenance() {
		return depot.GCResult{}, &protocol.ErrorBody{Code: string(protocol.ErrorCodeBuildFailed), Explanation: "a registry maintenance window is already open", Fix: "Wait for it to finish."}
	}
	defer s.depot.EndMaintenance()
	start := time.Now()
	s.log.Info("registry.maintenance", "state", "started", "reason", reason)
	s.emit(protocol.MessageRegistryMaintenance, map[string]any{"state": protocol.RegistryMaintenanceStateStarted, "deleted_blobs": 0, "freed_bytes": 0, "duration_s": 0})
	progress("registry.maintenance", "started; new builds queue with waiting_for_registry")
	finished := func(res depot.GCResult) {
		s.emit(protocol.MessageRegistryMaintenance, map[string]any{"state": protocol.RegistryMaintenanceStateFinished, "deleted_blobs": res.DeletedBlobs, "freed_bytes": res.FreedBytes, "duration_s": int(time.Since(start).Seconds())})
	}
	if err := s.workshops.WaitIdle(ctx); err != nil {
		finished(depot.GCResult{})
		return depot.GCResult{}, invalidParams(err)
	}
	progress("drained", "in-flight builds finished after "+time.Since(start).Round(10*time.Millisecond).String())
	res, err := s.depot.GC(ctx, progress)
	s.log.Info("registry.maintenance", "state", "finished", "reason", reason, "deleted_blobs", res.DeletedBlobs, "freed_bytes", res.FreedBytes, "duration_s", res.DurationS, "error", err)
	finished(res)
	progress("registry.maintenance", "finished")
	if err != nil {
		return res, &protocol.ErrorBody{Code: string(protocol.ErrorCodeBuildFailed), Explanation: "garbage collection: " + err.Error(), Fix: "Read the output in the result and the Depot log."}
	}
	return res, nil
}

func (s *Station) registryGC(_ context.Context, m dispatch.Message, b protocol.RegistryGcBody) {
	ref := m.ID
	s.send(protocol.MessageRegistryGcAccepted, &ref, map[string]any{})
	go s.maintenance(context.Background(), string(b.Reason), func(string, string) {})
}

func (s *Station) tickRegistryGC(now time.Time) {
	if s.plan == nil {
		return
	}
	spec := s.plan.Generation.Station.Settings.RegistryGcSchedule
	if spec == "" {
		s.gc = nil
		return
	}
	if s.gc == nil || s.gc.spec != spec {
		sched, err := cron.ParseStandard(spec)
		if err != nil {
			if s.gc == nil || s.gc.spec != spec {
				s.log.Error("registry.gc_schedule invalid", "cron", spec, "error", err)
			}
			s.gc = &gcSchedule{spec: spec}
			return
		}
		s.gc = &gcSchedule{spec: spec, sched: sched, next: sched.Next(now)}
		s.log.Info("registry gc schedule armed", "cron", spec, "next", s.gc.next.UTC().Format(timestampLayout))
	}
	if s.gc.sched == nil || now.Before(s.gc.next) {
		return
	}
	s.gc.next = s.gc.sched.Next(now)
	if s.link.Connected() && s.link.Negotiated(protocol.CapabilityRegistryV1) {
		s.log.Debug("registry gc schedule due; Dispatch sends registry.gc while connected", "cron", s.gc.spec)
		return
	}
	go s.maintenance(context.Background(), "schedule", func(string, string) {})
}
