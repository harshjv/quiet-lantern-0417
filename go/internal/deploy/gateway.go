//go:build linux

package deploy

import (
	"context"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/moby/moby/api/types/container"

	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/fsx"
	"github.com/harshjv/stationly/go/internal/gateway"
	"github.com/harshjv/stationly/go/internal/millis"
	"github.com/harshjv/stationly/go/internal/netns"
	"github.com/harshjv/stationly/go/internal/protocol"
)

const (
	gatewayDir       = "gateway"
	gatewayStateFile = "state.json"
	gatewayOverlap   = 2 * time.Minute
	gatewaySettle    = time.Second
	gatewayKillAfter = gateway.GraceTimeout + 10*time.Second
	gatewayBackoff   = 30 * time.Second

	phasePull  = "pull"
	phaseStart = "start"
	phaseProbe = "probe"
	phaseDrain = "drain"
)

type gatewaySide struct {
	Slot    string `json:"slot"`
	Version string `json:"version"`
	Image   string `json:"image"`
	Inputs  string `json:"inputs"`
}

type gatewayTransition struct {
	To         gatewaySide         `json:"to"`
	From       *gatewaySide        `json:"from"`
	Phase      string              `json:"phase"`
	Reason     string              `json:"reason"`
	StartedAt  string              `json:"started_at"`
	RunningAt  *string             `json:"running_at"`
	ReadyAt    *string             `json:"ready_at"`
	CutoverAt  *string             `json:"cutover_at"`
	SigtermAt  *string             `json:"sigterm_at"`
	FinishedAt *string             `json:"finished_at"`
	Detail     map[string]any      `json:"detail"`
	Failure    *protocol.ErrorBody `json:"failure,omitempty"`
}

type gatewayState struct {
	Current *gatewaySide       `json:"current"`
	Next    *gatewayTransition `json:"next"`
	Last    *gatewayTransition `json:"last"`
}

type objectStatus struct {
	result    protocol.ObjectResult
	applied   string
	blockedBy string
	failure   *protocol.ErrorBody
}

type gatewayRuntime struct {
	state       gatewayState
	ingressID   string
	failure     *protocol.ErrorBody
	failedAt    time.Time
	pulling     bool
	pulled      *error
	routes      map[string]objectStatus
	containerID string
	hostFailure *protocol.ErrorBody
	tunnel      tunnelRuntime
}

func (s *Station) gatewayDir() string {
	return filepath.Join(s.opts.StateDir, gatewayDir)
}

func (s *Station) dynamicDir() string {
	return filepath.Join(s.gatewayDir(), "dynamic")
}

func (s *Station) staticPath(slot string) string {
	return filepath.Join(s.gatewayDir(), "traefik-"+slot+".yml")
}

func loadGatewayState(stateDir string) (gatewayState, error) {
	return readJSON[gatewayState](filepath.Join(stateDir, gatewayDir, gatewayStateFile))
}

func (s *Station) saveGateway() {
	if err := os.MkdirAll(s.gatewayDir(), 0o755); err != nil {
		s.log.Error("create gateway state directory", "error", err)
		return
	}
	if err := writeJSON(filepath.Join(s.gatewayDir(), gatewayStateFile), s.gw.state); err != nil {
		s.log.Error("persist gateway state", "error", err)
	}
}

func otherSlot(cur *gatewaySide) string {
	if cur != nil && cur.Slot == gatewaySlotA {
		return gatewaySlotB
	}
	return gatewaySlotA
}

func gatewayFailure(format string, args ...any) *protocol.ErrorBody {
	return &protocol.ErrorBody{
		Code:        string(protocol.ErrorCodeNamespaceSetupFailed),
		Explanation: fmt.Sprintf(format, args...),
		Fix:         "Read the stationd log and the Gateway container log, then apply again.",
	}
}

