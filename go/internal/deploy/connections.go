//go:build linux

package deploy

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/netip"
	"slices"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/harshjv/stationly/go/internal/dispatch"
	"github.com/harshjv/stationly/go/internal/dns"
	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/flows"
	"github.com/harshjv/stationly/go/internal/logstore"
	"github.com/harshjv/stationly/go/internal/netns"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/moby/moby/api/types/container"
	"golang.org/x/sys/unix"
)

const (
	networkEvery     = 5 * time.Second
	oneShotHold      = 60 * time.Second
	sampleReuse      = 5 * time.Second
	sampleWait       = 8 * time.Second
	watchRetry       = 5 * time.Second
	groupsMax        = 64
	refusedMax       = 32
	networkFrameMax  = 192 << 10
	networkStatsEach = time.Minute
)

var cloudMetadata = netip.MustParseAddr("169.254.169.254")

type owner struct {
	serviceID    string
	deploymentID string
	sandbox      bool
}

type envPeers struct {
	gateway    netip.Addr
	vips       map[netip.Addr]string
	containers map[netip.Addr]owner
}

type netTarget struct {
	serviceID    string
	envID        string
	deploymentID string
	container    string
	pid          int
	inode        uint64
	self         netip.Addr
	rejects      []netip.Addr
	resolver     netip.Addr
	subnet       netip.Prefix
	state        string
	health       string
	sandbox      bool
	ring         netip.Addr
	baseline     netns.SandboxBaseline
	runsc        string
}

type netState struct {
	targets map[string]netTarget
	envs    map[string]*envPeers
	ingress netip.Prefix
	hosts   []netip.Prefix
	pool    netip.Prefix
	gateway string
}

type svcWatch struct {
	target  netTarget
	w       *flows.Watch
	refused *netns.RefusedReader
	lastAt  time.Time
}

type sampleRec struct {
	sample protocol.NetworkSample
	at     time.Time
}

type netStream struct {
	ids    []string
	notify chan time.Time
}

type netHub struct {
	log      *slog.Logger
	mon      *flows.Monitor
	resolver *dns.Resolver
	state    atomic.Pointer[netState]

	hostOriginal func(flows.Tuple) (flows.Tuple, bool)

	mu       sync.Mutex
	watched  map[string]*svcWatch
	subs     map[string]int
	oneShot  map[string]time.Time
	failedAt map[string]time.Time
	samples  map[string]sampleRec
	streams  map[*netStream]bool
	owners   map[netip.Addr]string
	probing  map[string]bool

	built        atomic.Int64
	buildNanos   atomic.Int64
	refusedNanos atomic.Int64
}

func newNetHub(log *slog.Logger, resolver *dns.Resolver) *netHub {
	h := &netHub{
		log: log, mon: flows.New(log), resolver: resolver,
		watched: map[string]*svcWatch{}, subs: map[string]int{}, oneShot: map[string]time.Time{}, failedAt: map[string]time.Time{},
		samples: map[string]sampleRec{}, streams: map[*netStream]bool{}, owners: map[netip.Addr]string{}, probing: map[string]bool{},
	}
	h.hostOriginal = h.mon.HostOriginal
	h.state.Store(&netState{targets: map[string]netTarget{}, envs: map[string]*envPeers{}})
	return h
}

func (h *netHub) run(ctx context.Context) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	samples := time.NewTicker(networkEvery)
	defer samples.Stop()
	stats := time.NewTicker(networkStatsEach)
	defer stats.Stop()
	for {
		select {
		case <-ctx.Done():
			h.close()
			return
		case now := <-t.C:
			h.mu.Lock()
			h.reconcile(now)
			h.mu.Unlock()
		case now := <-samples.C:
			h.mu.Lock()
			h.reconcile(now)
			h.mu.Unlock()
			if len(h.watchedIDs()) > 0 {
				h.sampleAll(now)
				continue
			}
			h.notify(now)
		case <-stats.C:
			h.logStats()
		}
	}
}

