//go:build linux

package netns

import (
	"fmt"
	"net/netip"
	"time"

	"github.com/google/nftables"
	"github.com/mdlayher/netlink"
	"github.com/ti-mo/conntrack"
)

func allowPresent(c *nftables.Conn, s *nftables.Set) (map[netip.Addr]bool, error) {
	have, err := c.GetSetElements(s)
	if err != nil {
		return nil, err
	}
	present := map[netip.Addr]bool{}
	for _, el := range have {
		present[addrOf(el.Key)] = true
	}
	return present, nil
}

func (n *Namespace) RefreshAllow(port uint16, els []AllowElement) error {
	if len(els) == 0 {
		return nil
	}
	for _, e := range els {
		if !e.Addr.Unmap().Is4() {
			return fmt.Errorf("allow element %s is not an IPv4 address", e.Addr)
		}
		if e.Timeout <= 0 {
			return fmt.Errorf("allow element %s has no timeout", e.Addr)
		}
	}
	c, err := nftables.New(nftables.WithNetNSFd(n.fd()))
	if err != nil {
		return err
	}
	s := allowSet(port)
	present, err := allowPresent(c, s)
	if err != nil {
		return err
	}
	var del []nftables.SetElement
	for _, e := range els {
		if present[e.Addr.Unmap()] {
			del = append(del, nftables.SetElement{Key: e.Addr.Unmap().AsSlice()})
			delete(present, e.Addr.Unmap())
		}
	}
	if len(del) > 0 {
		if err := c.SetDeleteElements(s, del); err != nil {
			return err
		}
	}
	if err := c.SetAddElements(s, allowElements(els)); err != nil {
		return err
	}
	return c.Flush()
}

func (n *Namespace) RemoveAllow(port uint16, addrs []netip.Addr) error {
	if len(addrs) == 0 {
		return nil
	}
	c, err := nftables.New(nftables.WithNetNSFd(n.fd()))
	if err != nil {
		return err
	}
	s := allowSet(port)
	present, err := allowPresent(c, s)
	if err != nil {
		return err
	}
	var del []nftables.SetElement
	for _, a := range addrs {
		if present[a.Unmap()] {
			del = append(del, nftables.SetElement{Key: a.Unmap().AsSlice()})
			delete(present, a.Unmap())
		}
	}
	if len(del) == 0 {
		return nil
	}
	if err := c.SetDeleteElements(s, del); err != nil {
		return err
	}
	return c.Flush()
}

func (n *Namespace) AllowElements(port uint16) (map[netip.Addr]time.Duration, error) {
	c, err := nftables.New(nftables.WithNetNSFd(n.fd()))
	if err != nil {
		return nil, err
	}
	els, err := c.GetSetElements(allowSet(port))
	if err != nil {
		return nil, err
	}
	out := map[netip.Addr]time.Duration{}
	for _, el := range els {
		out[addrOf(el.Key)] = el.Expires
	}
	return out, nil
}

func sandboxFlowTo(addrs []netip.Addr) func(conntrack.Flow) bool {
	want := map[netip.Addr]bool{}
	for _, a := range addrs {
		want[a.Unmap()] = true
	}
	return func(f conntrack.Flow) bool {
		return f.TupleOrig.IP.SourceAddress.Unmap() == SandboxLink &&
			want[f.TupleOrig.IP.DestinationAddress.Unmap()] &&
			f.TupleOrig.Proto.DestinationPort != 53
	}
}

func (n *Namespace) EvictSandboxFlows(addrs []netip.Addr) (FlowReport, error) {
	if len(addrs) == 0 {
		return FlowReport{}, nil
	}
	return flows(&netlink.Config{NetNS: n.fd()}, sandboxFlowTo(addrs), true)
}