func (s *Station) reconcileGateway(ctx context.Context) {
	gp := s.plan.Gateway
	s.gw.failure = nil
	if gp.Run {
		had := s.gw.ingressID != ""
		if err := s.ensureIngress(ctx); err != nil {
			s.gw.failure = gatewayFailure("ingress network: %v", err)
			s.log.Error("ingress network", "error", err)
		} else {
			if !had {
				s.ensureResolver()
			}
			s.writeRoutes()
			s.syncGatewayNamespaces(ctx)
			s.maybeStartTransition(ctx)
		}
	}
	if !gp.Run || s.gw.failure == nil {
		s.reconcileCloudflared(ctx)
	}
	_, _ = s.syncHost("reconcile")
}

func (s *Station) ensureIngress(ctx context.Context) error {
	gp := s.plan.Gateway
	spec := docker.IngressNetwork(s.plan.Generation.StationId, gp.Ingress, gp.IPRange, gp.Bridge)
	id, created, err := s.docker.EnsureFixedNetwork(ctx, spec)
	if err != nil {
		return err
	}
	if created {
		s.log.Info("created ingress network", "name", spec.Name, "bridge", docker.IngressBridgeName, "id", shortID(id), "subnet", gp.Ingress, "dynamic_range", gp.IPRange)
	}
	s.gw.ingressID = id
	return nil
}

func (s *Station) systemTargetAddr(name string) netip.Addr {
	if name != systemDispatch || !s.hostsDispatch() || s.system.id == "" || s.system.failure != "" {
		return netip.Addr{}
	}
	return dispatchAddress(s.system.subnet)
}

func (s *Station) systemTargetReady(name string) bool {
	return s.systemTargetAddr(name).IsValid() && s.disp.containerID != "" && s.disp.failure == ""
}

func (s *Station) serviceBlocked(svcID string) bool {
	st := s.services[svcID]
	return st != nil && (st.exhausted || st.failure != nil)
}

func (s *Station) writeRoutes() {
	gp := s.plan.Gateway
	dir := s.dynamicDir()
	routes := map[string]objectStatus{}
	defer func() { s.gw.routes = routes }()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		s.gw.failure = gatewayFailure("create %s: %v", dir, err)
		return
	}
	probe, err := gateway.ProbeConfig(gp.Bridge, gp.Cloudflared, s.probeID())
	if err == nil {
		_, err = fsx.WriteIfChanged(filepath.Join(dir, gateway.ProbeFile), probe, 0o644)
	}
	if err != nil {
		s.gw.failure = gatewayFailure("write %s: %v", gateway.ProbeFile, err)
		return
	}
	keep := map[string]bool{gateway.ProbeFile: true}
	for _, rp := range gp.Routes {
		name := rp.ID + ".yml"
		_, statErr := os.Stat(filepath.Join(dir, name))
		exists := statErr == nil
		if rp.System == "" && s.serviceBlocked(rp.ServiceID) {
			routes[rp.ID] = objectStatus{result: protocol.ObjectResultBlocked, blockedBy: "services/" + rp.ServiceID}
			keep[name] = exists
			continue
		}
		keep[name] = true
		changed, err := fsx.WriteIfChanged(filepath.Join(dir, name), rp.Config, 0o644)
		if err != nil {
			routes[rp.ID] = objectStatus{result: protocol.ObjectResultFailed, failure: gatewayFailure("write %s: %v", name, err)}
			continue
		}
		if changed {
			s.log.Info("Gateway route written", "route", rp.ID, "hostname", rp.Hostname, "upstream", rp.Upstream, "file", name)
		}
		st := objectStatus{result: protocol.ObjectResultOk, applied: rp.Hash}
		switch {
		case rp.System != "":
			if !s.systemTargetReady(rp.System) {
				st.result, st.blockedBy = protocol.ObjectResultPending, "system_targets/"+rp.System
			}
		case !s.switchTarget(rp.ServiceID).Addr.IsValid():
			st.result, st.blockedBy = protocol.ObjectResultPending, "services/"+rp.ServiceID
		}
		routes[rp.ID] = st
	}
	files, err := gateway.ConfigFiles(dir)
	if err != nil {
		return
	}
	for _, f := range files {
		if keep[f] {
			continue
		}
		if err := os.Remove(filepath.Join(dir, f)); err != nil {
			s.log.Warn("remove Gateway route file", "file", f, "error", err)
			continue
		}
		s.log.Info("Gateway route removed", "file", f)
	}
}

