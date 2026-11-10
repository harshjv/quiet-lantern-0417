//go:build linux

package deploy

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"github.com/harshjv/stationly/go/internal/cidr"
	"net/netip"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/gateway"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/verify"
)

var (
	hostnamePattern = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
	routeIDPattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	reservedPorts   = map[int]bool{22: true, 80: true, 443: true}
)

const (
	cloudflaredOffset = 2
	gatewaySlotA      = "a"
	gatewaySlotB      = "b"
	slotOffsetA       = 10
	slotOffsetB       = 11
	systemDispatch    = "dispatch"
)

type GatewayPlan struct {
	Run           bool
	Image         string
	Version       string
	Digest        string
	Ingress       netip.Prefix
	IPRange       netip.Prefix
	Bridge        netip.Addr
	Cloudflared   netip.Addr
	Slots         map[string]netip.Addr
	Public        netip.Addr
	VirtualPrefix netip.Prefix
	WebOpen       bool
	SourceRate    int
	Static        gateway.Static
	ACMERoots     []byte
	SystemTargets map[string]SystemTargetPlan
	ClassicHours  int
	Inputs        string
	Routes        []RoutePlan
	Ports         []PortPlan
}

type RoutePlan struct {
	ID        string
	Hash      string
	Hostname  string
	Direct    bool
	ServiceID string
	System    string
	Upstream  netip.AddrPort
	Resolver  string
	Config    []byte
}

type SystemTargetPlan struct {
	Hash string
	VIP  netip.Addr
	Port uint16
}

type PortPlan struct {
	ID            string
	Hash          string
	ServiceID     string
	VIP           netip.Addr
	HostPort      uint16
	ContainerPort uint16
}

func portRange(s string) (int, int, error) {
	lo, hi, ok := strings.Cut(s, "-")
	if !ok {
		return 0, 0, fmt.Errorf("%q is not a range of the form low-high", s)
	}
	a, err1 := strconv.Atoi(strings.TrimSpace(lo))
	b, err2 := strconv.Atoi(strings.TrimSpace(hi))
	if err1 != nil || err2 != nil || a < 1 || b > 65535 || a > b {
		return 0, 0, fmt.Errorf("%q is not a range of ports", s)
	}
	return a, b, nil
}

