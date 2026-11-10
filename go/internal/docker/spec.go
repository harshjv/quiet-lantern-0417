package docker

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"maps"
	"net/netip"
	"slices"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"

	"github.com/harshjv/stationly/go/internal/protocol"
)

const (
	couplerMemoryBytes = 32 << 20
	couplerNanoCPUs    = 100_000_000
	CouplerGwPriority  = 100
)

var AppCapabilities = []string{
	"CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL", "SETGID", "SETUID",
	"SETPCAP", "NET_BIND_SERVICE", "SYS_CHROOT", "SETFCAP", "AUDIT_WRITE",
}

var logConfig = container.LogConfig{
	Type:   "local",
	Config: map[string]string{"max-size": "20m", "max-file": "5"},
}

type NetworkSpec struct {
	Name    string
	Hash    string
	Options client.NetworkCreateOptions
}

type ContainerSpec struct {
	Name    string
	Role    string
	Hash    string
	Create  client.ContainerCreateOptions
	Coupler string
}

func CouplerName(deploymentID string) string {
	return protocol.ResourcePrefix + "coupler-" + deploymentID
}

func ServiceName(deploymentID string) string {
	return protocol.ResourcePrefix + "service-" + deploymentID
}

func EnvironmentNetwork(stationID, envID string, n protocol.EnvironmentNetwork) (NetworkSpec, error) {
	ipam, err := parseIPAM(n.Subnet, n.Gateway)
	if err != nil {
		return NetworkSpec{}, fmt.Errorf("environment %s %w", envID, err)
	}
	labels := map[string]string{LabelStation: stationID, LabelRole: RoleNetwork, LabelEnvironment: envID}
	return bridgeNetwork(n.BridgeName, n.BridgeName, true, ipam, labels, map[string]string{
		"com.docker.network.bridge.gateway_mode_ipv4": string(n.GatewayMode),
	}), nil
}

func Coupler(stationID, envID, serviceID, deploymentID, image, networkName string) ContainerSpec {
	labels := ownership(stationID, RoleCoupler, envID, serviceID, deploymentID)
	sysctls := routeLocalnet()
	maps.Copy(sysctls, ConntrackSysctls)
	return sealedWithoutImage(couplerSpec(CouplerName(deploymentID), RoleCoupler, image, networkName, labels, sysctls))
}

func couplerHost(networkMode container.NetworkMode, sysctls map[string]string) *container.HostConfig {
	hc := baseHost(networkMode, couplerMemoryBytes, couplerNanoCPUs)
	hc.ReadonlyRootfs = true
	hc.Sysctls = sysctls
	return hc
}

func routeLocalnet() map[string]string {
	return map[string]string{"net.ipv4.conf.all.route_localnet": "1"}
}

func couplerSpec(name, role, image, networkName string, labels, sysctls map[string]string) ContainerSpec {
	return ContainerSpec{
		Name: name,
		Role: role,
		Create: client.ContainerCreateOptions{
			Name:       name,
			Config:     &container.Config{Image: image, Labels: labels},
			HostConfig: couplerHost(container.NetworkMode(networkName), sysctls),
			NetworkingConfig: &network.NetworkingConfig{
				EndpointsConfig: map[string]*network.EndpointSettings{
					networkName: {GwPriority: CouplerGwPriority},
				},
			},
		},
	}
}

func RunName(runID string) string {
	return protocol.ResourcePrefix + "run-" + runID
}

func Service(stationID, envID, serviceID string, current protocol.DesiredServiceCurrent, mounts []mount.Mount) ContainerSpec {
	labels := ownership(stationID, RoleService, envID, serviceID, current.DeploymentId)
	var cmd []string
	if current.Spec.Command != nil {
		cmd = *current.Spec.Command
	}
	return sealed(appContainer(ServiceName(current.DeploymentId), RoleService, CouplerName(current.DeploymentId), current.DeploymentId, labels, current.Spec, cmd, mounts))
}

func Run(stationID, envID, serviceID, deploymentID, runID string, spec protocol.ContainerSpec, cmd []string, mounts []mount.Mount) ContainerSpec {
	labels := ownership(stationID, RoleRun, envID, serviceID, deploymentID)
	labels[LabelRun] = runID
	return sealed(appContainer(RunName(runID), RoleRun, CouplerName(runID), deploymentID, labels, spec, cmd, mounts))
}

