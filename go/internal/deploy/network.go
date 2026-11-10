//go:build linux

package deploy

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"slices"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"

	"github.com/harshjv/stationly/go/internal/cidr"
	"github.com/harshjv/stationly/go/internal/dns"
	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/netns"
	"github.com/harshjv/stationly/go/internal/protocol"
	vipswitch "github.com/harshjv/stationly/go/internal/switch"
)

func namespaceFailure(format string, args ...any) *protocol.ErrorBody {
	return &protocol.ErrorBody{
		Code:        string(protocol.ErrorCodeNamespaceSetupFailed),
		Explanation: fmt.Sprintf(format, args...),
		Fix:         "Check the stationd log and the kernel's nftables support, then apply again.",
	}
}

func (s *Station) refreshHostAddrs() bool {
	addrs, err := netns.HostAddresses()
	if err != nil {
		s.log.Warn("list host addresses", "error", err)
		return false
	}
	if slices.Equal(addrs, s.hostAddrs) {
		return false
	}
	s.log.Info("host addresses changed", "count", len(addrs))
	s.hostAddrs = addrs
	return true
}

func (s *Station) hostPrefixes() []netip.Prefix {
	var out []netip.Prefix
	for _, a := range s.hostAddrs {
		out = append(out, netip.PrefixFrom(a, 32))
	}
	st := s.plan.Generation.Station
	for _, subnet := range []string{st.Networks.System.Subnet, st.Networks.Ingress.Subnet, st.Registry.Subnet} {
		if p, err := netip.ParsePrefix(subnet); err == nil {
			out = append(out, p)
		}
	}
	return out
}

type envNet struct {
	subnet  netip.Prefix
	gateway netip.Addr
	bridge  string
}

func (s *Station) envNet(envID string) envNet {
	env := s.plan.Generation.Environments[envID]
	subnet, _ := netip.ParsePrefix(env.Network.Subnet)
	gateway, _ := netip.ParseAddr(env.Network.Gateway)
	return envNet{subnet: subnet, gateway: gateway, bridge: env.Network.BridgeName}
}

func (s *Station) ensureResolver() {
	var zones []dns.Zone
	var addrs []netip.Addr
	ids := sortedKeys(s.plan.Generation.Environments)
	for _, envID := range ids {
		env := s.plan.Generation.Environments[envID]
		n := s.envNet(envID)
		z := dns.Zone{Subnet: n.subnet, Log: true}
		for _, rec := range env.Dns {
			vip, err := netip.ParseAddr(rec.VirtualIp)
			if err != nil {
				continue
			}
			z.Records = append(z.Records, dns.Record{Name: rec.Name, VIP: vip})
		}
		zones = append(zones, z)
		if st := s.envs[envID]; st != nil && st.failure == nil && st.networkID != "" {
			addrs = append(addrs, n.gateway)
		}
	}
	if n, ok := s.sandboxNet(); ok && (s.sbx.netID != "" || bridgeUp(docker.SandboxIface)) {
		zones = append(zones, dns.Zone{Subnet: n.subnet, Log: true})
		addrs = append(addrs, n.gateway)
	}
	if gp := s.plan.Gateway; gp.Run && s.gw.ingressID != "" {
		zones = append(zones, dns.Zone{Subnet: gp.Ingress})
		addrs = append(addrs, gp.Bridge)
	}
	if state, _ := s.depot.State(); state != protocol.RegistryStateDown {
		ds := s.depot.Settings()
		zones = append(zones, dns.Zone{Subnet: ds.Subnet})
		addrs = append(addrs, ds.Front.Addr())
	}
	if s.system.id != "" && s.system.failure == "" {
		addrs = append(addrs, s.system.hostAddr.Addr())
		s.allowHostSources()
	}
	s.resolver.SetZones(zones)
	failed := s.resolver.Listen(addrs)
	for _, envID := range ids {
		st := s.envs[envID]
		if st == nil || st.networkID == "" {
			continue
		}
		if err, ok := failed[s.envNet(envID).gateway]; ok {
			st.failure = namespaceFailure("resolver cannot listen on %s:53: %v", s.envNet(envID).gateway, err)
		}
	}
}

func (s *Station) allocate(ctx context.Context, envID string) (netip.Addr, error) {
	env := s.envs[envID]
	n := s.envNet(envID)
	used, err := s.docker.NetworkAddresses(ctx, env.networkID)
	if err != nil {
		return netip.Addr{}, err
	}
	taken := map[netip.Addr]bool{n.gateway: true}
	cursor := s.cursor[envID]
	for _, a := range used {
		taken[a] = true
		if !cursor.IsValid() || a.Compare(cursor) > 0 {
			cursor = a
		}
	}
	if !cursor.IsValid() {
		cursor = n.gateway
	}
	first := n.subnet.Masked().Addr()
	last := cidr.Last(n.subnet)
	a := cursor
	for range 1 << (32 - n.subnet.Bits()) {
		a = a.Next()
		if !n.subnet.Contains(a) || a == last {
			a = first
			continue
		}
		if a == first || taken[a] {
			continue
		}
		s.cursor[envID] = a
		return a, nil
	}
	return netip.Addr{}, fmt.Errorf("no free address in %s", n.subnet)
}