func (h *netHub) logStats() {
	n := h.mon.Watching()
	if n == 0 {
		return
	}
	st := &h.mon.Stats
	h.log.Info("network visibility", "watched", n, "flows", h.mon.Flows(), "seeds", st.Seeds.Load(), "resyncs", st.Resyncs.Load(), "reaps", st.Reaps.Load(), "reap_ms_total", st.ReapNanos.Load()/1e6, "refreshed", st.Refreshed.Load(), "refresh_cpu_ms_total", st.RefreshNanos.Load()/1e6, "host_lookups", st.HostLookups.Load(), "samples", h.built.Load(), "sample_ms_total", h.buildNanos.Load()/1e6, "refused_read_ms_total", h.refusedNanos.Load()/1e6)
}

func (h *netHub) close() {
	h.mu.Lock()
	for id, sw := range h.watched {
		h.stopWatch(id, sw)
	}
	h.mu.Unlock()
	h.mon.Close()
}

func (h *netHub) watchedIDs() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]string, 0, len(h.watched))
	for id := range h.watched {
		out = append(out, id)
	}
	return out
}

func (h *netHub) wanted(id string, now time.Time) bool {
	return h.subs[id] > 0 || now.Before(h.oneShot[id])
}

func (h *netHub) stopWatch(id string, sw *svcWatch) {
	sw.w.Close()
	sw.refused.Close()
	delete(h.watched, id)
	delete(h.samples, id)
}

func (h *netHub) reconcile(now time.Time) {
	st := h.state.Load()
	for id, until := range h.oneShot {
		if !now.Before(until) {
			delete(h.oneShot, id)
		}
	}
	for id, sw := range h.watched {
		t, ok := st.targets[id]
		if !h.wanted(id, now) || !ok || t.inode != sw.target.inode || sw.w.Failed() != nil {
			h.stopWatch(id, sw)
			continue
		}
		sw.target = t
	}
	ids := make([]string, 0, len(h.subs)+len(h.oneShot))
	for id := range h.subs {
		ids = append(ids, id)
	}
	for id := range h.oneShot {
		ids = append(ids, id)
	}
	for _, id := range ids {
		if _, ok := h.watched[id]; ok || !h.wanted(id, now) {
			continue
		}
		t, ok := st.targets[id]
		if !ok || now.Sub(h.failedAt[id]) < watchRetry {
			continue
		}
		w, err := h.mon.Watch(t.pid, t.inode, h.classifier(t))
		if err != nil {
			h.failedAt[id] = now
			h.log.Warn("watch service namespace", "service", id, "netns", t.inode, "error", err)
			continue
		}
		r, err := netns.OpenRefused(t.pid, t.inode)
		if err != nil {
			w.Close()
			h.failedAt[id] = now
			h.log.Warn("open the refused set reader", "service", id, "netns", t.inode, "error", err)
			continue
		}
		delete(h.failedAt, id)
		h.watched[id] = &svcWatch{target: t, w: w, refused: r}
		h.log.Info("watching service namespace", "service", id, "deployment", t.deploymentID, "netns", t.inode)
	}
}

func addr4(b [4]byte) netip.Addr {
	return netip.AddrFrom4(b)
}