func (s *Station) gatewayTargets() []netip.AddrPort {
	var out []netip.AddrPort
	for _, rp := range s.plan.Gateway.Routes {
		if s.gw.routes[rp.ID].result != protocol.ObjectResultBlocked && !slices.Contains(out, rp.Upstream) {
			out = append(out, rp.Upstream)
		}
	}
	return out
}

func (s *Station) gatewaySlots() []string {
	var out []string
	if c := s.gw.state.Current; c != nil {
		out = append(out, c.Slot)
	}
	if t := s.gw.state.Next; t != nil && t.Phase != phasePull && t.Phase != phaseStart {
		out = append(out, t.To.Slot)
	}
	return out
}

func (s *Station) syncGatewayNamespace(ctx context.Context, slot string) (netns.Result, error) {
	gp := s.plan.Gateway
	v := s.inspectID(ctx, docker.GatewayCouplerName(slot), docker.IngressNetworkName)
	if v.state != string(container.StateRunning) || v.pid <= 0 {
		return netns.Unchanged, fmt.Errorf("Gateway Coupler %s is not running", docker.GatewayCouplerName(slot))
	}
	ns, err := netns.Open(v.pid)
	if err != nil {
		return netns.Unchanged, err
	}
	defer ns.Close()
	targets := s.gatewayTargets()
	result, err := ns.SyncGateway(netns.GatewayBaseline{Resolver: gp.Bridge, Self: gp.Slots[slot]}, s.hostPrefixes(), targets)
	if err != nil {
		return result, fmt.Errorf("write table inet %s into %s: %w", netns.TableName, docker.GatewayCouplerName(slot), err)
	}
	if result != netns.Unchanged {
		s.log.Info("Gateway namespace ruleset synced", "coupler", docker.GatewayCouplerName(slot), "netns", ns.Inode, "result", result, "gateway_targets", addrPortsText(targets))
	}
	return result, nil
}

func (s *Station) syncGatewayNamespaces(ctx context.Context) {
	for _, slot := range s.gatewaySlots() {
		if _, err := s.syncGatewayNamespace(ctx, slot); err != nil {
			s.log.Warn("sync Gateway namespace", "slot", slot, "error", err)
		}
	}
}

func addrPortsText(list []netip.AddrPort) string {
	out := ""
	for _, a := range list {
		if out != "" {
			out += ","
		}
		out += a.String()
	}
	return out
}

func (s *Station) maybeStartTransition(ctx context.Context) {
	gp := s.plan.Gateway
	if s.gw.state.Next != nil || time.Since(s.gw.failedAt) < gatewayBackoff {
		return
	}
	cur := s.gw.state.Current
	reason := ""
	switch {
	case cur == nil:
		reason = "install"
	case cur.Image != gp.Image:
		reason = fmt.Sprintf("image changed (Traefik %s %s to %s %s)", cur.Version, shortDigest(cur.Image), gp.Version, shortDigest(gp.Image))
	case cur.Inputs != gp.Inputs:
		reason = "static configuration changed"
	default:
		g := s.inspectID(ctx, docker.GatewayName(cur.Slot), docker.IngressNetworkName)
		c := s.inspectID(ctx, docker.GatewayCouplerName(cur.Slot), docker.IngressNetworkName)
		if g.state != string(container.StateRunning) || c.state != string(container.StateRunning) {
			reason = fmt.Sprintf("the current Gateway is not running (gateway %q, coupler %q)", g.state, c.state)
		} else {
			s.gw.containerID = g.id
		}
	}
	if reason == "" {
		return
	}
	t := &gatewayTransition{
		To:        gatewaySide{Slot: otherSlot(cur), Version: gp.Version, Image: gp.Image, Inputs: gp.Inputs},
		From:      cur,
		Phase:     phasePull,
		Reason:    reason,
		StartedAt: *stamp(time.Now()),
		Detail:    map[string]any{},
	}
	s.gw.state.Next = t
	s.saveGateway()
	from := "none"
	if cur != nil {
		from = cur.Slot
	}
	s.log.Info("Gateway transition started", "reason", reason, "from_slot", from, "to_slot", t.To.Slot, "image", gp.Image)
}

