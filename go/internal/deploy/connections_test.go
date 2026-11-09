//go:build linux

package deploy

import (
	"net/netip"
	"testing"
	"time"

	"github.com/harshjv/stationly/go/internal/flows"
	"github.com/harshjv/stationly/go/internal/protocol"
	"golang.org/x/sys/unix"
)

var (
	selfAddr    = netip.MustParseAddr("10.200.10.5")
	gatewayAddr = netip.MustParseAddr("10.200.10.1")
	dbAddr      = netip.MustParseAddr("10.200.10.7")
	dbVIP       = netip.MustParseAddr("100.64.10.9")
	ingressNet  = netip.MustParsePrefix("10.200.1.0/24")
)

func tuple(src, dst netip.Addr, sport, dport uint16, proto uint8) flows.Tuple {
	return flows.Tuple{Src: src.As4(), Dst: dst.As4(), SPort: sport, DPort: dport, Proto: proto}
}

func newTestHub(hostOriginal func(flows.Tuple) (flows.Tuple, bool)) (*netHub, netTarget) {
	h := &netHub{hostOriginal: hostOriginal}
	h.state.Store(&netState{
		targets: map[string]netTarget{},
		envs: map[string]*envPeers{
			"env_a": {
				gateway: gatewayAddr,
				vips:    map[netip.Addr]string{dbVIP: "svc_db"},
				containers: map[netip.Addr]owner{
					dbAddr:                             {serviceID: "svc_db", deploymentID: "dep_db_1"},
					netip.MustParseAddr("10.200.10.8"): {serviceID: "svc_db", deploymentID: "dep_db_2"},
				},
			},
		},
		ingress: ingressNet,
	})
	return h, netTarget{envID: "env_a", self: selfAddr}
}

func noHostEntry(flows.Tuple) (flows.Tuple, bool) { return flows.Tuple{}, false }

func TestOutboundFlowToAVirtualIPGroupsAsTheServiceWithTheServingDeployment(t *testing.T) {
	h, target := newTestHub(noHostEntry)
	orig := tuple(selfAddr, dbVIP, 40000, 5432, unix.IPPROTO_TCP)
	reply := tuple(dbAddr, selfAddr, 5432, 40000, unix.IPPROTO_TCP)
	key, ok := h.classifier(target)(orig, reply)
	want := flows.GroupKey{Out: true, Peer: flows.Peer{Kind: "service", ServiceID: "svc_db", DeploymentID: "dep_db_1"}, Port: 5432, Proto: unix.IPPROTO_TCP}
	if !ok || key != want {
		t.Fatalf("got %+v ok=%v", key, ok)
	}
}

func TestBlueAndGreenAreToldApartByTheReplySource(t *testing.T) {
	h, target := newTestHub(noHostEntry)
	classify := h.classifier(target)
	blue, _ := classify(tuple(selfAddr, dbVIP, 1, 5432, unix.IPPROTO_TCP), tuple(dbAddr, selfAddr, 5432, 1, unix.IPPROTO_TCP))
	green, _ := classify(tuple(selfAddr, dbVIP, 2, 5432, unix.IPPROTO_TCP), tuple(netip.MustParseAddr("10.200.10.8"), selfAddr, 5432, 2, unix.IPPROTO_TCP))
	if blue.Peer.DeploymentID != "dep_db_1" || green.Peer.DeploymentID != "dep_db_2" || blue == green {
		t.Fatalf("blue %+v green %+v", blue.Peer, green.Peer)
	}
}

func TestOutboundFlowToAContainerAddressGroupsAsThatService(t *testing.T) {
	h, target := newTestHub(noHostEntry)
	key, ok := h.classifier(target)(tuple(selfAddr, dbAddr, 1, 5432, unix.IPPROTO_TCP), tuple(dbAddr, selfAddr, 5432, 1, unix.IPPROTO_TCP))
	if !ok || key.Peer != (flows.Peer{Kind: "service", ServiceID: "svc_db", DeploymentID: "dep_db_1"}) {
		t.Fatalf("got %+v", key)
	}
}

