//go:build linux

package netns

import (
	"errors"
	"net"
	"net/netip"

	"github.com/jsimonetti/rtnetlink/v2"
	"golang.org/x/sys/unix"
)

type DefaultRoute struct {
	Interface string
	Address   netip.Addr
}

func DefaultRouteAddress() (DefaultRoute, error) {
	conn, err := rtnetlink.Dial(nil)
	if err != nil {
		return DefaultRoute{}, err
	}
	defer conn.Close()
	routes, err := conn.Route.List()
	if err != nil {
		return DefaultRoute{}, err
	}
	var best *rtnetlink.RouteMessage
	for i, r := range routes {
		if r.Family != unix.AF_INET || r.Table != unix.RT_TABLE_MAIN || r.DstLength != 0 || r.Attributes.OutIface == 0 {
			continue
		}
		if best == nil || r.Attributes.Priority < best.Attributes.Priority {
			best = &routes[i]
		}
	}
	if best == nil {
		return DefaultRoute{}, errors.New("the host has no IPv4 default route")
	}
	iface, err := net.InterfaceByIndex(int(best.Attributes.OutIface))
	if err != nil {
		return DefaultRoute{}, err
	}
	if src, ok := netip.AddrFromSlice(best.Attributes.Src.To4()); ok && src.IsValid() {
		return DefaultRoute{Interface: iface.Name, Address: src}, nil
	}
	addrs, err := iface.Addrs()
	if err != nil {
		return DefaultRoute{}, err
	}
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok {
			if ip, ok := netip.AddrFromSlice(n.IP.To4()); ok && ip.IsValid() {
				return DefaultRoute{Interface: iface.Name, Address: ip}, nil
			}
		}
	}
	return DefaultRoute{}, errors.New("the default-route interface " + iface.Name + " has no IPv4 address")
}