func shortDigest(image string) string {
	if i := len(image) - 12; i > 0 {
		return image[i:]
	}
	return image
}

func (s *Station) advanceGateway(ctx context.Context) {
	t := s.gw.state.Next
	if t == nil || s.gw.failure != nil {
		return
	}
	switch t.Phase {
	case phasePull:
		s.gatewayPull(ctx, t)
	case phaseStart:
		s.gatewayStart(ctx, t)
	case phaseProbe:
		s.gatewayProbe(ctx, t)
	case phaseDrain:
		s.gatewayDrain(ctx, t)
	}
}

func (s *Station) gatewayPull(ctx context.Context, t *gatewayTransition) {
	if s.gw.pulled != nil {
		err := *s.gw.pulled
		s.gw.pulled = nil
		if err != nil {
			s.gatewayFail(ctx, t, "pull %s: %v", t.To.Image, err)
			return
		}
		t.Detail["pulled_at"] = *stamp(time.Now())
		t.Phase = phaseStart
		s.saveGateway()
		s.gatewayStart(ctx, t)
		return
	}
	if s.gw.pulling {
		return
	}
	s.gw.pulling = true
	images := []string{t.To.Image, s.plan.couplerImage}
	go func() {
		var err error
		for _, img := range images {
			if err = s.docker.EnsureImage(ctx, img); err != nil {
				break
			}
		}
		select {
		case s.inspections <- func() { s.gw.pulling = false; s.gw.pulled = &err }:
		case <-ctx.Done():
		}
	}()
}

func (s *Station) gatewayStart(ctx context.Context, t *gatewayTransition) {
	gp := s.plan.Gateway
	slot := t.To.Slot
	stationID := s.plan.Generation.StationId
	s.removeNamed(ctx, docker.GatewayName(slot))
	s.removeNamed(ctx, docker.GatewayCouplerName(slot))
	if _, err := fsx.WriteIfChanged(s.staticPath(slot), gp.Static, 0o644); err != nil {
		s.gatewayFail(ctx, t, "write %s: %v", s.staticPath(slot), err)
		return
	}
	coupler := docker.GatewayCoupler(stationID, slot, s.plan.couplerImage, gp.Slots[slot])
	gw := docker.Gateway(stationID, slot, t.To.Image, docker.GatewayFiles{
		Static: s.staticPath(slot), StaticTarget: gateway.StaticTarget,
		Dynamic: s.dynamicDir(), DynamicTarget: gateway.DynamicTarget,
	})
	for _, spec := range []docker.ContainerSpec{coupler, gw} {
		if err := docker.CheckInvariants(spec, s.opts.StateDir); err != nil {
			s.gatewayFail(ctx, t, "%v", err)
			return
		}
	}
	cid, err := s.docker.CreateContainer(ctx, coupler.Create)
	if err == nil {
		err = s.docker.Start(ctx, cid)
	}
	if err != nil {
		s.gatewayFail(ctx, t, "start %s: %v", coupler.Name, err)
		return
	}
	result, err := s.syncGatewayNamespace(ctx, slot)
	if err != nil {
		s.gatewayFail(ctx, t, "%v", err)
		return
	}
	t.Detail["namespace"] = string(result)
	gid, err := s.docker.CreateContainer(ctx, gw.JoinedTo(cid))
	if err == nil {
		err = s.docker.Start(ctx, gid)
	}
	if err != nil {
		s.gatewayFail(ctx, t, "start %s: %v", gw.Name, err)
		return
	}
	t.RunningAt = stamp(time.Now())
	t.Phase = phaseProbe
	t.Detail["probes"] = 0
	s.saveGateway()
	s.log.Info("Gateway started", "slot", slot, "coupler", shortID(cid), "gateway", shortID(gid), "address", gp.Slots[slot], "static", s.staticPath(slot))
}

