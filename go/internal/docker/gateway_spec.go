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
	LabelComponent = "stationly.component"

	RoleIngressNetwork = "ingress-network"
	RoleGatewayCoupler = "gateway-coupler"
	RoleGateway        = "gateway"

	IngressNetworkName = "stationly-ingress"
	IngressBridgeName  = "or-ingress"
	GatewayVolume      = "or-gateway-data"
	GatewaySource      = "docker.io/library/traefik"

	gatewayMemoryBytes = 512 << 20
	gatewayGoMemLimit  = gatewayMemoryBytes / 4 * 3
	gatewayNanoCPUs    = 2_000_000_000
)

func IngressNetwork(stationID string, subnet, ipRange netip.Prefix, gateway netip.Addr) NetworkSpec {
	ipv4, ipv6 := true, false
	spec := NetworkSpec{
		Name: IngressNetworkName,
		Options: client.NetworkCreateOptions{
			Driver:     "bridge",
			EnableIPv4: &ipv4,
			EnableIPv6: &ipv6,
			IPAM: &network.IPAM{
				Driver: "default",
				Config: []network.IPAMConfig{{Subnet: subnet, IPRange: ipRange, Gateway: gateway}},
			},
			Options: map[string]string{
				"com.docker.network.bridge.name":       IngressBridgeName,
				"com.docker.network.bridge.enable_icc": "true",
			},
			Labels: platformLabels(stationID, RoleIngressNetwork, ""),
		},
	}
	spec.Hash = hashOf(spec.Options)
	spec.Options.Labels[LabelHash] = spec.Hash
	return spec
}

func GatewayCouplerName(slot string) string {
	return "or-gateway-coupler-" + slot
}

func GatewayName(slot string) string {
	return "or-gateway-" + slot
}

func gatewayLabels(stationID, role string) map[string]string {
	l := platformLabels(stationID, role, "")
	l[LabelComponent] = "gateway"
	return l
}

func GatewayCoupler(stationID, slot, image string, addr netip.Addr) ContainerSpec {
	hc := baseHost(container.NetworkMode(IngressNetworkName), couplerMemoryBytes, couplerNanoCPUs)
	hc.ReadonlyRootfs = true
	hc.Sysctls = map[string]string{"net.ipv4.conf.all.route_localnet": "1"}
	name := GatewayCouplerName(slot)
	spec := ContainerSpec{
		Name: name,
		Role: RoleGatewayCoupler,
		Create: client.ContainerCreateOptions{
			Name:       name,
			Config:     &container.Config{Image: image, Labels: gatewayLabels(stationID, RoleGatewayCoupler)},
			HostConfig: hc,
			NetworkingConfig: &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{
				IngressNetworkName: {IPAMConfig: &network.EndpointIPAMConfig{IPv4Address: addr}},
			}},
		},
	}
	return sealed(spec)
}

type GatewayFiles struct {
	Static, StaticTarget, Dynamic, DynamicTarget, DataTarget string
}

func Gateway(stationID, slot, image string, f GatewayFiles) ContainerSpec {
	coupler := GatewayCouplerName(slot)
	hc := baseHost(container.NetworkMode("container:"+coupler), gatewayMemoryBytes, gatewayNanoCPUs)
	hc.CapAdd = []string{"NET_BIND_SERVICE"}
	hc.ReadonlyRootfs = true
	hc.Mounts = []mount.Mount{
		bindRO(f.Static, f.StaticTarget),
		bindRO(f.Dynamic, f.DynamicTarget),
		namedVolume(GatewayVolume, f.DataTarget, false),
	}
	hc.Tmpfs = map[string]string{"/tmp": "size=16m,mode=1777"}
	name := GatewayName(slot)
	spec := ContainerSpec{
		Name:    name,
		Role:    RoleGateway,
		Coupler: coupler,
		Create: client.ContainerCreateOptions{
			Name: name,
			Config: &container.Config{
				Image:  image,
				Cmd:    []string{"--configFile=" + f.StaticTarget},
				Env:    []string{"GOMEMLIMIT=" + strconv.Itoa(gatewayGoMemLimit)},
				Labels: gatewayLabels(stationID, RoleGateway),
			},
			HostConfig: hc,
		},
	}
	return sealed(spec)
}

const (
	RoleSystemNetwork = "system-network"
	SystemNetworkName = "stationly-system"
	SystemBridgeName  = "or-system"
)

func SystemNetwork(stationID string, subnet, ipRange netip.Prefix, gateway netip.Addr) NetworkSpec {
	ipv4, ipv6 := true, false
	spec := NetworkSpec{
		Name: SystemNetworkName,
		Options: client.NetworkCreateOptions{
			Driver:     "bridge",
			EnableIPv4: &ipv4,
			EnableIPv6: &ipv6,
			IPAM: &network.IPAM{
				Driver: "default",
				Config: []network.IPAMConfig{{Subnet: subnet, IPRange: ipRange, Gateway: gateway}},
			},
			Options: map[string]string{
				"com.docker.network.bridge.name":       SystemBridgeName,
				"com.docker.network.bridge.enable_icc": "false",
			},
			Labels: platformLabels(stationID, RoleSystemNetwork, ""),
		},
	}
	spec.Hash = hashOf(spec.Options)
	spec.Options.Labels[LabelHash] = spec.Hash
	return spec
}