func (s *Station) startCoupler(ctx context.Context, sp *ServicePlan, st *serviceState) (string, *protocol.ErrorBody) {
	addr, err := s.allocate(ctx, sp.EnvID)
	if err != nil {
		return "", &protocol.ErrorBody{Code: string(protocol.ErrorCodeSubnetExhausted), Explanation: err.Error(), Fix: "Remove stopped services from the environment or give it a larger subnet."}
	}
	id, err := s.docker.CreateContainer(ctx, sp.Coupler.At(sp.NetworkName, addr))
	if err != nil {
		s.log.Error("create container", "name", sp.Coupler.Name, "error", err)
		return "", dockerFailure(protocol.ErrorCodeExitNonzero, "create "+sp.Coupler.Name, err)
	}
	if err := s.docker.Start(ctx, id); err != nil {
		s.remove(ctx, id)
		return "", dockerFailure(protocol.ErrorCodeExitNonzero, "start "+sp.Coupler.Name, err)
	}
	st.coupler = s.inspectID(ctx, id, sp.NetworkName)
	st.ownAddr = addr
	s.log.Info("started container", "name", sp.Coupler.Name, "id", shortID(id), "address", st.coupler.address)
	if failure := s.syncNamespace(ctx, sp, st); failure != nil {
		s.log.Error("baseline failed, removing Coupler", "service", sp.ID, "error", failure.Explanation)
		s.remove(ctx, id)
		st.coupler = view{}
		return "", failure
	}
	return id, nil
}

func (s *Station) realAddress(serviceID string) netip.Addr {
	st := s.services[serviceID]
	if st == nil || st.coupler.state != string(container.StateRunning) {
		return netip.Addr{}
	}
	return st.coupler.address
}

type nsTarget struct {
	name    string
	pid     int
	inode   uint64
	envID   string
	self    netip.Addr
	reach   []string
	sandbox string
}

func (s *Station) consumerFor(envID string, reach []string) vipswitch.Consumer {
	return vipswitch.For(reach, s.plan.Generation.Environments[envID].VirtualIps, s.switchTarget)
}

func (s *Station) nsBaseline(envID string, self netip.Addr) netns.Baseline {
	n := s.envNet(envID)
	return netns.Baseline{Resolver: n.gateway, Self: self, Subnet: n.subnet}
}

func (s *Station) writeNS(t nsTarget) (netns.Result, vipswitch.Consumer, error) {
	if t.sandbox != "" {
		return s.writeSandboxNS(t)
	}
	c := s.consumerFor(t.envID, t.reach)
	ns, err := netns.Open(t.pid)
	if err != nil {
		return netns.Unchanged, c, fmt.Errorf("open the namespace of %s: %w", t.name, err)
	}
	defer ns.Close()
	if t.inode != 0 && ns.Inode != t.inode {
		return netns.Unchanged, c, fmt.Errorf("the namespace of %s changed while stationd read it", t.name)
	}
	n := s.envNet(t.envID)
	result, err := ns.Sync(
		s.nsBaseline(t.envID, t.self),
		netns.Elements{HostAddrs: s.hostPrefixes(), Switch: c.Switch, Pending: c.Pending, Reject: c.Reject},
	)
	if err != nil {
		return result, c, fmt.Errorf("write table inet %s into %s: %w", netns.TableName, t.name, err)
	}
	if result != netns.Unchanged {
		s.log.Info("namespace ruleset synced", "coupler", t.name, "netns", ns.Inode, "result", result, "switch", switchText(c.Switch), "pending", len(c.Pending), "reject", len(c.Reject))
	}
	prefix, _ := netip.ParsePrefix(s.plan.Generation.Station.Settings.IpamVirtualPrefix)
	added, err := ns.EnsureRoute(prefix, n.gateway)
	if err != nil {
		return result, c, fmt.Errorf("install route %s via %s in %s: %w", prefix, n.gateway, t.name, err)
	}
	if added {
		s.log.Info("virtual prefix route installed", "coupler", t.name, "route", prefix.String()+" via "+n.gateway.String())
	}
	return result, c, nil
}

