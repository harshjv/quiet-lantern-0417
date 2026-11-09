//go:build linux

package deploy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/protocol"
)

const componentsFile = "components.json"

type componentPin struct {
	Version string `json:"version"`
	Digest  string `json:"digest"`
}

type componentRecord struct {
	componentPin
	Since    string        `json:"since"`
	Previous *componentPin `json:"previous,omitempty"`
}

type procState struct {
	To      componentPin        `json:"to"`
	From    componentPin        `json:"from"`
	Step    string              `json:"step"`
	Started time.Time           `json:"started"`
	Running bool                `json:"running"`
	Failure *protocol.ErrorBody `json:"failure,omitempty"`
	Detail  map[string]any      `json:"detail,omitempty"`
}

var procedureKinds = map[string]string{
	"stationd":          "self",
	"dispatch":          "dispatch",
	"gateway":           "gateway",
	"depot":             "depot",
	"buildkit":          "buildkit",
	"coupler_image":     "pinned",
	"railpack_frontend": "pinned",
	"syft_scanner":      "pinned",
	"litestream":        "litestream",
	"runsc":             "runsc",
	"sandbox_toolchain": "toolchain",
}

func loadComponents(stateDir string) (map[string]componentRecord, error) {
	out := map[string]componentRecord{}
	b, err := os.ReadFile(filepath.Join(stateDir, componentsFile))
	if errors.Is(err, fs.ErrNotExist) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	return out, json.Unmarshal(b, &out)
}

func (s *Station) saveComponents() {
	b, err := json.MarshalIndent(s.comps, "", "  ")
	if err == nil {
		err = writeAtomic(filepath.Join(s.opts.StateDir, componentsFile), b)
	}
	if err != nil {
		s.log.Error("persist components.json", "error", err)
	}
}

func (s *Station) sourceOf(name string) string {
	fallback := ComponentSources[name]
	if s.verifier == nil {
		return fallback
	}
	return s.verifier.Trust().Source(name, fallback)
}

func pinOfGeneration(p protocol.ComponentPin) (componentPin, bool) {
	if p.Digest == nil {
		return componentPin{}, false
	}
	return componentPin{Version: p.Version, Digest: string(*p.Digest)}, true
}

func (s *Station) setRunning(name string, to componentPin) {
	rec := componentRecord{componentPin: to, Since: *stamp(time.Now())}
	if prev, ok := s.comps[name]; ok && prev.componentPin != to {
		p := prev.componentPin
		rec.Previous = &p
	}
	s.comps[name] = rec
	s.saveComponents()
}

func (s *Station) runningPin(name string) (componentPin, string, bool) {
	switch name {
	case "stationd":
		return componentPin{Version: stationdVersion(), Digest: SelfDigest()}, s.started, true
	case "gateway":
		if cur := s.gw.state.Current; cur != nil {
			return componentPin{Version: cur.Version, Digest: shortImageDigest(cur.Image)}, "", true
		}
		return componentPin{}, "", false
	case "dispatch":
		if cur := s.disp.state.Current; cur != nil {
			return cur.componentPin, cur.Since, true
		}
		return componentPin{}, "", false
	}
	rec, ok := s.comps[name]
	return rec.componentPin, rec.Since, ok
}