func TestOutboundDNSToTheResolverGroupsAsResolver(t *testing.T) {
	h, target := newTestHub(noHostEntry)
	orig := tuple(selfAddr, netip.MustParseAddr("8.8.8.8"), 50000, 53, unix.IPPROTO_UDP)
	reply := tuple(gatewayAddr, selfAddr, 53, 50000, unix.IPPROTO_UDP)
	key, ok := h.classifier(target)(orig, reply)
	if !ok || key.Peer.Kind != "resolver" || !key.Out || key.Port != 53 || key.Proto != unix.IPPROTO_UDP {
		t.Fatalf("got %+v", key)
	}
}

func TestLoopbackDNSToDockerEmbeddedResolverGroupsAsResolver(t *testing.T) {
	h, target := newTestHub(noHostEntry)
	loopback := netip.MustParseAddr("127.0.0.1")
	orig := tuple(loopback, netip.MustParseAddr("127.0.0.11"), 50000, 53, unix.IPPROTO_UDP)
	reply := tuple(gatewayAddr, selfAddr, 53, 50000, unix.IPPROTO_UDP)
	key, ok := h.classifier(target)(orig, reply)
	if !ok || key.Peer.Kind != "resolver" || !key.Out {
		t.Fatalf("got %+v", key)
	}
}

func TestOutboundFlowToAPublicAddressCarriesTheAddress(t *testing.T) {
	h, target := newTestHub(noHostEntry)
	pub := netip.MustParseAddr("93.184.216.34")
	key, ok := h.classifier(target)(tuple(selfAddr, pub, 1, 443, unix.IPPROTO_TCP), tuple(pub, selfAddr, 443, 1, unix.IPPROTO_TCP))
	if !ok || key.Peer != (flows.Peer{Kind: "public", Address: "93.184.216.34"}) || key.Port != 443 {
		t.Fatalf("got %+v", key)
	}
}

func TestOutboundFlowToAnUnknownPrivateAddressIsAnAddressPeer(t *testing.T) {
	h, target := newTestHub(noHostEntry)
	other := netip.MustParseAddr("10.200.10.99")
	key, ok := h.classifier(target)(tuple(selfAddr, other, 1, 80, unix.IPPROTO_TCP), tuple(other, selfAddr, 80, 1, unix.IPPROTO_TCP))
	if !ok || key.Peer != (flows.Peer{Kind: "address", Address: "10.200.10.99"}) {
		t.Fatalf("got %+v", key)
	}
}

func TestInboundFlowFromAnInternetClientGroupsAsInternetWithoutItsAddress(t *testing.T) {
	h, target := newTestHub(noHostEntry)
	classify := h.classifier(target)
	var first flows.GroupKey
	for i, client := range []string{"203.0.113.5", "198.51.100.77", "192.0.2.200"} {
		c := netip.MustParseAddr(client)
		key, ok := classify(tuple(c, selfAddr, uint16(50000+i), 3000, unix.IPPROTO_TCP), tuple(selfAddr, c, 3000, uint16(50000+i), unix.IPPROTO_TCP))
		if !ok || key.Out || key.Peer.Kind != "internet" || key.Peer.Address != "" || key.Port != 3000 {
			t.Fatalf("%s: %+v", client, key)
		}
		if i == 0 {
			first = key
		} else if key != first {
			t.Fatalf("clients of one port must share one group: %+v vs %+v", key, first)
		}
	}
}

func TestInboundFlowFromAnotherServiceGroupsAsThatService(t *testing.T) {
	h, target := newTestHub(noHostEntry)
	key, ok := h.classifier(target)(tuple(dbAddr, selfAddr, 40000, 3000, unix.IPPROTO_TCP), tuple(selfAddr, dbAddr, 3000, 40000, unix.IPPROTO_TCP))
	if !ok || key.Out || key.Peer != (flows.Peer{Kind: "service", ServiceID: "svc_db", DeploymentID: "dep_db_1"}) {
		t.Fatalf("got %+v", key)
	}
}

