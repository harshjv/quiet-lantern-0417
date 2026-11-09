//go:build linux

package netns

import (
	"bytes"
	"net/netip"
	"slices"
	"strings"
	"testing"

	"github.com/google/nftables"
	"github.com/google/nftables/expr"
	"golang.org/x/sys/unix"
)

var testPublic = netip.MustParseAddr("198.51.100.10")

const testSourceRate = 20

func testHostLayout(webOpen bool) HostLayout {
	return HostLayout{
		Public:        testPublic,
		IngressBridge: "or-ingress",
		VirtualPrefix: netip.MustParsePrefix("100.64.0.0/16"),
		Translated:    []netip.Prefix{netip.MustParsePrefix("10.200.0.0/24"), netip.MustParsePrefix("10.200.1.0/24")},
		WebOpen:       webOpen,
		SourceRate:    testSourceRate,
	}
}

type shedRule struct {
	limit  *expr.Limit
	dynset *expr.Dynset
	keyed  bool
}

func hasLimit(r []expr.Any) bool {
	for _, e := range r {
		switch x := e.(type) {
		case *expr.Limit:
			return true
		case *expr.Dynset:
			if len(x.Exprs) > 0 {
				return true
			}
		}
	}
	return false
}

func shedRules(l HostLayout) map[uint16][]shedRule {
	out := map[uint16][]shedRule{}
	for _, r := range hostForwardRules(l, envBridgesSet(), webSourceSets(l)) {
		if !hasLimit(r) {
			continue
		}
		var dport uint16
		var rule shedRule
		var drops, newOnly bool
		for i, e := range r {
			switch x := e.(type) {
			case *expr.Cmp:
				if i == 0 {
					continue
				}
				if ct, ok := r[i-1].(*expr.Ct); ok && ct.Key == expr.CtKeyPROTODST {
					dport = uint16(x.Data[0])<<8 | uint16(x.Data[1])
				}
			case *expr.Ct:
				if x.Key == expr.CtKeySTATE {
					newOnly = true
				}
			case *expr.Limit:
				rule.limit = x
			case *expr.Dynset:
				rule.dynset = x
				rule.limit = x.Exprs[0].(*expr.Limit)
				p, ok := r[i-1].(*expr.Payload)
				rule.keyed = ok && p.Base == expr.PayloadBaseNetworkHeader && p.Offset == 12 && p.Len == 4 && x.SrcRegKey == p.DestRegister
			case *expr.Verdict:
				drops = x.Kind == expr.VerdictDrop
			}
		}
		if drops && newOnly && rule.limit != nil {
			out[dport] = append(out[dport], rule)
		}
	}
	return out
}

func droppedWebPorts(l HostLayout) []uint16 {
	var ports []uint16
	for _, r := range hostForwardRules(l, envBridgesSet(), webSourceSets(l)) {
		if hasLimit(r) {
			continue
		}
		matchesPublic, drops := false, false
		var dport []byte
		for i, e := range r {
			switch x := e.(type) {
			case *expr.Cmp:
				if bytes.Equal(x.Data, testPublic.AsSlice()) {
					matchesPublic = true
				}
				if i > 0 {
					if ct, ok := r[i-1].(*expr.Ct); ok && ct.Key == expr.CtKeyPROTODST {
						dport = x.Data
					}
				}
			case *expr.Verdict:
				drops = x.Kind == expr.VerdictDrop
			}
		}
		if matchesPublic && drops && len(dport) == 2 {
			ports = append(ports, uint16(dport[0])<<8|uint16(dport[1]))
		}
	}
	slices.Sort(ports)
	return ports
}

func TestTheHostChainDropsInbound80And443WhileNoDirectRouteExists(t *testing.T) {
	if got := droppedWebPorts(testHostLayout(false)); !slices.Equal(got, []uint16{80, 443}) {
		t.Fatalf("web ports closed must drop 80 and 443 on the public address, dropped %v", got)
	}
}

func TestTheHostChainLetsInbound80And443ThroughOnceADirectRouteExists(t *testing.T) {
	if got := droppedWebPorts(testHostLayout(true)); len(got) != 0 {
		t.Fatalf("web ports open must not drop any public port, dropped %v", got)
	}
}

func TestTheWebPortDropMatchesTheDestinationBeforeTranslation(t *testing.T) {
	for _, r := range hostForwardRules(testHostLayout(false), envBridgesSet(), nil) {
		for _, e := range r {
			if ct, ok := e.(*expr.Ct); ok && ct.Key == expr.CtKeyPROTODST && ct.Direction != 0 {
				t.Fatal("the drop must match ct original proto-dst so a port allocation to container port 80 is not dropped")
			}
		}
	}
}

