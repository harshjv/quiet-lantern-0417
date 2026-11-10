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

func presentElements(c *nftables.Conn, s *nftables.Set, addrs []netip.Addr) ([]nftables.SetElement, error) {
	present, err := readAddrs(c, s)
	if err != nil {
		return nil, err
	}
	var out []nftables.SetElement
	for _, a := range addrs {
		if present[a.Unmap()] {
			out = append(out, nftables.SetElement{Key: a.Unmap().AsSlice()})
			delete(present, a.Unmap())
		}
	}
	return out, nil
}

func (n *Namespace) RefreshAllow(port uint16, els []AllowElement) error {
	if len(els) == 0 {
		return nil
	}
	addrs := make([]netip.Addr, 0, len(els))
	for _, e := range els {
		if !e.Addr.Unmap().Is4() {
			return fmt.Errorf("allow element %s is not an IPv4 address", e.Addr)
		}
		if e.Timeout <= 0 {
			return fmt.Errorf("allow element %s has no timeout", e.Addr)
		}
		addrs = append(addrs, e.Addr)
	}
	return n.updateAllow(port, addrs, allowElements(els))
}

func (n *Namespace) RemoveAllow(port uint16, addrs []netip.Addr) error {
	if len(addrs) == 0 {
		return nil
	}
	return n.updateAllow(port, addrs, nil)
}

func (n *Namespace) updateAllow(port uint16, stale []netip.Addr, add []nftables.SetElement) error {
	c, err := nftables.New(nftables.WithNetNSFd(n.fd()))
	if err != nil {
		return err
	}
	s := allowSet(port)
	del, err := presentElements(c, s, stale)
	if err != nil {
		return err
	}
	_, err = applySetOps(c, false, setOp{s, del, true}, setOp{s, add, false})
	return err
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
