package docker

import (
	"net/netip"
	"strconv"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"

	"github.com/harshjv/stationly/go/internal/protocol"
)

const (
	RoleDispatch      = "dispatch"
	RoleDispatchCheck = "dispatch-check"
	RoleDispatchData  = "dispatch-data"

	DispatchName       = protocol.ResourcePrefix + "dispatch"
	DispatchCheckName  = protocol.ResourcePrefix + "dispatch-check"
	DispatchVolume     = protocol.ResourcePrefix + "dispatch-data"
	DispatchDataTarget = "/data"
	DispatchDatabase   = "/data/dispatch.sqlite"

	dispatchMemoryBytes = 1 << 30
	dispatchNanoCPUs    = 2_000_000_000
	dispatchStopS       = 10
)

func dispatchHost(networkMode container.NetworkMode) *container.HostConfig {
	hc := baseHost(networkMode, dispatchMemoryBytes, dispatchNanoCPUs)
	hc.ReadonlyRootfs = true
	hc.Tmpfs = map[string]string{"/tmp": "size=64m,mode=1777"}
	return hc
}

func DispatchContainer(stationID, image string, addr netip.Addr, env []string, replicated bool) ContainerSpec {
	hc := dispatchHost(container.NetworkMode(SystemNetworkName))
	port := network.MustParsePort(strconv.Itoa(protocol.NetworkDispatchPort) + "/tcp")
	hc.PortBindings = network.PortMap{port: []network.PortBinding{{HostIP: netip.MustParseAddr(protocol.NetworkDispatchHostAddress), HostPort: strconv.Itoa(protocol.NetworkDispatchPort)}}}
	hc.Mounts = []mount.Mount{namedVolume(DispatchVolume, DispatchDataTarget, false)}
	stop := dispatchStopS
	spec := ContainerSpec{
		Name: DispatchName,
		Role: RoleDispatch,
		Create: client.ContainerCreateOptions{
			Name: DispatchName,
			Config: &container.Config{
				Image:        image,
				ExposedPorts: network.PortSet{port: struct{}{}},
				StopTimeout:  &stop,
				Labels:       platformLabels(stationID, RoleDispatch, ""),
			},
			HostConfig: hc,
			NetworkingConfig: &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{
				SystemNetworkName: {IPAMConfig: &network.EndpointIPAMConfig{IPv4Address: addr}},
			}},
		},
	}
	spec.Create.Config.Labels[LabelComponent] = "dispatch"
	if replicated {
		spec.Create.Config.Labels[LabelReplicated] = "true"
	}
	spec = sealed(spec)
	spec.Create.Config.Env = env
	return spec
}

func DispatchCheck(stationID, image string, args []string) ContainerSpec {
	hc := dispatchHost("none")
	hc.Mounts = []mount.Mount{namedVolume(DispatchVolume, DispatchDataTarget, false)}
	spec := ContainerSpec{
		Name: DispatchCheckName,
		Role: RoleDispatchCheck,
		Create: client.ContainerCreateOptions{
			Name:       DispatchCheckName,
			Config:     &container.Config{Image: image, Cmd: args, Env: []string{"STATIONLY_DATABASE=" + DispatchDatabase}, Labels: platformLabels(stationID, RoleDispatchCheck, "")},
			HostConfig: hc,
		},
	}
	return sealed(spec)
}

const (
	RoleLitestream     = "litestream"
	RoleLitestreamTask = "litestream-task"

	LitestreamName        = protocol.ResourcePrefix + "litestream"
	LitestreamTaskName    = protocol.ResourcePrefix + "litestream-task"
	LitestreamConfigHash  = "STATIONLY_LITESTREAM_CONFIG_SHA256"
	LabelReplicated       = "stationly.replicated"
	DispatchUser          = "1000:1000"
	litestreamMemoryBytes = 256 << 20
	litestreamNanoCPUs    = 500_000_000
	litestreamStopS       = 30
)

type LitestreamFiles struct {
	ConfigHost, ConfigTarget string
}

func litestreamHost(networkMode container.NetworkMode, f LitestreamFiles) *container.HostConfig {
	hc := baseHost(networkMode, litestreamMemoryBytes, litestreamNanoCPUs)
	hc.ReadonlyRootfs = true
	hc.Tmpfs = map[string]string{"/tmp": "size=64m,mode=1777"}
	hc.Mounts = []mount.Mount{namedVolume(DispatchVolume, DispatchDataTarget, false), bindRO(f.ConfigHost, f.ConfigTarget)}
	return hc
}

func litestreamSpec(name, role, stationID, image string, cmd []string, addr netip.Addr, f LitestreamFiles, env []string) ContainerSpec {
	stop := litestreamStopS
	create := client.ContainerCreateOptions{
		Name: name,
		Config: &container.Config{
			Image:       image,
			User:        DispatchUser,
			Cmd:         cmd,
			Env:         env,
			StopTimeout: &stop,
			Labels:      platformLabels(stationID, role, ""),
		},
		HostConfig: litestreamHost(container.NetworkMode(SystemNetworkName), f),
	}
	if addr.IsValid() {
		create.NetworkingConfig = &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{
			SystemNetworkName: {IPAMConfig: &network.EndpointIPAMConfig{IPv4Address: addr}},
		}}
	}
	create.Config.Labels[LabelComponent] = "litestream"
	return sealed(ContainerSpec{Name: name, Role: role, Create: create})
}

func Litestream(stationID, image string, f LitestreamFiles, env []string) ContainerSpec {
	return litestreamSpec(LitestreamName, RoleLitestream, stationID, image, []string{"replicate", "-config", f.ConfigTarget}, netip.Addr{}, f, env)
}

func LitestreamTask(stationID, image string, f LitestreamFiles, env []string, subcommand string, flags []string, operands ...string) ContainerSpec {
	cmd := append(append([]string{subcommand}, flags...), "-config", f.ConfigTarget)
	return litestreamSpec(LitestreamTaskName, RoleLitestreamTask, stationID, image, append(cmd, operands...), netip.Addr{}, f, env)
}