func TestTheMarkAcceptRuleUsesTheHostTranslationMark(t *testing.T) {
	rule := strings.Join(MarkAcceptRule(), " ")
	if !strings.Contains(rule, "--mark 0x10000/0x10000") || !strings.HasSuffix(rule, "-j ACCEPT") {
		t.Fatalf("rule %q must accept exactly the mark mark_pre sets", rule)
	}
}

func TestTheHostChainLimitsNewConnectionsPerSourceBeforeTheGlobalCapOn80And443WhileTheyAreOpen(t *testing.T) {
	got := shedRules(testHostLayout(true))
	if len(got) != 2 {
		t.Fatalf("limited ports %v, want 80 and 443 only", got)
	}
	for _, p := range []uint16{80, 443} {
		rules := got[p]
		if len(rules) != 2 {
			t.Fatalf("port %d has %d limit rules, want per-source then global", p, len(rules))
		}
		perSource, global := rules[0], rules[1]
		if perSource.dynset == nil || !perSource.keyed || perSource.dynset.Operation != unix.NFT_DYNSET_OP_UPDATE {
			t.Errorf("port %d first rule must update a set keyed by ip saddr: %+v", p, perSource)
		}
		l := perSource.limit
		if !l.Over || l.Rate != testSourceRate || l.Burst != 2*testSourceRate || l.Unit != expr.LimitTimeSecond || l.Type != expr.LimitTypePkts {
			t.Errorf("port %d per-source limit %+v", p, *l)
		}
		if global.dynset != nil {
			t.Errorf("port %d second rule must be the global cap", p)
		}
		g := global.limit
		if !g.Over || g.Rate != WebNewConnectionRate || g.Burst != WebNewConnectionBurst || g.Unit != expr.LimitTimeSecond || g.Type != expr.LimitTypePkts {
			t.Errorf("port %d global limit %+v", p, *g)
		}
	}
}

func TestThePerSourceRateAndBurstFollowTheSetting(t *testing.T) {
	for _, rate := range []int{1, 50, 1000} {
		l := testHostLayout(true)
		l.SourceRate = rate
		for p, rules := range shedRules(l) {
			got := rules[0].limit
			if got.Rate != uint64(rate) || got.Burst != uint32(2*rate) || len(rules) != 2 {
				t.Errorf("rate %d port %d: limit %+v with %d rules", rate, p, *got, len(rules))
			}
		}
	}
}

func TestZeroDisablesThePerSourceRuleAndKeepsTheGlobalBackstop(t *testing.T) {
	l := testHostLayout(true)
	l.SourceRate = 0
	if got := webSourceSets(l); len(got) != 0 {
		t.Fatalf("no per-source rate needs no source sets, got %v", got)
	}
	got := shedRules(l)
	if len(got) != 2 {
		t.Fatalf("limited ports %v, want the global cap on 80 and 443", got)
	}
	for p, rules := range got {
		if len(rules) != 1 || rules[0].dynset != nil || rules[0].limit.Rate != WebNewConnectionRate || rules[0].limit.Burst != WebNewConnectionBurst {
			t.Errorf("port %d rules %+v, want only the global cap", p, rules)
		}
	}
}

func TestTheSourceSetsAreDynamicBoundedAndExpire(t *testing.T) {
	sets := webSourceSets(testHostLayout(true))
	if len(sets) != 2 {
		t.Fatalf("source sets %v, want one per web port", sets)
	}
	for p, s := range sets {
		if !s.Dynamic || !s.HasTimeout || s.Timeout != WebSourceIdleTimeout || s.Size != WebSourceTableSize || s.KeyType != nftables.TypeIPAddr {
			t.Errorf("port %d set %+v is not a bounded expiring ip address set", p, *s)
		}
		for _, r := range shedRules(testHostLayout(true))[p] {
			if r.dynset != nil && (r.dynset.SetName != s.Name || r.dynset.Timeout != WebSourceIdleTimeout) {
				t.Errorf("port %d rule updates %q with timeout %v", p, r.dynset.SetName, r.dynset.Timeout)
			}
		}
	}
}

func TestTheSourceSetsExistOnlyWhileTheWebPortsAreOpen(t *testing.T) {
	if got := webSourceSets(testHostLayout(false)); len(got) != 0 {
		t.Fatalf("closed web ports need no source sets, got %v", got)
	}
	if got := webSourceSets(HostLayout{WebOpen: true}); len(got) != 0 {
		t.Fatalf("no public address needs no source sets, got %v", got)
	}
}

func TestTheHostChainSetsNoNewConnectionLimitWhileTheWebPortsAreClosed(t *testing.T) {
	if got := shedRules(testHostLayout(false)); len(got) != 0 {
		t.Fatalf("closed web ports drop everything and need no limit, got %v", got)
	}
}

func TestTheWebPortLimitFollowsTheWebOpenFingerprint(t *testing.T) {
	if testHostLayout(true).fingerprint() == testHostLayout(false).fingerprint() {
		t.Fatal("opening the web ports must change the table fingerprint")
	}
}
