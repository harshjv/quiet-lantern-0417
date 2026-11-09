//go:build linux

package netns

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"net/netip"
	"slices"
	"strconv"
	"time"

	"github.com/google/nftables"
	"github.com/google/nftables/expr"
	"github.com/google/nftables/userdata"
	"github.com/mdlayher/netlink"
	"golang.org/x/sys/unix"
)

const (
	HostTableName     = "stationly_host"
	hostLayoutVersion = "1a.8"
	hostCommentPrefix = "stationly host "
	AcceptMark        = 0x10000
	regProto          = 9
	ctStatusDNAT      = 0x20

	WebNewConnectionRate  = 300
	WebNewConnectionBurst = 150
	WebSourceTableSize    = 65536
	WebSourceIdleTimeout  = time.Minute
)

var webPorts = []uint16{80, 443}

var hostTable = &nftables.Table{Name: HostTableName, Family: nftables.TableFamilyINet}

var concatAddrPort = nftables.MustConcatSetType(nftables.TypeIPAddr, nftables.TypeInetService)

type HostLayout struct {
	Public        netip.Addr
	IngressBridge string
	VirtualPrefix netip.Prefix
	Translated    []netip.Prefix
	EnvBridges    []string
	WebOpen       bool
	SourceRate    int
}

type HostElements struct {
	Ports  map[uint16]netip.AddrPort
	Switch map[netip.Addr]netip.Addr
}

func (l HostLayout) fingerprint() string {
	text := hostLayoutVersion + "|" + l.Public.String() + "|" + l.IngressBridge + "|" + l.VirtualPrefix.Masked().String() + "|" + strconv.FormatBool(l.WebOpen) + "|" + strconv.Itoa(l.SourceRate)
	for _, p := range l.Translated {
		text += "|" + p.Masked().String()
	}
	for _, b := range l.EnvBridges {
		text += "|" + b
	}
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:8])
}

func portSwitchMap() *nftables.Set {
	return &nftables.Set{Table: hostTable, Name: "port_switch", IsMap: true, KeyType: nftables.TypeInetService, DataType: concatAddrPort}
}

func hostVipTargets() *nftables.Set {
	return &nftables.Set{Table: hostTable, Name: "vip_targets", KeyType: nftables.TypeIPAddr}
}

func hostSwitchMap() *nftables.Set {
	return &nftables.Set{Table: hostTable, Name: "switch", IsMap: true, KeyType: nftables.TypeIPAddr, DataType: nftables.TypeIPAddr}
}

func translatedSet() *nftables.Set {
	return &nftables.Set{Table: hostTable, Name: "translated_dst", KeyType: nftables.TypeIPAddr, Interval: true}
}

func envBridgesSet() *nftables.Set {
	return &nftables.Set{Table: hostTable, Name: "env_bridges", KeyType: nftables.TypeIFName}
}

func webSourceSet(p uint16) *nftables.Set {
	return &nftables.Set{
		Table:      hostTable,
		Name:       "web_src_" + strconv.Itoa(int(p)),
		KeyType:    nftables.TypeIPAddr,
		Dynamic:    true,
		HasTimeout: true,
		Timeout:    WebSourceIdleTimeout,
		Size:       WebSourceTableSize,
	}
}

func webSourceSets(l HostLayout) map[uint16]*nftables.Set {
	if !l.Public.IsValid() || !l.WebOpen || l.SourceRate <= 0 {
		return nil
	}
	sets := map[uint16]*nftables.Set{}
	for _, p := range webPorts {
		sets[p] = webSourceSet(p)
	}
	return sets
}

func portKey(p uint16) []byte {
	return port(p)
}

func addrPortData(a netip.AddrPort) []byte {
	b := make([]byte, 8)
	copy(b, a.Addr().AsSlice())
	binary.BigEndian.PutUint16(b[4:], a.Port())
	return b
}

func SyncHost(l HostLayout, e HostElements) (Result, error) {
	c, err := nftables.New()
	if err != nil {
		return Unchanged, err
	}
	if state := layoutState(c, hostTable, "forward", hostCommentPrefix+l.fingerprint()); state != Unchanged {
		return state, writeHost(c, l, e)
	}
	changed, err := syncHostElements(c, e)
	if err != nil || !changed {
		return Unchanged, err
	}
	return Updated, nil
}

func RemoveHost() error {
	c, err := nftables.New()
	if err != nil {
		return err
	}
	tables, err := c.ListTablesOfFamily(nftables.TableFamilyINet)
	if err != nil {
		return err
	}
	for _, t := range tables {
		if t.Name == HostTableName {
			c.DelTable(hostTable)
			return c.Flush()
		}
	}
	return nil
}

