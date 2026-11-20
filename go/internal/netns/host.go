//go:build linux

package netns

import (
	"crypto/sha256"
	"encoding/hex"
	"net/netip"
	"os"
	"slices"

	"github.com/google/nftables"
	"github.com/google/nftables/expr"
	"github.com/mdlayher/netlink"
	"golang.org/x/sys/unix"

	"github.com/harshjv/stationly/go/internal/protocol"
)

const (
	HostTableName     = protocol.NftTablePrefix + "host"
	hostLayoutVersion = "1a.9"
	hostCommentPrefix = "stationly host "
	AcceptMark        = 0x10000
	regProto          = 9
)

var WebPorts = []uint16{80, 443}

var hostTable = &nftables.Table{Name: HostTableName, Family: nftables.TableFamilyINet}

var concatAddrPort = nftables.MustConcatSetType(nftables.TypeIPAddr, nftables.TypeInetService)

type HostLayout struct {
	IngressBridge string
	VirtualPrefix netip.Prefix
	Translated    []netip.Prefix
	EnvBridges    []string
}

type HostElements struct {
	Switch map[netip.Addr]netip.Addr
}

func (l HostLayout) fingerprint() string {
	text := hostLayoutVersion + "|" + l.IngressBridge + "|" + l.VirtualPrefix.Masked().String()
	for _, p := range l.Translated {
		text += "|" + p.Masked().String()
	}
	for _, b := range l.EnvBridges {
		text += "|" + b
	}
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:8])
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

func SyncHost(l HostLayout, e HostElements) (Result, error) {
	c, err := nftables.New()
	if err != nil {
		return Unchanged, err
	}
	if state := layoutState(c, hostTable, "forward", hostCommentPrefix+l.fingerprint()); state != Unchanged {
		return state, writeHost(c, l, e)
	}
	return elementsResult(syncHostElements(c, e))
}

func writeHost(c *nftables.Conn, l HostLayout, e HostElements) error {
	targets, sw, translated, bridges := hostVipTargets(), hostSwitchMap(), translatedSet(), envBridgesSet()
	targetEls, switchEls := switchElements(e.Switch)
	var bridgeEls []nftables.SetElement
	for _, b := range l.EnvBridges {
		bridgeEls = append(bridgeEls, nftables.SetElement{Key: ifname(b)})
	}
	if err := resetTable(c, hostTable, []setEls{
		{targets, targetEls},
		{sw, switchEls},
		{translated, intervalElements(l.Translated)},
		{bridges, bridgeEls},
	}); err != nil {
		return err
	}

	natPre := c.AddChain(&nftables.Chain{Name: "nat_pre", Table: hostTable, Type: nftables.ChainTypeNAT, Hooknum: nftables.ChainHookPrerouting, Priority: nftables.ChainPriorityRef(-100)})
	markPre := c.AddChain(&nftables.Chain{Name: "mark_pre", Table: hostTable, Type: nftables.ChainTypeFilter, Hooknum: nftables.ChainHookPrerouting, Priority: nftables.ChainPriorityRef(-1)})
	input := c.AddChain(&nftables.Chain{Name: "input", Table: hostTable, Type: nftables.ChainTypeFilter, Hooknum: nftables.ChainHookInput, Priority: nftables.ChainPriorityRef(-1)})
	forward := c.AddChain(&nftables.Chain{Name: "forward", Table: hostTable, Type: nftables.ChainTypeFilter, Hooknum: nftables.ChainHookForward, Priority: nftables.ChainPriorityRef(-1)})

	if l.IngressBridge != "" {
		c.AddRule(&nftables.Rule{Table: hostTable, Chain: natPre, Exprs: append(iifExprs(l.IngressBridge, false), switchDNAT(targets, sw)...)})
	}

	c.AddRule(&nftables.Rule{Table: hostTable, Chain: markPre, Exprs: append(ctDNAT(), append(ipv4(),
		daddr(),
		lookup(translated, false),
		&expr.Meta{Key: expr.MetaKeyMARK, Register: 1},
		&expr.Bitwise{SourceRegister: 1, DestRegister: 1, Len: 4, Mask: binaryNative(^uint32(AcceptMark)), Xor: binaryNative(AcceptMark)},
		&expr.Meta{Key: expr.MetaKeyMARK, SourceRegister: true, Register: 1},
		&expr.Counter{},
	)...)})

	for _, r := range hostInputRules() {
		c.AddRule(&nftables.Rule{Table: hostTable, Chain: input, Exprs: r})
	}
	addFingerprinted(c, forward, hostForwardRules(l, bridges), hostCommentPrefix+l.fingerprint())
	return c.Flush()
}