func (s *Station) advanceComponents(ctx context.Context) {
	if s.plan == nil || s.handingOver {
		return
	}
	g := s.plan.Generation
	names := make([]string, 0, len(g.Components))
	for n := range g.Components {
		names = append(names, n)
	}
	sort.Strings(names)
	changed := false
	for _, name := range names {
		want, ok := pinOfGeneration(g.Components[name])
		if !ok {
			continue
		}
		kind := procedureKinds[name]
		if kind == "gateway" {
			continue
		}
		if kind == "dispatch" && !s.hostsDispatch() {
			continue
		}
		have, _, known := s.runningPin(name)
		if p := s.procs[name]; p != nil && p.To != want && !p.Running {
			delete(s.procs, name)
			changed = true
		}
		if !known && kind != "dispatch" && kind != "self" && !(kind == "runsc" && s.needsRunsc(want)) {
			s.setRunning(name, want)
			s.log.Info("component recorded at its pin", "component", name, "version", want.Version, "digest", want.Digest)
			changed = true
			continue
		}
		if known && have == want {
			if p := s.procs[name]; p != nil && !p.Running {
				delete(s.procs, name)
				changed = true
			}
			continue
		}
		if p := s.procs[name]; p != nil && (p.Running || p.To == want) {
			continue
		}
		proc := &procState{To: want, From: have, Step: "start", Started: time.Now(), Running: true, Detail: map[string]any{}}
		s.procs[name] = proc
		changed = true
		s.log.Info("component upgrade procedure started", "component", name, "kind", kind, "from_version", have.Version, "from_digest", have.Digest, "to_version", want.Version, "to_digest", want.Digest)
		switch kind {
		case "self":
			s.startSelfUpgrade(ctx, proc)
		case "dispatch":
			s.startDispatchUpgrade(ctx, proc)
		case "depot":
			s.runProcedure(ctx, name, proc, s.depotProcedure)
		case "buildkit":
			s.runProcedure(ctx, name, proc, s.buildkitProcedure)
		case "litestream":
			s.runProcedure(ctx, name, proc, s.litestreamProcedure)
		case "pinned":
			s.runProcedure(ctx, name, proc, s.pullProcedure)
		case "runsc":
			s.runProcedure(ctx, name, proc, s.runscProcedure)
		default:
			proc.Running, proc.Step = false, "done"
			s.setRunning(name, want)
			s.log.Info("component pin recorded; nothing runs it in phase 1a", "component", name, "version", want.Version)
		}
	}
	if changed {
		s.reportComponents(g)
	}
}

type procedureFunc func(ctx context.Context, name string, p *procState, step func(string, map[string]any)) error

func (s *Station) runProcedure(ctx context.Context, name string, p *procState, run procedureFunc) {
	to := p.To
	step := func(name string, detail map[string]any) {
		go func() {
			select {
			case s.inspections <- func() {
				p.Step = name
				for k, v := range detail {
					p.Detail[k] = v
				}
			}:
			case <-ctx.Done():
			}
		}()
	}
	go func() {
		start := time.Now()
		err := run(ctx, name, p, step)
		select {
		case s.inspections <- func() { s.finishProcedure(name, p, to, err, time.Since(start)) }:
		case <-ctx.Done():
		}
	}()
}

func (s *Station) finishProcedure(name string, p *procState, to componentPin, err error, took time.Duration) {
	p.Running = false
	p.Detail["took_ms"] = took.Milliseconds()
	if err != nil {
		p.Step = "failed"
		p.Failure = &protocol.ErrorBody{Code: string(protocol.ErrorCodeUpgradeFailed), Explanation: fmt.Sprintf("%s upgrade to %s (%s): %v", name, to.Version, to.Digest, err), Fix: "Read the stationd log; Dispatch reverts the upgrade to the previous pin."}
		s.log.Error("component upgrade procedure failed", "component", name, "to_version", to.Version, "error", err, "took_ms", took.Milliseconds())
	} else {
		p.Step = "done"
		if name != "dispatch" {
			s.setRunning(name, to)
		}
		s.log.Info("component upgrade procedure done", "component", name, "version", to.Version, "digest", to.Digest, "took_ms", took.Milliseconds(), "detail", p.Detail)
	}
	if s.plan != nil {
		s.reportComponents(s.plan.Generation)
	}
}

func (s *Station) pullProcedure(ctx context.Context, name string, p *procState, step func(string, map[string]any)) error {
	ref := s.sourceOf(name) + "@" + p.To.Digest
	step("pull", map[string]any{"ref": ref})
	t := time.Now()
	if err := s.docker.EnsureImage(ctx, ref); err != nil {
		return fmt.Errorf("pull %s: %w", ref, err)
	}
	step("pulled", map[string]any{"pull_ms": time.Since(t).Milliseconds(), "takes_effect": takesEffect(name)})
	return nil
}

