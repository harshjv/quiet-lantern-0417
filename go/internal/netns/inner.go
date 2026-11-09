//go:build linux

package netns

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/jsimonetti/rtnetlink/v2"
	"github.com/jsimonetti/rtnetlink/v2/driver"
	"github.com/mdlayher/netlink"
	"golang.org/x/sys/unix"
)

const (
	innerDir  = "/run/stationly/netns"
	innerIf   = "eth0"
	linkBits  = 30
	threadNet = "/proc/thread-self/ns/net"
)

func InnerPath(sandboxID string) string {
	return innerDir + "/" + sandboxID
}

func checkSandboxID(id string) error {
	if id == "" || id == "." || id == ".." || strings.ContainsAny(id, "/\x00") {
		return fmt.Errorf("invalid sandbox id %q", id)
	}
	return nil
}

func isNetns(p string) (bool, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(p, &st); err != nil {
		if errors.Is(err, unix.ENOENT) {
			return false, nil
		}
		return false, err
	}
	return st.Type == unix.NSFS_MAGIC, nil
}

func CreateInner(sandboxID string) (*Namespace, error) {
	if err := checkSandboxID(sandboxID); err != nil {
		return nil, err
	}
	p := InnerPath(sandboxID)
	mounted, err := isNetns(p)
	if err != nil {
		return nil, err
	}
	if !mounted {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return nil, err
		}
		f, err := os.OpenFile(p, os.O_RDONLY|os.O_CREATE, 0o444)
		if err != nil {
			return nil, err
		}
		if err := f.Close(); err != nil {
			return nil, err
		}
		if err := bindNewNetns(p); err != nil {
			return nil, err
		}
	}
	ns, err := OpenPath(p)
	if err != nil {
		return nil, err
	}
	if err := ns.linkUp("lo"); err != nil {
		ns.Close()
		return nil, err
	}
	return ns, nil
}

func bindNewNetns(p string) error {
	done := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		orig, err := os.Open(threadNet)
		if err != nil {
			runtime.UnlockOSThread()
			done <- err
			return
		}
		defer orig.Close()
		if err := unix.Unshare(unix.CLONE_NEWNET); err != nil {
			runtime.UnlockOSThread()
			done <- err
			return
		}
		mountErr := unix.Mount(threadNet, p, "none", unix.MS_BIND, "")
		if err := unix.Setns(int(orig.Fd()), unix.CLONE_NEWNET); err != nil {
			done <- errors.Join(mountErr, fmt.Errorf("restore the thread's network namespace: %w", err))
			return
		}
		runtime.UnlockOSThread()
		done <- mountErr
	}()
	return <-done
}

