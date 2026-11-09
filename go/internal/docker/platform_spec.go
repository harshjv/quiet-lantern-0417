package docker

import (
	"net/netip"
	"strconv"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"
)

const (
	LabelProject = "stationly.project"

	RoleDepotNetwork    = "depot-network"
	RoleDepot           = "depot"
	RoleDepotGC         = "depot-gc"
	RoleWorkshopCoupler = "workshop-coupler"
	RoleWorkshop        = "workshop"
	RolePrepare         = "railpack-prepare"

	DepotNetworkName = "stationly-depot"
	DepotBridgeName  = "or-depot"
	DepotName        = "or-depot"
	DepotGCName      = "or-depot-gc"
	DepotVolume      = "or-depot-data"

	WorkshopAppArmorProfile = "stationly-workshop"
	WorkshopSocketDir       = "/run/buildkit"
	WorkshopSocket          = "unix:///run/buildkit/buildkitd.sock"
	WorkshopConfigPath      = "/etc/buildkit/buildkitd.toml"
	workshopHome            = "/home/user"
	workshopCache           = "/home/user/.local/share/buildkit"
	workshopRuntimeDir      = "/run/user/1000"

	depotImageVolume = "/var/lib/registry"
	depotMemoryBytes = 512 << 20
	depotNanoCPUs    = 1_000_000_000
	prepareMemory    = 1 << 30
	prepareNanoCPUs  = 1_000_000_000
)

func platformLabels(stationID, role, projectID string) map[string]string {
	l := map[string]string{LabelStation: stationID, LabelRole: role}
	if projectID != "" {
		l[LabelProject] = projectID
	}
	return l
}

func baseHost(network container.NetworkMode, memory, nanoCPUs int64) *container.HostConfig {
	return &container.HostConfig{
		NetworkMode:   network,
		CapDrop:       []string{"ALL"},
		SecurityOpt:   []string{"no-new-privileges"},
		RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyDisabled},
		LogConfig:     logConfig,
		Resources:     container.Resources{Memory: memory, MemorySwap: memory, NanoCPUs: nanoCPUs},
	}
}

func DepotNetwork(stationID string, subnet, ipRange netip.Prefix, gateway netip.Addr) NetworkSpec {
	ipv4, ipv6 := true, false
	spec := NetworkSpec{
		Name: DepotNetworkName,
		Options: client.NetworkCreateOptions{
			Driver:     "bridge",
			EnableIPv4: &ipv4,
			EnableIPv6: &ipv6,
			IPAM: &network.IPAM{
				Driver: "default",
				Config: []network.IPAMConfig{{Subnet: subnet, IPRange: ipRange, Gateway: gateway}},
			},
			Options: map[string]string{
				"com.docker.network.bridge.name":       DepotBridgeName,
				"com.docker.network.bridge.enable_icc": "true",
			},
			Labels: platformLabels(stationID, RoleDepotNetwork, ""),
		},
	}
	spec.Hash = hashOf(spec.Options)
	spec.Options.Labels[LabelHash] = spec.Hash
	return spec
}

func bindRO(src, dst string) mount.Mount {
	return mount.Mount{Type: mount.TypeBind, Source: src, Target: dst, ReadOnly: true}
}

func namedVolume(name, dst string, noCopy bool) mount.Mount {
	m := mount.Mount{Type: mount.TypeVolume, Source: name, Target: dst}
	if noCopy {
		m.VolumeOptions = &mount.VolumeOptions{NoCopy: true}
	}
	return m
}

type DepotFiles struct {
	ConfigHost, ConfigTarget string
	JWKSHost, JWKSTarget     string
	StorageTarget            string
}

func Depot(stationID, image string, addr netip.Addr, f DepotFiles) ContainerSpec {
	hc := baseHost(container.NetworkMode(DepotNetworkName), depotMemoryBytes, depotNanoCPUs)
	hc.Mounts = []mount.Mount{
		namedVolume(DepotVolume, f.StorageTarget, false),
		bindRO(f.ConfigHost, f.ConfigTarget),
		bindRO(f.JWKSHost, f.JWKSTarget),
		{Type: mount.TypeTmpfs, Target: depotImageVolume, TmpfsOptions: &mount.TmpfsOptions{SizeBytes: 1 << 20}},
	}
	spec := ContainerSpec{
		Name: DepotName,
		Role: RoleDepot,
		Create: client.ContainerCreateOptions{
			Name:       DepotName,
			Config:     &container.Config{Image: image, Entrypoint: []string{"registry"}, Cmd: []string{"serve", f.ConfigTarget}, Labels: platformLabels(stationID, RoleDepot, "")},
			HostConfig: hc,
			NetworkingConfig: &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{
				DepotNetworkName: {IPAMConfig: &network.EndpointIPAMConfig{IPv4Address: addr}},
			}},
		},
	}
	return sealed(spec)
}