func TestInboundFlowFromTheBridgeGatewayIsTheStationWhenTheHostHasNoEntry(t *testing.T) {
	h, target := newTestHub(noHostEntry)
	key, ok := h.classifier(target)(tuple(gatewayAddr, selfAddr, 40000, 3000, unix.IPPROTO_TCP), tuple(selfAddr, gatewayAddr, 3000, 40000, unix.IPPROTO_TCP))
	if !ok || key.Out || key.Peer.Kind != "station" {
		t.Fatalf("got %+v", key)
	}
}

func TestInboundFlowFromTheBridgeGatewayIsTheGatewayWhenTheHostEntryCameFromTheIngressSubnet(t *testing.T) {
	var asked flows.Tuple
	h, target := newTestHub(func(reply flows.Tuple) (flows.Tuple, bool) {
		asked = reply
		return tuple(netip.MustParseAddr("10.200.1.11"), netip.MustParseAddr("100.64.10.2"), 33000, 80, unix.IPPROTO_TCP), true
	})
	orig := tuple(gatewayAddr, selfAddr, 40000, 3000, unix.IPPROTO_TCP)
	key, ok := h.classifier(target)(orig, tuple(selfAddr, gatewayAddr, 3000, 40000, unix.IPPROTO_TCP))
	if !ok || key.Peer.Kind != "gateway" {
		t.Fatalf("got %+v", key)
	}
	want := tuple(selfAddr, gatewayAddr, 3000, 40000, unix.IPPROTO_TCP)
	if asked != want {
		t.Fatalf("host lookup keyed by %+v, want the reply tuple %+v", asked, want)
	}
}

func TestInboundFlowFromTheBridgeGatewayStaysStationWhenTheHostEntryIsOutsideTheIngressSubnet(t *testing.T) {
	h, target := newTestHub(func(flows.Tuple) (flows.Tuple, bool) {
		return tuple(netip.MustParseAddr("203.0.113.7"), netip.MustParseAddr("203.0.113.7"), 33000, 8080, unix.IPPROTO_TCP), true
	})
	key, _ := h.classifier(target)(tuple(gatewayAddr, selfAddr, 40000, 3000, unix.IPPROTO_TCP), tuple(selfAddr, gatewayAddr, 3000, 40000, unix.IPPROTO_TCP))
	if key.Peer.Kind != "station" {
		t.Fatalf("got %+v", key)
	}
}

func TestInboundFlowFromAnUnknownPrivateAddressIsAnAddressPeer(t *testing.T) {
	h, target := newTestHub(noHostEntry)
	other := netip.MustParseAddr("10.200.10.99")
	key, _ := h.classifier(target)(tuple(other, selfAddr, 1, 3000, unix.IPPROTO_TCP), tuple(selfAddr, other, 3000, 1, unix.IPPROTO_TCP))
	if key.Peer != (flows.Peer{Kind: "address", Address: "10.200.10.99"}) {
		t.Fatalf("got %+v", key)
	}
}

func TestOnlyTCPAndUDPFlowsAreClassified(t *testing.T) {
	h, target := newTestHub(noHostEntry)
	if _, ok := h.classifier(target)(tuple(selfAddr, dbAddr, 0, 0, unix.IPPROTO_ICMP), tuple(dbAddr, selfAddr, 0, 0, unix.IPPROTO_ICMP)); ok {
		t.Fatal("ICMP must not form a group")
	}
}

func TestClassifierToleratesAnEnvironmentWithNoPeersYet(t *testing.T) {
	h, target := newTestHub(noHostEntry)
	target.envID = "env_unknown"
	pub := netip.MustParseAddr("93.184.216.34")
	key, ok := h.classifier(target)(tuple(selfAddr, pub, 1, 443, unix.IPPROTO_TCP), tuple(pub, selfAddr, 443, 1, unix.IPPROTO_TCP))
	if !ok || key.Peer.Kind != "public" {
		t.Fatalf("got %+v", key)
	}
}

