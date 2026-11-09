//go:build linux

package netns

import (
	"encoding/binary"
	"fmt"
	"net/netip"
	"os"
	"strconv"
	"syscall"
	"time"

	"github.com/google/nftables"
)

type Refused struct {
	Address netip.Addr
	Proto   uint8
	Port    uint16
	Count   uint64
	Expires time.Duration
}

type RefusedReader struct {
	c *nftables.Conn
}

func OpenRefused(pid int, inode uint64) (*RefusedReader, error) {
	if pid <= 0 {
		return nil, fmt.Errorf("no process for the namespace")
	}
	f, err := os.Open(path(pid))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var st syscall.Stat_t
	if err := syscall.Fstat(int(f.Fd()), &st); err != nil {
		return nil, err
	}
	if inode != 0 && st.Ino != inode {
		return nil, fmt.Errorf("namespace of pid %s is %d, not %d", strconv.Itoa(pid), st.Ino, inode)
	}
	c, err := nftables.New(nftables.WithNetNSFd(int(f.Fd())), nftables.AsLasting())
	if err != nil {
		return nil, err
	}
	return &RefusedReader{c: c}, nil
}

func (r *RefusedReader) Close() error {
	return r.c.CloseLasting()
}

func (r *RefusedReader) Read() ([]Refused, bool, error) {
	els, err := r.c.GetSetElements(refusedSet())
	if err != nil {
		return nil, false, err
	}
	return decodeRefused(els), true, nil
}

func decodeRefused(els []nftables.SetElement) []Refused {
	out := make([]Refused, 0, len(els))
	for _, el := range els {
		if len(el.Key) < 10 {
			continue
		}
		a, _ := netip.AddrFromSlice(el.Key[0:4])
		e := Refused{Address: a, Proto: el.Key[4], Port: binary.BigEndian.Uint16(el.Key[8:10]), Expires: el.Expires}
		if el.Counter != nil {
			e.Count = el.Counter.Packets
		}
		out = append(out, e)
	}
	return out
}
