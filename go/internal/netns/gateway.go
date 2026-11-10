//go:build linux

package netns

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"net/netip"

	"github.com/google/nftables"
	"golang.org/x/sys/unix"
)

const gatewayLayoutVersion = "1a.6-gateway"

type GatewayBaseline struct {
	Resolver netip.Addr
	Self     netip.Addr
}

func (b GatewayBaseline) fingerprint() string {
	sum := sha256.Sum256([]byte(gatewayLayoutVersion + "|" + b.Resolver.String() + "|" + b.Self.String()))
	return hex.EncodeToString(sum[:8])
}

func gatewayTargetsSet() *nftables.Set {
	return &nftables.Set{Table: table, Name: "gateway_targets", KeyType: concatAddrPort, Concatenation: true}
}

func addrPortKey(a netip.AddrPort) []byte {
	b := make([]byte, 8)
	copy(b, a.Addr().AsSlice())
	binary.BigEndian.PutUint16(b[4:], a.Port())
	return b
}

func gatewayKeys(targets []netip.AddrPort) map[string]bool {
	out := map[string]bool{}
	for _, t := range targets {
		out[string(addrPortKey(t))] = true
	}
	return out
}

func (n *Namespace) SyncGateway(b GatewayBaseline, hostAddrs []netip.Prefix, targets []netip.AddrPort) (Result, error) {
	c, err := nftables.New(nftables.WithNetNSFd(n.fd()))
	if err != nil {
		return Unchanged, err
	}
	if state := layoutState(c, table, "egress", commentPrefix+b.fingerprint()); state != Unchanged {
		return state, writeGateway(c, b, hostAddrs, targets)
	}
	changed, err := syncIntervals(c, hostAddrsSet(), hostAddrs)
	if err != nil {
		return Unchanged, err
	}
	set := gatewayTargetsSet()
	have, err := c.GetSetElements(set)
	if err != nil {
		return Unchanged, err
	}
	haveKeys := map[string]bool{}
	for _, el := range have {
		haveKeys[string(el.Key)] = true
	}
	del, add := diffElements(haveKeys, gatewayKeys(targets), func(k string) []byte { return []byte(k) }, nil)
	return elementsResult(applySetOps(c, changed, setOp{set, del, true}, setOp{set, add, false}))
}

func gatewayTable(b GatewayBaseline, hosts, private, gw *nftables.Set) []egressRule {
	tcp := byte(unix.IPPROTO_TCP)
	rules := []egressRule{
		{terms: []term{{kind: termEstablished}}, verdict: verdictAccept},
		{terms: []term{{kind: termOif, name: "lo"}}, verdict: verdictAccept},
	}
	for _, proto := range []byte{unix.IPPROTO_UDP, unix.IPPROTO_TCP} {
		rules = append(rules, egressRule{terms: []term{ipv4Term(), l4Term(proto), dportTerm(53), daddrTerm(b.Resolver)}, verdict: verdictAccept, counter: true})
	}
	return append(rules,
		egressRule{terms: []term{ipv4Term(), setTerm(hosts, false)}, verdict: verdictDrop, counter: true},
		egressRule{terms: []term{ipv4Term(), l4Term(tcp), {kind: termDaddrPortSet, set: gw}}, verdict: verdictAccept, counter: true},
		egressRule{terms: []term{ipv4Term(), setTerm(private, false)}, verdict: verdictDrop, counter: true},
		egressRule{terms: []term{ipv4Term(), l4Term(tcp), dportTerm(443)}, verdict: verdictAccept, counter: true},
		egressRule{terms: []term{ipv4Term()}, verdict: verdictDrop, counter: true},
	)
}

func writeGateway(c *nftables.Conn, b GatewayBaseline, hostAddrs []netip.Prefix, targets []netip.AddrPort) error {
	hosts, private, gw := hostAddrsSet(), privateRangesSet(), gatewayTargetsSet()
	var targetEls []nftables.SetElement
	for _, t := range targets {
		targetEls = append(targetEls, nftables.SetElement{Key: addrPortKey(t)})
	}
	if err := resetTable(c, table, []setEls{{hosts, intervalElements(hostAddrs)}, {private, intervalElements(PrivateRanges)}, {gw, targetEls}}); err != nil {
		return err
	}

	drop := nftables.ChainPolicyDrop
	intercept := c.AddChain(&nftables.Chain{Name: "dns_intercept", Table: table, Type: nftables.ChainTypeNAT, Hooknum: nftables.ChainHookOutput, Priority: nftables.ChainPriorityRef(-110)})
	source := c.AddChain(&nftables.Chain{Name: "dns_source", Table: table, Type: nftables.ChainTypeNAT, Hooknum: nftables.ChainHookPostrouting, Priority: nftables.ChainPriorityRef(100)})
	egress := c.AddChain(&nftables.Chain{Name: "egress", Table: table, Type: nftables.ChainTypeFilter, Hooknum: nftables.ChainHookOutput, Priority: nftables.ChainPriorityRef(0), Policy: &drop})

	addDNSRedirect(c, intercept, source, b.Resolver, b.Self)
	addFingerprinted(c, egress, egressExprs(gatewayTable(b, hosts, private, gw), nil), commentPrefix+b.fingerprint())
	return c.Flush()
}
