//go:build linux

package netns

import (
	"errors"
	"net/netip"
	"time"

	"github.com/mdlayher/netlink"
	"github.com/ti-mo/conntrack"
	"golang.org/x/sys/unix"
)

const (
	tcpEstablished = 3
	tcpFinWait     = 4
	tcpClose       = 8
)

type FlowMatch struct {
	Destination netip.Addr
	Port        uint16
	ReplySource netip.Addr
	Closing     bool
}

type FlowReport struct {
	Total       int     `json:"total"`
	Matched     int     `json:"matched"`
	Established int     `json:"established"`
	UDP         int     `json:"udp"`
	Deleted     int     `json:"deleted"`
	Gone        int     `json:"gone"`
	Failed      int     `json:"failed"`
	DumpMS      float64 `json:"dump_ms"`
	DeleteMS    float64 `json:"delete_ms"`
}

func (m FlowMatch) matches(f conntrack.Flow) bool {
	if f.TupleReply.IP.SourceAddress != m.ReplySource {
		return false
	}
	if m.Destination.IsValid() && f.TupleOrig.IP.DestinationAddress != m.Destination {
		return false
	}
	if m.Port != 0 && f.TupleOrig.Proto.DestinationPort != m.Port {
		return false
	}
	if m.Closing {
		if f.TupleOrig.Proto.Protocol != unix.IPPROTO_TCP || f.ProtoInfo.TCP == nil {
			return false
		}
		return f.ProtoInfo.TCP.State >= tcpFinWait && f.ProtoInfo.TCP.State <= tcpClose
	}
	return true
}

func (n *Namespace) Flows(m FlowMatch, evict bool) (FlowReport, error) {
	return flows(&netlink.Config{NetNS: n.fd()}, m.matches, evict)
}

func anyOf(ms []FlowMatch) func(conntrack.Flow) bool {
	return func(f conntrack.Flow) bool {
		for _, m := range ms {
			if m.matches(f) {
				return true
			}
		}
		return false
	}
}

func flows(cfg *netlink.Config, match func(conntrack.Flow) bool, evict bool) (FlowReport, error) {
	var r FlowReport
	c, err := conntrack.Dial(cfg)
	if err != nil {
		return r, err
	}
	defer c.Close()
	start := time.Now()
	all, err := c.Dump(nil)
	if err != nil {
		return r, err
	}
	r.DumpMS = millis(time.Since(start))
	r.Total = len(all)
	var matched []conntrack.Flow
	for _, f := range all {
		if !match(f) {
			continue
		}
		matched = append(matched, f)
		switch f.TupleOrig.Proto.Protocol {
		case unix.IPPROTO_TCP:
			if f.ProtoInfo.TCP != nil && f.ProtoInfo.TCP.State == tcpEstablished {
				r.Established++
			}
		case unix.IPPROTO_UDP:
			r.UDP++
		}
	}
	r.Matched = len(matched)
	if !evict {
		return r, nil
	}
	start = time.Now()
	for _, f := range matched {
		if err := c.Delete(f); err != nil {
			if errors.Is(err, unix.ENOENT) {
				r.Gone++
			} else {
				r.Failed++
			}
			continue
		}
		r.Deleted++
	}
	r.DeleteMS = millis(time.Since(start))
	return r, nil
}

func millis(d time.Duration) float64 {
	return float64(d.Microseconds()) / 1000
}