func (s *Station) assertEndpoints(ctx context.Context, sp *ServicePlan, st *serviceState) error {
	env := s.envs[sp.EnvID]
	changed := false
	for name, ep := range st.coupler.endpoints {
		if name != sp.NetworkName && ep.GwPriority >= docker.CouplerGwPriority {
			s.log.Warn("disconnecting a network that outranks the environment gateway", "coupler", sp.Coupler.Name, "network", name, "gw_priority", ep.GwPriority)
			if err := s.docker.Disconnect(ctx, ep.NetworkID, st.coupler.id); err != nil {
				return err
			}
			changed = true
		}
	}
	ep, ok := st.coupler.endpoints[sp.NetworkName]
	if !ok || ep.GwPriority != docker.CouplerGwPriority {
		addr := st.coupler.address
		if !addr.IsValid() {
			addr = st.ownAddr
		}
		if ok {
			if err := s.docker.Disconnect(ctx, env.networkID, st.coupler.id); err != nil {
				return err
			}
		}
		settings := &network.EndpointSettings{GwPriority: docker.CouplerGwPriority, MacAddress: st.ownMAC}
		if addr.IsValid() {
			settings.IPAMConfig = &network.EndpointIPAMConfig{IPv4Address: addr}
		}
		s.log.Warn("reconnecting the Coupler to its environment network", "coupler", sp.Coupler.Name, "address", addr, "mac", st.ownMAC.String(), "gw_priority", docker.CouplerGwPriority)
		if err := s.docker.Connect(ctx, env.networkID, st.coupler.id, settings); err != nil {
			return err
		}
		changed = true
	}
	if changed {
		st.coupler = s.inspectID(ctx, st.coupler.id, sp.NetworkName)
	}
	return nil
}

func (s *Station) syncNamespace(ctx context.Context, sp *ServicePlan, st *serviceState) *protocol.ErrorBody {
	if st.coupler.pid <= 0 {
		st.nsFailure = namespaceFailure("Coupler %s has no running process", sp.Coupler.Name)
		return st.nsFailure
	}
	if err := s.assertEndpoints(ctx, sp, st); err != nil {
		st.nsFailure = namespaceFailure("re-assert the gateway priority of %s: %v", sp.Coupler.Name, err)
		return st.nsFailure
	}
	if st.coupler.address.IsValid() {
		st.ownAddr = st.coupler.address
	}
	if ep := st.coupler.endpoints[sp.NetworkName]; ep != nil && len(ep.MacAddress) > 0 {
		st.ownMAC = ep.MacAddress
	}
	t := nsTarget{name: sp.Coupler.Name, pid: st.coupler.pid, inode: st.coupler.netns, envID: sp.EnvID, self: st.coupler.address, reach: s.plan.Generation.Services[sp.ID].Reach}
	if _, _, err := s.writeNS(t); err != nil {
		st.nsFailure = namespaceFailure("%v", err)
		return st.nsFailure
	}
	st.nsFailure = nil
	return nil
}

func switchText(m map[netip.Addr]netip.Addr) string {
	keys := make([]netip.Addr, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.SortFunc(keys, func(a, b netip.Addr) int { return a.Compare(b) })
	out := ""
	for _, k := range keys {
		if out != "" {
			out += ","
		}
		out += k.String() + "->" + m[k].String()
	}
	return out
}

func (s *Station) syncNamespaces(ctx context.Context) {
	ids := s.plan.ServiceIDs()
	for _, id := range ids {
		sp, st := s.plan.Services[id], s.services[id]
		if st == nil || !sp.Run || st.coupler.state != string(container.StateRunning) {
			continue
		}
		s.syncNamespace(ctx, sp, st)
	}
	for _, r := range s.orderedRollouts() {
		if r.terminal() || !r.reached(stepBaseline) {
			continue
		}
		for _, name := range []string{r.Green.Coupler, blueCoupler(r)} {
			if name == "" || (r.Blue != nil && name == r.Blue.Coupler && !r.ownsBlue()) {
				continue
			}
			if t, ok := s.rolloutNamespace(ctx, r, name); ok {
				if _, _, err := s.writeNS(t); err != nil {
					s.log.Warn("sync deployment namespace", "deployment", r.ID, "coupler", name, "error", err)
				}
			}
		}
	}
	g := s.plan.Generation
	for _, id := range ids {
		st := s.services[id]
		if st == nil {
			continue
		}
		st.switchAddr = netip.Addr{}
		addr := s.switchTarget(id).Addr
		if !addr.IsValid() {
			continue
		}
		svc := g.Services[id]
		var vipID string
		for _, v := range g.Environments[svc.EnvironmentId].VirtualIps {
			if v.ServiceId == id {
				vipID = v.Id
			}
		}
		programmed := true
		for _, cid := range ids {
			csvc, cst := g.Services[cid], s.services[cid]
			if cst == nil || csvc.EnvironmentId != svc.EnvironmentId || cst.coupler.state != string(container.StateRunning) || !slices.Contains(csvc.Reach, vipID) {
				continue
			}
			if cst.nsFailure != nil {
				programmed = false
			}
		}
		if programmed {
			st.switchAddr = addr
		}
	}
}

func bridgeUp(name string) bool {
	iface, err := net.InterfaceByName(name)
	return err == nil && iface.Flags&net.FlagUp != 0
}
