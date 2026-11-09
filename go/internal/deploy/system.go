//go:build linux

package deploy

import (
	"context"
	"fmt"
	"net/netip"

	"github.com/harshjv/stationly/go/internal/docker"
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
		return netip.Prefix{}, netip.AddrPort{}, fmt.Errorf("no system subnet known yet (install.json or a generation): %v", err)
	}
	host := netip.AddrPortFrom(hostAt(subnet, 1), resolverPort)
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
	gateway := hostAt(subnet, 1)
	spec := docker.SystemNetwork(s.opts.Identity.StationID, subnet, upperHalf(subnet), gateway)
	id, labels, ok, err := s.docker.NetworkByName(ctx, spec.Name)
	switch {
	case err != nil:
		s.system.failure = "inspect " + spec.Name + ": " + err.Error()
		return
	case ok && labels[docker.LabelHash] != spec.Hash:
		s.system.failure = fmt.Sprintf("network %s exists with other settings; the system subnet is fixed at install", spec.Name)
		return
	case !ok:
		if id, err = s.docker.CreateNetwork(ctx, spec); err != nil {
			s.system.failure = "create " + spec.Name + ": " + err.Error()
			s.log.Error("create the system network", "error", err)
			return
		}
		s.log.Info("created system network", "name", spec.Name, "bridge", docker.SystemBridgeName, "id", shortID(id), "subnet", subnet, "gateway", gateway)
	}
	s.system = systemNet{id: id, subnet: subnet, gateway: gateway, hostAddr: hostAddr}
	if hostAddr.Port() != resolverPort {
		s.system.failure = fmt.Sprintf("stationd.resolver_host_address %s must use port 53, the port every resolver listener shares", hostAddr)
		return
	}
	s.allowHostSources()
	s.log.Info("resolver host listener", "address", hostAddr, "zone", "public names only; .internal refused", "sources", subnet.String()+" and the host's own addresses")
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