func private(a netip.Addr) bool {
	for _, p := range netns.PrivateRanges {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

func (h *netHub) classifier(t netTarget) flows.Classifier {
	self, envID := t.self, t.envID
	return func(orig, reply flows.Tuple) (flows.GroupKey, bool) {
		if orig.Proto != unix.IPPROTO_TCP && orig.Proto != unix.IPPROTO_UDP {
			return flows.GroupKey{}, false
		}
		st := h.state.Load()
		env := st.envs[envID]
		if env == nil {
			env = &envPeers{}
		}
		src, dst := addr4(orig.Src), addr4(orig.Dst)
		if t.sandbox && (src != self || dst == netns.SandboxLink) {
			return flows.GroupKey{}, false
		}
		if src == self || src.IsLoopback() {
			k := flows.GroupKey{Out: true, Port: orig.DPort, Proto: orig.Proto}
			real := addr4(reply.Src)
			if svc, ok := env.vips[dst]; ok {
				k.Peer = flows.Peer{Kind: "service", ServiceID: svc, DeploymentID: env.containers[real].deploymentID}
				return k, true
			}
			switch o, ok := env.containers[real]; {
			case (real == env.gateway || real == t.resolver) && orig.DPort == 53:
				k.Peer = flows.Peer{Kind: "resolver"}
			case ok && o.sandbox:
				k.Peer = flows.Peer{Kind: "sandbox", ServiceID: o.serviceID}
			case ok:
				k.Peer = flows.Peer{Kind: "service", ServiceID: o.serviceID, DeploymentID: o.deploymentID}
			case !private(real):
				k.Peer = flows.Peer{Kind: "public", Address: real.String()}
			default:
				k.Peer = flows.Peer{Kind: "address", Address: real.String()}
			}
			return k, true
		}
		k := flows.GroupKey{Out: false, Port: orig.DPort, Proto: orig.Proto}
		switch o, ok := env.containers[src]; {
		case ok && o.sandbox:
			k.Peer = flows.Peer{Kind: "sandbox", ServiceID: o.serviceID}
		case ok:
			k.Peer = flows.Peer{Kind: "service", ServiceID: o.serviceID, DeploymentID: o.deploymentID}
		case src == env.gateway && src.IsValid():
			k.Peer = flows.Peer{Kind: "station"}
			if host, found := h.hostOriginal(flows.Tuple{Src: orig.Dst, SPort: orig.DPort, Dst: orig.Src, DPort: orig.SPort, Proto: orig.Proto}); found && st.ingress.IsValid() && st.ingress.Contains(addr4(host.Src)) {
				k.Peer = flows.Peer{Kind: "gateway"}
			}
		case !private(src):
			k.Peer = flows.Peer{Kind: "internet"}
		default:
			k.Peer = flows.Peer{Kind: "address", Address: src.String()}
		}
		return k, true
	}
}

func (h *netHub) refusedPath(t netTarget, st *netState, a netip.Addr) protocol.RefusedPath {
	if t.sandbox {
		switch {
		case a == netns.SandboxLink || a == netns.CouplerLink || a == t.ring:
			return protocol.RefusedPathSandboxInbound
		case !private(a) && !slices.ContainsFunc(st.hosts, func(p netip.Prefix) bool { return p.Contains(a) }):
			return protocol.RefusedPathDomainNotAllowed
		}
	}
	switch {
	case slices.Contains(t.rejects, a):
		return protocol.RefusedPathNoSwitchTarget
	case slices.ContainsFunc(st.hosts, func(p netip.Prefix) bool { return p.Contains(a) }):
		return protocol.RefusedPathHostAddress
	case st.pool.IsValid() && st.pool.Contains(a):
		return protocol.RefusedPathOtherEnvironment
	case a == cloudMetadata:
		return protocol.RefusedPathCloudMetadata
	}
	return protocol.RefusedPathPrivateRange
}

func refusedProtocol(p uint8) (protocol.RefusedProtocol, bool) {
	switch p {
	case unix.IPPROTO_TCP:
		return protocol.RefusedProtocolTcp, true
	case unix.IPPROTO_UDP:
		return protocol.RefusedProtocolUdp, true
	case unix.IPPROTO_ICMP:
		return protocol.RefusedProtocolIcmp, false
	}
	return protocol.RefusedProtocolOther, false
}

func intp(v int) *int { return &v }

func emptySample(id, deploymentID string, at time.Time) protocol.NetworkSample {
	s := protocol.NetworkSample{
		ServiceId:   ptr(id),
		At:          logstore.FormatTime(at),
		Connections: []protocol.NetworkConnection{},
		Refused:     []protocol.NetworkRefused{},
		Names:       protocol.NetworkSampleNames{},
	}
	if deploymentID != "" {
		s.DeploymentId = protocol.NetworkSampleDeploymentId(ptr(deploymentID))
	}
	return s
}

func connectionOf(g flows.GroupStat, snap flows.Snapshot, now time.Time, dt float64) protocol.NetworkConnection {
	c := protocol.NetworkConnection{
		Direction:   protocol.NetworkDirectionIn,
		Port:        int(g.Key.Port),
		Protocol:    protocol.NetworkProtocolTcp,
		Flows:       g.Flows,
		Established: g.Established,
		Peer:        protocol.NetworkPeer{Kind: protocol.NetworkPeerKind(g.Key.Peer.Kind)},
	}
	if g.Key.Out {
		c.Direction = protocol.NetworkDirectionOut
	}
	if g.Key.Proto == unix.IPPROTO_UDP {
		c.Protocol = protocol.NetworkProtocolUdp
	}
	if g.Key.Peer.Kind == "sandbox" {
		c.Peer.SandboxId = ptr(g.Key.Peer.ServiceID)
	} else if g.Key.Peer.ServiceID != "" {
		c.Peer.ServiceId = ptr(g.Key.Peer.ServiceID)
		var dep *string
		if g.Key.Peer.DeploymentID != "" {
			dep = ptr(g.Key.Peer.DeploymentID)
		}
		c.Peer.DeploymentId = protocol.NetworkPeerDeploymentId(dep)
	}
	if g.Key.Peer.Address != "" {
		c.Peer.Address = ptr(g.Key.Peer.Address)
	}
	if snap.Accounting {
		out, in, dOut, dIn := g.Orig, g.Repl, g.DeltaOrig, g.DeltaRepl
		if !g.Key.Out {
			out, in, dOut, dIn = in, out, dIn, dOut
		}
		c.BytesOut, c.BytesIn = protocol.NetworkConnectionBytesOut(intp(int(out))), protocol.NetworkConnectionBytesIn(intp(int(in)))
		if dt > 0 {
			c.BpsOut, c.BpsIn = protocol.NetworkConnectionBpsOut(intp(int(float64(dOut)/dt))), protocol.NetworkConnectionBpsIn(intp(int(float64(dIn)/dt)))
		}
		c.CountersAgeS = protocol.NetworkConnectionCountersAgeS(intp(max(0, int(now.Sub(time.Unix(0, g.OldestRead)).Seconds()))))
	}
	if g.Flows > 0 && !g.StartUnknown && g.OldestStart > 0 {
		c.OldestS = protocol.NetworkConnectionOldestS(intp(max(0, int(now.Sub(time.Unix(0, g.OldestStart)).Seconds()))))
	}
	return c
}

func capGroups(groups []flows.GroupStat) []flows.GroupStat {
	sort.SliceStable(groups, func(i, j int) bool {
		bi, bj := groups[i].Orig+groups[i].Repl, groups[j].Orig+groups[j].Repl
		if bi != bj {
			return bi > bj
		}
		return groups[i].Flows > groups[j].Flows
	})
	if len(groups) <= groupsMax {
		return groups
	}
	rest := flows.GroupStat{Key: flows.GroupKey{Peer: flows.Peer{Kind: "other"}}}
	out, in := 0, 0
	tcp, udp := 0, 0
	for _, g := range groups[groupsMax-1:] {
		rest.Flows += g.Flows
		rest.Established += g.Established
		rest.Orig += g.Orig
		rest.Repl += g.Repl
		rest.DeltaOrig += g.DeltaOrig
		rest.DeltaRepl += g.DeltaRepl
		rest.StartUnknown = rest.StartUnknown || g.StartUnknown
		if g.OldestStart > 0 && (rest.OldestStart == 0 || g.OldestStart < rest.OldestStart) {
			rest.OldestStart = g.OldestStart
		}
		if g.OldestRead > 0 && (rest.OldestRead == 0 || g.OldestRead < rest.OldestRead) {
			rest.OldestRead = g.OldestRead
		}
		if g.Key.Out {
			out += g.Flows
		} else {
			in += g.Flows
		}
		if g.Key.Proto == unix.IPPROTO_UDP {
			udp += g.Flows
		} else {
			tcp += g.Flows
		}
	}
	rest.Key.Out = out >= in
	rest.Key.Proto = unix.IPPROTO_TCP
	if udp > tcp {
		rest.Key.Proto = unix.IPPROTO_UDP
	}
	return append(groups[:groupsMax-1:groupsMax-1], rest)
}

func (h *netHub) build(id string, sw *svcWatch, st *netState, now time.Time) protocol.NetworkSample {
	start := time.Now()
	defer func() {
		h.built.Add(1)
		h.buildNanos.Add(int64(time.Since(start)))
	}()
	t := sw.target
	s := emptySample(id, t.deploymentID, now)
	if t.sandbox {
		s.ServiceId, s.SandboxId = nil, ptr(id)
	}
	snap := sw.w.Collect(now)
	dt := 0.0
	if !snap.First && !sw.lastAt.IsZero() {
		dt = now.Sub(sw.lastAt).Seconds()
	}
	sw.lastAt = now
	groups := capGroups(snap.Groups)
	public := map[string]bool{}
	for _, g := range groups {
		s.Connections = append(s.Connections, connectionOf(g, snap, now, dt))
		if g.Key.Peer.Kind == "public" {
			public[g.Key.Peer.Address] = true
		}
	}
	readStart := time.Now()
	refused, tableOK, err := sw.refused.Read()
	h.refusedNanos.Add(int64(time.Since(readStart)))
	if err != nil {
		h.log.Debug("read the refused set", "service", id, "error", err)
	}
	s.Conntrack = protocol.NetworkConntrack{Truncated: snap.Truncated, Stale: snap.Stale, Lossy: snap.Lossy, Accounting: snap.Accounting, Timestamps: snap.Timestamps}
	if tableOK && snap.Entries != nil {
		s.Conntrack.Entries = protocol.NetworkConntrackEntries(intp(*snap.Entries))
	}
	s.RefusedTruncated = len(refused) >= netns.RefusedSize
	sort.SliceStable(refused, func(i, j int) bool { return refused[i].Count > refused[j].Count })
	for _, r := range refused[:min(len(refused), refusedMax)] {
		proto, ported := refusedProtocol(r.Proto)
		e := protocol.NetworkRefused{Path: h.refusedPath(t, st, r.Address), Address: r.Address.String(), Protocol: proto, Count: int(r.Count), ExpiresInS: int(r.Expires.Seconds())}
		if ported {
			e.Port = int(r.Port)
		}
		s.Refused = append(s.Refused, e)
	}
	if len(public) > 0 {
		ring := t.self
		if t.ring.IsValid() {
			ring = t.ring
		}
		for a, name := range h.resolver.Names(ring) {
			if public[a.String()] {
				s.Names[a.String()] = name
			}
		}
	}
	return s
}

func (h *netHub) sampleAll(now time.Time) {
	h.mon.Tick(now)
	st := h.state.Load()
	h.mu.Lock()
	for id, sw := range h.watched {
		h.samples[id] = sampleRec{sample: h.build(id, sw, st, now), at: now}
	}
	h.mu.Unlock()
	h.notify(now)
}

func (h *netHub) notify(at time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for s := range h.streams {
		select {
		case <-s.notify:
		default:
		}
		s.notify <- at
	}
}

func (h *netHub) tickSamples(ids []string, at time.Time) []protocol.NetworkSample {
	h.mu.Lock()
	defer h.mu.Unlock()
	st := h.state.Load()
	out := make([]protocol.NetworkSample, 0, len(ids))
	for _, id := range ids {
		if rec, ok := h.samples[id]; ok && !rec.at.Before(at) {
			smp := rec.sample
			smp.At = logstore.FormatTime(at)
			out = append(out, smp)
			continue
		}
		s := emptySample(id, st.targets[id].deploymentID, at)
		if _, ok := st.targets[id]; ok {
			s.Conntrack.Stale = true
		}
		out = append(out, s)
	}
	return out
}

func (h *netHub) subscribe(ids []string) *netStream {
	s := &netStream{ids: ids, notify: make(chan time.Time, 1)}
	h.mu.Lock()
	for _, id := range ids {
		h.subs[id]++
	}
	h.streams[s] = true
	h.reconcile(time.Now())
	h.mu.Unlock()
	return s
}

func (h *netHub) unsubscribe(s *netStream) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.streams, s)
	for _, id := range s.ids {
		if h.subs[id]--; h.subs[id] <= 0 {
			delete(h.subs, id)
		}
	}
	h.reconcile(time.Now())
}