func RemoveInner(sandboxID string) error {
	if err := checkSandboxID(sandboxID); err != nil {
		return err
	}
	p := InnerPath(sandboxID)
	if err := unix.Unmount(p, unix.MNT_DETACH); err != nil && !errors.Is(err, unix.EINVAL) && !errors.Is(err, unix.ENOENT) {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (n *Namespace) rtnl() (*rtnetlink.Conn, error) {
	return rtnetlink.Dial(&netlink.Config{NetNS: n.fd()})
}

func linkByName(c *rtnetlink.Conn, name string) (rtnetlink.LinkMessage, bool, error) {
	links, err := c.Link.List()
	if err != nil {
		return rtnetlink.LinkMessage{}, false, err
	}
	for _, l := range links {
		if l.Attributes != nil && l.Attributes.Name == name {
			return l, true, nil
		}
	}
	return rtnetlink.LinkMessage{}, false, nil
}

func requireLink(c *rtnetlink.Conn, name string) (rtnetlink.LinkMessage, error) {
	l, ok, err := linkByName(c, name)
	if err != nil {
		return l, err
	}
	if !ok {
		return l, fmt.Errorf("the namespace has no interface %s", name)
	}
	return l, nil
}

func setUp(c *rtnetlink.Conn, l rtnetlink.LinkMessage) error {
	if l.Flags&unix.IFF_UP != 0 {
		return nil
	}
	return c.Link.Set(&rtnetlink.LinkMessage{Family: unix.AF_UNSPEC, Index: l.Index, Flags: unix.IFF_UP, Change: unix.IFF_UP})
}

func setMTU(c *rtnetlink.Conn, l rtnetlink.LinkMessage, mtu uint32) error {
	if l.Attributes.MTU == mtu {
		return nil
	}
	return c.Link.Set(&rtnetlink.LinkMessage{Family: unix.AF_UNSPEC, Index: l.Index, Attributes: &rtnetlink.LinkAttributes{MTU: mtu}})
}

func (n *Namespace) linkUp(name string) error {
	c, err := n.rtnl()
	if err != nil {
		return err
	}
	defer c.Close()
	l, err := requireLink(c, name)
	if err != nil {
		return err
	}
	return setUp(c, l)
}

func replaceAddr(c *rtnetlink.Conn, index uint32, a netip.Addr) error {
	ip := net.IP(a.AsSlice())
	_, err := c.Execute(&rtnetlink.AddressMessage{
		Family:       unix.AF_INET,
		PrefixLength: linkBits,
		Scope:        unix.RT_SCOPE_UNIVERSE,
		Index:        index,
		Attributes:   &rtnetlink.AddressAttributes{Address: ip, Local: ip},
	}, unix.RTM_NEWADDR, netlink.Request|netlink.Create|netlink.Replace|netlink.Acknowledge)
	return err
}

func LinkSandbox(coupler, inner *Namespace) error {
	cc, err := coupler.rtnl()
	if err != nil {
		return err
	}
	defer cc.Close()
	ic, err := inner.rtnl()
	if err != nil {
		return err
	}
	defer ic.Close()
	uplink, err := requireLink(cc, couplerIf)
	if err != nil {
		return err
	}
	mtu := uplink.Attributes.MTU
	sbx, haveSbx, err := linkByName(cc, SandboxIf)
	if err != nil {
		return err
	}
	eth, haveEth, err := linkByName(ic, innerIf)
	if err != nil {
		return err
	}
	if haveSbx != haveEth {
		if haveSbx {
			err = cc.Link.Delete(sbx.Index)
		} else {
			err = ic.Link.Delete(eth.Index)
		}
		if err != nil {
			return err
		}
	}
	if !haveSbx || !haveEth {
		err := cc.Link.New(&rtnetlink.LinkMessage{
			Family: unix.AF_UNSPEC,
			Attributes: &rtnetlink.LinkAttributes{
				Name: SandboxIf,
				MTU:  mtu,
				Info: &rtnetlink.LinkInfo{Kind: "veth", Data: &driver.Veth{PeerInfo: &rtnetlink.LinkMessage{
					Family:     unix.AF_UNSPEC,
					Attributes: &rtnetlink.LinkAttributes{Name: innerIf, MTU: mtu, NetNS: rtnetlink.NetNSForFD(uint32(inner.fd()))},
				}}},
			},
		})
		if err != nil {
			return err
		}
		if sbx, err = requireLink(cc, SandboxIf); err != nil {
			return err
		}
		if eth, err = requireLink(ic, innerIf); err != nil {
			return err
		}
	}
	if err := setMTU(cc, sbx, mtu); err != nil {
		return err
	}
	if err := setMTU(ic, eth, mtu); err != nil {
		return err
	}
	if err := replaceAddr(cc, sbx.Index, CouplerLink); err != nil {
		return err
	}
	return setUp(cc, sbx)
}

func Readdr(inner *Namespace) error {
	c, err := inner.rtnl()
	if err != nil {
		return err
	}
	defer c.Close()
	eth, err := requireLink(c, innerIf)
	if err != nil {
		return err
	}
	if err := replaceAddr(c, eth.Index, SandboxLink); err != nil {
		return err
	}
	if err := setUp(c, eth); err != nil {
		return err
	}
	return c.Route.Replace(&rtnetlink.RouteMessage{
		Family:   unix.AF_INET,
		Table:    unix.RT_TABLE_MAIN,
		Protocol: unix.RTPROT_STATIC,
		Scope:    unix.RT_SCOPE_UNIVERSE,
		Type:     unix.RTN_UNICAST,
		Attributes: rtnetlink.RouteAttributes{
			Gateway:  net.IP(CouplerLink.AsSlice()),
			OutIface: eth.Index,
		},
	})
}

func (n *Namespace) LinkCounters(name string) (rxBytes, txBytes uint64, err error) {
	c, err := n.rtnl()
	if err != nil {
		return 0, 0, err
	}
	defer c.Close()
	l, err := requireLink(c, name)
	if err != nil {
		return 0, 0, err
	}
	switch {
	case l.Attributes.Stats64 != nil:
		return l.Attributes.Stats64.RXBytes, l.Attributes.Stats64.TXBytes, nil
	case l.Attributes.Stats != nil:
		return uint64(l.Attributes.Stats.RXBytes), uint64(l.Attributes.Stats.TXBytes), nil
	}
	return 0, 0, fmt.Errorf("interface %s reports no counters", name)
}
