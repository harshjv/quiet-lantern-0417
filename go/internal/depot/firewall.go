//go:build linux

package depot

import (
	"encoding/binary"
	"net/netip"

	"github.com/google/nftables"
	"github.com/google/nftables/expr"
	"github.com/google/nftables/userdata"
	"golang.org/x/sys/unix"
)

const FirewallTable = "stationly_depot"

var bridgeTable = &nftables.Table{Name: FirewallTable, Family: nftables.TableFamilyBridge}

func firewallComment(dist netip.AddrPort) string {
	return "stationly depot guard " + dist.String()
}

func EnsureFirewall(dist netip.AddrPort) (bool, error) {
	c, err := nftables.New()
	if err != nil {
		return false, err
	}
	chain := &nftables.Chain{Name: "forward", Table: bridgeTable}
	if rules, err := c.GetRules(bridgeTable, chain); err == nil && len(rules) == 1 {
		if comment, ok := userdata.GetString(rules[0].UserData, userdata.TypeComment); ok && comment == firewallComment(dist) {
			return false, nil
		}
	}
	c.AddTable(bridgeTable)
	c.DelTable(bridgeTable)
	c.AddTable(bridgeTable)
	accept := nftables.ChainPolicyAccept
	chain = c.AddChain(&nftables.Chain{Name: "forward", Table: bridgeTable, Type: nftables.ChainTypeFilter, Hooknum: nftables.ChainHookForward, Priority: nftables.ChainPriorityFilter, Policy: &accept})
	port := make([]byte, 2)
	binary.BigEndian.PutUint16(port, dist.Port())
	ethIP := make([]byte, 2)
	binary.BigEndian.PutUint16(ethIP, unix.ETH_P_IP)
	c.AddRule(&nftables.Rule{
		Table:    bridgeTable,
		Chain:    chain,
		UserData: userdata.AppendString(nil, userdata.TypeComment, firewallComment(dist)),
		Exprs: []expr.Any{
			&expr.Meta{Key: expr.MetaKeyPROTOCOL, Register: 1},
			&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: ethIP},
			&expr.Payload{DestRegister: 1, Base: expr.PayloadBaseNetworkHeader, Offset: 16, Len: 4},
			&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: dist.Addr().AsSlice()},
			&expr.Payload{DestRegister: 1, Base: expr.PayloadBaseNetworkHeader, Offset: 9, Len: 1},
			&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte{unix.IPPROTO_TCP}},
			&expr.Payload{DestRegister: 1, Base: expr.PayloadBaseTransportHeader, Offset: 2, Len: 2},
			&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: port},
			&expr.Counter{},
			&expr.Verdict{Kind: expr.VerdictDrop},
		},
	})
	return true, c.Flush()
}

func RemoveFirewall() error {
	c, err := nftables.New()
	if err != nil {
		return err
	}
	tables, err := c.ListTablesOfFamily(nftables.TableFamilyBridge)
	if err != nil {
		return err
	}
	for _, t := range tables {
		if t.Name == FirewallTable {
			c.DelTable(bridgeTable)
			return c.Flush()
		}
	}
	return nil
}
