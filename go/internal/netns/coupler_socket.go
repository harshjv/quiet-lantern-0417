//go:build linux

package netns

import (
	"context"
	"encoding/binary"
	"errors"
	"net"
	"net/netip"
	"os"

	"github.com/mdlayher/socket"
	"golang.org/x/sys/unix"
)

func (n *Namespace) ListenCoupler(port uint16) (net.Listener, error) {
	c, err := socket.Socket(unix.AF_INET, unix.SOCK_STREAM, 0, "coupler-listen", &socket.Config{NetNS: n.fd()})
	if err != nil {
		return nil, err
	}
	defer c.Close()
	if err := c.SetsockoptInt(unix.SOL_SOCKET, unix.SO_REUSEADDR, 1); err != nil {
		return nil, err
	}
	if err := c.Bind(&unix.SockaddrInet4{Port: int(port), Addr: CouplerLink.As4()}); err != nil {
		return nil, err
	}
	if err := c.Listen(unix.SOMAXCONN); err != nil {
		return nil, err
	}
	f, err := dupFile(c, "coupler-listen")
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return net.FileListener(f)
}

func (n *Namespace) DialCoupler(ctx context.Context, to netip.AddrPort) (net.Conn, error) {
	if !to.Addr().Unmap().Is4() {
		return nil, errors.New("the Coupler dials IPv4 only")
	}
	c, err := socket.Socket(unix.AF_INET, unix.SOCK_STREAM, 0, "coupler-dial", &socket.Config{NetNS: n.fd()})
	if err != nil {
		return nil, err
	}
	defer c.Close()
	if _, err := c.Connect(ctx, &unix.SockaddrInet4{Port: int(to.Port()), Addr: to.Addr().Unmap().As4()}); err != nil {
		return nil, err
	}
	f, err := dupFile(c, "coupler-dial")
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return net.FileConn(f)
}

func dupFile(c *socket.Conn, name string) (*os.File, error) {
	raw, err := c.SyscallConn()
	if err != nil {
		return nil, err
	}
	fd, dupErr := -1, error(nil)
	if err := raw.Control(func(s uintptr) { fd, dupErr = unix.FcntlInt(s, unix.F_DUPFD_CLOEXEC, 0) }); err != nil {
		return nil, err
	}
	if dupErr != nil {
		return nil, dupErr
	}
	f := os.NewFile(uintptr(fd), name)
	if f == nil {
		return nil, errors.New("wrap the " + name + " socket")
	}
	return f, nil
}

func OriginalDst(c net.Conn) (netip.AddrPort, error) {
	tc, ok := c.(*net.TCPConn)
	if !ok {
		return netip.AddrPort{}, errors.New("the connection is not TCP")
	}
	raw, err := tc.SyscallConn()
	if err != nil {
		return netip.AddrPort{}, err
	}
	var mreq *unix.IPv6Mreq
	var optErr error
	if err := raw.Control(func(fd uintptr) {
		mreq, optErr = unix.GetsockoptIPv6Mreq(int(fd), unix.SOL_IP, unix.SO_ORIGINAL_DST)
	}); err != nil {
		return netip.AddrPort{}, err
	}
	if optErr != nil {
		return netip.AddrPort{}, optErr
	}
	b := mreq.Multiaddr
	addr := netip.AddrFrom4([4]byte{b[4], b[5], b[6], b[7]})
	return netip.AddrPortFrom(addr, binary.BigEndian.Uint16(b[2:4])), nil
}