func (h *netHub) sample(ids []string) []protocol.NetworkSample {
	now := time.Now()
	h.mu.Lock()
	var waits []<-chan struct{}
	for _, id := range ids {
		h.oneShot[id] = now.Add(oneShotHold)
	}
	h.reconcile(now)
	for _, id := range ids {
		if sw, ok := h.watched[id]; ok {
			waits = append(waits, sw.w.Ready())
		}
	}
	h.mu.Unlock()
	deadline := time.After(sampleWait)
	for _, ready := range waits {
		select {
		case <-ready:
		case <-deadline:
		}
	}
	st := h.state.Load()
	h.mu.Lock()
	defer h.mu.Unlock()
	now = time.Now()
	out := make([]protocol.NetworkSample, 0, len(ids))
	for _, id := range ids {
		if rec, ok := h.samples[id]; ok && now.Sub(rec.at) < sampleReuse {
			out = append(out, rec.sample)
			continue
		}
		sw, ok := h.watched[id]
		if !ok {
			s := emptySample(id, st.targets[id].deploymentID, now)
			if _, running := st.targets[id]; running {
				s.Conntrack.Stale = true
			}
			out = append(out, s)
			continue
		}
		s := h.build(id, sw, st, now)
		h.samples[id] = sampleRec{sample: s, at: now}
		out = append(out, s)
	}
	return out
}