func takesEffect(name string) string {
	switch name {
	case "coupler_image":
		return "each service's next deployment; running Couplers are never replaced"
	case "railpack_frontend":
		return "the next Railpack build"
	case "syft_scanner":
		return "the next build's SBOM attestation"
	}
	return "next use"
}

func (s *Station) buildkitProcedure(ctx context.Context, name string, p *procState, step func(string, map[string]any)) error {
	ref := s.sourceOf(name) + "@" + p.To.Digest
	step("pull", map[string]any{"ref": ref})
	t := time.Now()
	if err := s.docker.EnsureImage(ctx, ref); err != nil {
		return fmt.Errorf("pull %s: %w", ref, err)
	}
	step("restart", map[string]any{"pull_ms": time.Since(t).Milliseconds()})
	restarted, err := s.workshops.RestartDaemons(ctx, ref)
	step("restarted", map[string]any{"workshops": restarted})
	return err
}

func (s *Station) depotProcedure(ctx context.Context, name string, p *procState, step func(string, map[string]any)) error {
	ref := s.sourceOf(name) + "@" + p.To.Digest
	step("pull", map[string]any{"ref": ref})
	t := time.Now()
	if err := s.docker.EnsureImage(ctx, ref); err != nil {
		return fmt.Errorf("pull %s: %w", ref, err)
	}
	step("maintenance", map[string]any{"pull_ms": time.Since(t).Milliseconds()})
	for !s.depot.BeginMaintenance() {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
	defer s.depot.EndMaintenance()
	start := time.Now()
	s.emit(protocol.MessageRegistryMaintenance, map[string]any{"state": protocol.RegistryMaintenanceStateStarted, "deleted_blobs": 0, "freed_bytes": 0, "duration_s": 0})
	defer func() {
		s.emit(protocol.MessageRegistryMaintenance, map[string]any{"state": protocol.RegistryMaintenanceStateFinished, "deleted_blobs": 0, "freed_bytes": 0, "duration_s": int(time.Since(start).Seconds())})
	}()
	if err := s.workshops.WaitIdle(ctx); err != nil {
		return err
	}
	step("drained", map[string]any{"drain_ms": time.Since(start).Milliseconds()})
	res, err := s.depot.Upgrade(ctx, ref, func(st, detail string) { step(st, map[string]any{"detail": detail}) })
	step("restarted", map[string]any{"readonly_ms": res.ReadonlyMs, "restart_ms": res.TookMs, "window_ms": time.Since(start).Milliseconds()})
	return err
}

func (s *Station) procedureStatus(name string, want componentPin) (protocol.ComponentStatus, *protocol.ErrorBody) {
	if name == "gateway" {
		if s.gw.state.Next != nil {
			return protocol.ComponentStatusUpgrading, nil
		}
		if last := s.gw.state.Last; last != nil && last.Failure != nil && shortImageDigest(last.To.Image) == want.Digest {
			if cur := s.gw.state.Current; cur == nil || shortImageDigest(cur.Image) != want.Digest {
				return protocol.ComponentStatusFailed, last.Failure
			}
		}
	}
	p := s.procs[name]
	if p == nil || p.To != want {
		return "", nil
	}
	if p.Running {
		return protocol.ComponentStatusUpgrading, nil
	}
	if p.Failure != nil {
		return protocol.ComponentStatusFailed, p.Failure
	}
	return "", nil
}

func (s *Station) hostsDispatch() bool {
	if s.plan != nil {
		return s.plan.Generation.Station.HostsDispatch
	}
	return s.disp.state.Current != nil
}

func componentContainer(name string) string {
	switch name {
	case "depot":
		return docker.DepotName
	case "dispatch":
		return docker.DispatchName
	}
	return ""
}
