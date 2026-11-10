//go:build linux

package netns

import (
	"crypto/sha256"
	"encoding/hex"
	"net/netip"
	"time"

	"github.com/google/nftables"
	"github.com/google/nftables/userdata"

	"github.com/harshjv/stationly/go/internal/protocol"
)

const (
	TableName     = protocol.NftTableName
	layoutVersion = "1a.3"
	commentPrefix = "stationly baseline "
)

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
	return n.syncTable(commentPrefix+b.fingerprint(), e, func(c *nftables.Conn, sw map[netip.Addr]netip.Addr) error {
		return write(c, b, e.HostAddrs, sw, e.Reject)
	})
}

func (n *Namespace) syncTable(comment string, e Elements, rewrite func(*nftables.Conn, map[netip.Addr]netip.Addr) error) (Result, error) {
	c, err := nftables.New(nftables.WithNetNSFd(n.fd()))
	if err != nil {
		return Unchanged, err
	}
	if state := layoutState(c, table, "egress", comment); state != Unchanged {
		kept, _ := readAddrMap(c, switchMap())
		return state, rewrite(c, resolve(e, kept))
	}
	return elementsResult(syncElements(c, e))
}

func elementsResult(changed bool, err error) (Result, error) {
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
		if realAddr, ok := have[vip]; ok {
			out[vip] = realAddr
		}
	}
	for _, vip := range e.Reject {
		delete(out, vip)
	}
	return out
}

func syncElements(c *nftables.Conn, e Elements) (bool, error) {
	changed, err := syncIntervals(c, hostAddrsSet(), e.HostAddrs)
	if err != nil {
		return false, err
	}
	sw, targets, rejects := switchMap(), vipTargetsSet(), switchRejectSet()
	current, err := readAddrMap(c, sw)
	if err != nil {
		return false, err
	}
	haveTargets, err := readAddrs(c, targets)
	if err != nil {
		return false, err
	}
	haveRejects, err := readAddrs(c, rejects)
	if err != nil {
		return false, err
	}
	want := resolve(e, current)
	delSwitch, addSwitch := diffElements(current, want, addrKey, addrKey)
	delTargets, addTargets := diffElements(haveTargets, keysOf(want), addrKey, nil)
	delReject, addReject := diffElements(haveRejects, addrsOf(e.Reject), addrKey, nil)
	return applySetOps(c, changed,
		setOp{sw, delSwitch, true}, setOp{targets, delTargets, true}, setOp{rejects, delReject, true},
		setOp{rejects, addReject, false}, setOp{targets, addTargets, false}, setOp{sw, addSwitch, false})
}
