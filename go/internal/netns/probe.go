//go:build linux

package netns

import (
	"context"
	"net/netip"

	"github.com/mdlayher/socket"
	"golang.org/x/sys/unix"
)

type ProbeConn struct {
	c *socket.Conn
}

func (n *Namespace) ProbeSocket(udp bool) (*ProbeConn, error) {
	typ := unix.SOCK_STREAM
	if udp {
		typ = unix.SOCK_DGRAM
	}
	c, err := socket.Socket(unix.AF_INET, typ, 0, "probe", &socket.Config{NetNS: n.fd()})
	if err != nil {
		return nil, err
	}
	return &ProbeConn{c: c}, nil
}

func (p *ProbeConn) Connect(ctx context.Context, to netip.AddrPort) error {
	_, err := p.c.Connect(ctx, &unix.SockaddrInet4{Port: int(to.Port()), Addr: to.Addr().As4()})
	return err
}

func (p *ProbeConn) Local() netip.AddrPort {
	sa, err := p.c.Getsockname()
	if err != nil {
		return netip.AddrPort{}
	}
	if s4, ok := sa.(*unix.SockaddrInet4); ok {
		return netip.AddrPortFrom(netip.AddrFrom4(s4.Addr), uint16(s4.Port))
	}
	return netip.AddrPort{}
}

func (p *ProbeConn) Write(ctx context.Context, b []byte) (int, error) {
	return p.c.WriteContext(ctx, b)
}

func (p *ProbeConn) Read(ctx context.Context, b []byte) (int, error) {
	return p.c.ReadContext(ctx, b)
}

func (p *ProbeConn) Close() error {
	return p.c.Close()
}
