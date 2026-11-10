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
	LabelComponent = "stationly.component"

	RoleIngressNetwork = "ingress-network"
	RoleGatewayCoupler = "gateway-coupler"
	RoleGateway        = "gateway"

	IngressNetworkName = protocol.ResourcePrefix + "ingress"
	IngressBridgeName  = IngressNetworkName
	GatewayVolume      = protocol.ResourcePrefix + "gateway-data"

	gatewayMemoryBytes = 512 << 20
	gatewayGoMemLimit  = gatewayMemoryBytes / 4 * 3
	gatewayNanoCPUs    = 2_000_000_000
)

func IngressNetwork(stationID string, subnet, ipRange netip.Prefix, gateway netip.Addr) NetworkSpec {
	return bridgeNetwork(IngressNetworkName, IngressBridgeName, true, network.IPAMConfig{Subnet: subnet, IPRange: ipRange, Gateway: gateway}, platformLabels(stationID, RoleIngressNetwork, ""), nil)
}

func GatewayCouplerName(slot string) string {
	return protocol.ResourcePrefix + "gateway-coupler-" + slot
}

func GatewayName(slot string) string {
	return protocol.ResourcePrefix + "gateway-" + slot
}

func gatewayLabels(stationID, role string) map[string]string {
	l := platformLabels(stationID, role, "")
	l[LabelComponent] = "gateway"
	return l
}

func GatewayCoupler(stationID, slot, image string, addr netip.Addr) ContainerSpec {
	hc := couplerHost(container.NetworkMode(IngressNetworkName), routeLocalnet())
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
	SystemNetworkName = protocol.ResourcePrefix + "system"
	SystemBridgeName  = SystemNetworkName
)

func SystemNetwork(stationID string, subnet, ipRange netip.Prefix, gateway netip.Addr) NetworkSpec {
	return bridgeNetwork(SystemNetworkName, SystemBridgeName, false, network.IPAMConfig{Subnet: subnet, IPRange: ipRange, Gateway: gateway}, platformLabels(stationID, RoleSystemNetwork, ""), nil)
}
