//go:build linux

package deploy

import (
	"crypto/sha256"
	"encoding/hex"
	"net/netip"
	"regexp"
	"slices"
	"strings"

	"github.com/harshjv/stationly/go/internal/cidr"
	"github.com/harshjv/stationly/go/internal/gateway"
	"github.com/harshjv/stationly/go/internal/protocol"
)

var (
	hostnamePattern = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
	routeIDPattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
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
	GatewayVIP    netip.Addr
	Tunnel        CloudflaredPlan
	Slots         map[string]netip.Addr
	VirtualPrefix netip.Prefix
	SystemTargets map[string]SystemTargetPlan
	Static        []byte
	Inputs        string
	Routes        []RoutePlan
}

type CloudflaredPlan struct {
	Image   string
	Version string
	Digest  string
}

type RoutePlan struct {
	ID        string
	Hash      string
	Hostname  string
	ServiceID string
	System    string
	Upstream  netip.AddrPort
	Config    []byte
}

type SystemTargetPlan struct {
	Hash string
	VIP  netip.Addr
	Port uint16
}

func checkGateway(g *protocol.Generation) *Rejection {
	invalid := func(format string, args ...any) *Rejection {
		return reject(protocol.ErrorCodeGenerationInvalid, "Fix the generation and send it again.", format, args...)
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
	for _, name := range []string{"gateway", "cloudflared"} {
		if pin, ok := g.Components[name]; ok && pin.Digest == nil {
			return invalid("components.%s needs a digest", name)
		}
	}
	hostnames := map[string]string{}
	for _, id := range sortedKeys(g.Gateway.Routes) {
		r := g.Gateway.Routes[id]
		if !routeIDPattern.MatchString(id) || id == gateway.ProbeRouter || strings.HasPrefix(id, gateway.TunnelProbeRouter) {
			return invalid("route id %q must be 1 to 64 letters, digits, - or _, not %s and not start with %s", id, gateway.ProbeRouter, gateway.TunnelProbeRouter)
		}
		if _, err := netip.ParseAddr(r.Hostname); err == nil {
			return invalid("route %s hostname %s is an IP address; routes carry DNS names only", id, r.Hostname)
		}
		if len(r.Hostname) > 253 || !hostnamePattern.MatchString(r.Hostname) {
			return invalid("route %s hostname %q is not a lowercase DNS name", id, r.Hostname)
		}
		if other, ok := hostnames[r.Hostname]; ok {
			return invalid("routes %s and %s share hostname %s", other, id, r.Hostname)
		}
		hostnames[r.Hostname] = id
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
	return nil
}

func planGateway(g *protocol.Generation) (*GatewayPlan, error) {
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
		GatewayVIP:    cidr.Offset(vp.Masked(), protocol.NetworkGatewayVirtualHost),
		Slots:         map[string]netip.Addr{gatewaySlotA: cidr.Offset(ingress, slotOffsetA), gatewaySlotB: cidr.Offset(ingress, slotOffsetB)},
		VirtualPrefix: vp.Masked(),
	}
	gp.SystemTargets = map[string]SystemTargetPlan{}
	for name, st := range g.SystemTargets {
		gp.SystemTargets[name] = SystemTargetPlan{Hash: st.Hash, VIP: netip.MustParseAddr(st.VirtualIp), Port: uint16(st.Port)}
	}
	if pin, ok := g.Components["gateway"]; ok {
		gp.Run = true
		gp.Version = pin.Version
		gp.Digest = *pin.Digest
		gp.Image = protocol.GatewaySource + "@" + gp.Digest
	}
	if pin, ok := g.Components["cloudflared"]; ok {
		gp.Tunnel = CloudflaredPlan{Image: protocol.CloudflaredSource + "@" + *pin.Digest, Version: pin.Version, Digest: *pin.Digest}
	}
	gp.Static, err = gateway.StaticConfig(gp.Cloudflared)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(slices.Concat([]byte(gp.Image+"|"), gp.Static))
	gp.Inputs = hex.EncodeToString(sum[:8])
	for _, id := range sortedKeys(g.Gateway.Routes) {
		r := g.Gateway.Routes[id]
		rp := RoutePlan{ID: id, Hash: r.Hash, Hostname: r.Hostname}
		if r.Target.ServiceId != nil {
			rp.ServiceID = *r.Target.ServiceId
		} else {
			rp.System = *r.Target.System
		}
		rp.Upstream = netip.AddrPortFrom(netip.MustParseAddr(r.Target.VirtualIp), uint16(r.Target.Port))
		rp.Config, err = gateway.RouteConfig(gateway.Route{ID: id, Hostname: r.Hostname, Upstream: rp.Upstream, Cloudflared: gp.Cloudflared})
		if err != nil {
			return nil, err
		}
		gp.Routes = append(gp.Routes, rp)
	}
	return gp, nil
}