func (s *Station) gatewayProbe(ctx context.Context, t *gatewayTransition) {
	gp := s.plan.Gateway
	addr := gp.Slots[t.To.Slot]
	code, err := gateway.Ready(ctx, addr)
	n, _ := t.Detail["probes"].(float64)
	if i, ok := t.Detail["probes"].(int); ok {
		n = float64(i)
	}
	t.Detail["probes"] = n + 1
	if code == 200 {
		t.ReadyAt = stamp(time.Now())
		t.Detail["ready_ms"] = millis.Of(time.Since(parseStamp(t.RunningAt)))
		s.gatewayCutover(ctx, t)
		return
	}
	last := fmt.Sprintf("status %d", code)
	if err != nil {
		last = err.Error()
	}
	t.Detail["last_probe"] = last
	if time.Since(parseStamp(t.RunningAt)) > gatewayOverlap {
		s.gatewayFail(ctx, t, "the new Gateway at %s did not answer %s with 200 within %s (last: %s)", addr, gateway.ProbeHost, gatewayOverlap, last)
	}
}

func (s *Station) gatewayCutover(ctx context.Context, t *gatewayTransition) {
	gp := s.plan.Gateway
	prev := s.gw.state.Current
	to := t.To
	s.gw.state.Current = &to
	start := time.Now()
	result, err := s.syncHost("gateway cutover")
	if err != nil {
		s.gw.state.Current = prev
		s.gatewayFail(ctx, t, "point the Gateway virtual IP's switch entry at the new Gateway: %v", err)
		return
	}
	t.CutoverAt = stamp(time.Now())
	t.Detail["switch_ms"] = millis.Of(time.Since(start))
	t.Detail["switch_result"] = string(result)
	t.Detail["switch_to"] = gp.Slots[to.Slot].String()
	if prev != nil {
		rep, err := netns.HostFlows([]netns.FlowMatch{{ReplySource: gp.Slots[prev.Slot], Closing: true}}, true)
		if err != nil {
			t.Detail["first_pass_error"] = err.Error()
		}
		t.Detail["first_pass"] = rep
		t.Phase = phaseDrain
		s.saveGateway()
		s.log.Info("Gateway cutover: the Gateway virtual IP now points at the new Gateway", "vip", gp.GatewayVIP, "to", gp.Slots[to.Slot], "from", gp.Slots[prev.Slot], "ms", t.Detail["switch_ms"], "first_pass_deleted", rep.Deleted, "first_pass_matched", rep.Matched)
	} else {
		s.log.Info("Gateway installed: the Gateway virtual IP points at the Gateway", "vip", gp.GatewayVIP, "address", gp.Slots[to.Slot])
		s.gatewayFinish(t)
	}
	s.writeRoutes()
	s.syncGatewayNamespaces(ctx)
}

