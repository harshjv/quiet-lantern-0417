//go:build linux

package deploy

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"runtime/debug"
	"slices"
	"time"

	"github.com/moby/moby/api/types/container"

	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/protocol"
)

const timestampLayout = "2006-01-02T15:04:05.000Z"

func ptr[T any](v T) *T {
	return &v
}

func stamp(t time.Time) *string {
	if t.IsZero() {
		return nil
	}
	return ptr(t.UTC().Format(timestampLayout))
}

func dockerStamp(s string) *string {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil || t.Year() < 2000 {
		return nil
	}
	return stamp(t)
}

var buildVersion string

func stationdVersion() string {
	if buildVersion != "" {
		return buildVersion
	}
	if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" {
		return info.Main.Version
	}
	return "dev"
}

func (s *Station) observed() protocol.Observed {
	o := protocol.Observed{
		Components:      protocol.ObservedComponents{},
		Deployments:     protocol.ObservedDeployments{},
		Environments:    protocol.ObservedEnvironments{},
		Gateway:         protocol.ObservedGateway{Routes: protocol.ObservedGatewayRoutes{}},
		PortAllocations: protocol.ObservedPortAllocations{},
		Services:        protocol.ObservedServices{},
		SystemTargets:   protocol.ObservedSystemTargets{},
		Unknown:         s.unknown,
		Volumes:         protocol.ObservedVolumes{},
		Runs:            protocol.ObservedRuns{},
		Workshops:       protocol.ObservedWorkshops{},
		Station: protocol.ObservedStation{
			Resources: protocol.Resources{
				CpuMillis:   s.info.NCPU * 1000,
				MemoryBytes: int(s.info.MemTotal),
			},
			Routes: []any{},
			Capabilities: protocol.StationCapabilities{
				DockerVersion:   s.info.ServerVersion,
				Kernel:          s.info.KernelVersion,
				StationdVersion: stationdVersion(),
			},
			DockerVersion: s.info.ServerVersion,
			Registry:      protocol.ObservedRegistry{State: protocol.RegistryStateDown},
		},
		StationId: s.opts.Identity.StationID,
	}
	if o.Unknown == nil {
		o.Unknown = []protocol.UnknownObject{}
	}
	o.Station.Capabilities.Sandboxes = s.sandboxCapability()
	host := s.hostCapability()
	o.Station.Capabilities.Host = &host
	s.sandboxResources(&o.Station.Resources)
	if s.applied != nil {
		o.StationId = s.applied.StationId
		o.Applied.Number = s.applied.Number
		o.Applied.Hash = ptr(s.applied.Hash)
		o.Applied.Status = ptr(s.status)
	}
	if s.plan == nil {
		return o
	}
	g := s.plan.Generation
	o.StationId = g.StationId
	o.Sandboxes, o.SandboxSnapshots, o.SandboxBases = s.observedSandboxes()
	o.Unknown = append(slices.Clone(o.Unknown), s.sbx.unknown...)
	if pin, ok := g.Components["coupler_image"]; ok {
		o.Components["coupler_image"] = protocol.ObservedComponent{Version: pin.Version, Digest: (*string)(pin.Digest), Status: protocol.ComponentStatusOk}
	}
	applied := s.applied != nil && s.applied.Hash == g.Hash
	state, _ := s.depot.State()
	o.Station.Registry.State = state
	if pin, ok := g.Components["depot"]; ok {
		o.Components["depot"] = protocol.ObservedComponent{Version: pin.Version, Digest: (*string)(pin.Digest), Status: protocol.ComponentStatusOk}
	}
	running := s.workshops.Observed()
	for id, ws := range g.Workshops {
		ow := protocol.ObservedWorkshop{Running: running[id].Running, BuildsRunning: running[id].BuildsRunning}
		if applied {
			ow.AppliedHash = ptr(ws.Hash)
		}
		o.Workshops[id] = ow
	}

	for envID, env := range g.Environments {
		st := s.envs[envID]
		oe := protocol.ObservedEnvironment{Result: protocol.ObjectResultPending}
		if st != nil {
			switch {
			case st.failure != nil:
				oe.Result, oe.Failure = protocol.ObjectResultFailed, st.failure
			case st.networkID != "":
				oe.Result, oe.BridgeUp = protocol.ObjectResultOk, bridgeUp(env.Network.BridgeName)
				oe.DockerNetworkId = ptr(st.networkID)
				if applied {
					oe.AppliedHash = ptr(env.Hash)
				}
			}
		}
		o.Environments[envID] = oe
	}

	for svcID, svc := range g.Services {
		sp := s.plan.Services[svcID]
		st := s.services[svcID]
		so := protocol.ObservedService{
			Result:     protocol.ObjectResultPending,
			StatusHint: protocol.StatusHintStopped,
			Health:     protocol.ServiceHealth{State: protocol.HealthStateNone},
			Containers: []protocol.ObservedContainer{},
		}
		env := s.envs[svc.EnvironmentId]
		switch {
		case env != nil && env.failure != nil:
			so.Result, so.BlockedBy = protocol.ObjectResultBlocked, ptr("environments/"+svc.EnvironmentId)
		case st == nil:
		case st.blockedBy != "":
			so.Result, so.BlockedBy = protocol.ObjectResultBlocked, ptr(st.blockedBy)
			so.Failure = st.blockedErr
		case st.failure != nil:
			so.Result, so.Failure = protocol.ObjectResultFailed, st.failure
		case st.nsFailure != nil && sp.Run:
			so.Result, so.Failure = protocol.ObjectResultFailed, st.nsFailure
		case !sp.Run:
			so.Result = protocol.ObjectResultOk
		case st.service.state == string(container.StateRunning):
			so.Result = protocol.ObjectResultOk
		}
		if so.Result == protocol.ObjectResultOk && applied {
			so.AppliedHash = ptr(svc.Hash)
		}
		if st != nil {
			if st.switchAddr.IsValid() {
				so.SwitchAddress = ptr(st.switchAddr.String())
			}
			so.StatusHint = statusHint(st, sp)
			if sp != nil && runsOnly(sp.Kind) {
				so.StatusHint = protocol.StatusHintStopped
				for _, rr := range s.orderedRuns() {
					if rr.ServiceID != svcID || rr.terminal() || rr.ContainerID == "" {
						continue
					}
					so.StatusHint = protocol.StatusHintRunning
					oc := protocol.ObservedContainer{Role: docker.RoleRun, DeploymentId: ptr(rr.DeploymentID), RunId: ptr(rr.ID), ContainerId: rr.ContainerID, State: string(rr.Status), StartedAt: rr.StartedAt}
					if rr.Address != "" {
						oc.Address = ptr(rr.Address)
					}
					so.Containers = append(so.Containers, oc)
				}
			}
			so.Health = protocol.ServiceHealth{
				State:       st.health.state,
				Consecutive: st.health.consecutive(),
				LastCheck:   stamp(st.health.lastCheck),
			}
			if st.health.failure != nil && so.Failure == nil {
				so.Failure = st.health.failure
			}
			var deploymentID *string
			if sp != nil && sp.DeploymentID != "" {
				deploymentID = ptr(sp.DeploymentID)
			}
			for _, c := range []struct {
				role string
				v    view
			}{{docker.RoleCoupler, st.coupler}, {docker.RoleService, st.service}} {
				if c.v.id == "" {
					continue
				}
				oc := protocol.ObservedContainer{
					Role:         c.role,
					DeploymentId: deploymentID,
					ContainerId:  c.v.id,
					State:        c.v.state,
					ExitCode:     c.v.exitCode,
					StartedAt:    dockerStamp(c.v.startedAt),
				}
				if c.v.address.IsValid() {
					oc.Address = ptr(c.v.address.String())
				}
				if c.role == docker.RoleService {
					oc.Restarts = len(st.restarts)
				}
				so.Containers = append(so.Containers, oc)
			}
		}
		o.Services[svcID] = so
	}
	s.observeGateway(&o, applied)
	o.Volumes = s.observedVolumes(applied)
	o.Runs = s.observedRuns()
	for depID, d := range g.Deployments {
		if r := s.rollouts[depID]; r != nil {
			o.Deployments[depID] = observedRollout(r, d.Hash)
		}
	}
	return o
}