func (s *Station) servingGreen(ctx context.Context) map[string]view {
	seen := map[string]bool{}
	out := map[string]view{}
	for _, r := range s.orderedRollouts() {
		if r.terminal() || !r.switched() || r.Green.Coupler == "" {
			continue
		}
		sp := s.plan.Services[r.ServiceID]
		if sp == nil {
			continue
		}
		seen[r.Green.Coupler] = true
		v, ok := s.greenViews[r.Green.Coupler]
		if !ok || v.pid <= 0 {
			v = s.inspectID(ctx, r.Green.Coupler, sp.NetworkName)
			s.greenViews[r.Green.Coupler] = v
		}
		if v.pid > 0 && v.state == string(container.StateRunning) {
			out[r.ServiceID] = v
		}
	}
	for name := range s.greenViews {
		if !seen[name] {
			delete(s.greenViews, name)
		}
	}
	return out
}

func (s *Station) syncNetwork(ctx context.Context) {
	if s.plan == nil {
		return
	}
	green := s.servingGreen(ctx)
	g := s.plan.Generation
	st := &netState{targets: map[string]netTarget{}, envs: map[string]*envPeers{}, hosts: s.hostPrefixes()}
	st.pool, _ = netip.ParsePrefix(g.Station.Settings.IpamPool)
	if s.plan.Gateway.Run {
		st.ingress = s.plan.Gateway.Ingress
		if c := s.gw.state.Current; c != nil {
			st.gateway = docker.GatewayCouplerName(c.Slot)
		}
	}
	owners := map[netip.Addr]string{}
	env := func(id string) *envPeers {
		e := st.envs[id]
		if e == nil {
			n := s.envNet(id)
			e = &envPeers{gateway: n.gateway, vips: map[netip.Addr]string{}, containers: map[netip.Addr]owner{}}
			for _, v := range g.Environments[id].VirtualIps {
				if a, err := netip.ParseAddr(v.Address); err == nil {
					e.vips[a] = v.ServiceId
				}
			}
			st.envs[id] = e
		}
		return e
	}
	for id, svc := range g.Services {
		sp, ss := s.plan.Services[id], s.services[id]
		e := env(svc.EnvironmentId)
		if sp == nil || ss == nil || ss.coupler.state != string(container.StateRunning) || !ss.coupler.address.IsValid() {
			continue
		}
		e.containers[ss.coupler.address] = owner{serviceID: id, deploymentID: sp.DeploymentID}
		owners[ss.coupler.address] = sp.Coupler.Name
		n := s.envNet(svc.EnvironmentId)
		state := ss.service.state
		if state == "" {
			state = ss.coupler.state
		}
		st.targets[id] = netTarget{serviceID: id, envID: svc.EnvironmentId, deploymentID: sp.DeploymentID, container: sp.Coupler.Name, pid: ss.coupler.pid, inode: ss.coupler.netns, self: ss.coupler.address, rejects: s.consumerFor(svc.EnvironmentId, svc.Reach).Reject, resolver: n.gateway, subnet: n.subnet, state: state, health: healthName(ss.health)}
	}
	for _, r := range s.orderedRollouts() {
		if r.terminal() {
			continue
		}
		e := env(r.EnvID)
		for _, side := range []*sideRef{&r.Green, r.Blue} {
			if side == nil {
				continue
			}
			if a := parseAddr(side.Address); a.IsValid() {
				if _, taken := e.containers[a]; !taken {
					e.containers[a] = owner{serviceID: r.ServiceID, deploymentID: side.DeploymentID}
					owners[a] = side.Coupler
				}
			}
		}
		if v, ok := green[r.ServiceID]; ok && v.address.IsValid() {
			if t, held := st.targets[r.ServiceID]; !held || t.container != r.Green.Coupler {
				svc := g.Services[r.ServiceID]
				n := s.envNet(r.EnvID)
				st.targets[r.ServiceID] = netTarget{serviceID: r.ServiceID, envID: r.EnvID, deploymentID: r.ID, container: r.Green.Coupler, pid: v.pid, inode: v.netns, self: v.address, rejects: s.consumerFor(r.EnvID, svc.Reach).Reject, resolver: n.gateway, subnet: n.subnet, state: v.state, health: healthName(r.rt.health)}
			}
		}
	}
	for id, sb := range s.sbx.states {
		d, ok := g.Sandboxes[id]
		addr, err := netip.ParseAddr(sb.rec.Address)
		if !ok || err != nil || sb.pid <= 0 || sb.rec.Status != protocol.SandboxReportStatusRunning {
			continue
		}
		t := netTarget{serviceID: id, container: "or-sbx-coupler-" + id, pid: sb.pid, inode: sb.inode, self: netns.SandboxLink, ring: addr, sandbox: true, state: "running", resolver: sb.baseline.Resolver, baseline: sb.baseline, runsc: sb.rec.Runsc}
		if d.Network == protocol.SandboxNetworkEnvironment {
			e := env(d.EnvironmentId)
			e.containers[addr] = owner{serviceID: id, sandbox: true}
			n := s.envNet(d.EnvironmentId)
			t.envID, t.subnet, t.rejects = d.EnvironmentId, n.subnet, s.consumerFor(d.EnvironmentId, d.Reach).Reject
		}
		owners[addr] = t.container
		st.targets[id] = t
	}
	h := s.net
	h.mu.Lock()
	for a, id := range h.owners {
		if owners[a] != id {
			s.resolver.Forget(a)
		}
	}
	h.owners = owners
	h.mu.Unlock()
	h.state.Store(st)
}