func portElements(ports map[uint16]netip.AddrPort) []nftables.SetElement {
	keys := make([]uint16, 0, len(ports))
	for k := range ports {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	var out []nftables.SetElement
	for _, k := range keys {
		out = append(out, nftables.SetElement{Key: portKey(k), Val: addrPortData(ports[k])})
	}
	return out
}

func writeHost(c *nftables.Conn, l HostLayout, e HostElements) error {
	c.AddTable(hostTable)
	c.DelTable(hostTable)
	c.AddTable(hostTable)

	ports, targets, sw, translated, bridges := portSwitchMap(), hostVipTargets(), hostSwitchMap(), translatedSet(), envBridgesSet()
	var targetEls, switchEls, bridgeEls []nftables.SetElement
	for vip, real := range e.Switch {
		targetEls = append(targetEls, nftables.SetElement{Key: vip.AsSlice()})
		switchEls = append(switchEls, nftables.SetElement{Key: vip.AsSlice(), Val: real.AsSlice()})
	}
	for _, b := range l.EnvBridges {
		bridgeEls = append(bridgeEls, nftables.SetElement{Key: ifname(b)})
	}
	for _, set := range []struct {
		s   *nftables.Set
		els []nftables.SetElement
	}{
		{ports, portElements(e.Ports)},
		{targets, targetEls},
		{sw, switchEls},
		{translated, intervalElements(l.Translated)},
		{bridges, bridgeEls},
	} {
		if err := c.AddSet(set.s, set.els); err != nil {
			return err
		}
	}

	natPre := c.AddChain(&nftables.Chain{Name: "nat_pre", Table: hostTable, Type: nftables.ChainTypeNAT, Hooknum: nftables.ChainHookPrerouting, Priority: nftables.ChainPriorityRef(-100)})
	natOut := c.AddChain(&nftables.Chain{Name: "nat_out", Table: hostTable, Type: nftables.ChainTypeNAT, Hooknum: nftables.ChainHookOutput, Priority: nftables.ChainPriorityRef(-100)})
	markPre := c.AddChain(&nftables.Chain{Name: "mark_pre", Table: hostTable, Type: nftables.ChainTypeFilter, Hooknum: nftables.ChainHookPrerouting, Priority: nftables.ChainPriorityRef(-1)})
	forward := c.AddChain(&nftables.Chain{Name: "forward", Table: hostTable, Type: nftables.ChainTypeFilter, Hooknum: nftables.ChainHookForward, Priority: nftables.ChainPriorityRef(-1)})

	if l.Public.IsValid() {
		portDNAT := func() []expr.Any {
			return append(ipv4(),
				daddr(),
				&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: l.Public.AsSlice()},
				&expr.Meta{Key: expr.MetaKeyL4PROTO, Register: 1},
				&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte{unix.IPPROTO_TCP}},
				&expr.Payload{DestRegister: 1, Base: expr.PayloadBaseTransportHeader, Offset: 2, Len: 2},
				&expr.Lookup{SourceRegister: 1, DestRegister: 1, IsDestRegSet: true, SetName: ports.Name, SetID: ports.ID},
				&expr.NAT{Type: expr.NATTypeDestNAT, Family: unix.NFPROTO_IPV4, RegAddrMin: 1, RegProtoMin: regProto, Specified: true},
			)
		}
		c.AddRule(&nftables.Rule{Table: hostTable, Chain: natPre, Exprs: portDNAT()})
		c.AddRule(&nftables.Rule{Table: hostTable, Chain: natOut, Exprs: portDNAT()})
	}
	if l.IngressBridge != "" {
		c.AddRule(&nftables.Rule{Table: hostTable, Chain: natPre, Exprs: append([]expr.Any{
			&expr.Meta{Key: expr.MetaKeyIIFNAME, Register: 1},
			&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: ifname(l.IngressBridge)},
		}, append(ipv4(),
			daddr(),
			lookup(targets, false),
			daddr(),
			&expr.Lookup{SourceRegister: 1, DestRegister: 1, IsDestRegSet: true, SetName: sw.Name, SetID: sw.ID},
			&expr.Counter{},
			&expr.NAT{Type: expr.NATTypeDestNAT, Family: unix.NFPROTO_IPV4, RegAddrMin: 1},
		)...)})
	}

	c.AddRule(&nftables.Rule{Table: hostTable, Chain: markPre, Exprs: append([]expr.Any{
		&expr.Ct{Register: 1, Key: expr.CtKeySTATUS},
		&expr.Bitwise{SourceRegister: 1, DestRegister: 1, Len: 4, Mask: binaryNative(ctStatusDNAT), Xor: []byte{0, 0, 0, 0}},
		&expr.Cmp{Op: expr.CmpOpNeq, Register: 1, Data: []byte{0, 0, 0, 0}},
	}, append(ipv4(),
		daddr(),
		lookup(translated, false),
		&expr.Meta{Key: expr.MetaKeyMARK, Register: 1},
		&expr.Bitwise{SourceRegister: 1, DestRegister: 1, Len: 4, Mask: binaryNative(^uint32(AcceptMark)), Xor: binaryNative(AcceptMark)},
		&expr.Meta{Key: expr.MetaKeyMARK, SourceRegister: true, Register: 1},
		&expr.Counter{},
	)...)})

	sources := webSourceSets(l)
	for _, p := range webPorts {
		if set, ok := sources[p]; ok {
			if err := c.AddSet(set, nil); err != nil {
				return err
			}
		}
	}

	forwardRules := hostForwardRules(l, bridges, sources)
	for i, exprs := range forwardRules {
		r := &nftables.Rule{Table: hostTable, Chain: forward, Exprs: exprs}
		if i == 0 {
			r.UserData = userdata.AppendString(nil, userdata.TypeComment, hostCommentPrefix+l.fingerprint())
		}
		c.AddRule(r)
	}
	return c.Flush()
}