func observedRollout(r *rollout, hash string) protocol.ObservedDeployment {
	od := protocol.ObservedDeployment{
		AppliedHash:  ptr(hash),
		Steps:        []protocol.ObservedDeploymentStep{},
		Outcome:      r.Outcome,
		CancelReason: r.CancelReason,
		FinishedAt:   r.FinishedAt,
	}
	if r.Failure != nil {
		f := protocol.ObservedDeploymentFailure(*r.Failure)
		od.Failure = &f
	}
	for _, row := range r.Steps {
		detail := protocol.ObservedDeploymentStepDetail{}
		for k, v := range row.Detail {
			detail[k] = v
		}
		od.Steps = append(od.Steps, protocol.ObservedDeploymentStep{
			Step: row.Step, Status: row.Status, Attempt: row.Attempt, Detail: detail,
			StartedAt: row.StartedAt, FinishedAt: row.FinishedAt,
		})
	}
	row := r.current()
	if row == nil || r.terminal() {
		row = &r.Steps[0]
		for i := len(r.Steps) - 1; i >= 0; i-- {
			if r.Steps[i].Status != statusPending {
				row = &r.Steps[i]
				break
			}
		}
	}
	od.Step, od.StepStatus, od.Attempt, od.StartedAt = row.Step, row.Status, row.Attempt, row.StartedAt
	return od
}

func statusHint(st *serviceState, sp *ServicePlan) protocol.StatusHint {
	switch {
	case sp == nil || !sp.Run || st.exhausted:
		return protocol.StatusHintStopped
	case st.service.state == string(container.StateRunning) && st.coupler.state == string(container.StateRunning):
		return protocol.StatusHintRunning
	default:
		return protocol.StatusHintRestarting
	}
}

func (s *Station) writeObserved() {
	o := s.observed()
	s.publish(o)
	body, err := json.MarshalIndent(o, "", "  ")
	if err != nil {
		s.log.Error("encode observed state", "error", err)
		return
	}
	if bytes.Equal(body, s.written) {
		return
	}
	o.ObservedAt = time.Now().UTC().Format(timestampLayout)
	if err := writeJSON(filepath.Join(s.opts.StateDir, ObservedFile), o); err != nil {
		s.log.Error("write observed state", "error", err)
		return
	}
	s.written = body
}
