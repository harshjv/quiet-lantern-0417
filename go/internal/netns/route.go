//go:build linux

package netns

import (
	"net"
	"net/netip"

	"github.com/jsimonetti/rtnetlink/v2"
	"github.com/mdlayher/netlink"
	"golang.org/x/sys/unix"
)

func (n *Namespace) EnsureRoute(dst netip.Prefix, gateway netip.Addr) (bool, error) {
	conn, err := rtnetlink.Dial(&netlink.Config{NetNS: n.fd()})
	if err != nil {
		return false, err
	}
	defer conn.Close()
	dst = dst.Masked()
	routes, err := conn.Route.List()
	if err != nil {
		return false, err
	}
	for _, r := range routes {
		if r.Family != unix.AF_INET || r.Table != unix.RT_TABLE_MAIN || int(r.DstLength) != dst.Bits() {
			continue
		}
		have, _ := netip.AddrFromSlice(r.Attributes.Dst.To4())
		via, _ := netip.AddrFromSlice(r.Attributes.Gateway.To4())
		if have == dst.Addr() && via == gateway {
			return false, nil
		}
	}
	err = conn.Route.Replace(&rtnetlink.RouteMessage{
		Family:    unix.AF_INET,
		Table:     unix.RT_TABLE_MAIN,
		Protocol:  unix.RTPROT_STATIC,
		Scope:     unix.RT_SCOPE_UNIVERSE,
		Type:      unix.RTN_UNICAST,
		DstLength: uint8(dst.Bits()),
		Attributes: rtnetlink.RouteAttributes{
			Dst:     net.IP(dst.Addr().AsSlice()),
			Gateway: net.IP(gateway.AsSlice()),
		},
	})
	return err == nil, err
}
