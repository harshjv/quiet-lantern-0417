//go:build linux

package netns

import (
	"errors"
	"net"
	"os"

	"github.com/mdlayher/socket"
	"golang.org/x/sys/unix"
)

func (n *Namespace) ListenRelay(port uint16) (net.Listener, error) {
	c, err := socket.Socket(unix.AF_INET, unix.SOCK_STREAM, 0, "relay", &socket.Config{NetNS: n.fd()})
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
	f := os.NewFile(uintptr(fd), "relay")
	if f == nil {
		return nil, errors.New("wrap the relay socket")
	}
	defer f.Close()
	return net.FileListener(f)
}