func TestConnectionOfReportsBytesFromTheServicesPointOfView(t *testing.T) {
	now := time.Unix(2000, 0)
	out := connectionOf(flows.GroupStat{Key: flows.GroupKey{Out: true, Peer: flows.Peer{Kind: "service", ServiceID: "svc_db", DeploymentID: "dep_db_1"}, Port: 5432, Proto: unix.IPPROTO_TCP}, Flows: 10, Established: 9, Orig: 1000, Repl: 5000, DeltaOrig: 100, DeltaRepl: 500, OldestRead: now.Add(-5 * time.Second).UnixNano(), OldestStart: now.Add(-60 * time.Second).UnixNano()},
		flows.Snapshot{Accounting: true}, now, 10)
	if out.Direction != protocol.NetworkDirectionOut || *out.BytesOut != 1000 || *out.BytesIn != 5000 || *out.BpsOut != 10 || *out.BpsIn != 50 {
		t.Fatalf("out: %+v", out)
	}
	if out.Flows != 10 || out.Established != 9 || out.Port != 5432 || out.Protocol != protocol.NetworkProtocolTcp {
		t.Fatalf("out shape: %+v", out)
	}
	in := connectionOf(flows.GroupStat{Key: flows.GroupKey{Out: false, Peer: flows.Peer{Kind: "internet"}, Port: 3000, Proto: unix.IPPROTO_TCP}, Flows: 1, Orig: 100, Repl: 900, DeltaOrig: 10, DeltaRepl: 90, OldestRead: now.UnixNano()},
		flows.Snapshot{Accounting: true}, now, 10)
	if in.Direction != protocol.NetworkDirectionIn || *in.BytesOut != 900 || *in.BytesIn != 100 || *in.BpsOut != 9 || *in.BpsIn != 1 {
		t.Fatalf("in: %+v", in)
	}
}

func TestConnectionOfReportsCountersAgeAsTheOldestCounterRead(t *testing.T) {
	now := time.Unix(2000, 0)
	c := connectionOf(flows.GroupStat{Key: flows.GroupKey{Proto: unix.IPPROTO_TCP}, OldestRead: now.Add(-12 * time.Second).UnixNano()}, flows.Snapshot{Accounting: true}, now, 5)
	if c.CountersAgeS == nil || *c.CountersAgeS != 12 {
		t.Fatalf("counters age %v", c.CountersAgeS)
	}
	future := connectionOf(flows.GroupStat{Key: flows.GroupKey{Proto: unix.IPPROTO_TCP}, OldestRead: now.Add(3 * time.Second).UnixNano()}, flows.Snapshot{Accounting: true}, now, 5)
	if *future.CountersAgeS != 0 {
		t.Fatalf("clock skew must clamp at zero, got %d", *future.CountersAgeS)
	}
}

func TestConnectionOfOmitsBytesAndCountersAgeWhenAccountingIsOff(t *testing.T) {
	c := connectionOf(flows.GroupStat{Key: flows.GroupKey{Proto: unix.IPPROTO_TCP}, Orig: 5, Repl: 5, OldestRead: time.Now().UnixNano()}, flows.Snapshot{Accounting: false}, time.Now(), 5)
	if c.BytesOut != nil || c.BytesIn != nil || c.BpsOut != nil || c.BpsIn != nil || c.CountersAgeS != nil {
		t.Fatalf("got %+v", c)
	}
}

func TestConnectionOfOmitsRatesOnTheFirstSample(t *testing.T) {
	c := connectionOf(flows.GroupStat{Key: flows.GroupKey{Proto: unix.IPPROTO_TCP}, Orig: 5, Repl: 5, OldestRead: time.Now().UnixNano()}, flows.Snapshot{Accounting: true}, time.Now(), 0)
	if c.BytesOut == nil || c.BpsOut != nil || c.BpsIn != nil {
		t.Fatalf("got %+v", c)
	}
}

