//go:build linux

package netns

import (
	"crypto/sha256"
	"encoding/hex"
	"net/netip"
	"time"

	"github.com/google/nftables"
	"github.com/google/nftables/userdata"
)

const (
	TableName     = "stationly"
	layoutVersion = "1a.3"
	commentPrefix = "stationly baseline "
)

var PrivateRanges = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("224.0.0.0/4"),
	netip.MustParsePrefix("240.0.0.0/4"),
}

type Baseline struct {
	Resolver netip.Addr
	Self     netip.Addr
	Subnet   netip.Prefix
	Allow    []netip.AddrPort
}

type Elements struct {
	HostAddrs []netip.Prefix
	Switch    map[netip.Addr]netip.Addr
	Pending   []netip.Addr
	Reject    []netip.Addr
}

type Result string

const (
	Unchanged Result = "unchanged"
	Updated   Result = "elements"
	Rewritten Result = "rewritten"
	Created   Result = "created"
)

func layoutState(c *nftables.Conn, t *nftables.Table, chain, comment string) Result {
	rules, err := c.GetRules(t, &nftables.Chain{Name: chain, Table: t})
	if err != nil || len(rules) == 0 {
		return Created
	}
	if have, ok := userdata.GetString(rules[0].UserData, userdata.TypeComment); ok && have == comment {
		return Unchanged
	}
	return Rewritten
}

func (b Baseline) fingerprint() string {
	text := layoutVersion + "|" + b.Resolver.String() + "|" + b.Self.String() + "|" + b.Subnet.Masked().String()
	for _, a := range b.Allow {
		text += "|" + a.String()
	}
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:8])
}

var table = &nftables.Table{Name: TableName, Family: nftables.TableFamilyINet}

func hostAddrsSet() *nftables.Set {
	return &nftables.Set{Table: table, Name: "host_addrs", KeyType: nftables.TypeIPAddr, Interval: true}
}

func privateRangesSet() *nftables.Set {
	return &nftables.Set{Table: table, Name: "private_ranges", KeyType: nftables.TypeIPAddr, Interval: true}
}

func vipTargetsSet() *nftables.Set {
	return &nftables.Set{Table: table, Name: "vip_targets", KeyType: nftables.TypeIPAddr}
}

func switchRejectSet() *nftables.Set {
	return &nftables.Set{Table: table, Name: "switch_reject", KeyType: nftables.TypeIPAddr}
}

const (
	RefusedSize    = 256
	RefusedTimeout = 10 * time.Minute
)

var refusedKey = nftables.MustConcatSetType(nftables.TypeIPAddr, nftables.TypeInetProto, nftables.TypeInetService)

func refusedSet() *nftables.Set {
	return &nftables.Set{Table: table, Name: "refused", KeyType: refusedKey, Concatenation: true, Dynamic: true, HasTimeout: true, Timeout: RefusedTimeout, Counter: true, Size: RefusedSize}
}

func switchMap() *nftables.Set {
	return &nftables.Set{Table: table, Name: "switch", IsMap: true, KeyType: nftables.TypeIPAddr, DataType: nftables.TypeIPAddr}
}

func (n *Namespace) Sync(b Baseline, e Elements) (Result, error) {
	c, err := nftables.New(nftables.WithNetNSFd(n.fd()))
	if err != nil {
		return Unchanged, err
	}
	if state := layoutState(c, table, "egress", commentPrefix+b.fingerprint()); state != Unchanged {
		kept := map[netip.Addr]netip.Addr{}
		if have, err := c.GetSetElements(switchMap()); err == nil {
			for _, el := range have {
				kept[addrOf(el.Key)] = addrOf(el.Val)
			}
		}
		return state, write(c, b, e.HostAddrs, resolve(e, kept), e.Reject)
	}
	changed, err := syncElements(c, e)
	if err != nil || !changed {
		return Unchanged, err
	}
	return Updated, nil
}

