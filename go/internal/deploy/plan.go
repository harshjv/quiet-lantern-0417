//go:build linux

package deploy

import (
	"errors"
	"fmt"
	"maps"
	"net/netip"
	"path"
	"regexp"
	"slices"
	"sort"
	"time"

	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/verify"
	"github.com/moby/moby/api/types/mount"
)

var dockerNamePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]+$`)

type Rejection struct {
	Body protocol.ErrorBody
}

func (r *Rejection) Error() string {
	return r.Body.Code + ": " + r.Body.Explanation
}

func reject(code protocol.ErrorCode, fix, format string, args ...any) *Rejection {
	return &Rejection{Body: protocol.ErrorBody{Code: string(code), Explanation: fmt.Sprintf(format, args...), Fix: fix}}
}

type Plan struct {
	Generation   *protocol.Generation
	Networks     map[string]docker.NetworkSpec
	Services     map[string]*ServicePlan
	Gateway      *GatewayPlan
	couplerImage string
}

type ServicePlan struct {
	ID           string
	EnvID        string
	NetworkName  string
	DeploymentID string
	Run          bool
	Hash         string
	Coupler      docker.ContainerSpec
	Service      docker.ContainerSpec
	Health       *protocol.ContainerSpecHealth
	Ports        []protocol.ContainerPort
	Unsupported  *protocol.ErrorBody
	Kind         protocol.ServiceKind
	Wanted       bool
	Spec         protocol.ContainerSpec
	Mounts       []mount.Mount
}

func runsOnly(kind protocol.ServiceKind) bool {
	return kind == protocol.ServiceKindCron || kind == protocol.ServiceKindOneOff
}

func (p *Plan) ServiceIDs() []string {
	ids := make([]string, 0, len(p.Services))
	for id := range p.Services {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func BuildPlan(g *protocol.Generation, applied *protocol.Generation, stateDir string, trust verify.Trust) (*Plan, error) {
	if err := checkGeneration(g, applied); err != nil {
		return nil, err
	}
	coupler := g.Components["coupler_image"]
	couplerImage := docker.CouplerSource + "@" + *coupler.Digest

	plan := &Plan{Generation: g, Networks: map[string]docker.NetworkSpec{}, Services: map[string]*ServicePlan{}, couplerImage: couplerImage}
	gp, err := planGateway(g, couplerImage, time.Now(), trust)
	if err != nil {
		return nil, reject(protocol.ErrorCodeGenerationInvalid, "Send a generation with a valid gateway section.", "%v", err)
	}
	plan.Gateway = gp
	for envID, env := range g.Environments {
		spec, err := docker.EnvironmentNetwork(g.StationId, envID, env.Network)
		if err != nil {
			return nil, reject(protocol.ErrorCodeGenerationInvalid, "Send a generation with valid environment networks.", "%v", err)
		}
		plan.Networks[envID] = spec
	}
	for svcID, svc := range g.Services {
		if svc.Current == nil {
			plan.Services[svcID] = &ServicePlan{ID: svcID, EnvID: svc.EnvironmentId, NetworkName: plan.Networks[svc.EnvironmentId].Name, Kind: svc.Kind}
			continue
		}
		sp := plan.ServicePlanFor(svcID, svc.Current.DeploymentId, svc.Current.Number, svc.Current.Spec)
		plan.Services[svcID] = sp
		if sp.Unsupported != nil {
			continue
		}
		if err := checkContainers(svcID, sp, stateDir); err != nil {
			return nil, err
		}
	}
	for depID, d := range g.Deployments {
		sp := plan.ServicePlanFor(d.ServiceId, depID, d.Number, d.Target)
		if sp.Unsupported != nil {
			continue
		}
		if err := checkContainers(d.ServiceId, sp, stateDir); err != nil {
			return nil, err
		}
	}
	return plan, nil
}

func (p *Plan) ServicePlanFor(svcID, deploymentID string, number int, spec protocol.ContainerSpec) *ServicePlan {
	g := p.Generation
	svc := g.Services[svcID]
	wanted := svc.DesiredState == protocol.DesiredStateRunning
	sp := &ServicePlan{
		ID:           svcID,
		EnvID:        svc.EnvironmentId,
		NetworkName:  p.Networks[svc.EnvironmentId].Name,
		DeploymentID: deploymentID,
		Run:          wanted && !runsOnly(svc.Kind),
		Health:       spec.Health,
		Ports:        spec.Ports,
		Kind:         svc.Kind,
		Wanted:       wanted,
		Spec:         spec,
		Mounts:       p.mounts(spec),
	}
	sp.Unsupported = unsupported(spec)
	if sp.Unsupported != nil {
		sp.Run = false
		return sp
	}
	if runsOnly(svc.Kind) {
		sp.Service = p.RunSpec(sp, deploymentID, "run_00000000000000000000000000", spec, commandOf(spec))
		sp.Hash = sp.Service.Hash
		return sp
	}
	cur := protocol.DesiredServiceCurrent{DeploymentId: deploymentID, Number: number, Spec: spec}
	sp.Coupler = docker.Coupler(g.StationId, svc.EnvironmentId, svcID, deploymentID, p.couplerImage, sp.NetworkName)
	sp.Service = docker.Service(g.StationId, svc.EnvironmentId, svcID, cur, sp.Mounts)
	sp.Hash = sp.Coupler.Hash + sp.Service.Hash
	return sp
}

func commandOf(spec protocol.ContainerSpec) []string {
	if spec.Command == nil {
		return nil
	}
	return *spec.Command
}

func (p *Plan) mounts(spec protocol.ContainerSpec) []mount.Mount {
	var out []mount.Mount
	for _, v := range spec.Volumes {
		if vol, ok := p.Generation.Volumes[v.VolumeId]; ok {
			out = append(out, docker.VolumeMount(vol.DockerName, v.MountPath))
		}
	}
	return out
}

func (p *Plan) RunSpec(sp *ServicePlan, deploymentID, runID string, spec protocol.ContainerSpec, cmd []string) docker.ContainerSpec {
	return docker.Run(p.Generation.StationId, sp.EnvID, sp.ID, deploymentID, runID, spec, cmd, p.mounts(spec))
}

func (p *Plan) RunCoupler(sp *ServicePlan, deploymentID, runID string) docker.ContainerSpec {
	return docker.RunCoupler(p.Generation.StationId, sp.EnvID, sp.ID, deploymentID, runID, p.couplerImage, sp.NetworkName)
}

func checkContainers(svcID string, sp *ServicePlan, stateDir string) *Rejection {
	specs := []docker.ContainerSpec{sp.Coupler, sp.Service}
	if runsOnly(sp.Kind) {
		specs = specs[1:]
	}
	for _, c := range specs {
		if err := docker.CheckInvariants(c, stateDir); err != nil {
			var v *docker.Violation
			errors.As(err, &v)
			return &Rejection{Body: protocol.ErrorBody{
				Code:        string(protocol.ErrorCodeStationInvariantViolation),
				Explanation: fmt.Sprintf("service %s, container %s breaks the invariant %q: %s", svcID, v.Container, v.Rule, v.Detail),
				Fix:         "Remove the setting from the service; stationd refuses it on every station.",
				Details:     protocol.ErrorBodyDetails{"service_id": svcID, "container": v.Container, "rule": v.Rule},
			}}
		}
	}
	return nil
}

func unsupported(spec protocol.ContainerSpec) *protocol.ErrorBody {
	if spec.Health != nil && spec.Health.Type == "image" {
		return &protocol.ErrorBody{
			Code:        string(protocol.ErrorCodeStationCapabilityMissing),
			Explanation: "health checks of type image are not supported by this stationd yet",
			Fix:         "Run this service on a stationd build that includes the capability.",
		}
	}
	return nil
}

func checkGeneration(g *protocol.Generation, applied *protocol.Generation) *Rejection {
	invalid := func(format string, args ...any) *Rejection {
		return reject(protocol.ErrorCodeGenerationInvalid, "Fix the generation and send it again.", format, args...)
	}
	if applied != nil {
		if g.StationId != applied.StationId || g.InstanceId != applied.InstanceId {
			return invalid("generation is for station %s of instance %s, this station is %s of %s", g.StationId, g.InstanceId, applied.StationId, applied.InstanceId)
		}
		if g.Number < applied.Number || (g.Number == applied.Number && g.Hash != applied.Hash) {
			return reject(protocol.ErrorCodeGenerationStale, "Send a generation numbered above the applied one.", "generation %d is not newer than applied generation %d", g.Number, applied.Number)
		}
	}
	pin, ok := g.Components["coupler_image"]
	if !ok || pin.Digest == nil {
		return invalid("components.coupler_image with a digest is required")
	}
	pool, err := netip.ParsePrefix(g.Station.Settings.IpamPool)
	if err != nil {
		return invalid("ipam.pool %q: %v", g.Station.Settings.IpamPool, err)
	}
	virtualPrefix, err := netip.ParsePrefix(g.Station.Settings.IpamVirtualPrefix)
	if err != nil {
		return invalid("ipam.virtual_prefix %q: %v", g.Station.Settings.IpamVirtualPrefix, err)
	}
	reserved := map[string]string{
		"system network":  g.Station.Networks.System.Subnet,
		"ingress network": g.Station.Networks.Ingress.Subnet,
		"registry subnet": g.Station.Registry.Subnet,
	}
	taken := map[string]netip.Prefix{}
	for name, s := range reserved {
		p, err := netip.ParsePrefix(s)
		if err != nil {
			return invalid("%s %q: %v", name, s, err)
		}
		taken[name] = p
	}
	bridges := map[string]string{}
	for envID, env := range g.Environments {
		subnet, err := netip.ParsePrefix(env.Network.Subnet)
		if err != nil {
			return invalid("environment %s subnet %q: %v", envID, env.Network.Subnet, err)
		}
		gateway, err := netip.ParseAddr(env.Network.Gateway)
		if err != nil || !subnet.Contains(gateway) {
			return invalid("environment %s gateway %q is not an address inside %s", envID, env.Network.Gateway, subnet)
		}
		if !pool.Contains(subnet.Addr()) || subnet.Bits() < pool.Bits() {
			return invalid("environment %s subnet %s lies outside ipam.pool %s", envID, subnet, pool)
		}
		for name, p := range taken {
			if p.Overlaps(subnet) {
				return invalid("environment %s subnet %s overlaps %s %s", envID, subnet, name, p)
			}
		}
		taken["environment "+envID] = subnet
		if env.Network.BridgeName == "" || len(env.Network.BridgeName) > protocol.InterfaceNameMaxLength {
			return invalid("environment %s bridge_name %q must be 1 to %d characters", envID, env.Network.BridgeName, protocol.InterfaceNameMaxLength)
		}
		if other, ok := bridges[env.Network.BridgeName]; ok {
			return invalid("environments %s and %s share bridge_name %s", other, envID, env.Network.BridgeName)
		}
		bridges[env.Network.BridgeName] = envID
	}
	if r := checkSandboxes(g, pool, taken, sandboxHeld); r != nil {
		return r
	}
	vipHolders := map[string]string{}
	for _, envID := range slices.Sorted(maps.Keys(g.Environments)) {
		for _, v := range g.Environments[envID].VirtualIps {
			holder := "environment " + envID + " service " + v.ServiceId
			if other, ok := vipHolders[v.Address]; ok {
				return invalid("virtual_ip %s is held by %s and by %s; a virtual IP is unique across the instance, because the host namespace translates the Gateway's flows by virtual IP alone", v.Address, other, holder)
			}
			vipHolders[v.Address] = holder
		}
	}
	for _, name := range slices.Sorted(maps.Keys(g.SystemTargets)) {
		st := g.SystemTargets[name]
		if name != systemDispatch || st.Component != systemDispatch {
			return invalid("system target %s names component %q; the only system target is %s", name, st.Component, systemDispatch)
		}
		if !g.Station.HostsDispatch {
			return invalid("system target %s is on a station whose hosts_dispatch is false", name)
		}
		if st.Port != protocol.NetworkDispatchPort {
			return invalid("system target %s port %d is not Dispatch's port %d", name, st.Port, protocol.NetworkDispatchPort)
		}
		vip, err := netip.ParseAddr(st.VirtualIp)
		if err != nil || !vip.Is4() || !virtualPrefix.Contains(vip) {
			return invalid("system target %s virtual_ip %q lies outside ipam.virtual_prefix %s", name, st.VirtualIp, virtualPrefix)
		}
		if other, ok := vipHolders[st.VirtualIp]; ok {
			return invalid("virtual_ip %s is held by %s and by system target %s; a virtual IP is unique across the instance", st.VirtualIp, other, name)
		}
		vipHolders[st.VirtualIp] = "system target " + name
	}
	for svcID, svc := range g.Services {
		if _, ok := g.Environments[svc.EnvironmentId]; !ok {
			return invalid("service %s names environment %s, which the generation does not contain", svcID, svc.EnvironmentId)
		}
		vip, err := netip.ParseAddr(svc.VirtualIp)
		if err != nil || !virtualPrefix.Contains(vip) {
			return invalid("service %s virtual_ip %q lies outside ipam.virtual_prefix %s", svcID, svc.VirtualIp, virtualPrefix)
		}
		if svc.Current == nil {
			continue
		}
		for _, e := range svc.Current.Spec.Env {
			if !e.Platform && e.Value != nil {
				return invalid("service %s variable %s carries a literal value but is not a platform entry", svcID, e.Key)
			}
		}
	}
	uncancelled := 0
	perService := map[string][]string{}
	for depID, d := range g.Deployments {
		if _, ok := g.Services[d.ServiceId]; !ok {
			return invalid("deployment %s names service %s, which the generation does not contain", depID, d.ServiceId)
		}
		for _, e := range d.Target.Env {
			if !e.Platform && e.Value != nil {
				return invalid("deployment %s variable %s carries a literal value but is not a platform entry", depID, e.Key)
			}
		}
		if d.Supersedes != nil {
			old, ok := g.Deployments[*d.Supersedes]
			if ok && (old.ServiceId != d.ServiceId || old.Cancel == nil) {
				return invalid("deployment %s supersedes %s, which must be a cancelled deployment of the same service", depID, *d.Supersedes)
			}
		}
		if d.Cancel == nil {
			uncancelled++
			perService[d.ServiceId] = append(perService[d.ServiceId], depID)
		}
	}
	if r := checkVolumes(g); r != nil {
		return r
	}
	if r := checkGateway(g); r != nil {
		return r
	}
	if uncancelled > g.Station.ConcurrencyCap {
		return invalid("%d deployments without cancel exceed concurrency_cap %d", uncancelled, g.Station.ConcurrencyCap)
	}
	for svcID, ids := range perService {
		if len(ids) > 1 {
			sort.Strings(ids)
			return invalid("service %s has %d deployments without cancel (%v); at most one is allowed besides a supersedes pair", svcID, len(ids), ids)
		}
	}
	return nil
}

func checkVolumes(g *protocol.Generation) *Rejection {
	invalid := func(format string, args ...any) *Rejection {
		return reject(protocol.ErrorCodeGenerationInvalid, "Fix the generation and send it again.", format, args...)
	}
	names := map[string]string{}
	for volID, v := range g.Volumes {
		if !dockerNamePattern.MatchString(v.DockerName) {
			return invalid("volume %s docker_name %q is not a valid Docker volume name", volID, v.DockerName)
		}
		if other, ok := names[v.DockerName]; ok {
			return invalid("volumes %s and %s share docker_name %s", other, volID, v.DockerName)
		}
		names[v.DockerName] = volID
		switch {
		case v.Owner == protocol.VolumeOwnerStation && v.ServiceId != nil:
			return invalid("station-owned volume %s names service %s", volID, *v.ServiceId)
		case v.Owner == protocol.VolumeOwnerService && v.Status == protocol.DesiredVolumeStatusActive && v.ServiceId == nil:
			return invalid("service-owned volume %s is active but names no service", volID)
		case v.Status == protocol.DesiredVolumeStatusRetained && v.ServiceId != nil:
			return invalid("retained volume %s still names service %s; a retained volume has no service until it is adopted", volID, *v.ServiceId)
		}
		if v.ServiceId != nil {
			if _, ok := g.Services[*v.ServiceId]; !ok {
				return invalid("volume %s names service %s, which the generation does not contain", volID, *v.ServiceId)
			}
		}
	}
	check := func(owner, svcID string, kind protocol.ServiceKind, spec protocol.ContainerSpec) *Rejection {
		paths := map[string]bool{}
		for _, m := range spec.Volumes {
			v, ok := g.Volumes[m.VolumeId]
			if !ok {
				return invalid("%s mounts volume %s, which the generation does not contain", owner, m.VolumeId)
			}
			if v.Status != protocol.DesiredVolumeStatusActive {
				return invalid("%s mounts volume %s with status %s; only active volumes are mounted", owner, m.VolumeId, v.Status)
			}
			if v.Owner == protocol.VolumeOwnerService && *v.ServiceId != svcID {
				return invalid("%s mounts volume %s, which belongs to service %s", owner, m.VolumeId, *v.ServiceId)
			}
			if !path.IsAbs(m.MountPath) || path.Clean(m.MountPath) == "/" {
				return invalid("%s mounts volume %s at %q; mount_path must be an absolute path below /", owner, m.VolumeId, m.MountPath)
			}
			if paths[path.Clean(m.MountPath)] {
				return invalid("%s mounts two volumes at %s", owner, m.MountPath)
			}
			paths[path.Clean(m.MountPath)] = true
		}
		if kind == protocol.ServiceKindCron {
			if spec.Schedule == nil {
				return invalid("%s is a cron service without a schedule", owner)
			}
			if _, err := parseSchedule(*spec.Schedule); err != nil {
				return invalid("%s schedule: %v", owner, err)
			}
		}
		return nil
	}
	for svcID, svc := range g.Services {
		if svc.Current == nil {
			continue
		}
		if r := check("service "+svcID, svcID, svc.Kind, svc.Current.Spec); r != nil {
			return r
		}
	}
	for depID, d := range g.Deployments {
		if r := check("deployment "+depID, d.ServiceId, g.Services[d.ServiceId].Kind, d.Target); r != nil {
			return r
		}
	}
	return nil
}