func hostForwardRules(l HostLayout, bridges *nftables.Set, sources map[uint16]*nftables.Set) [][]expr.Any {
	var forwardRules [][]expr.Any
	if l.IngressBridge != "" && l.VirtualPrefix.IsValid() {
		forwardRules = append(forwardRules, append([]expr.Any{
			&expr.Meta{Key: expr.MetaKeyIIFNAME, Register: 1},
			&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: ifname(l.IngressBridge)},
		}, append(ipv4(),
			daddr(),
			&expr.Bitwise{SourceRegister: 1, DestRegister: 1, Len: 4, Mask: mask(l.VirtualPrefix), Xor: []byte{0, 0, 0, 0}},
			&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: l.VirtualPrefix.Masked().Addr().AsSlice()},
			&expr.Meta{Key: expr.MetaKeyL4PROTO, Register: 1},
			&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte{unix.IPPROTO_TCP}},
			&expr.Counter{},
			&expr.Reject{Type: unix.NFT_REJECT_TCP_RST},
		)...), append([]expr.Any{
			&expr.Meta{Key: expr.MetaKeyIIFNAME, Register: 1},
			&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: ifname(l.IngressBridge)},
		}, append(ipv4(),
			daddr(),
			&expr.Bitwise{SourceRegister: 1, DestRegister: 1, Len: 4, Mask: mask(l.VirtualPrefix), Xor: []byte{0, 0, 0, 0}},
			&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: l.VirtualPrefix.Masked().Addr().AsSlice()},
			&expr.Counter{},
			verdict(expr.VerdictDrop),
		)...))
	}
	if l.Public.IsValid() {
		for _, p := range webPorts {
			match := append(ipv4(),
				&expr.Ct{Register: 1, Key: expr.CtKeyDSTIP, Direction: 0},
				&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: l.Public.AsSlice()},
				&expr.Meta{Key: expr.MetaKeyL4PROTO, Register: 1},
				&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte{unix.IPPROTO_TCP}},
				&expr.Ct{Register: 1, Key: expr.CtKeyPROTODST, Direction: 0},
				&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: port(p)},
			)
			if !l.WebOpen {
				forwardRules = append(forwardRules, append(match, &expr.Counter{}, verdict(expr.VerdictDrop)))
				continue
			}
			match = append(match,
				&expr.Ct{Register: 1, Key: expr.CtKeySTATE},
				&expr.Bitwise{SourceRegister: 1, DestRegister: 1, Len: 4, Mask: binaryNative(expr.CtStateBitNEW), Xor: []byte{0, 0, 0, 0}},
				&expr.Cmp{Op: expr.CmpOpNeq, Register: 1, Data: []byte{0, 0, 0, 0}},
			)
			if src, ok := sources[p]; ok {
				forwardRules = append(forwardRules, append(slices.Clone(match),
					saddr(),
					&expr.Dynset{
						SrcRegKey: 1,
						SetName:   src.Name,
						SetID:     src.ID,
						Operation: unix.NFT_DYNSET_OP_UPDATE,
						Timeout:   WebSourceIdleTimeout,
						Exprs:     []expr.Any{&expr.Limit{Type: expr.LimitTypePkts, Rate: uint64(l.SourceRate), Unit: expr.LimitTimeSecond, Burst: uint32(2 * l.SourceRate), Over: true}},
					},
					&expr.Counter{},
					verdict(expr.VerdictDrop),
				))
			}
			forwardRules = append(forwardRules, append(match,
				&expr.Limit{Type: expr.LimitTypePkts, Rate: WebNewConnectionRate, Unit: expr.LimitTimeSecond, Burst: WebNewConnectionBurst, Over: true},
				&expr.Counter{},
				verdict(expr.VerdictDrop),
			))
		}
	}
	for _, b := range l.EnvBridges {
		forwardRules = append(forwardRules, []expr.Any{
			&expr.Meta{Key: expr.MetaKeyIIFNAME, Register: 1},
			&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: ifname(b)},
			&expr.Meta{Key: expr.MetaKeyOIFNAME, Register: 1},
			lookup(bridges, false),
			&expr.Meta{Key: expr.MetaKeyOIFNAME, Register: 1},
			&expr.Cmp{Op: expr.CmpOpNeq, Register: 1, Data: ifname(b)},
			&expr.Counter{},
			verdict(expr.VerdictDrop),
		})
	}
	return append(forwardRules, []expr.Any{&expr.Counter{}})
}