func resolve(e Elements, have map[netip.Addr]netip.Addr) map[netip.Addr]netip.Addr {
	out := map[netip.Addr]netip.Addr{}
	for vip, real := range e.Switch {
		out[vip] = real
	}
	for _, vip := range e.Pending {
		if real, ok := have[vip]; ok {
			out[vip] = real
		}
	}
	for _, vip := range e.Reject {
		delete(out, vip)
	}
	return out
}

func syncElements(c *nftables.Conn, e Elements) (bool, error) {
	changed := false
	hosts := hostAddrsSet()
	haveHosts, err := c.GetSetElements(hosts)
	if err != nil {
		return false, err
	}
	wantHosts := intervalElements(e.HostAddrs)
	if !sameIntervals(haveHosts, wantHosts) {
		c.FlushSet(hosts)
		if len(wantHosts) > 0 {
			if err := c.SetAddElements(hosts, wantHosts); err != nil {
				return false, err
			}
		}
		changed = true
	}

	sw, targets := switchMap(), vipTargetsSet()
	haveSwitch, err := c.GetSetElements(sw)
	if err != nil {
		return false, err
	}
	haveTargets, err := c.GetSetElements(targets)
	if err != nil {
		return false, err
	}
	current := map[netip.Addr]netip.Addr{}
	for _, el := range haveSwitch {
		current[addrOf(el.Key)] = addrOf(el.Val)
	}
	targetSet := map[netip.Addr]bool{}
	for _, el := range haveTargets {
		targetSet[addrOf(el.Key)] = true
	}
	want := resolve(e, current)

	var delSwitch, addSwitch, delTargets, addTargets []nftables.SetElement
	for vip, real := range current {
		if w, ok := want[vip]; !ok || w != real {
			delSwitch = append(delSwitch, nftables.SetElement{Key: vip.AsSlice()})
		}
	}
	for vip, real := range want {
		if have, ok := current[vip]; !ok || have != real {
			addSwitch = append(addSwitch, nftables.SetElement{Key: vip.AsSlice(), Val: real.AsSlice()})
		}
		if !targetSet[vip] {
			addTargets = append(addTargets, nftables.SetElement{Key: vip.AsSlice()})
		}
	}
	for vip := range targetSet {
		if _, ok := want[vip]; !ok {
			delTargets = append(delTargets, nftables.SetElement{Key: vip.AsSlice()})
		}
	}
	rejects := switchRejectSet()
	haveReject, err := c.GetSetElements(rejects)
	if err != nil {
		return false, err
	}
	rejectSet := map[netip.Addr]bool{}
	for _, el := range haveReject {
		rejectSet[addrOf(el.Key)] = true
	}
	wantReject := map[netip.Addr]bool{}
	var delReject, addReject []nftables.SetElement
	for _, vip := range e.Reject {
		wantReject[vip] = true
		if !rejectSet[vip] {
			addReject = append(addReject, nftables.SetElement{Key: vip.AsSlice()})
		}
	}
	for vip := range rejectSet {
		if !wantReject[vip] {
			delReject = append(delReject, nftables.SetElement{Key: vip.AsSlice()})
		}
	}
	for _, op := range []struct {
		set *nftables.Set
		els []nftables.SetElement
		del bool
	}{{sw, delSwitch, true}, {targets, delTargets, true}, {rejects, delReject, true}, {rejects, addReject, false}, {targets, addTargets, false}, {sw, addSwitch, false}} {
		if len(op.els) == 0 {
			continue
		}
		changed = true
		var err error
		if op.del {
			err = c.SetDeleteElements(op.set, op.els)
		} else {
			err = c.SetAddElements(op.set, op.els)
		}
		if err != nil {
			return false, err
		}
	}
	if !changed {
		return false, nil
	}
	return true, c.Flush()
}

func addrOf(b []byte) netip.Addr {
	a, _ := netip.AddrFromSlice(b)
	return a.Unmap()
}