func DepotGC(stationID, image string, f DepotFiles) ContainerSpec {
	hc := baseHost("none", depotMemoryBytes, depotNanoCPUs)
	hc.Mounts = []mount.Mount{
		namedVolume(DepotVolume, f.StorageTarget, false),
		bindRO(f.ConfigHost, f.ConfigTarget),
		bindRO(f.JWKSHost, f.JWKSTarget),
		{Type: mount.TypeTmpfs, Target: depotImageVolume, TmpfsOptions: &mount.TmpfsOptions{SizeBytes: 1 << 20}},
	}
	spec := ContainerSpec{
		Name: DepotGCName,
		Role: RoleDepotGC,
		Create: client.ContainerCreateOptions{
			Name:       DepotGCName,
			Config:     &container.Config{Image: image, Entrypoint: []string{"registry"}, Cmd: []string{"garbage-collect", "--delete-untagged", f.ConfigTarget}, Labels: platformLabels(stationID, RoleDepotGC, "")},
			HostConfig: hc,
		},
	}
	return sealed(spec)
}

func WorkshopCouplerName(projectID string) string {
	return "or-workshop-coupler-" + projectID
}

func WorkshopName(projectID string) string {
	return "or-workshop-" + projectID
}

func WorkshopCoupler(stationID, projectID, image string) ContainerSpec {
	hc := baseHost(container.NetworkMode(DepotNetworkName), couplerMemoryBytes, couplerNanoCPUs)
	hc.ReadonlyRootfs = true
	hc.Sysctls = map[string]string{"net.ipv4.conf.all.route_localnet": "1"}
	name := WorkshopCouplerName(projectID)
	spec := ContainerSpec{
		Name: name,
		Role: RoleWorkshopCoupler,
		Create: client.ContainerCreateOptions{
			Name:             name,
			Config:           &container.Config{Image: image, Labels: platformLabels(stationID, RoleWorkshopCoupler, projectID)},
			HostConfig:       hc,
			NetworkingConfig: &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{DepotNetworkName: {}}},
		},
	}
	return sealed(spec)
}

type WorkshopFiles struct {
	Passwd, Group, Subuid, Subgid, Config string
}

type WorkshopVolumes struct {
	Home, Cache, Socket string
}

func Workshop(stationID, projectID, image string, uidBase int, files WorkshopFiles, vols WorkshopVolumes, apparmor bool, memory, nanoCPUs int64) ContainerSpec {
	coupler := WorkshopCouplerName(projectID)
	hc := baseHost(container.NetworkMode("container:"+coupler), memory, nanoCPUs)
	hc.CapAdd = []string{"SETUID", "SETGID"}
	hc.SecurityOpt = []string{"seccomp=unconfined"}
	hc.MaskedPaths = []string{}
	hc.ReadonlyPaths = []string{}
	if apparmor {
		hc.SecurityOpt = append(hc.SecurityOpt, "apparmor="+WorkshopAppArmorProfile)
	}
	hc.Mounts = []mount.Mount{
		bindRO(files.Passwd, "/etc/passwd"),
		bindRO(files.Group, "/etc/group"),
		bindRO(files.Subuid, "/etc/subuid"),
		bindRO(files.Subgid, "/etc/subgid"),
		bindRO(files.Config, WorkshopConfigPath),
		namedVolume(vols.Home, workshopHome, true),
		namedVolume(vols.Cache, workshopCache, true),
		namedVolume(vols.Socket, WorkshopSocketDir, true),
	}
	ids := itoa(uidBase)
	hc.Tmpfs = map[string]string{workshopRuntimeDir: "uid=" + ids + ",gid=" + ids + ",mode=0700"}
	name := WorkshopName(projectID)
	spec := ContainerSpec{
		Name:    name,
		Role:    RoleWorkshop,
		Coupler: coupler,
		Create: client.ContainerCreateOptions{
			Name: name,
			Config: &container.Config{
				Image:  image,
				User:   ids + ":" + ids,
				Cmd:    []string{"--addr", WorkshopSocket, "--config", WorkshopConfigPath},
				Labels: platformLabels(stationID, RoleWorkshop, projectID),
			},
			HostConfig: hc,
		},
	}
	return sealed(spec)
}

type PrepareVolumes struct {
	Context, Plan, Cache string
}

func Prepare(stationID, projectID, buildID, image string, args []string, vols PrepareVolumes) ContainerSpec {
	coupler := WorkshopCouplerName(projectID)
	hc := baseHost(container.NetworkMode("container:"+coupler), prepareMemory, prepareNanoCPUs)
	hc.Mounts = []mount.Mount{
		{Type: mount.TypeVolume, Source: vols.Context, Target: "/app", ReadOnly: true},
		namedVolume(vols.Plan, "/plan", false),
		namedVolume(vols.Cache, "/tmp/railpack", false),
	}
	name := "or-prepare-" + buildID
	labels := platformLabels(stationID, RolePrepare, projectID)
	spec := ContainerSpec{
		Name:    name,
		Role:    RolePrepare,
		Coupler: coupler,
		Create: client.ContainerCreateOptions{
			Name:       name,
			Config:     &container.Config{Image: image, Entrypoint: []string{"/railpack"}, Cmd: args, Labels: labels},
			HostConfig: hc,
		},
	}
	return sealed(spec)
}

func itoa(v int) string {
	return strconv.Itoa(v)
}
