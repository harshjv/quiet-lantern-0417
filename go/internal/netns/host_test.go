//go:build linux

package netns

import (
	"bytes"
	"net/netip"
	"slices"
	"strings"
	"testing"

	"github.com/google/nftables/expr"
	"golang.org/x/sys/unix"
)

func testHostLayout() HostLayout {
	return HostLayout{
		IngressBridge: "sly-ingress",
		VirtualPrefix: netip.MustParsePrefix("100.64.0.0/16"),
		Translated:    []netip.Prefix{netip.MustParsePrefix("10.200.0.0/24"), netip.MustParsePrefix("10.200.1.0/24")},
		EnvBridges:    []string{"sly-env-a"},
	}
}

type webDrop struct {
	port      uint16
	exceptLo  bool
	ipv4Only  bool
	original  bool
	newOnly   bool
	dnatOnly  bool
	exempt    []string
	exemptSet string
}

func readWebDrop(r []expr.Any) (webDrop, bool) {
	var d webDrop
	tcp, drops := false, false
	for i, e := range r {
		switch x := e.(type) {
		case *expr.Meta:
			if x.Key == expr.MetaKeyNFPROTO {
				d.ipv4Only = true
			}
		case *expr.Cmp:
			if i == 0 {
				continue
			}
			switch prev := r[i-1].(type) {
			case *expr.Meta:
				if prev.Key == expr.MetaKeyL4PROTO && bytes.Equal(x.Data, []byte{unix.IPPROTO_TCP}) {
					tcp = true
				}
				if prev.Key == expr.MetaKeyIIFNAME && x.Op == expr.CmpOpNeq {
					name := string(bytes.TrimRight(x.Data, "\x00"))
					if name == "lo" {
						d.exceptLo = true
					} else {
						d.exempt = append(d.exempt, name)
					}
				}
			case *expr.Payload:
				if prev.Base == expr.PayloadBaseTransportHeader && prev.Offset == 2 && prev.Len == 2 {
					d.port = uint16(x.Data[0])<<8 | uint16(x.Data[1])
				}
			case *expr.Ct:
				if prev.Key == expr.CtKeyPROTODST {
					d.port = uint16(x.Data[0])<<8 | uint16(x.Data[1])
					d.original = prev.Direction == 0
				}
			case *expr.Bitwise:
				if ct, ok := r[i-2].(*expr.Ct); ok {
					switch ct.Key {
					case expr.CtKeySTATE:
						d.newOnly = bytes.Equal(prev.Mask, binaryNative(expr.CtStateBitNEW))
					case expr.CtKeySTATUS:
						d.dnatOnly = bytes.Equal(prev.Mask, binaryNative(ipsDstNAT))
					}
				}
			}
		case *expr.Lookup:
			if m, ok := r[i-1].(*expr.Meta); ok && m.Key == expr.MetaKeyIIFNAME && x.Invert {
				d.exemptSet = x.SetName
			}
		case *expr.Verdict:
			drops = x.Kind == expr.VerdictDrop
		}
	}
	return d, tcp && drops && d.port != 0
}

func webDrops(rules [][]expr.Any) []webDrop {
	var out []webDrop
	for _, r := range rules {
		if d, ok := readWebDrop(r); ok {
			out = append(out, d)
		}
	}
	return out
}

func dropPorts(ds []webDrop) []uint16 {
	var ports []uint16
	for _, d := range ds {
		ports = append(ports, d.port)
	}
	slices.Sort(ports)
	return ports
}

func TestTheHostDropsInbound80And443DeliveredToItselfExceptOnLoopback(t *testing.T) {
	drops := webDrops(hostInputRules())
	if got := dropPorts(drops); !slices.Equal(got, []uint16{80, 443}) {
		t.Fatalf("the input chain must drop 80 and 443, dropped %v", got)
	}
	for _, d := range drops {
		if !d.exceptLo || d.ipv4Only || len(d.exempt) != 0 || d.exemptSet != "" {
			t.Errorf("port %d: the drop must spare loopback only and cover IPv4 and IPv6: %+v", d.port, d)
		}
	}
}

func TestAPublishedPortCannotReopen80Or443(t *testing.T) {
	l := testHostLayout()
	drops := webDrops(hostForwardRules(l, envBridgesSet()))
	if got := dropPorts(drops); !slices.Equal(got, []uint16{80, 443}) {
		t.Fatalf("the forward chain must drop translated 80 and 443, dropped %v", got)
	}
	for _, d := range drops {
		if !d.original || !d.newOnly || !d.dnatOnly || d.ipv4Only {
			t.Errorf("port %d: the drop must match new, translated flows by the port the client dialed, on both families: %+v", d.port, d)
		}
		if !slices.Equal(d.exempt, []string{l.IngressBridge}) || d.exemptSet != envBridgesSet().Name {
			t.Errorf("port %d: cloudflared on the ingress bridge and apps on their bridges must pass: %+v", d.port, d)
		}
	}
}

func TestTheMarkAcceptRuleUsesTheHostTranslationMark(t *testing.T) {
	rule := strings.Join(MarkAcceptRule(), " ")
	if !strings.Contains(rule, "--mark 0x10000/0x10000") || !strings.HasSuffix(rule, "-j ACCEPT") {
		t.Fatalf("rule %q must accept exactly the mark mark_pre sets", rule)
	}
}