func (s *Station) gatewayDrain(ctx context.Context, t *gatewayTransition) {
	gp := s.plan.Gateway
	old := docker.GatewayName(t.From.Slot)
	oldAddr := gp.Slots[t.From.Slot]
	if t.SigtermAt == nil {
		if time.Since(parseStamp(t.CutoverAt)) < gatewaySettle {
			return
		}
		if err := s.docker.Signal(ctx, old, "SIGTERM"); err != nil {
			t.Detail["sigterm_error"] = err.Error()
		}
		t.SigtermAt = stamp(time.Now())
		s.saveGateway()
		s.log.Info("Gateway drain: SIGTERM sent to the old Gateway", "container", old, "address", oldAddr)
		return
	}
	full, err := s.docker.Inspect(ctx, old)
	running := err == nil && full.State != nil && full.State.Running
	if running {
		if rep, err := netns.HostFlows([]netns.FlowMatch{{ReplySource: oldAddr}}, false); err == nil {
			series, _ := t.Detail["established_series"].([]any)
			t.Detail["established_series"] = append(series, rep.Established)
		}
		if time.Since(parseStamp(t.SigtermAt)) < gatewayKillAfter {
			return
		}
		t.Detail["forced_kill"] = true
		if err := s.docker.Signal(ctx, old, "SIGKILL"); err != nil {
			t.Detail["sigkill_error"] = err.Error()
		}
	}
	if err == nil && full.State != nil {
		if fin, perr := time.Parse(time.RFC3339Nano, full.State.FinishedAt); perr == nil && fin.Year() > 2000 {
			t.Detail["old_exit_s"] = fin.Sub(parseStamp(t.SigtermAt)).Seconds()
		}
		t.Detail["old_exit_code"] = full.State.ExitCode
	}
	rep, ferr := netns.HostFlows([]netns.FlowMatch{{ReplySource: oldAddr}}, true)
	if ferr != nil {
		t.Detail["second_pass_error"] = ferr.Error()
	}
	t.Detail["second_pass"] = rep
	s.removeNamed(ctx, old)
	s.removeNamed(ctx, docker.GatewayCouplerName(t.From.Slot))
	s.log.Info("Gateway drain finished: old Gateway removed", "container", old, "exit_s", t.Detail["old_exit_s"], "second_pass_deleted", rep.Deleted)
	s.gatewayFinish(t)
}

func (s *Station) gatewayFinish(t *gatewayTransition) {
	t.FinishedAt = stamp(time.Now())
	s.gw.state.Last = t
	s.gw.state.Next = nil
	s.saveGateway()
}

func (s *Station) gatewayFail(ctx context.Context, t *gatewayTransition, format string, args ...any) {
	t.Failure = gatewayFailure(format, args...)
	s.log.Error("Gateway transition failed; the previous Gateway keeps serving", "error", t.Failure.Explanation, "slot", t.To.Slot)
	if cur := s.gw.state.Current; cur == nil || cur.Slot != t.To.Slot {
		s.removeNamed(ctx, docker.GatewayName(t.To.Slot))
		s.removeNamed(ctx, docker.GatewayCouplerName(t.To.Slot))
	}
	s.gw.failedAt = time.Now()
	s.gatewayFinish(t)
}

func (s *Station) hostLayout() netns.HostLayout {
	g := s.plan.Generation
	gp := s.plan.Gateway
	layout := netns.HostLayout{VirtualPrefix: gp.VirtualPrefix}
	if s.gw.ingressID != "" {
		layout.IngressBridge = docker.IngressBridgeName
	}
	for _, subnet := range []string{g.Station.Networks.System.Subnet, g.Station.Networks.Ingress.Subnet} {
		if p, err := netip.ParsePrefix(subnet); err == nil {
			layout.Translated = append(layout.Translated, p)
		}
	}
	for _, envID := range sortedKeys(g.Environments) {
		n := s.envNet(envID)
		layout.Translated = append(layout.Translated, n.subnet)
		layout.EnvBridges = append(layout.EnvBridges, n.bridge)
	}
	if n, ok := s.sandboxNet(); ok {
		layout.EnvBridges = append(layout.EnvBridges, n.bridge)
	}
	return layout
}

func (s *Station) hostState() (netns.HostLayout, netns.HostElements) {
	gp := s.plan.Gateway
	layout := s.hostLayout()
	el := netns.HostElements{Switch: map[netip.Addr]netip.Addr{}}
	if cur := s.gw.state.Current; cur != nil && gp.Run {
		el.Switch[gp.GatewayVIP] = gp.Slots[cur.Slot]
	}
	for _, rp := range gp.Routes {
		if rp.ServiceID == "" || s.serviceBlocked(rp.ServiceID) {
			continue
		}
		if a := s.switchTarget(rp.ServiceID).Addr; a.IsValid() {
			el.Switch[rp.Upstream.Addr()] = a
		}
	}
	for name, st := range gp.SystemTargets {
		if a := s.systemTargetAddr(name); a.IsValid() {
			el.Switch[st.VIP] = a
		}
	}
	return layout, el
}

