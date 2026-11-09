//go:build linux

package flows

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"time"

	"github.com/mdlayher/socket"
	"golang.org/x/sys/unix"
)

const (
	getBatch     = 500
	getTimeout   = 2 * time.Second
	getRcvBuffer = 1 << 20
)

type getter struct {
	c        *socket.Conn
	seq      uint32
	buf      []byte
	req      []byte
	answered []bool
}

func dialNetfilter(nsfd int, name string) (*socket.Conn, error) {
	c, err := socket.Socket(unix.AF_NETLINK, unix.SOCK_RAW, unix.NETLINK_NETFILTER, name, &socket.Config{NetNS: nsfd})
	if err != nil {
		return nil, err
	}
	return c, nil
}

func newGetter(nsfd int) (*getter, error) {
	c, err := dialNetfilter(nsfd, "conntrack-get")
	if err != nil {
		return nil, err
	}
	if err := c.SetsockoptInt(unix.SOL_SOCKET, unix.SO_RCVBUFFORCE, getRcvBuffer); err != nil {
		c.Close()
		return nil, err
	}
	if err := c.Bind(&unix.SockaddrNetlink{Family: unix.AF_NETLINK}); err != nil {
		c.Close()
		return nil, err
	}
	return &getter{c: c, buf: make([]byte, 64<<10)}, nil
}

func (g *getter) close() error {
	return g.c.Close()
}

type getResult struct {
	msg message
	err unix.Errno
}

func (g *getter) roundTrip(n int, fill func(b []byte, seq uint32, i int) []byte, out []getResult) error {
	g.req = g.req[:0]
	base := g.seq + 1
	for i := range n {
		g.seq++
		g.req = fill(g.req, g.seq, i)
	}
	ctx := context.Background()
	if err := g.c.SetDeadline(time.Now().Add(getTimeout)); err != nil {
		return err
	}
	defer g.c.SetDeadline(time.Time{})
	if err := g.c.Sendto(ctx, g.req, 0, &unix.SockaddrNetlink{Family: unix.AF_NETLINK}); err != nil {
		return err
	}
	if cap(g.answered) < n {
		g.answered = make([]bool, n)
	}
	answered := g.answered[:n]
	clear(answered)
	left := n
	for left > 0 {
		got, err := g.c.ReadContext(ctx, g.buf)
		if err != nil {
			return err
		}
		messages(g.buf[:got], func(m []byte) {
			i := int(binary.NativeEndian.Uint32(m[8:]) - base)
			if i < 0 || i >= n || answered[i] {
				return
			}
			answered[i] = true
			left--
			if binary.NativeEndian.Uint16(m[4:]) == unix.NLMSG_ERROR {
				if len(m) >= nlmsgHeaderLen+4 {
					out[i].err = unix.Errno(-int32(binary.NativeEndian.Uint32(m[nlmsgHeaderLen:])))
				}
				return
			}
			if !decode(m, &out[i].msg) {
				out[i].err = unix.EPROTO
			}
		})
	}
	return nil
}

func (g *getter) get(tuples []Tuple, which uint16, out []getResult) error {
	for start := 0; start < len(tuples); start += getBatch {
		end := min(start+getBatch, len(tuples))
		part := tuples[start:end]
		if err := g.roundTrip(len(part), func(b []byte, seq uint32, i int) []byte {
			return tupleAttr(header(b, msgGet, unix.AF_INET, seq, tupleAttrLen), which, part[i])
		}, out[start:end]); err != nil {
			return err
		}
	}
	return nil
}

func (g *getter) entries() (int, error) {
	g.seq++
	seq := g.seq
	g.req = header(g.req[:0], msgGetStats, unix.AF_UNSPEC, seq, 0)
	ctx := context.Background()
	if err := g.c.SetDeadline(time.Now().Add(getTimeout)); err != nil {
		return 0, err
	}
	defer g.c.SetDeadline(time.Time{})
	if err := g.c.Sendto(ctx, g.req, 0, &unix.SockaddrNetlink{Family: unix.AF_NETLINK}); err != nil {
		return 0, err
	}
	for {
		n, err := g.c.ReadContext(ctx, g.buf)
		if err != nil {
			return 0, err
		}
		count, found, err := statsReply(g.buf[:n], seq)
		if found || err != nil {
			return count, err
		}
	}
}

func statsReply(b []byte, seq uint32) (int, bool, error) {
	var count int
	var found bool
	var failure error
	messages(b, func(m []byte) {
		if found || binary.NativeEndian.Uint32(m[8:]) != seq {
			return
		}
		found = true
		if binary.NativeEndian.Uint16(m[4:]) == unix.NLMSG_ERROR && len(m) >= nlmsgHeaderLen+4 {
			failure = fmt.Errorf("conntrack stats: %w", unix.Errno(-int32(binary.NativeEndian.Uint32(m[nlmsgHeaderLen:]))))
			return
		}
		failure = errors.New("conntrack stats reply carries no entry count")
		if len(m) < headerLen {
			return
		}
		walk(m[headerLen:], func(typ uint16, v []byte) {
			if typ == ctaStatsGlobalEntries && len(v) >= 4 {
				count, failure = int(binary.BigEndian.Uint32(v)), nil
			}
		})
	})
	return count, found, failure
}