func (s *Station) networkBody(m dispatch.Message, b any) bool {
	if !s.requireCapability(m, protocol.CapabilityNetworkV1) {
		return false
	}
	if err := json.Unmarshal(m.Body, b); err != nil {
		s.replyError(m, protocolError(protocol.ErrorCodeProtocolInvalidMessage, "Send a "+m.Type+" body that matches its schema.", "%v", err))
		return false
	}
	return true
}

func (s *Station) sampleNetwork(m dispatch.Message) {
	var b protocol.NetworkSampleBody
	if !s.networkBody(m, &b) {
		return
	}
	ref := m.ID
	go func() {
		s.send(protocol.MessageNetworkSampleResult, &ref, protocol.NetworkSampleResultBody{Samples: s.net.sample(append(append([]string{}, b.ServiceIds...), b.SandboxIds...))})
	}()
}

func (s *Station) subscribeNetwork(ctx context.Context, m dispatch.Message) {
	var b protocol.NetworkSubscribeBody
	if !s.networkBody(m, &b) {
		return
	}
	st, err := s.link.OpenStream(protocol.LimitStreamWindowBytes, nil, nil)
	if err != nil {
		s.replyError(m, streamFailure(err))
		return
	}
	if err := st.Opened(m.ID, protocol.LimitStreamWindowBytes); err != nil {
		st.End("send failed", nil)
		return
	}
	sub := s.net.subscribe(append(append([]string{}, b.ServiceIds...), b.SandboxIds...))
	go func() {
		defer s.net.unsubscribe(sub)
		for {
			select {
			case <-st.Done():
				return
			case <-ctx.Done():
				st.End("stationd shutting down", nil)
				return
			case at := <-sub.notify:
				if err := sendNetworkSamples(ctx, st, s.net.tickSamples(sub.ids, at)); err != nil {
					return
				}
			}
		}
	}()
}

func sendNetworkSamples(ctx context.Context, st *dispatch.Stream, samples []protocol.NetworkSample) error {
	var frame []json.RawMessage
	size := 0
	flush := func() error {
		if len(frame) == 0 {
			return nil
		}
		err := st.SendItems(ctx, frame)
		frame, size = nil, 0
		return err
	}
	for _, smp := range samples {
		raw, err := json.Marshal(smp)
		if err != nil {
			return err
		}
		if size+len(raw) > networkFrameMax {
			if err := flush(); err != nil {
				return err
			}
		}
		frame = append(frame, raw)
		size += len(raw) + 1
	}
	return flush()
}