func (s *Station) syncHost(why string) (netns.Result, error) {
	layout, el := s.hostState()
	result, err := netns.SyncHost(layout, el)
	if err != nil {
		s.gw.hostFailure = namespaceFailure("write table inet %s: %v", netns.HostTableName, err)
		s.log.Error("host table", "why", why, "error", err)
		return result, err
	}
	s.gw.hostFailure = nil
	if result != netns.Unchanged {
		s.log.Info("host table synced", "table", "inet "+netns.HostTableName, "why", why, "result", result, "switch", switchText(el.Switch))
	}
	return result, nil
}

func (s *Station) ensureMarkAccept() {
	added, err := netns.EnsureMarkAccept()
	if err != nil {
		s.log.Error("accept translated flows in "+netns.DockerUserChain, "error", err)
		return
	}
	if added {
		s.log.Info("translated flows accepted in "+netns.DockerUserChain, "mark", fmt.Sprintf("%#x", netns.AcceptMark))
	}
}

func (s *Station) observeGateway(o *protocol.Observed, applied bool) {
	g := s.plan.Generation
	gp := s.plan.Gateway
	if gp.Run {
		oc := protocol.ObservedComponent{Version: gp.Version, Digest: ptr(gp.Digest), Status: protocol.ComponentStatusOk}
		if cur := s.gw.state.Current; cur != nil {
			oc.Version = cur.Version
			oc.Digest = ptr(shortImageDigest(cur.Image))
			if s.gw.containerID != "" {
				oc.ContainerId = ptr(s.gw.containerID)
			}
		}
		switch {
		case s.gw.state.Next != nil:
			oc.Status = protocol.ComponentStatusUpgrading
		case s.gw.failure != nil || s.gw.state.Current == nil:
			oc.Status = protocol.ComponentStatusFailed
		case s.gw.state.Current.Inputs != gp.Inputs:
			oc.Status = protocol.ComponentStatusDrift
		}
		o.Components["gateway"] = oc
	}
	allOK := true
	for id, r := range g.Gateway.Routes {
		st, ok := s.gw.routes[id]
		if !ok {
			st = objectStatus{result: protocol.ObjectResultPending}
		}
		if !gp.Run {
			st = objectStatus{result: protocol.ObjectResultBlocked, blockedBy: "components/gateway"}
		}
		or := protocol.ObservedRoute{Result: st.result, Failure: st.failure}
		if st.blockedBy != "" {
			or.BlockedBy = ptr(st.blockedBy)
		}
		if st.result == protocol.ObjectResultOk && applied {
			or.AppliedHash = ptr(r.Hash)
		}
		if st.result != protocol.ObjectResultOk {
			allOK = false
		}
		or.Probe = s.observedTunnelProbe(id)
		o.Gateway.Routes[id] = or
	}
	o.Gateway.Tunnel = s.observedTunnel()
	if allOK && applied && gp.Run && s.gw.failure == nil {
		o.Gateway.AppliedHash = ptr(g.Gateway.Hash)
	}
	for name, st := range g.SystemTargets {
		ot := protocol.ObservedSystemTarget{Result: protocol.ObjectResultPending, BlockedBy: ptr("components/" + name)}
		if s.systemTargetReady(name) {
			ot = protocol.ObservedSystemTarget{Result: protocol.ObjectResultOk, Address: ptr(s.systemTargetAddr(name).String())}
			if applied {
				ot.AppliedHash = ptr(st.Hash)
			}
		}
		o.SystemTargets[name] = ot
	}
}

func shortImageDigest(image string) string {
	for i := range image {
		if image[i] == '@' {
			return image[i+1:]
		}
	}
	return image
}