func checkGateway(g *protocol.Generation) *Rejection {
	invalid := func(format string, args ...any) *Rejection {
		return reject(protocol.ErrorCodeGenerationInvalid, "Fix the generation and send it again.", format, args...)
	}
	var public netip.Addr
	if p := g.Station.PublicAddress; p != nil {
		a, err := netip.ParseAddr(*p)
		if err != nil || !a.Is4() {
			return invalid("station.public_address %q is not an IPv4 address", *p)
		}
		public = a
	}
	ingress, err := netip.ParsePrefix(g.Station.Networks.Ingress.Subnet)
	if err != nil || ingress.Bits() > 27 {
		return invalid("ingress network subnet %q must be an IPv4 prefix of /27 or larger", g.Station.Networks.Ingress.Subnet)
	}
	bridge, err := netip.ParseAddr(g.Station.Networks.Ingress.Gateway)
	if err != nil || !ingress.Contains(bridge) {
		return invalid("ingress network gateway %q is not an address inside %s", g.Station.Networks.Ingress.Gateway, ingress)
	}
	for _, n := range []uint32{cloudflaredOffset, slotOffsetA, slotOffsetB} {
		if cidr.Offset(ingress, n) == bridge {
			return invalid("ingress network gateway %s collides with the fixed cloudflared or Gateway Coupler addresses", bridge)
		}
	}
	if pin, ok := g.Components["gateway"]; ok && pin.Digest == nil {
		return invalid("components.gateway needs a digest")
	}
	if strings.ContainsAny(g.Gateway.Acme.Email, "\n\r") || strings.Count(g.Gateway.Acme.Email, "@") > 1 {
		return invalid("gateway.acme.email %q is not an address", g.Gateway.Acme.Email)
	}
	if ca := g.Gateway.Acme.CaServer; ca != nil && !strings.HasPrefix(*ca, "https://") {
		return invalid("gateway.acme.ca_server %q must be an https URL", *ca)
	}
	hostnames := map[string]string{}
	direct := false
	ipRoutes := 0
	for _, id := range sortedKeys(g.Gateway.Routes) {
		r := g.Gateway.Routes[id]
		if !routeIDPattern.MatchString(id) || id == gateway.ProbeRouter {
			return invalid("route id %q must be 1 to 64 letters, digits, - or _ and not %s", id, gateway.ProbeRouter)
		}
		ip, ipErr := netip.ParseAddr(r.Hostname)
		switch {
		case ipErr == nil:
			if !ip.Is4() || ip != public {
				return invalid("route %s hostname %s is an IP address; only station.public_address may be routed by address", id, r.Hostname)
			}
			ipRoutes++
		case len(r.Hostname) > 253 || !hostnamePattern.MatchString(r.Hostname):
			return invalid("route %s hostname %q is not a lowercase DNS name", id, r.Hostname)
		}
		if other, ok := hostnames[r.Hostname]; ok {
			return invalid("routes %s and %s share hostname %s", other, id, r.Hostname)
		}
		hostnames[r.Hostname] = id
		switch r.Ingress {
		case protocol.IngressDirect:
			direct = true
			if r.Tls == nil {
				return invalid("direct route %s has no tls resolver", id)
			}
			if ipErr == nil && r.Tls.Resolver != protocol.CertResolverLetsencryptShortlived {
				return invalid("route %s routes an IP address and needs resolver %s, which issues IP certificates", id, gateway.ResolverShortlived)
			}
		case protocol.IngressTunnel:
			if r.Tls != nil || ipErr == nil {
				return invalid("tunnel route %s carries tls or an IP hostname", id)
			}
		}
		t := r.Target
		if (t.ServiceId == nil) == (t.System == nil) {
			return invalid("route %s target names neither or both of service_id and system", id)
		}
		if t.ServiceId != nil {
			svc, ok := g.Services[*t.ServiceId]
			if !ok {
				return invalid("route %s targets service %s, which the generation does not contain", id, *t.ServiceId)
			}
			if svc.VirtualIp != t.VirtualIp {
				return invalid("route %s targets %s:%d but service %s has virtual IP %s", id, t.VirtualIp, t.Port, *t.ServiceId, svc.VirtualIp)
			}
		} else {
			st, ok := g.SystemTargets[*t.System]
			if !ok || st.VirtualIp != t.VirtualIp || st.Port != t.Port {
				return invalid("route %s targets system %s at %s:%d, which system_targets does not match", id, *t.System, t.VirtualIp, t.Port)
			}
		}
	}
	if ipRoutes > 1 {
		return invalid("%d routes use the station address; at most one may", ipRoutes)
	}
	if direct && !public.IsValid() {
		return invalid("direct routes need station.public_address")
	}
	if want := protocol.WebPortsClosed; direct != (g.Station.Inbound.WebPorts == protocol.WebPortsOpen) {
		if direct {
			want = protocol.WebPortsOpen
		}
		return invalid("station.inbound.web_ports is %s but must be %s, since %d direct routes exist", g.Station.Inbound.WebPorts, want, len(hostnames))
	}
	if len(g.PortAllocations) > 0 {
		lo, hi, err := portRange(g.Station.Settings.ExposurePortRange)
		if err != nil {
			return invalid("exposure.port_range: %v", err)
		}
		if !public.IsValid() {
			return invalid("port allocations need station.public_address")
		}
		taken := map[int]string{}
		for _, id := range sortedKeys(g.PortAllocations) {
			pa := g.PortAllocations[id]
			if pa.HostPort < lo || pa.HostPort > hi || reservedPorts[pa.HostPort] {
				return invalid("port allocation %s host_port %d lies outside exposure.port_range %d-%d or is 22, 80 or 443", id, pa.HostPort, lo, hi)
			}
			if other, ok := taken[pa.HostPort]; ok {
				return invalid("port allocations %s and %s share host_port %d", other, id, pa.HostPort)
			}
			taken[pa.HostPort] = id
			svc, ok := g.Services[pa.ServiceId]
			if !ok {
				return invalid("port allocation %s names service %s, which the generation does not contain", id, pa.ServiceId)
			}
			if svc.VirtualIp != pa.VirtualIp {
				return invalid("port allocation %s names virtual IP %s but service %s has %s", id, pa.VirtualIp, pa.ServiceId, svc.VirtualIp)
			}
			if pa.ContainerPort < 1 || pa.ContainerPort > 65535 {
				return invalid("port allocation %s container_port %d is not a port", id, pa.ContainerPort)
			}
		}
	}
	return nil
}

