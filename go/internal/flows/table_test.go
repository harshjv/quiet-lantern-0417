//go:build linux

package flows

import (
	"log/slog"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

const (
	serviceAddr = 10
	t0          = int64(1_000_000_000_000)
)

func newMonitor(perNamespace int, perStation int64) *Monitor {
	return &Monitor{
		log:          slog.New(slog.DiscardHandler),
		perNamespace: perNamespace,
		perStation:   perStation,
		budget:       RefreshBudget,
		watches:      map[*Watch]bool{},
		wake:         make(chan struct{}, 1),
		stop:         make(chan struct{}),
	}
}

func classifyByDestination(orig, reply Tuple) (GroupKey, bool) {
	if orig.Proto != unix.IPPROTO_TCP && orig.Proto != unix.IPPROTO_UDP {
		return GroupKey{}, false
	}
	if orig.Src[3] == serviceAddr {
		return GroupKey{Out: true, Peer: Peer{Kind: "address", Address: addrString(orig.Dst)}, Port: orig.DPort, Proto: orig.Proto}, true
	}
	return GroupKey{Out: false, Peer: Peer{Kind: "internet"}, Port: orig.DPort, Proto: orig.Proto}, true
}

func addrString(b [4]byte) string {
	return string([]byte{'0' + b[3]/100%10, '0' + b[3]/10%10, '0' + b[3]%10})
}

func newWatch(m *Monitor, classify Classifier) *Watch {
	w := &Watch{
		m:        m,
		classify: classify,
		table:    map[key]flow{},
		groupIdx: map[GroupKey]int32{},
		closed:   map[int32]*closedAcc{},
		tombs:    map[key]tomb{},
		stale:    true,
		backoff:  resyncSpacing,
		ready:    make(chan struct{}),
	}
	m.watches[w] = true
	return w
}

func outTuple(id uint32, dstHost byte, sport, dport uint16, proto uint8) key {
	return key{id: id, orig: Tuple{Src: [4]byte{10, 200, 1, serviceAddr}, Dst: [4]byte{10, 200, 1, dstHost}, SPort: sport, DPort: dport, Proto: proto}}
}

func inTuple(id uint32, client byte, sport, dport uint16) key {
	return key{id: id, orig: Tuple{Src: [4]byte{203, 0, 113, client}, Dst: [4]byte{10, 200, 1, serviceAddr}, SPort: sport, DPort: dport, Proto: unix.IPPROTO_TCP}}
}

func seedOf(w *Watch, k key, orig, repl uint64, start int64) seeded {
	f := flow{read: t0, orig: orig, repl: repl, baseOrig: orig, baseRepl: repl, tcp: tcpEstablished}
	if start != 0 {
		f.start, f.startKnown = start, true
	}
	g, ok := w.classify(k.orig, Tuple{})
	return seeded{k: k, f: f, group: g, ok: ok}
}

func seedWith(t *testing.T, w *Watch, flows ...seeded) {
	t.Helper()
	w.install(flows, nil, true, 0, time.Now())
}

func newEvent(k key, tcp bool) *message {
	return &message{kind: kindNew, key: k, start: 0, tcp: 0, hasTCP: tcp}
}

func destroyEvent(k key, orig, repl uint64) *message {
	return &message{kind: kindDestroy, key: k, origB: orig, replB: repl, counters: true}
}

func groupOf(t *testing.T, stats []GroupStat, port uint16) GroupStat {
	t.Helper()
	for _, s := range stats {
		if s.Key.Port == port {
			return s
		}
	}
	t.Fatalf("no group for port %d in %+v", port, stats)
	return GroupStat{}
}

func TestTheDocumentedCapsAreTheConstants(t *testing.T) {
	if PerNamespaceFlows != 20000 || PerStationFlows != 100000 {
		t.Fatalf("caps %d and %d", PerNamespaceFlows, PerStationFlows)
	}
	m := New(slog.New(slog.DiscardHandler))
	defer m.Close()
	if m.perNamespace != 20000 || m.perStation != 100000 {
		t.Fatalf("monitor caps %d and %d", m.perNamespace, m.perStation)
	}
}

func TestResyncBackoffStartsAt30sAndCapsAt5min(t *testing.T) {
	if resyncSpacing != 30*time.Second || resyncBackoffMax != 5*time.Minute {
		t.Fatalf("spacing %v max %v", resyncSpacing, resyncBackoffMax)
	}
}

func TestSeedMakesTheTableCurrentAndFreshWatchIsStale(t *testing.T) {
	m := newMonitor(100, 1000)
	w := newWatch(m, classifyByDestination)
	if s := w.Collect2(t); !s.Stale || s.Lossy || !s.First {
		t.Fatalf("before the seed: stale %v lossy %v first %v", s.Stale, s.Lossy, s.First)
	}
	seedWith(t, w, seedOf(w, outTuple(1, 20, 40000, 5432, unix.IPPROTO_TCP), 100, 200, t0-int64(5*time.Second)))
	select {
	case <-w.Ready():
	default:
		t.Fatal("a seed must mark the watch ready")
	}
	s := w.Collect2(t)
	if s.Stale || s.Lossy || s.First {
		t.Fatalf("after the seed: stale %v lossy %v first %v", s.Stale, s.Lossy, s.First)
	}
}

func (w *Watch) Collect2(t *testing.T) Snapshot {
	t.Helper()
	n := 0
	w.mu.Lock()
	w.entries = &n
	w.mu.Unlock()
	return w.Collect(time.Unix(0, t0+int64(10*time.Second)))
}

func TestSeededFlowsReportTheirSeededCountersAsAbsoluteAndNoDelta(t *testing.T) {
	w := newWatch(newMonitor(100, 1000), classifyByDestination)
	seedWith(t, w,
		seedOf(w, outTuple(1, 20, 40000, 5432, unix.IPPROTO_TCP), 100, 200, t0-int64(5*time.Second)),
		seedOf(w, outTuple(2, 20, 40001, 5432, unix.IPPROTO_TCP), 10, 20, t0-int64(9*time.Second)),
	)
	g := groupOf(t, w.Collect2(t).Groups, 5432)
	if g.Flows != 2 || g.Established != 2 || g.Orig != 110 || g.Repl != 220 {
		t.Fatalf("got %+v", g)
	}
	if g.DeltaOrig != 0 || g.DeltaRepl != 0 {
		t.Fatalf("seeded bytes are not new traffic: %+v", g)
	}
	if g.OldestStart != t0-int64(9*time.Second) {
		t.Fatalf("oldest start %d", g.OldestStart)
	}
}

func TestNewEventForAHeldFlowChangesNothing(t *testing.T) {
	w := newWatch(newMonitor(100, 1000), classifyByDestination)
	k := outTuple(1, 20, 40000, 5432, unix.IPPROTO_TCP)
	seedWith(t, w, seedOf(w, k, 100, 200, t0))
	w.apply(newEvent(k, false), t0+1)
	w.apply(newEvent(k, false), t0+2)
	g := groupOf(t, w.Collect2(t).Groups, 5432)
	if g.Flows != 1 || g.Orig != 100 || g.Repl != 200 {
		t.Fatalf("a replayed NEW double counted: %+v", g)
	}
}

func TestDestroyOfASeededFlowReportsOnlyTheBytesSinceTheLastSample(t *testing.T) {
	w := newWatch(newMonitor(100, 1000), classifyByDestination)
	k := outTuple(1, 20, 40000, 5432, unix.IPPROTO_TCP)
	seedWith(t, w, seedOf(w, k, 100, 200, t0))
	w.Collect2(t)
	w.apply(destroyEvent(k, 160, 290), t0+1)
	g := groupOf(t, w.Collect2(t).Groups, 5432)
	if g.Flows != 0 || g.Orig != 160 || g.Repl != 290 || g.DeltaOrig != 60 || g.DeltaRepl != 90 {
		t.Fatalf("got %+v", g)
	}
	if after := w.Collect2(t).Groups; len(after) != 0 {
		t.Fatalf("a closed flow reported twice: %+v", after)
	}
}

func TestNewThenDestroyCountsTheFinalCountersOnce(t *testing.T) {
	w := newWatch(newMonitor(100, 1000), classifyByDestination)
	k := outTuple(7, 30, 41000, 8080, unix.IPPROTO_TCP)
	w.apply(newEvent(k, false), t0)
	if g := groupOf(t, w.Collect2(t).Groups, 8080); g.Flows != 1 || g.Orig != 0 {
		t.Fatalf("open flow: %+v", g)
	}
	w.apply(destroyEvent(k, 500, 4000), t0+1)
	g := groupOf(t, w.Collect2(t).Groups, 8080)
	if g.Flows != 0 || g.Orig != 500 || g.Repl != 4000 || g.DeltaOrig != 500 {
		t.Fatalf("got %+v", g)
	}
}

func TestDestroyOfAnUnknownFlowAddsItsCountersOnly(t *testing.T) {
	w := newWatch(newMonitor(100, 1000), classifyByDestination)
	k := outTuple(9, 30, 41000, 8080, unix.IPPROTO_TCP)
	w.apply(destroyEvent(k, 70, 80), t0)
	g := groupOf(t, w.Collect2(t).Groups, 8080)
	if g.Flows != 0 || g.Orig != 70 || g.Repl != 80 {
		t.Fatalf("got %+v", g)
	}
	if len(w.table) != 0 {
		t.Fatal("a destroyed flow must not enter the table")
	}
}

func TestDestroyWithoutCountersForAnUnknownFlowIsIgnored(t *testing.T) {
	w := newWatch(newMonitor(100, 1000), classifyByDestination)
	k := outTuple(9, 30, 41000, 8080, unix.IPPROTO_TCP)
	w.apply(&message{kind: kindDestroy, key: k}, t0)
	if got := w.Collect2(t).Groups; len(got) != 0 {
		t.Fatalf("got %+v", got)
	}
}

func TestEventsAfterTheSeedNeitherLoseNorRepeatAFlow(t *testing.T) {
	w := newWatch(newMonitor(100, 1000), classifyByDestination)
	a := outTuple(1, 20, 40000, 5432, unix.IPPROTO_TCP)
	b := outTuple(2, 20, 40001, 5432, unix.IPPROTO_TCP)
	c := outTuple(3, 20, 40002, 5432, unix.IPPROTO_TCP)
	seedWith(t, w, seedOf(w, a, 100, 100, t0), seedOf(w, b, 200, 200, t0))
	w.apply(newEvent(a, false), t0)
	w.apply(newEvent(c, false), t0)
	w.apply(destroyEvent(b, 260, 260), t0)
	g := groupOf(t, w.Collect2(t).Groups, 5432)
	if g.Flows != 2 {
		t.Fatalf("flows %d", g.Flows)
	}
	if g.Orig != 100+260 || g.Repl != 100+260 {
		t.Fatalf("bytes %d/%d", g.Orig, g.Repl)
	}
	if g.DeltaOrig != 60 {
		t.Fatalf("delta %d", g.DeltaOrig)
	}
}

func TestRefreshUpdatesOpenFlowCountersAndTCPState(t *testing.T) {
	w := newWatch(newMonitor(100, 1000), classifyByDestination)
	k := outTuple(1, 20, 40000, 5432, unix.IPPROTO_TCP)
	seedWith(t, w, seedOf(w, k, 100, 100, t0))
	w.Collect2(t)
	w.applyGet(k, &getResult{msg: message{key: k, counters: true, origB: 400, replB: 900, hasTCP: true, tcp: 4}}, t0+int64(time.Second))
	g := groupOf(t, w.Collect2(t).Groups, 5432)
	if g.Orig != 400 || g.Repl != 900 || g.DeltaOrig != 300 || g.DeltaRepl != 800 || g.Established != 0 {
		t.Fatalf("got %+v", g)
	}
	if g.OldestRead != t0+int64(time.Second) {
		t.Fatalf("counters read at %d", g.OldestRead)
	}
}

func TestRefreshThatFindsNoEntryClosesTheFlowOnceAndAbsorbsTheLateDestroy(t *testing.T) {
	w := newWatch(newMonitor(100, 1000), classifyByDestination)
	k := outTuple(1, 20, 40000, 5432, unix.IPPROTO_TCP)
	seedWith(t, w, seedOf(w, k, 100, 100, t0))
	w.Collect2(t)
	w.table[k] = withCounters(w.table[k], 150, 160)
	w.applyGet(k, &getResult{err: unix.ENOENT}, t0+1)
	if _, held := w.table[k]; held {
		t.Fatal("ENOENT must remove the flow")
	}
	w.apply(destroyEvent(k, 180, 190), t0+2)
	g := groupOf(t, w.Collect2(t).Groups, 5432)
	if g.Orig != 150+30 || g.Repl != 160+30 {
		t.Fatalf("the late DESTROY double counted: %+v", g)
	}
}

func withCounters(f flow, orig, repl uint64) flow {
	f.orig, f.repl = orig, repl
	return f
}

func TestRefreshOfAReusedIDTreatsTheOldFlowAsClosed(t *testing.T) {
	w := newWatch(newMonitor(100, 1000), classifyByDestination)
	k := outTuple(1, 20, 40000, 5432, unix.IPPROTO_TCP)
	seedWith(t, w, seedOf(w, k, 100, 100, t0))
	w.applyGet(k, &getResult{msg: message{key: key{id: 99, orig: k.orig}}}, t0+1)
	if _, held := w.table[k]; held {
		t.Fatal("a different conntrack id means the flow closed")
	}
}

func TestFailedRefreshRequeuesTheFlowWithoutChangingIt(t *testing.T) {
	w := newWatch(newMonitor(100, 1000), classifyByDestination)
	k := outTuple(1, 20, 40000, 5432, unix.IPPROTO_TCP)
	seedWith(t, w, seedOf(w, k, 100, 100, t0))
	before := len(w.order)
	w.applyGet(k, &getResult{err: unix.EINTR}, t0+1)
	if len(w.order) != before+1 || w.table[k].orig != 100 {
		t.Fatalf("order %d table %+v", len(w.order), w.table[k])
	}
}

func TestOnlyTCPAndUDPFlowsAreQueuedForRefresh(t *testing.T) {
	w := newWatch(newMonitor(100, 1000), func(orig, reply Tuple) (GroupKey, bool) {
		return GroupKey{Peer: Peer{Kind: "address"}, Proto: orig.Proto}, true
	})
	seedWith(t, w,
		seedOf(w, outTuple(1, 20, 1, 1, unix.IPPROTO_TCP), 0, 0, 0),
		seedOf(w, outTuple(2, 20, 1, 1, unix.IPPROTO_UDP), 0, 0, 0),
		seedOf(w, outTuple(3, 20, 0, 0, unix.IPPROTO_ICMP), 0, 0, 0),
	)
	if len(w.table) != 3 || len(w.order) != 2 {
		t.Fatalf("table %d order %d", len(w.table), len(w.order))
	}
}

func TestUnclassifiedFlowsAreHeldButNeverReported(t *testing.T) {
	w := newWatch(newMonitor(100, 1000), classifyByDestination)
	k := outTuple(5, 20, 0, 0, unix.IPPROTO_ICMP)
	seedWith(t, w, seedOf(w, k, 1, 1, t0))
	if len(w.table) != 1 {
		t.Fatal("flow should be held")
	}
	if got := w.Collect2(t).Groups; len(got) != 0 {
		t.Fatalf("got %+v", got)
	}
	w.apply(destroyEvent(k, 9, 9), t0)
	if got := w.Collect2(t).Groups; len(got) != 0 {
		t.Fatalf("a destroyed unclassified flow reported %+v", got)
	}
}

func TestInternetPeersOfOnePortFormOneGroupWithoutAClientAddress(t *testing.T) {
	w := newWatch(newMonitor(100, 1000), classifyByDestination)
	seedWith(t, w,
		seedOf(w, inTuple(1, 5, 50000, 3000), 10, 10, t0),
		seedOf(w, inTuple(2, 6, 50001, 3000), 10, 10, t0),
		seedOf(w, inTuple(3, 7, 50002, 3000), 10, 10, t0),
		seedOf(w, inTuple(4, 7, 50003, 4000), 10, 10, t0),
	)
	stats := w.Collect2(t).Groups
	if len(stats) != 2 {
		t.Fatalf("groups %+v", stats)
	}
	g := groupOf(t, stats, 3000)
	if g.Flows != 3 || g.Key.Out || g.Key.Peer != (Peer{Kind: "internet"}) {
		t.Fatalf("got %+v", g)
	}
	if g.Key.Peer.Address != "" {
		t.Fatal("client address leaked into the group key")
	}
}

func TestStationPeerKindGroupsSeparatelyFromOtherPeers(t *testing.T) {
	station := func(orig, reply Tuple) (GroupKey, bool) {
		kind := "station"
		if orig.Src[3] == 99 {
			kind = "gateway"
		}
		return GroupKey{Peer: Peer{Kind: kind}, Port: orig.DPort, Proto: orig.Proto}, true
	}
	w := newWatch(newMonitor(100, 1000), station)
	mk := func(id uint32, src byte) key {
		return key{id: id, orig: Tuple{Src: [4]byte{10, 200, 1, src}, Dst: [4]byte{10, 200, 1, serviceAddr}, SPort: uint16(id), DPort: 3000, Proto: unix.IPPROTO_TCP}}
	}
	seedWith(t, w, seedOf(w, mk(1, 1), 1, 1, t0), seedOf(w, mk(2, 1), 1, 1, t0), seedOf(w, mk(3, 99), 1, 1, t0))
	stats := w.Collect2(t).Groups
	kinds := map[string]int{}
	for _, s := range stats {
		kinds[s.Key.Peer.Kind] = s.Flows
	}
	if kinds["station"] != 2 || kinds["gateway"] != 1 || len(stats) != 2 {
		t.Fatalf("got %v", kinds)
	}
}

func TestDifferentPortsAndProtocolsAreDifferentGroups(t *testing.T) {
	w := newWatch(newMonitor(100, 1000), classifyByDestination)
	seedWith(t, w,
		seedOf(w, outTuple(1, 20, 1, 53, unix.IPPROTO_UDP), 1, 1, t0),
		seedOf(w, outTuple(2, 20, 2, 53, unix.IPPROTO_TCP), 1, 1, t0),
		seedOf(w, outTuple(3, 21, 3, 53, unix.IPPROTO_TCP), 1, 1, t0),
	)
	if got := len(w.Collect2(t).Groups); got != 3 {
		t.Fatalf("groups %d", got)
	}
}

func TestCollectReportsTheOldestStartAndMarksUnknownStarts(t *testing.T) {
	w := newWatch(newMonitor(100, 1000), classifyByDestination)
	seedWith(t, w,
		seedOf(w, outTuple(1, 20, 1, 80, unix.IPPROTO_TCP), 1, 1, t0-int64(100*time.Second)),
		seedOf(w, outTuple(2, 20, 2, 80, unix.IPPROTO_TCP), 1, 1, t0-int64(50*time.Second)),
		seedOf(w, outTuple(3, 20, 3, 80, unix.IPPROTO_TCP), 1, 1, 0),
	)
	g := groupOf(t, w.Collect2(t).Groups, 80)
	if !g.StartUnknown || g.OldestStart != t0-int64(100*time.Second) {
		t.Fatalf("got %+v", g)
	}
}

func TestNewEventUsesTheKernelStartWhenPresentAndTheArrivalTimeOtherwise(t *testing.T) {
	w := newWatch(newMonitor(100, 1000), classifyByDestination)
	a := outTuple(1, 20, 1, 80, unix.IPPROTO_TCP)
	b := outTuple(2, 20, 2, 80, unix.IPPROTO_TCP)
	w.apply(&message{kind: kindNew, key: a, start: t0 - 5}, t0)
	w.apply(newEvent(b, false), t0)
	if w.table[a].start != t0-5 || w.table[b].start != t0 || !w.table[b].startKnown {
		t.Fatalf("starts %d %d", w.table[a].start, w.table[b].start)
	}
}

func TestPerNamespaceCapStopsStoringAndMarksTheSampleTruncated(t *testing.T) {
	m := newMonitor(3, 1000)
	w := newWatch(m, classifyByDestination)
	for i := uint32(1); i <= 5; i++ {
		w.apply(newEvent(outTuple(i, 20, uint16(i), 80, unix.IPPROTO_TCP), false), t0)
	}
	if len(w.table) != 3 || w.notStored != 2 || m.Flows() != 3 {
		t.Fatalf("table %d not stored %d station %d", len(w.table), w.notStored, m.Flows())
	}
	if s := w.Collect2(t); !s.Truncated {
		t.Fatalf("snapshot %+v", s)
	}
}

func TestPerStationCapIsSharedAcrossNamespaces(t *testing.T) {
	m := newMonitor(10, 4)
	a, b := newWatch(m, classifyByDestination), newWatch(m, classifyByDestination)
	for i := uint32(1); i <= 3; i++ {
		a.apply(newEvent(outTuple(i, 20, uint16(i), 80, unix.IPPROTO_TCP), false), t0)
	}
	for i := uint32(1); i <= 3; i++ {
		b.apply(newEvent(outTuple(i, 20, uint16(i), 80, unix.IPPROTO_TCP), false), t0)
	}
	if len(a.table) != 3 || len(b.table) != 1 || m.Flows() != 4 {
		t.Fatalf("a %d b %d station %d", len(a.table), len(b.table), m.Flows())
	}
	if b.notStored != 2 {
		t.Fatalf("b not stored %d", b.notStored)
	}
}

func TestClosedFlowsReleaseTheirStationReservation(t *testing.T) {
	m := newMonitor(10, 2)
	w := newWatch(m, classifyByDestination)
	a, b, c := outTuple(1, 20, 1, 80, unix.IPPROTO_TCP), outTuple(2, 20, 2, 80, unix.IPPROTO_TCP), outTuple(3, 20, 3, 80, unix.IPPROTO_TCP)
	w.apply(newEvent(a, false), t0)
	w.apply(newEvent(b, false), t0)
	w.apply(newEvent(c, false), t0)
	if len(w.table) != 2 {
		t.Fatalf("table %d", len(w.table))
	}
	w.apply(destroyEvent(a, 1, 1), t0)
	w.apply(newEvent(c, false), t0)
	if len(w.table) != 2 || m.Flows() != 2 {
		t.Fatalf("table %d station %d", len(w.table), m.Flows())
	}
}

func TestSeedStopsAtTheCapAndReportsTruncation(t *testing.T) {
	m := newMonitor(2, 1000)
	w := newWatch(m, classifyByDestination)
	seedWith(t, w,
		seedOf(w, outTuple(1, 20, 1, 80, unix.IPPROTO_TCP), 1, 1, t0),
		seedOf(w, outTuple(2, 20, 2, 80, unix.IPPROTO_TCP), 1, 1, t0),
		seedOf(w, outTuple(3, 20, 3, 80, unix.IPPROTO_TCP), 1, 1, t0),
	)
	if len(w.table) != 2 || !w.truncated || w.notStored != 1 {
		t.Fatalf("table %d truncated %v not stored %d", len(w.table), w.truncated, w.notStored)
	}
}

func TestResyncReplacesTheTableAndReleasesTheOldReservation(t *testing.T) {
	m := newMonitor(10, 1000)
	w := newWatch(m, classifyByDestination)
	seedWith(t, w,
		seedOf(w, outTuple(1, 20, 1, 80, unix.IPPROTO_TCP), 1, 1, t0),
		seedOf(w, outTuple(2, 20, 2, 80, unix.IPPROTO_TCP), 1, 1, t0),
	)
	w.install([]seeded{seedOf(w, outTuple(2, 20, 2, 80, unix.IPPROTO_TCP), 5, 5, t0)}, nil, false, 0, time.Now())
	if len(w.table) != 1 || m.Flows() != 1 {
		t.Fatalf("table %d station %d", len(w.table), m.Flows())
	}
}

func TestResyncKeepsTheDeltaBaselineOfSurvivingFlows(t *testing.T) {
	w := newWatch(newMonitor(10, 1000), classifyByDestination)
	k := outTuple(1, 20, 1, 80, unix.IPPROTO_TCP)
	seedWith(t, w, seedOf(w, k, 100, 100, t0))
	w.Collect2(t)
	w.install([]seeded{seedOf(w, k, 160, 130, t0)}, nil, false, 0, time.Now())
	g := groupOf(t, w.Collect2(t).Groups, 80)
	if g.DeltaOrig != 60 || g.DeltaRepl != 30 {
		t.Fatalf("got %+v", g)
	}
}

func TestResyncMarksTheNextSampleLossyOnce(t *testing.T) {
	w := newWatch(newMonitor(10, 1000), classifyByDestination)
	seedWith(t, w)
	if w.Collect2(t).Lossy {
		t.Fatal("the initial seed is not lossy")
	}
	w.install(nil, nil, false, 0, time.Now())
	if !w.Collect2(t).Lossy {
		t.Fatal("the sample after a resync must be lossy")
	}
	if w.Collect2(t).Lossy {
		t.Fatal("lossy must clear after one sample")
	}
}

func TestFailedDumpKeepsTheTableStaleAndSchedulesARetry(t *testing.T) {
	m := newMonitor(10, 1000)
	w := newWatch(m, classifyByDestination)
	seedWith(t, w, seedOf(w, outTuple(1, 20, 1, 80, unix.IPPROTO_TCP), 1, 1, t0))
	w.overflow()
	w.install(nil, unix.EIO, false, 0, time.Now())
	if s := w.Collect2(t); !s.Stale {
		t.Fatalf("snapshot %+v", s)
	}
	if len(w.table) != 1 {
		t.Fatal("a failed dump must not discard the table")
	}
	if len(m.queue) != 1 || !m.queue[0].notBefore.After(time.Now().Add(20*time.Second)) {
		t.Fatalf("queue %+v", m.queue)
	}
}

func TestOverflowMarksTheWatchStaleUntilTheResyncReturns(t *testing.T) {
	m := newMonitor(10, 1000)
	w := newWatch(m, classifyByDestination)
	seedWith(t, w)
	if w.Collect2(t).Stale {
		t.Fatal("seeded watch is current")
	}
	w.overflow()
	if !w.Collect2(t).Stale {
		t.Fatal("ENOBUFS must mark the sample stale")
	}
	w.install(nil, nil, false, 0, time.Now())
	if w.Collect2(t).Stale {
		t.Fatal("a completed resync clears stale")
	}
}

func TestFirstOverflowResyncsImmediately(t *testing.T) {
	m := newMonitor(10, 1000)
	w := newWatch(m, classifyByDestination)
	seedWith(t, w)
	w.mu.Lock()
	w.lastSync = time.Now().Add(-time.Hour)
	w.mu.Unlock()
	before := time.Now()
	w.overflow()
	if len(m.queue) != 1 || m.queue[0].notBefore.After(time.Now().Add(time.Second)) || m.queue[0].notBefore.Before(before.Add(-time.Second)) {
		t.Fatalf("queue %+v", m.queue)
	}
	if w.backoff != resyncSpacing {
		t.Fatalf("backoff %v", w.backoff)
	}
}

func TestRepeatedOverflowWithin30sBacksOffDoublingToFiveMinutes(t *testing.T) {
	m := newMonitor(10, 1000)
	w := newWatch(m, classifyByDestination)
	seedWith(t, w)
	want := []time.Duration{30 * time.Second, 60 * time.Second, 120 * time.Second, 240 * time.Second, 300 * time.Second, 300 * time.Second}
	for i, d := range want {
		m.queue = nil
		w.mu.Lock()
		w.lastSync = time.Now().Add(-time.Second)
		w.mu.Unlock()
		start := time.Now()
		w.overflow()
		wait := m.queue[0].notBefore.Sub(start)
		if wait < d-time.Second || wait > d+time.Second {
			t.Fatalf("overflow %d waits %v, want %v", i+1, wait, d)
		}
	}
}

func TestOverflowAfterAQuietPeriodResetsTheBackoff(t *testing.T) {
	m := newMonitor(10, 1000)
	w := newWatch(m, classifyByDestination)
	seedWith(t, w)
	for range 3 {
		w.mu.Lock()
		w.lastSync = time.Now().Add(-time.Second)
		w.mu.Unlock()
		w.overflow()
	}
	if w.backoff <= resyncSpacing {
		t.Fatalf("backoff %v did not grow", w.backoff)
	}
	w.mu.Lock()
	w.lastSync = time.Now().Add(-2 * resyncSpacing)
	w.mu.Unlock()
	m.queue = nil
	w.overflow()
	if w.backoff != resyncSpacing {
		t.Fatalf("backoff %v", w.backoff)
	}
}

func TestEnqueueKeepsOneRequestPerWatchAndTheEarliestTime(t *testing.T) {
	m := newMonitor(10, 1000)
	w := newWatch(m, classifyByDestination)
	later, sooner := time.Now().Add(time.Minute), time.Now().Add(time.Second)
	m.enqueue(w, later)
	m.enqueue(w, sooner)
	m.enqueue(w, later)
	if len(m.queue) != 1 || !m.queue[0].notBefore.Equal(sooner) {
		t.Fatalf("queue %+v", m.queue)
	}
}

func TestEnqueueIgnoresAWatchThatWasForgotten(t *testing.T) {
	m := newMonitor(10, 1000)
	w := newWatch(m, classifyByDestination)
	m.forget(w)
	m.enqueue(w, time.Now())
	if len(m.queue) != 0 {
		t.Fatalf("queue %+v", m.queue)
	}
}

func TestNextGrantsDueRequestsInOrderAndReportsTheWait(t *testing.T) {
	m := newMonitor(10, 1000)
	a, b := newWatch(m, classifyByDestination), newWatch(m, classifyByDestination)
	now := time.Now()
	m.enqueue(a, now.Add(time.Minute))
	m.enqueue(b, now.Add(-time.Second))
	got, wait := m.next(now)
	if got != b || wait != 0 {
		t.Fatalf("got %v wait %v", got == b, wait)
	}
	got, wait = m.next(now)
	if got != nil || wait != time.Minute {
		t.Fatalf("got %v wait %v", got, wait)
	}
}

func TestCountDriftBeyondTenPercentForThreeTicksRequestsAResync(t *testing.T) {
	m := newMonitor(100, 1000)
	w := newWatch(m, classifyByDestination)
	flows := make([]seeded, 0, 10)
	for i := uint32(1); i <= 10; i++ {
		flows = append(flows, seedOf(w, outTuple(i, 20, uint16(i), 80, unix.IPPROTO_TCP), 1, 1, t0))
	}
	seedWith(t, w, flows...)
	w.mu.Lock()
	w.lastSync = time.Now().Add(-time.Hour)
	w.mu.Unlock()
	now := time.Now().UnixNano()
	for i := 0; i < driftTicks-1; i++ {
		w.recordCount(20, nil, now)
		if len(m.queue) != 0 {
			t.Fatalf("tick %d queued early", i+1)
		}
	}
	w.recordCount(20, nil, now)
	if len(m.queue) != 1 {
		t.Fatalf("queue %+v", m.queue)
	}
}

func TestCountWithinTenPercentResetsTheDriftRun(t *testing.T) {
	m := newMonitor(100, 1000)
	w := newWatch(m, classifyByDestination)
	flows := make([]seeded, 0, 10)
	for i := uint32(1); i <= 10; i++ {
		flows = append(flows, seedOf(w, outTuple(i, 20, uint16(i), 80, unix.IPPROTO_TCP), 1, 1, t0))
	}
	seedWith(t, w, flows...)
	w.mu.Lock()
	w.lastSync = time.Now().Add(-time.Hour)
	w.mu.Unlock()
	now := time.Now().UnixNano()
	w.recordCount(20, nil, now)
	w.recordCount(20, nil, now)
	w.recordCount(10, nil, now)
	w.recordCount(20, nil, now)
	w.recordCount(20, nil, now)
	if len(m.queue) != 0 || w.drift != 2 {
		t.Fatalf("queue %d drift %d", len(m.queue), w.drift)
	}
}

func TestDriftResyncWaitsForTheSpacingSinceTheLastSync(t *testing.T) {
	m := newMonitor(100, 1000)
	w := newWatch(m, classifyByDestination)
	seedWith(t, w, seedOf(w, outTuple(1, 20, 1, 80, unix.IPPROTO_TCP), 1, 1, t0))
	now := time.Now().UnixNano()
	for range driftTicks + 2 {
		w.recordCount(50, nil, now)
	}
	if len(m.queue) != 0 {
		t.Fatal("a resync inside 30 s of the last one must wait")
	}
}

func TestCountErrorClearsTheEntryCount(t *testing.T) {
	w := newWatch(newMonitor(100, 1000), classifyByDestination)
	n := 5
	w.entries = &n
	w.recordCount(0, unix.EIO, time.Now().UnixNano())
	if w.entries != nil {
		t.Fatal("entries must be unknown after a failed read")
	}
}

func TestTruncationClearsWhenTheKernelCountFitsTheTable(t *testing.T) {
	m := newMonitor(2, 1000)
	w := newWatch(m, classifyByDestination)
	seedWith(t, w,
		seedOf(w, outTuple(1, 20, 1, 80, unix.IPPROTO_TCP), 1, 1, t0),
		seedOf(w, outTuple(2, 20, 2, 80, unix.IPPROTO_TCP), 1, 1, t0),
		seedOf(w, outTuple(3, 20, 3, 80, unix.IPPROTO_TCP), 1, 1, t0),
	)
	w.recordCount(3, nil, time.Now().UnixNano())
	if !w.truncated {
		t.Fatal("count above the table keeps the truncation")
	}
	w.recordCount(2, nil, time.Now().UnixNano())
	if w.truncated || w.notStored != 0 {
		t.Fatalf("truncated %v not stored %d", w.truncated, w.notStored)
	}
}

func TestCollectReportsTheEntryCountWhenKnown(t *testing.T) {
	w := newWatch(newMonitor(100, 1000), classifyByDestination)
	seedWith(t, w)
	n := 41
	w.entries = &n
	s := w.Collect(time.Unix(0, t0))
	if s.Entries == nil || *s.Entries != 41 {
		t.Fatalf("entries %v", s.Entries)
	}
}

func TestTombstonesExpireAfterTheirLifetime(t *testing.T) {
	w := newWatch(newMonitor(100, 1000), classifyByDestination)
	k := outTuple(1, 20, 1, 80, unix.IPPROTO_TCP)
	w.tombs[k] = tomb{at: t0}
	w.collect(t0 + int64(tombLifetime) - 1)
	if len(w.tombs) != 1 {
		t.Fatal("tomb expired early")
	}
	w.collect(t0 + int64(tombLifetime) + 1)
	if len(w.tombs) != 0 {
		t.Fatal("tomb outlived its lifetime")
	}
}

func TestCollectClosedGroupCountersAgeIsTheCollectionTime(t *testing.T) {
	w := newWatch(newMonitor(100, 1000), classifyByDestination)
	w.apply(destroyEvent(outTuple(9, 30, 41000, 8080, unix.IPPROTO_TCP), 1, 1), t0)
	g := groupOf(t, w.collect(t0+77), 8080)
	if g.OldestRead != t0+77 {
		t.Fatalf("oldest read %d", g.OldestRead)
	}
}