func syncHostElements(c *nftables.Conn, e HostElements) (bool, error) {
	ports := portSwitchMap()
	havePorts, err := c.GetSetElements(ports)
	if err != nil {
		return false, err
	}
	current := map[uint16]netip.AddrPort{}
	for _, el := range havePorts {
		if len(el.Key) < 2 || len(el.Val) < 6 {
			continue
		}
		a, _ := netip.AddrFromSlice(el.Val[:4])
		current[binary.BigEndian.Uint16(el.Key[:2])] = netip.AddrPortFrom(a, binary.BigEndian.Uint16(el.Val[4:6]))
	}
	var delPorts, addPorts []nftables.SetElement
	for p, have := range current {
		if want, ok := e.Ports[p]; !ok || want != have {
			delPorts = append(delPorts, nftables.SetElement{Key: portKey(p)})
		}
	}
	for p, want := range e.Ports {
		if have, ok := current[p]; !ok || have != want {
			addPorts = append(addPorts, nftables.SetElement{Key: portKey(p), Val: addrPortData(want)})
		}
	}

	sw, targets := hostSwitchMap(), hostVipTargets()
	haveSwitch, err := c.GetSetElements(sw)
	if err != nil {
		return false, err
	}
	haveSw := map[netip.Addr]netip.Addr{}
	for _, el := range haveSwitch {
		haveSw[addrOf(el.Key)] = addrOf(el.Val)
	}
	haveTargets, err := c.GetSetElements(targets)
	if err != nil {
		return false, err
	}
	targetSet := map[netip.Addr]bool{}
	for _, el := range haveTargets {
		targetSet[addrOf(el.Key)] = true
	}
	var delSwitch, addSwitch, delTargets, addTargets []nftables.SetElement
	for vip, real := range haveSw {
		if want, ok := e.Switch[vip]; !ok || want != real {
			delSwitch = append(delSwitch, nftables.SetElement{Key: vip.AsSlice()})
		}
	}
	for vip, want := range e.Switch {
		if have, ok := haveSw[vip]; !ok || have != want {
			addSwitch = append(addSwitch, nftables.SetElement{Key: vip.AsSlice(), Val: want.AsSlice()})
		}
		if !targetSet[vip] {
			addTargets = append(addTargets, nftables.SetElement{Key: vip.AsSlice()})
		}
	}
	for vip := range targetSet {
		if _, ok := e.Switch[vip]; !ok {
			delTargets = append(delTargets, nftables.SetElement{Key: vip.AsSlice()})
		}
	}
	changed := false
	for _, op := range []struct {
		set *nftables.Set
		els []nftables.SetElement
		del bool
	}{{ports, delPorts, true}, {sw, delSwitch, true}, {targets, delTargets, true}, {targets, addTargets, false}, {sw, addSwitch, false}, {ports, addPorts, false}} {
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

func HostFlows(ms []FlowMatch, evict bool) (FlowReport, error) {
	return flows(&netlink.Config{}, anyOf(ms), evict)
}
