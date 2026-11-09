//go:build linux

package deploy

import (
	"context"
	"fmt"
	"strings"
	"time"
	_ "time/tzdata"

	"github.com/harshjv/stationly/go/internal/protocol"
	cron "github.com/netresearch/go-cron"
)

type cronState struct {
	key   string
	sched cron.Schedule
	next  time.Time
}

func parseSchedule(sc protocol.ContainerSpecSchedule) (cron.Schedule, error) {
	if sc.Timezone == "" {
		return nil, fmt.Errorf("timezone is required")
	}
	if strings.Contains(sc.Cron, "TZ=") {
		return nil, fmt.Errorf("cron %q carries its own timezone prefix; use the timezone field", sc.Cron)
	}
	if strings.HasPrefix(strings.TrimSpace(sc.Cron), "@every") {
		return nil, fmt.Errorf("cron %q: @every intervals are not cron expressions", sc.Cron)
	}
	if _, err := time.LoadLocation(sc.Timezone); err != nil {
		return nil, fmt.Errorf("timezone %q: %v", sc.Timezone, err)
	}
	return cron.ParseStandard("CRON_TZ=" + sc.Timezone + " " + sc.Cron)
}

func (s *Station) tickCron(ctx context.Context, now time.Time) {
	for _, id := range s.plan.ServiceIDs() {
		sp := s.plan.Services[id]
		if sp.Kind != protocol.ServiceKindCron || !sp.Wanted || sp.DeploymentID == "" || sp.Unsupported != nil || sp.Spec.Schedule == nil {
			if _, ok := s.crons[id]; ok {
				delete(s.crons, id)
				s.log.Info("cron schedule disarmed", "service", id)
			}
			continue
		}
		sc := *sp.Spec.Schedule
		key := sc.Cron + "|" + sc.Timezone
		st := s.crons[id]
		if st == nil || st.key != key {
			sched, err := parseSchedule(sc)
			if err != nil {
				s.log.Error("cron schedule invalid", "service", id, "cron", sc.Cron, "timezone", sc.Timezone, "error", err)
				continue
			}
			from := now
			if last := s.lastTick(id); last.After(from) {
				from = last
			}
			st = &cronState{key: key, sched: sched, next: sched.Next(from)}
			s.crons[id] = st
			s.log.Info("cron schedule armed", "service", id, "cron", sc.Cron, "timezone", sc.Timezone, "concurrency", sc.Concurrency, "next", st.next.UTC().Format(timestampLayout))
		}
		if now.Before(st.next) {
			continue
		}
		tick := st.next
		st.next = st.sched.Next(now)
		if sc.Concurrency == protocol.ScheduleConcurrencySkip {
			if busy := s.activeRun(id, protocol.RunKindCron); busy != nil {
				rr := s.newRun(protocol.RunKindCron, sp.EnvID, id, sp.DeploymentID, sp.Spec, commandOf(sp.Spec), tick, protocol.RunStatusSkipped)
				rr.Detail["skipped_because"] = busy.ID
				s.saveRun(rr)
				s.log.Info("cron tick skipped: the previous run is still running", "service", id, "run", rr.ID, "running", busy.ID, "tick", stamp(tick))
				continue
			}
		}
		rr := s.newRun(protocol.RunKindCron, sp.EnvID, id, sp.DeploymentID, sp.Spec, commandOf(sp.Spec), tick, protocol.RunStatusQueued)
		s.log.Info("cron tick", "service", id, "run", rr.ID, "tick", *stamp(tick), "next", *stamp(st.next))
		s.driveRun(ctx, rr)
	}
}

func (s *Station) lastTick(svcID string) time.Time {
	var last time.Time
	for _, rr := range s.runs {
		if rr.ServiceID == svcID && rr.Kind == protocol.RunKindCron {
			if t := parseStamp(rr.ScheduledAt); t.After(last) {
				last = t
			}
		}
	}
	return last
}
