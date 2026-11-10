//go:build linux

package deploy

import (
	"context"
	"fmt"
	"log/slog"
	"net/netip"

	"github.com/harshjv/stationly/go/internal/cidr"
	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/protocol"
)

type systemNet struct {
	id       string
	subnet   netip.Prefix
	gateway  netip.Addr
	hostAddr netip.AddrPort
	failure  string
}

func (s *Station) systemLayout() (netip.Prefix, netip.AddrPort, error) {
	subnetText := ""
	if s.opts.Install != nil {
		subnetText = s.opts.Install.SystemSubnet
	} else if s.plan != nil {
		subnetText = s.plan.Generation.Station.Networks.System.Subnet
	}
	subnet, err := netip.ParsePrefix(subnetText)
	if err != nil {
		return netip.Prefix{}, netip.AddrPort{}, fmt.Errorf("no system subnet known yet (install.json or a generation): %w", err)
	}
	host := netip.AddrPortFrom(cidr.Offset(subnet, protocol.NetworkGatewayHost), resolverPort)
	if s.opts.Host != nil && s.opts.Host.Stationd.ResolverHostAddress != "" {
		ap, err := netip.ParseAddrPort(s.opts.Host.Stationd.ResolverHostAddress)
		if err != nil {
			return netip.Prefix{}, netip.AddrPort{}, fmt.Errorf("stationd.resolver_host_address in host.toml: %w", err)
		}
		host = ap
	}
	return subnet, host, nil
}

func (s *Station) ensureSystemNetwork(ctx context.Context) {
	subnet, hostAddr, err := s.systemLayout()
	if err != nil {
		s.system.failure = err.Error()
		return
	}
	id, gateway, err := ensureSystemNetwork(ctx, s.docker, s.log, s.opts.Identity.StationID, subnet)
	if err != nil {
		s.system.failure = err.Error()
		s.log.Error("system network", "error", err)
		return
	}
	s.system = systemNet{id: id, subnet: subnet, gateway: gateway, hostAddr: hostAddr}
	if hostAddr.Port() != resolverPort {
		s.system.failure = fmt.Sprintf("stationd.resolver_host_address %s must use port 53, the port every resolver listener shares", hostAddr)
		return
	}
	s.allowHostSources()
	s.log.Info("resolver host listener", "address", hostAddr, "zone", "public names only; .internal refused", "sources", subnet.String()+" and the host's own addresses")
}

func ensureSystemNetwork(ctx context.Context, dc *docker.Client, log *slog.Logger, stationID string, subnet netip.Prefix) (string, netip.Addr, error) {
	gateway := cidr.Offset(subnet, protocol.NetworkGatewayHost)
	spec := docker.SystemNetwork(stationID, subnet, cidr.UpperHalf(subnet), gateway)
	id, created, err := dc.EnsureFixedNetwork(ctx, spec)
	if err != nil {
		return "", gateway, err
	}
	if created {
		log.Info("created system network", "name", spec.Name, "bridge", docker.SystemBridgeName, "id", shortID(id), "subnet", subnet, "gateway", gateway, "station", stationID)
	}
	return id, gateway, nil
}

func (s *Station) allowHostSources() {
	if s.system.id == "" || s.system.failure != "" {
		return
	}
	from := []netip.Prefix{s.system.subnet}
	for _, a := range s.hostAddrs {
		from = append(from, netip.PrefixFrom(a, a.BitLen()))
	}
	s.resolver.SetHost(s.system.hostAddr.Addr(), from)
}
