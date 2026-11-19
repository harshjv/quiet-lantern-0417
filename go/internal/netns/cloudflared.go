//go:build linux

package netns

import (
	"crypto/sha256"
	"encoding/hex"
	"net/netip"
	"strconv"

	"github.com/google/nftables"
	"github.com/google/nftables/expr"
	"golang.org/x/sys/unix"
)

const cloudflaredLayoutVersion = "1a.9-cloudflared"

type CloudflaredBaseline struct {
	MetricsPort uint16
	Prober      netip.Addr
}

func (b CloudflaredBaseline) fingerprint() string {
	sum := sha256.Sum256([]byte(cloudflaredLayoutVersion + "|" + strconv.Itoa(int(b.MetricsPort)) + "|" + b.Prober.String()))
	return hex.EncodeToString(sum[:8])
}

func (n *Namespace) SyncCloudflared(b CloudflaredBaseline) (Result, error) {
	c, err := nftables.New(nftables.WithNetNSFd(n.fd()))
	if err != nil {
		return Unchanged, err
	}
	comment := commentPrefix + b.fingerprint()
	state := layoutState(c, table, "metrics_in", comment)
	if state == Unchanged {
		return Unchanged, nil
	}
	if err := resetTable(c, table, nil); err != nil {
		return Unchanged, err
	}
	accept := nftables.ChainPolicyAccept
	in := c.AddChain(&nftables.Chain{Name: "metrics_in", Table: table, Type: nftables.ChainTypeFilter, Hooknum: nftables.ChainHookInput, Priority: nftables.ChainPriorityRef(0), Policy: &accept})
	addFingerprinted(c, in, [][]expr.Any{append(ipv4(),
		&expr.Meta{Key: expr.MetaKeyL4PROTO, Register: 1},
		&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte{unix.IPPROTO_TCP}},
		&expr.Payload{DestRegister: 1, Base: expr.PayloadBaseTransportHeader, Offset: 2, Len: 2},
		&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: port(b.MetricsPort)},
		saddr(),
		&expr.Cmp{Op: expr.CmpOpNeq, Register: 1, Data: b.Prober.AsSlice()},
		&expr.Counter{},
		verdict(expr.VerdictDrop),
	)}, comment)
	return state, c.Flush()
}