func ACMEDirectory(requested *string, trust verify.Trust) string {
	if trust.Production {
		if requested == nil {
			return ""
		}
		return *requested
	}
	if requested == nil || *requested == verify.LetsEncryptProduction {
		return trust.DefaultACME()
	}
	return *requested
}

func planGateway(g *protocol.Generation, couplerImage string, now time.Time, trust verify.Trust) (*GatewayPlan, error) {
	ingress := netip.MustParsePrefix(g.Station.Networks.Ingress.Subnet).Masked()
	vp, err := netip.ParsePrefix(g.Station.Settings.IpamVirtualPrefix)
	if err != nil {
		return nil, err
	}
	gp := &GatewayPlan{
		Ingress:       ingress,
		IPRange:       cidr.UpperHalf(ingress),
		Bridge:        netip.MustParseAddr(g.Station.Networks.Ingress.Gateway),
		Cloudflared:   cidr.Offset(ingress, cloudflaredOffset),
		Slots:         map[string]netip.Addr{gatewaySlotA: cidr.Offset(ingress, slotOffsetA), gatewaySlotB: cidr.Offset(ingress, slotOffsetB)},
		VirtualPrefix: vp.Masked(),
		WebOpen:       g.Station.Inbound.WebPorts == protocol.WebPortsOpen,
		SourceRate:    g.Station.Settings.GatewayRatePerSource,
		ClassicHours:  gateway.ClassicHours(now),
		Static:        gateway.Static{Email: g.Gateway.Acme.Email, Cloudflared: cidr.Offset(ingress, cloudflaredOffset)},
	}
	if p := g.Station.PublicAddress; p != nil {
		gp.Public = netip.MustParseAddr(*p)
	}
	gp.Static.CAServer = ACMEDirectory(g.Gateway.Acme.CaServer, trust)
	if roots := trust.ACMERoots(); len(roots) > 0 {
		gp.ACMERoots = roots
		gp.Static.CACertificates = true
	}
	gp.SystemTargets = map[string]SystemTargetPlan{}
	for name, st := range g.SystemTargets {
		gp.SystemTargets[name] = SystemTargetPlan{Hash: st.Hash, VIP: netip.MustParseAddr(st.VirtualIp), Port: uint16(st.Port)}
	}
	if pin, ok := g.Components["gateway"]; ok {
		gp.Run = true
		gp.Version = pin.Version
		gp.Digest = *pin.Digest
		gp.Image = docker.GatewaySource + "@" + gp.Digest
	}
	body, err := gateway.StaticConfig(gp.Static, gp.ClassicHours)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(slices.Concat([]byte(gp.Image+"|"), body, []byte("|"), gp.ACMERoots))
	gp.Inputs = hex.EncodeToString(sum[:8])
	for _, id := range sortedKeys(g.Gateway.Routes) {
		r := g.Gateway.Routes[id]
		rp := RoutePlan{ID: id, Hash: r.Hash, Hostname: r.Hostname, Direct: r.Ingress == protocol.IngressDirect}
		if r.Target.ServiceId != nil {
			rp.ServiceID = *r.Target.ServiceId
		} else {
			rp.System = *r.Target.System
		}
		rp.Upstream = netip.AddrPortFrom(netip.MustParseAddr(r.Target.VirtualIp), uint16(r.Target.Port))
		if r.Tls != nil {
			rp.Resolver = string(r.Tls.Resolver)
		}
		rp.Config, err = gateway.RouteConfig(gateway.Route{
			ID: id, Hostname: r.Hostname, Tunnel: r.Ingress == protocol.IngressTunnel, Upstream: rp.Upstream,
			Resolver: rp.Resolver, RedirectHTTP: r.RedirectHttp, Cloudflared: gp.Cloudflared,
		})
		if err != nil {
			return nil, err
		}
		gp.Routes = append(gp.Routes, rp)
	}
	for _, id := range sortedKeys(g.PortAllocations) {
		pa := g.PortAllocations[id]
		gp.Ports = append(gp.Ports, PortPlan{ID: id, Hash: pa.Hash, ServiceID: pa.ServiceId, VIP: netip.MustParseAddr(pa.VirtualIp), HostPort: uint16(pa.HostPort), ContainerPort: uint16(pa.ContainerPort)})
	}
	sort.Slice(gp.Ports, func(i, j int) bool { return gp.Ports[i].HostPort < gp.Ports[j].HostPort })
	return gp, nil
}