func RunCoupler(stationID, envID, serviceID, deploymentID, runID, image, networkName string) ContainerSpec {
	spec := Coupler(stationID, envID, serviceID, runID, image, networkName)
	labels := spec.Create.Config.Labels
	delete(labels, LabelHash)
	labels[LabelDeployment] = deploymentID
	labels[LabelRun] = runID
	return sealedWithoutImage(spec)
}

func appContainer(name, role, coupler, deploymentID string, labels map[string]string, s protocol.ContainerSpec, cmd []string, mounts []mount.Mount) ContainerSpec {
	var env []string
	files := false
	for _, e := range s.Env {
		switch {
		case e.Value != nil:
			env = append(env, e.Key+"="+*e.Value)
		case !e.Platform && e.Injection == protocol.InjectionFile:
			env = append(env, e.Key+"_FILE="+SecretsTarget+"/"+e.Key)
			files = true
		}
	}
	if files {
		mounts = append(slices.Clone(mounts), mount.Mount{Type: mount.TypeBind, Source: SecretsRoot + "/" + deploymentID, Target: SecretsTarget, ReadOnly: true})
	}
	if s.EnvDigest != "" {
		labels[LabelEnvDigest] = s.EnvDigest
	}
	hc := baseHost(container.NetworkMode("container:"+coupler), int64(s.Limits.MemoryBytes), int64(s.Limits.CpuMillis)*1_000_000)
	hc.CapAdd = AppCapabilities
	hc.ReadonlyRootfs = s.ReadonlyRootfs
	hc.Mounts = mounts
	return ContainerSpec{
		Name:    name,
		Role:    role,
		Coupler: coupler,
		Create: client.ContainerCreateOptions{
			Name:       name,
			Config:     &container.Config{Image: s.ImageRef, Cmd: cmd, Env: env, Labels: labels},
			HostConfig: hc,
		},
	}
}

func (s ContainerSpec) WithEnv(extra []string) ContainerSpec {
	if len(extra) == 0 {
		return s
	}
	cfg := *s.Create.Config
	cfg.Env = append(slices.Clone(cfg.Env), extra...)
	s.Create.Config = &cfg
	return s
}

func VolumeMount(dockerName, target string) mount.Mount {
	return mount.Mount{Type: mount.TypeVolume, Source: dockerName, Target: target}
}

func (s ContainerSpec) JoinedTo(couplerID string) client.ContainerCreateOptions {
	create := s.Create
	if s.Coupler == "" {
		return create
	}
	hc := *create.HostConfig
	hc.NetworkMode = container.NetworkMode("container:" + couplerID)
	create.HostConfig = &hc
	return create
}

func (s ContainerSpec) At(networkName string, addr netip.Addr) client.ContainerCreateOptions {
	create := s.Create
	endpoints := map[string]*network.EndpointSettings{}
	for name, ep := range create.NetworkingConfig.EndpointsConfig {
		copied := *ep
		if name == networkName {
			copied.IPAMConfig = &network.EndpointIPAMConfig{IPv4Address: addr}
		}
		endpoints[name] = &copied
	}
	create.NetworkingConfig = &network.NetworkingConfig{EndpointsConfig: endpoints}
	return create
}

func ownership(stationID, role, envID, serviceID, deploymentID string) map[string]string {
	return map[string]string{
		LabelStation:     stationID,
		LabelRole:        role,
		LabelEnvironment: envID,
		LabelService:     serviceID,
		LabelDeployment:  deploymentID,
	}
}

var ConntrackSysctls = map[string]string{
	"net.netfilter.nf_conntrack_acct":      "1",
	"net.netfilter.nf_conntrack_timestamp": "1",
	"net.netfilter.nf_conntrack_events":    "1",
}

func sealedWithoutImage(spec ContainerSpec) ContainerSpec {
	image, sysctls := spec.Create.Config.Image, spec.Create.HostConfig.Sysctls
	spec.Create.Config.Image = ""
	hashed := maps.Clone(sysctls)
	maps.DeleteFunc(hashed, func(k, _ string) bool { _, observability := ConntrackSysctls[k]; return observability })
	spec.Create.HostConfig.Sysctls = hashed
	spec.Hash = hashOf(spec.Create)
	spec.Create.HostConfig.Sysctls = sysctls
	spec.Create.Config.Image = image
	spec.Create.Config.Labels[LabelHash] = spec.Hash
	return spec
}

func sealed(spec ContainerSpec) ContainerSpec {
	spec.Hash = hashOf(spec.Create)
	spec.Create.Config.Labels[LabelHash] = spec.Hash
	return spec
}

func hashOf(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
