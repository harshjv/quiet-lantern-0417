//go:build linux

package netns

import (
	"context"
	"net/netip"
	"slices"

	"github.com/jsimonetti/rtnetlink/v2"
	"github.com/mdlayher/netlink"
	"golang.org/x/sys/unix"
)

func HostAddresses() ([]netip.Addr, error) {
	conn, err := rtnetlink.Dial(nil)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	msgs, err := conn.Address.List()
	if err != nil {
		return nil, err
	}
	var out []netip.Addr
	for _, m := range msgs {
		if m.Family != unix.AF_INET || m.Attributes == nil {
			continue
		}
		ip := m.Attributes.Local
		if ip == nil {
			ip = m.Attributes.Address
		}
		if a, ok := netip.AddrFromSlice(ip.To4()); ok {
			out = append(out, a)
		}
	}
	slices.SortFunc(out, func(a, b netip.Addr) int { return a.Compare(b) })
	return slices.Compact(out), nil
}

func WatchAddresses(ctx context.Context, changed chan<- struct{}) error {
	conn, err := rtnetlink.Dial(&netlink.Config{Groups: unix.RTMGRP_IPV4_IFADDR})
	if err != nil {
		return err
	}
	go func() {
		<-ctx.Done()
		conn.Close()
	}()
	for {
		if _, _, err := conn.Receive(); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		select {
		case changed <- struct{}{}:
		default:
		}
	}
}
