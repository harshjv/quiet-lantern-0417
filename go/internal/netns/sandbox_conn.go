//go:build linux

package netns

import (
	"context"
	"errors"
	"net/netip"
	"time"

	"github.com/google/nftables"
	"github.com/mdlayher/socket"
	"golang.org/x/sys/unix"
)

const SandboxDialTimeout = 5 * time.Second

type StreamConn struct {
	c *socket.Conn
}

func (n *Namespace) DialSandbox(ctx context.Context, port uint16) (*StreamConn, error) {
	pc, err := n.ProbeSocket(false)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, SandboxDialTimeout)
	defer cancel()
	if err := pc.Connect(ctx, netip.AddrPortFrom(SandboxLink, port)); err != nil {
		return nil, errors.Join(err, pc.Close())
	}
	return &StreamConn{c: pc.c}, nil
}

func (s *StreamConn) Read(b []byte) (int, error) {
	return s.c.Read(b)
}

func (s *StreamConn) Write(b []byte) (int, error) {
	return s.c.Write(b)
}

func (s *StreamConn) CloseWrite() error {
	return s.c.Shutdown(unix.SHUT_WR)
}

func (s *StreamConn) Close() error {
	return s.c.Close()
}

func (n *Namespace) ReadRefused() ([]Refused, error) {
	c, err := nftables.New(nftables.WithNetNSFd(n.fd()))
	if err != nil {
		return nil, err
	}
	els, err := c.GetSetElements(refusedSet())
	if err != nil {
		return nil, err
	}
	return decodeRefused(els), nil
}