func TestConnectionOfReportsOldestFlowAgeUnlessTheStartIsUnknown(t *testing.T) {
	now := time.Unix(5000, 0)
	g := flows.GroupStat{Key: flows.GroupKey{Proto: unix.IPPROTO_TCP}, Flows: 2, OldestStart: now.Add(-3605 * time.Second).UnixNano()}
	if c := connectionOf(g, flows.Snapshot{}, now, 5); c.OldestS == nil || *c.OldestS != 3605 {
		t.Fatalf("oldest %v", c.OldestS)
	}
	g.StartUnknown = true
	if c := connectionOf(g, flows.Snapshot{}, now, 5); c.OldestS != nil {
		t.Fatalf("unknown start must be null, got %d", *c.OldestS)
	}
}

func TestConnectionOfNeverCarriesAClientAddressForInternetPeers(t *testing.T) {
	c := connectionOf(flows.GroupStat{Key: flows.GroupKey{Peer: flows.Peer{Kind: "internet"}, Port: 3000, Proto: unix.IPPROTO_TCP}, Flows: 3}, flows.Snapshot{}, time.Now(), 5)
	if c.Peer.Kind != protocol.NetworkPeerKind("internet") || c.Peer.Address != nil || c.Peer.ServiceId != nil {
		t.Fatalf("got %+v", c.Peer)
	}
}

func TestConnectionOfReportsUDPAndPeerIdentity(t *testing.T) {
	c := connectionOf(flows.GroupStat{Key: flows.GroupKey{Out: true, Peer: flows.Peer{Kind: "public", Address: "1.1.1.1"}, Port: 53, Proto: unix.IPPROTO_UDP}}, flows.Snapshot{}, time.Now(), 5)
	if c.Protocol != protocol.NetworkProtocolUdp || c.Peer.Address == nil || *c.Peer.Address != "1.1.1.1" {
		t.Fatalf("got %+v", c)
	}
}

func TestCapGroupsKeepsTheBusiestAndFoldsTheRestIntoOther(t *testing.T) {
	var groups []flows.GroupStat
	for i := 0; i < groupsMax+10; i++ {
		groups = append(groups, flows.GroupStat{Key: flows.GroupKey{Out: true, Port: uint16(1000 + i), Proto: unix.IPPROTO_TCP}, Flows: 1, Established: 1, Orig: uint64(i), Repl: uint64(i)})
	}
	got := capGroups(groups)
	if len(got) != groupsMax {
		t.Fatalf("got %d groups", len(got))
	}
	rest := got[len(got)-1]
	if rest.Key.Peer.Kind != "other" || rest.Flows != 11 {
		t.Fatalf("rest %+v", rest)
	}
	if got[0].Key.Port != uint16(1000+groupsMax+9) {
		t.Fatalf("busiest group first, got port %d", got[0].Key.Port)
	}
}

func TestCapGroupsLeavesASmallListAlone(t *testing.T) {
	in := []flows.GroupStat{{Key: flows.GroupKey{Port: 1}, Orig: 1}, {Key: flows.GroupKey{Port: 2}, Orig: 9}}
	got := capGroups(in)
	if len(got) != 2 || got[0].Key.Port != 2 {
		t.Fatalf("got %+v", got)
	}
}

func TestRefusedPathClassificationFollowsTheDocumentedOrder(t *testing.T) {
	h := &netHub{}
	st := &netState{
		hosts: []netip.Prefix{netip.MustParsePrefix("10.200.0.0/24")},
		pool:  netip.MustParsePrefix("10.200.0.0/16"),
	}
	target := netTarget{rejects: []netip.Addr{netip.MustParseAddr("100.64.10.9")}}
	cases := map[string]protocol.RefusedPath{
		"100.64.10.9":     protocol.RefusedPathNoSwitchTarget,
		"10.200.0.1":      protocol.RefusedPathHostAddress,
		"10.200.5.5":      protocol.RefusedPathOtherEnvironment,
		"169.254.169.254": protocol.RefusedPathCloudMetadata,
		"192.168.1.1":     protocol.RefusedPathPrivateRange,
	}
	for addr, want := range cases {
		if got := h.refusedPath(target, st, netip.MustParseAddr(addr)); got != want {
			t.Errorf("%s: %s, want %s", addr, got, want)
		}
	}
}