func tcp() []expr.Any {
	return []expr.Any{
		&expr.Meta{Key: expr.MetaKeyL4PROTO, Register: 1},
		&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte{unix.IPPROTO_TCP}},
	}
}

func hostInputRules() [][]expr.Any {
	var out [][]expr.Any
	for _, p := range WebPorts {
		out = append(out, slices.Concat(
			iifExprs("lo", true),
			tcp(),
			[]expr.Any{
				&expr.Payload{DestRegister: 1, Base: expr.PayloadBaseTransportHeader, Offset: 2, Len: 2},
				&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: port(p)},
				&expr.Counter{},
				verdict(expr.VerdictDrop),
			},
		))
	}
	return out
}

func HostWebListeners() ([]Socket, error) {
	var out []Socket
	for _, file := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		socks, err := procSockets(file, "tcp", tcpListen)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return out, err
		}
		for _, s := range socks {
			if slices.Contains(WebPorts, s.Port) && !s.Address.IsLoopback() && !slices.Contains(out, s) {
				out = append(out, s)
			}
		}
	}
	return out, nil
}

func WebPortDrops() ([]uint16, error) {
	c, err := nftables.New()
	if err != nil {
		return WebPorts, err
	}
	rules, err := c.GetRules(hostTable, &nftables.Chain{Name: "input", Table: hostTable})
	if err != nil {
		return WebPorts, err
	}
	var missing []uint16
	for _, p := range WebPorts {
		if !slices.ContainsFunc(rules, func(r *nftables.Rule) bool { return dropsPort(r.Exprs, p) }) {
			missing = append(missing, p)
		}
	}
	return missing, nil
}

func dropsPort(exprs []expr.Any, p uint16) bool {
	matches, drops := false, false
	for _, e := range exprs {
		switch e := e.(type) {
		case *expr.Cmp:
			matches = matches || (e.Op == expr.CmpOpEq && slices.Equal(e.Data, port(p)))
		case *expr.Verdict:
			drops = drops || e.Kind == expr.VerdictDrop
		}
	}
	return matches && drops
}

func publishedWebPortRules(l HostLayout, bridges *nftables.Set) [][]expr.Any {
	var out [][]expr.Any
	for _, p := range WebPorts {
		r := slices.Concat(
			tcp(),
			[]expr.Any{
				&expr.Ct{Register: 1, Key: expr.CtKeySTATE},
				&expr.Bitwise{SourceRegister: 1, DestRegister: 1, Len: 4, Mask: binaryNative(expr.CtStateBitNEW), Xor: []byte{0, 0, 0, 0}},
				&expr.Cmp{Op: expr.CmpOpNeq, Register: 1, Data: []byte{0, 0, 0, 0}},
			},
			ctDNAT(),
			[]expr.Any{
				&expr.Ct{Register: 1, Key: expr.CtKeyPROTODST, Direction: 0},
				&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: port(p)},
			},
		)
		if l.IngressBridge != "" {
			r = append(r, iifExprs(l.IngressBridge, true)...)
		}
		r = append(r,
			&expr.Meta{Key: expr.MetaKeyIIFNAME, Register: 1},
			lookup(bridges, true),
			&expr.Counter{},
			verdict(expr.VerdictDrop),
		)
		out = append(out, r)
	}
	return out
}

func hostForwardRules(l HostLayout, bridges *nftables.Set) [][]expr.Any {
	forwardRules := publishedWebPortRules(l, bridges)
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
	sw, targets := hostSwitchMap(), hostVipTargets()
	haveSw, err := readAddrMap(c, sw)
	if err != nil {
		return false, err
	}
	haveTargets, err := readAddrs(c, targets)
	if err != nil {
		return false, err
	}
	delSwitch, addSwitch := diffElements(haveSw, e.Switch, addrKey, addrKey)
	delTargets, addTargets := diffElements(haveTargets, keysOf(e.Switch), addrKey, nil)
	return applySetOps(c, false,
		setOp{sw, delSwitch, true}, setOp{targets, delTargets, true},
		setOp{targets, addTargets, false}, setOp{sw, addSwitch, false})
}

func HostFlows(ms []FlowMatch, evict bool) (FlowReport, error) {
	return flows(&netlink.Config{}, anyOf(ms), evict)
}
