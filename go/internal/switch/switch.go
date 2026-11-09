package vipswitch

import (
	"net/netip"

	"github.com/harshjv/stationly/go/internal/protocol"
)

type Target struct {
	Addr   netip.Addr
	Reject bool
}

type Consumer struct {
	Switch  map[netip.Addr]netip.Addr
	Pending []netip.Addr
	Reject  []netip.Addr
}

func For(reach []string, vips []protocol.EnvironmentVirtualIp, target func(serviceID string) Target) Consumer {
	byID := map[string]protocol.EnvironmentVirtualIp{}
	for _, v := range vips {
		byID[v.Id] = v
	}
	c := Consumer{Switch: map[netip.Addr]netip.Addr{}}
	for _, id := range reach {
		v, ok := byID[id]
		if !ok {
			continue
		}
		vip, err := netip.ParseAddr(v.Address)
		if err != nil {
			continue
		}
		t := target(v.ServiceId)
		switch {
		case t.Reject:
			c.Reject = append(c.Reject, vip)
		case t.Addr.IsValid():
			c.Switch[vip] = t.Addr
		default:
			c.Pending = append(c.Pending, vip)
		}
	}
	return c
}
