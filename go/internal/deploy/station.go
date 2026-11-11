//go:build linux

package deploy

import (
	"context"
	"fmt"
	"log/slog"
	"net/netip"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/api/types/system"

	"github.com/harshjv/stationly/go/internal/depot"
	"github.com/harshjv/stationly/go/internal/dispatch"
	"github.com/harshjv/stationly/go/internal/dns"
	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/hostconfig"
	"github.com/harshjv/stationly/go/internal/hostprobe"
	"github.com/harshjv/stationly/go/internal/identity"
	"github.com/harshjv/stationly/go/internal/logstore"
	"github.com/harshjv/stationly/go/internal/netns"
	"github.com/harshjv/stationly/go/internal/outbox"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/rootsocket"
	"github.com/harshjv/stationly/go/internal/sandbox"
	"github.com/harshjv/stationly/go/internal/secrets"
	"github.com/harshjv/stationly/go/internal/upgrade"
	"github.com/harshjv/stationly/go/internal/verify"
	"github.com/harshjv/stationly/go/internal/workshop"
)

const (
	restartWindow   = 10 * time.Minute
	restartBudget   = 5
	backoffBase     = time.Second
	backoffCap      = 60 * time.Second
	backoffMaxShift = 6
	fullResync      = 30 * time.Second
	eventsRetryBase = time.Second
	eventsRetryCap  = 30 * time.Second
	resolvConf      = "/etc/resolv.conf"
	reapInterval    = 10 * time.Second
)

type Options struct {
	StateDir      string
	SocketPath    string
	Log           *slog.Logger
	Identity      *identity.Identity
	Link          *dispatch.Client
	Verifier      *verify.Verifier
	SigstoreFetch string
	EtcDir        string
	Host          *hostconfig.Config
	Install       *InstallState
	BackupRoot    string
	Outbox        *outbox.Outbox
	Handover      bool
	RunArgs       []string
	BinDir        string
	BinaryLink    string
	Sandbox       sandbox.Runtime
}

type Station struct {
	opts      Options
	log       *slog.Logger
	docker    *docker.Client
	info      system.Info
	host      protocol.HostProbe
	applied   *protocol.Generation
	plan      *Plan
	status    protocol.AppliedStatus
	rejection *protocol.ErrorBody
	envs      map[string]*envState
	services  map[string]*serviceState
	unknown   []protocol.UnknownObject
	results   chan probeResult
	written   []byte
	resolver  *dns.Resolver
	hostAddrs []netip.Addr
	hostEvent chan struct{}
	cursor    map[string]netip.Addr

	rollouts      map[string]*rollout
	rolloutEvents chan rolloutEvent
	resync        bool

	volumes       map[string]*volumeState
	volumeSizes   map[string]int64
	volumeSizesAt time.Time
	diskCheckedAt time.Time
	diskLevel     protocol.DiskThreshold
	runs          map[string]*runRecord
	crons         map[string]*cronState

	depot        *depot.Depot
	workshops    *workshop.Manager
	registryAddr string
	insecureOK   atomic.Bool

	gw     gatewayRuntime
	system systemNet

	backups  map[string]bool
	quiesced map[string]bool

	secrets        *secrets.Store
	inspections    chan func()
	owners         map[string]secrets.Owner
	secretRequests map[string]secretRequest

	link          *dispatch.Client
	pendingAck    *pendingAck
	observedSent  *observedBaseline
	builds        map[string]context.CancelFunc
	buildSecrets  map[string]protocol.SecretsDeliverBody
	backupSecrets map[string]backupCredential

	logs              *logstore.Store
	captures          *captureSet
	lastSweep         time.Time
	runTerminal       sync.Map
	buildLogs         sync.Map
	runningBuilds     sync.Map
	attached          map[string]*attachment
	attachByStream    map[int]string
	pendingRunSecrets map[string]protocol.SecretsDeliverBody
	metrics           *metricsHub
	net               *netHub
	greenViews        map[string]view
	gc                *gcSchedule

	verifier *verify.Verifier
	sigs     signatureBook

	outbox     *outbox.Outbox
	linkCancel context.CancelFunc
	linkDone   chan struct{}
	capCtx     context.Context
	capCancel  context.CancelFunc
	sock       *rootsocket.Server
	started    string
	comps      map[string]componentRecord
	procs      map[string]*procState
	disp       dispatchRuntime

	litestreamFailure string
	handingOver       bool
	handedOver        bool

	sbx sandboxSet
}

type envState struct {
	networkID string
	failure   *protocol.ErrorBody
}

type serviceState struct {
	hash       string
	restarts   []time.Time
	exits      map[string]bool
	staleNetns uint64
	downSince  time.Time
	exhausted  bool
	failure    *protocol.ErrorBody
	retryAt    time.Time
	retries    int
	blockedBy  string
	blockedErr *protocol.ErrorBody
	waitingFor time.Time
	coupler    view
	service    view
	health     health
	healthFor  string
	ownAddr    netip.Addr
	ownMAC     network.HardwareAddr
	nsFailure  *protocol.ErrorBody
	switchAddr netip.Addr

	reportedHealth string
	reportedExit   string
}

type view struct {
	id        string
	state     string
	address   netip.Addr
	exitCode  *int
	oom       bool
	startedAt string
	exitedAt  string
	pid       int
	netns     uint64
	endpoints map[string]*network.EndpointSettings
}

type probeResult struct {
	serviceID string
	since     time.Time
	pass      bool
	result    string
	at        time.Time
}

func Run(ctx context.Context, opts Options) error {
	if err := os.MkdirAll(opts.StateDir, 0o700); err != nil {
		return err
	}
	applied, err := loadApplied(opts.StateDir)
	if err != nil {
		return fmt.Errorf("read applied generation: %w", err)
	}
	dc, err := docker.Connect(ctx)
	if err != nil {
		return fmt.Errorf("connect to Docker: %w", err)
	}
	defer dc.Close()
	info, err := dc.Info(ctx)
	if err != nil {
		return fmt.Errorf("docker info: %w", err)
	}
	upstream, err := dns.UpstreamFrom(resolvConf)
	if opts.Host != nil && opts.Host.Resolver.Upstream != "" {
		upstream, err = opts.Host.Resolver.Upstream, nil
	}
	if err != nil {
		return fmt.Errorf("read the upstream resolver: %w", err)
	}
	s := &Station{
		opts:      opts,
		log:       opts.Log,
		docker:    dc,
		info:      info.Info,
		host:      hostprobe.Default().Probe(ctx, ""),
		applied:   applied,
		envs:      map[string]*envState{},
		services:  map[string]*serviceState{},
		results:   make(chan probeResult, 16),
		resolver:  dns.New(opts.Log, upstream),
		hostEvent: make(chan struct{}, 1),
		cursor:    map[string]netip.Addr{},

		rolloutEvents: make(chan rolloutEvent, 16),
		volumes:       map[string]*volumeState{},
		backups:       map[string]bool{},
		quiesced:      map[string]bool{},
		crons:         map[string]*cronState{},

		secrets:        secrets.NewStore(),
		inspections:    make(chan func()),
		owners:         map[string]secrets.Owner{},
		secretRequests: map[string]secretRequest{},

		link:          opts.Link,
		outbox:        opts.Outbox,
		started:       *stamp(time.Now()),
		procs:         map[string]*procState{},
		verifier:      opts.Verifier,
		builds:        map[string]context.CancelFunc{},
		buildSecrets:  map[string]protocol.SecretsDeliverBody{},
		backupSecrets: map[string]backupCredential{},

		logs:              logstore.New(opts.StateDir),
		captures:          &captureSet{active: map[string]chan struct{}{}},
		attached:          map[string]*attachment{},
		attachByStream:    map[int]string{},
		pendingRunSecrets: map[string]protocol.SecretsDeliverBody{},
		metrics:           newMetricsHub(),
		greenViews:        map[string]view{},
	}
	s.net = newNetHub(opts.Log, s.resolver)
	defer func() {
		if !s.handingOver && s.outbox != nil {
			s.outbox.Close()
		}
	}()
	if s.rollouts, err = loadRollouts(opts.StateDir); err != nil {
		return fmt.Errorf("read deployment state: %w", err)
	}
	if s.runs, err = loadRuns(opts.StateDir); err != nil {
		return fmt.Errorf("read run state: %w", err)
	}
	if err := s.loadSandboxes(); err != nil {
		return fmt.Errorf("read sandbox state: %w", err)
	}
	s.recoverSandboxRuns()
	s.probeSandboxStorage(ctx)
	for id, rr := range s.runs {
		s.runTerminal.Store(id, rr.terminal())
	}
	s.resolver.OnAllow(s.onAllow)
	if s.gw.state, err = loadGatewayState(opts.StateDir); err != nil {
		return fmt.Errorf("read gateway state: %w", err)
	}
	if s.comps, err = loadComponents(opts.StateDir); err != nil {
		return fmt.Errorf("read components.json: %w", err)
	}
	if s.disp.state, err = loadDispatchState(opts.StateDir); err != nil {
		return fmt.Errorf("read dispatch.json: %w", err)
	}
	s.depot = depot.New(opts.Log, dc, opts.StateDir)
	defer s.depot.Close()
	s.workshops = workshop.NewManager(opts.Log, dc, s.depot, opts.StateDir)
	dc.SetRegistryAuth(s.pullAuth)
	defer s.resolver.Close()
	netCtx, stopNet := context.WithCancel(ctx)
	defer stopNet()
	go s.net.run(netCtx)
	s.log.Info("resolver upstream", "address", upstream)
	s.refreshHostAddrs()
	go func() {
		if err := netns.WatchAddresses(ctx, s.hostEvent); err != nil {
			s.log.Error("host address watch stopped", "error", err)
		}
	}()
	s.loadApplied()
	s.ensureSystemNetwork(ctx)
	if s.system.failure == "" {
		if failed := s.resolver.Listen([]netip.Addr{s.system.hostAddr.Addr()}); len(failed) > 0 {
			s.system.failure = fmt.Sprintf("resolver host listener cannot bind %s: %v", s.system.hostAddr, failed[s.system.hostAddr.Addr()])
		}
	}
	if s.system.failure != "" {
		s.log.Error("system network or resolver host listener", "failure", s.system.failure)
	}
	s.publish(s.observed())
	sock, err := rootsocket.Listen(opts.Log, opts.SocketPath, s.handlers())
	if err != nil {
		return fmt.Errorf("root socket: %w", err)
	}
	s.sock = sock
	go sock.Serve(ctx)
	s.startLink(ctx)
	s.startCaptures(ctx)
	if !opts.Handover {
		if sent, err := upgrade.Notify("READY=1"); sent || err != nil {
			s.log.Info("systemd notified", "state", "READY=1", "error", err)
		}
	}
	if s.plan == nil {
		s.log.Info("no applied generation on disk; waiting for the first generation from Dispatch")
		if err := s.awaitGeneration(ctx); err != nil {
			return nil
		}
	} else {
		if failure := s.verifyComponents(ctx, s.plan.Generation); failure != nil {
			s.log.Error("a pinned platform artifact of the persisted generation failed verification", "code", failure.Code, "explanation", failure.Explanation)
		}
		s.configurePlatform(ctx)
	}

	observedAt := time.Now()
	s.reconcile(ctx)
	s.commit()
	s.requestLostRedaction()
	s.recoverBuilds()
	s.advance(ctx)
	s.advanceGateway(ctx)
	s.advanceRuns(ctx, time.Now())
	s.syncCaptures(ctx)
	s.ensureDispatch(ctx)
	s.advanceComponents(ctx)
	s.writeObserved()
	s.reportComponents(s.plan.Generation)
	s.writeLockMirror(s.plan.Generation)
	if opts.Handover {
		go s.reportReady(ctx)
	}

	evCtx, stopEvents := context.WithCancel(ctx)
	events := s.docker.Events(evCtx, observedAt.UTC().Format(time.RFC3339Nano))
	retry := eventsRetryBase
	var resubscribeAt time.Time
	lastFull := time.Now()
	lastReap := time.Now()
	dirty := false
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			stopEvents()
			s.writeObserved()
			return nil
		case m := <-s.link.Inbound():
			s.handle(ctx, m)
			s.writeObserved()
		case ev := <-events.Messages:
			s.log.Debug("docker event", "type", ev.Type, "action", ev.Action, "id", ev.Actor.ID, "name", ev.Actor.Attributes["name"])
			dirty = true
			retry = eventsRetryBase
		case err := <-events.Err:
			stopEvents()
			events.Messages, events.Err = nil, nil
			if ctx.Err() != nil {
				continue
			}
			s.log.Warn("docker event stream ended", "error", err, "retry_in", retry)
			resubscribeAt = time.Now().Add(retry)
			retry = min(retry*2, eventsRetryCap)
		case f := <-s.inspections:
			f()
			if s.handedOver {
				stopEvents()
				return nil
			}
		case r := <-s.results:
			s.recordProbe(r)
		case ev := <-s.rolloutEvents:
			s.rolloutEvent(ctx, ev)
			s.writeObserved()
		case <-s.hostEvent:
			if s.refreshHostAddrs() {
				dirty = true
			}
		case now := <-ticker.C:
			if events.Err == nil && !now.Before(resubscribeAt) {
				evCtx, stopEvents = context.WithCancel(ctx)
				observedAt = now
				events = s.docker.Events(evCtx, observedAt.UTC().Format(time.RFC3339Nano))
				dirty = true
			}
			if dirty || s.resync || s.anyDown() || now.Sub(lastFull) >= fullResync {
				s.resync = false
				s.reconcile(ctx)
				s.commit()
				s.settlePendingAck()
				s.syncCaptures(ctx)
				s.writeLockMirror(s.plan.Generation)
				dirty = false
				lastFull = now
			}
			s.syncMetrics(ctx, now)
			s.syncNetwork(ctx)
			s.tickRegistryGC(now)
			s.tickDiskPressure(now)
			s.advance(ctx)
			s.advanceGateway(ctx)
			s.advanceComponents(ctx)
			s.reportComponents(s.plan.Generation)
			s.checkCertificates(ctx, now)
			s.advanceRuns(ctx, now)
			s.reconcileSandboxes(ctx, now)
			s.syncSandboxMetrics(ctx, now)
			s.healthTick(ctx, now)
			s.reportHealth()
			if now.Sub(lastReap) >= reapInterval {
				s.workshops.Reap(ctx, now)
				lastReap = now
			}
			s.writeObserved()
		}
	}
}

func (s *Station) loadApplied() {
	if s.applied == nil {
		return
	}
	if s.applied.StationId != s.opts.Identity.StationID || s.applied.InstanceId != s.opts.Identity.InstanceID {
		s.log.Error("generation.json belongs to another station; ignoring it", "station", s.applied.StationId, "instance", s.applied.InstanceId)
		s.applied = nil
		return
	}
	plan, err := BuildPlan(s.applied, nil, s.opts.StateDir, s.trust())
	if err != nil {
		s.log.Error("applied generation no longer valid; waiting for Dispatch", "number", s.applied.Number, "error", err)
		s.status = protocol.AppliedStatusRejected
		return
	}
	s.plan, s.status = plan, protocol.AppliedStatusApplied
	s.syncRollouts()
	s.log.Info("serving the persisted generation", "number", s.applied.Number, "hash", s.applied.Hash)
}

func (s *Station) awaitGeneration(ctx context.Context) error {
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case m := <-s.link.Inbound():
			switch {
			case m.Connected, m.Type == protocol.MessageGeneration, m.Type == protocol.MessageGenerationAvailable, m.Type == protocol.MessageError:
				s.handle(ctx, m)
				if s.plan != nil {
					return nil
				}
			default:
				s.replyError(m, protocolError(protocol.ErrorCodeProtocolInvalidMessage, "Send a generation first.", "stationd holds no generation yet and cannot handle %s", m.Type))
			}
		case f := <-s.inspections:
			f()
			if s.plan != nil {
				return nil
			}
		}
	}
}

func (s *Station) commit() {
	g := s.plan.Generation
	if s.rejection != nil || (s.applied != nil && s.applied.Hash == g.Hash) {
		return
	}
	if err := saveApplied(s.opts.StateDir, g); err != nil {
		s.log.Error("persist generation", "error", err)
		return
	}
	s.applied = g
	s.log.Info("generation applied", "number", g.Number, "hash", g.Hash, "status", s.status)
}

func (s *Station) reconcile(ctx context.Context) {
	now := time.Now()
	stationID := s.plan.Generation.StationId
	s.depot.Ensure(ctx)
	containers, err := s.docker.Containers(ctx)
	if err != nil {
		s.log.Warn("list containers", "error", err)
		return
	}
	networks, err := s.docker.Networks(ctx)
	if err != nil {
		s.log.Warn("list networks", "error", err)
		return
	}

	wanted := s.rolloutContainers()
	for _, sp := range s.plan.Services {
		if sp.Run {
			wanted[sp.Coupler.Name] = true
			wanted[sp.Service.Name] = true
		}
	}
	unknown := []protocol.UnknownObject{}
	byName := map[string]container.Summary{}
	for _, c := range containers {
		if c.Labels[docker.LabelStation] != stationID {
			unknown = append(unknown, protocol.UnknownObject{Kind: protocol.UnknownObjectKindContainer, DockerId: ptr(c.ID), Labels: c.Labels})
			continue
		}
		if runID := c.Labels[docker.LabelRun]; runID != "" {
			if rr := s.runs[runID]; rr == nil || rr.terminal() {
				s.log.Info("removing container of a finished or unknown run", "name", containerName(c), "run", runID)
				s.remove(ctx, c.ID)
			}
			continue
		}
		if role := c.Labels[docker.LabelRole]; role != docker.RoleCoupler && role != docker.RoleService {
			continue
		}
		name := containerName(c)
		if !wanted[name] || c.Labels[docker.LabelHash] == "" {
			s.log.Info("removing container absent from the generation", "name", name)
			s.remove(ctx, c.ID)
			continue
		}
		byName[name] = c
	}
	netByName := map[string]network.Summary{}
	for _, n := range networks {
		if n.Labels[docker.LabelStation] != stationID {
			unknown = append(unknown, protocol.UnknownObject{Kind: protocol.UnknownObjectKindNetwork, DockerId: ptr(n.ID), Labels: n.Labels})
			continue
		}
		if n.Labels[docker.LabelRole] != docker.RoleNetwork {
			continue
		}
		netByName[n.Name] = n
	}
	unknown = append(unknown, s.reconcileVolumes(ctx, containers)...)
	s.unknown = unknown

	desiredNets := map[string]bool{}
	for envID, spec := range s.plan.Networks {
		desiredNets[spec.Name] = true
		s.ensureNetwork(ctx, envID, spec, byName)
	}
	for envID := range s.envs {
		if _, ok := s.plan.Networks[envID]; !ok {
			delete(s.envs, envID)
			delete(s.cursor, envID)
		}
	}
	s.ensureResolver()

	status := protocol.AppliedStatusApplied
	for _, id := range s.plan.ServiceIDs() {
		sp := s.plan.Services[id]
		st := s.serviceState(sp)
		if env := s.envs[sp.EnvID]; env.failure != nil {
			status = protocol.AppliedStatusPartial
			continue
		}
		if s.heldByRollout(id) {
			s.observe(ctx, st, byName, sp)
			continue
		}
		st.blockedBy, st.blockedErr = "", nil
		if sp.Wanted && sp.Unsupported == nil {
			if blocked := s.volumeBlockedBy(sp.Spec); blocked != "" {
				st.blockedBy, st.blockedErr = blocked, s.volumeBlock(sp.Spec)
				status = protocol.AppliedStatusPartial
				s.observe(ctx, st, byName, sp)
				continue
			}
		}
		s.ensureService(ctx, sp, st, byName, now)
		if (st.failure != nil && !st.exhausted) || st.blockedBy != "" {
			status = protocol.AppliedStatusPartial
		}
	}
	for id := range s.services {
		if _, ok := s.plan.Services[id]; !ok {
			delete(s.services, id)
		}
	}
	s.syncNamespaces(ctx)
	s.syncRunNamespaces(ctx)
	s.reconcileGateway(ctx)
	if s.gw.failure != nil || s.gw.hostFailure != nil {
		status = protocol.AppliedStatusPartial
	}
	for _, st := range s.gw.routes {
		if st.result == protocol.ObjectResultFailed || st.result == protocol.ObjectResultBlocked {
			status = protocol.AppliedStatusPartial
		}
	}
	s.destroyVolumes(ctx)
	s.ensureDispatch(ctx)
	withContainers := map[string]bool{}
	for _, c := range containers {
		if c.Labels[docker.LabelStation] == stationID && c.Labels[docker.LabelRole] != docker.RoleProbe {
			withContainers[c.Labels[docker.LabelDeployment]] = true
		}
	}
	s.sweepSecrets(ctx, withContainers)
	for _, st := range s.volumes {
		if st.failure != nil {
			status = protocol.AppliedStatusPartial
		}
	}
	for _, st := range s.services {
		if st.nsFailure != nil {
			status = protocol.AppliedStatusPartial
		}
	}
	for _, st := range s.envs {
		if st.failure != nil {
			status = protocol.AppliedStatusPartial
		}
	}

	for name, n := range netByName {
		if desiredNets[name] {
			continue
		}
		s.log.Info("removing network absent from the generation", "name", name)
		if err := s.docker.RemoveNetwork(ctx, n.ID); err != nil {
			s.log.Warn("remove network", "name", name, "error", err)
		}
	}
	s.ensureMarkAccept()
	if s.rejection == nil {
		s.status = status
	}
}

func (s *Station) ensureNetwork(ctx context.Context, envID string, spec docker.NetworkSpec, byName map[string]container.Summary) {
	st := s.envs[envID]
	if st == nil {
		st = &envState{}
		s.envs[envID] = st
	}
	id, created, err := s.docker.EnsureNetwork(ctx, spec, func() {
		s.log.Info("network differs from the generation, recreating", "name", spec.Name)
		for name, c := range byName {
			if c.Labels[docker.LabelEnvironment] == envID {
				s.remove(ctx, c.ID)
				delete(byName, name)
			}
		}
	})
	if err != nil {
		st.networkID = ""
		st.failure = dockerError(protocol.ErrorCodeGenerationInvalid, err)
		s.log.Error("network", "name", spec.Name, "error", err)
		return
	}
	if created {
		s.log.Info("created network", "name", spec.Name, "id", shortID(id))
	}
	st.networkID, st.failure = id, nil
}

func (s *Station) serviceState(sp *ServicePlan) *serviceState {
	st := s.services[sp.ID]
	if st == nil || st.hash != sp.Hash {
		st = &serviceState{hash: sp.Hash, health: newHealth(nil, time.Now())}
		s.services[sp.ID] = st
	}
	return st
}

func (s *Station) ensureService(ctx context.Context, sp *ServicePlan, st *serviceState, byName map[string]container.Summary, now time.Time) {
	if sp.Unsupported != nil {
		st.failure = sp.Unsupported
		return
	}
	if !sp.Run {
		st.failure = nil
		st.coupler, st.service = view{}, view{}
		return
	}
	if st.exhausted || s.quiesced[sp.ID] {
		s.observe(ctx, st, byName, sp)
		return
	}

	coupler, hasCoupler := byName[sp.Coupler.Name]
	service, hasService := byName[sp.Service.Name]
	if hasCoupler && coupler.Labels[docker.LabelHash] != sp.Coupler.Hash {
		s.remove(ctx, service.ID)
		s.remove(ctx, coupler.ID)
		hasCoupler, hasService = false, false
	}
	if hasService && service.Labels[docker.LabelHash] != sp.Service.Hash {
		s.remove(ctx, service.ID)
		hasService = false
	}

	couplerUp := hasCoupler && coupler.State == container.StateRunning
	serviceUp := hasService && service.State == container.StateRunning
	if couplerUp && serviceUp {
		s.observe(ctx, st, byName, sp)
		if st.coupler.netns == 0 || st.service.netns == 0 || st.coupler.netns == st.service.netns {
			st.downSince = time.Time{}
			st.failure = nil
			s.trackHealth(st, sp)
			return
		}
		s.log.Warn("Coupler namespace no longer matches the service (Coupler restarted), recreating the container set", "service", sp.ID, "coupler_netns", st.coupler.netns, "service_netns", st.service.netns)
		st.staleNetns = st.coupler.netns
		couplerUp = false
	}

	firstStart := st.coupler.id == "" && st.service.id == "" && !hasCoupler && !hasService
	if !firstStart {
		s.observe(ctx, st, byName, sp)
		s.reportExit(st, sp)
		if st.downSince.IsZero() {
			st.downSince = now
		}
	}
	if now.Before(st.retryAt) {
		return
	}

	needsValues := !hasService || !couplerUp || (secrets.HasFiles(sp.Spec) && !secrets.Mounted(sp.DeploymentID))
	serviceEnv, proceed := s.startGate(ctx, st, sp, now, needsValues, !firstStart)
	if !proceed {
		return
	}

	if !couplerUp {
		s.remove(ctx, service.ID)
		s.remove(ctx, coupler.ID)
		hasService = false
		if !firstStart {
			s.log.Warn("Coupler is down, recreating the container set", "service", sp.ID, "restarts", len(st.restarts))
		}
		id, failure := s.startCoupler(ctx, sp, st)
		if failure != nil {
			s.holdBack(st, sp, failure, now)
			return
		}
		coupler = container.Summary{ID: id}
	} else if failure := s.syncNamespace(ctx, sp, st); failure != nil {
		s.holdBack(st, sp, failure, now)
		return
	}
	if hasService {
		s.log.Warn("restarting service container in place", "service", sp.ID, "restarts", len(st.restarts))
		if err := s.docker.Start(ctx, service.ID); err != nil {
			s.holdBack(st, sp, dockerFailure(protocol.ErrorCodeExitNonzero, "start "+sp.Service.Name, err), now)
			return
		}
	} else if _, failure := s.createAndStart(ctx, sp.Service.WithEnv(serviceEnv), coupler.ID); failure != nil {
		s.holdBack(st, sp, failure, now)
		return
	}
	st.failure = nil
	st.staleNetns = 0
	st.retries = 0
	st.retryAt = time.Time{}
	st.downSince = time.Time{}
	s.refresh(ctx, st, sp)
	s.trackHealth(st, sp)
}

func (s *Station) startGate(ctx context.Context, st *serviceState, sp *ServicePlan, now time.Time, needsValues, restart bool) ([]string, bool) {
	var env []string
	if needsValues {
		set, failure := s.prepareSecrets(ctx, sp.DeploymentID, sp.Spec)
		if failure != nil {
			s.holdBack(st, sp, failure, now)
			return nil, false
		}
		env = envOf(set)
	}
	st.blockedBy, st.blockedErr, st.waitingFor = "", nil, time.Time{}
	if restart && !s.allowRestart(st, sp, now) {
		return nil, false
	}
	return env, true
}

func (s *Station) holdBack(st *serviceState, sp *ServicePlan, failure *protocol.ErrorBody, now time.Time) {
	if failure.Code == string(protocol.ErrorCodeSecretsUnavailable) {
		st.failure = nil
		st.blockedBy, st.blockedErr = "secrets/"+sp.DeploymentID, failure
		if st.waitingFor.IsZero() {
			st.waitingFor = now
			s.log.Info("service waits for its secret values, no restart is spent", "service", sp.ID, "deployment", sp.DeploymentID, "env_digest", sp.Spec.EnvDigest)
		}
		return
	}
	st.failure = failure
	st.retryAt = now.Add(backoffDelay(st.retries))
	st.retries++
}

func backoffDelay(attempt int) time.Duration {
	return min(backoffBase<<min(attempt, backoffMaxShift), backoffCap)
}

func (s *Station) exitKeys(st *serviceState) []string {
	var keys []string
	for _, v := range []view{st.service, st.coupler} {
		if v.id != "" && v.exitCode != nil {
			keys = append(keys, v.id+"@"+v.exitedAt)
		}
	}
	if st.staleNetns != 0 {
		keys = append(keys, fmt.Sprintf("netns@%d", st.staleNetns))
	}
	return keys
}

func (s *Station) reportExit(st *serviceState, sp *ServicePlan) {
	v, role := st.service, docker.RoleService
	if v.exitCode == nil && st.coupler.exitCode != nil {
		v, role = st.coupler, docker.RoleCoupler
	}
	if v.id == "" || v.exitCode == nil || st.reportedExit == v.id {
		return
	}
	st.reportedExit = v.id
	s.emit(protocol.MessageContainerExited, protocol.ContainerExitedBody{
		ContainerId: v.id, Role: role, ServiceId: &sp.ID, DeploymentId: nilIfEmpty(sp.DeploymentID),
		ExitCode: *v.exitCode, OomKilled: v.oom, Restarts: len(st.restarts),
	})
	s.log.Warn("container exited", "service", sp.ID, "container", shortID(v.id), "role", role, "exit_code", *v.exitCode, "oom_killed", v.oom)
}

func (s *Station) trackHealth(st *serviceState, sp *ServicePlan) {
	if st.healthFor == st.service.id+st.service.startedAt {
		return
	}
	since := time.Now()
	if t, err := time.Parse(time.RFC3339Nano, st.service.startedAt); err == nil {
		since = t
	}
	st.health = newHealth(ruleFor(sp.Health, sp.Ports), since)
	st.healthFor = st.service.id + st.service.startedAt
}

func (s *Station) allowRestart(st *serviceState, sp *ServicePlan, now time.Time) bool {
	var fresh []string
	for _, k := range s.exitKeys(st) {
		if !st.exits[k] {
			fresh = append(fresh, k)
		}
	}
	if len(fresh) == 0 {
		return true
	}
	if st.downSince.IsZero() {
		st.downSince = now
	}
	recent := st.restarts[:0]
	for _, t := range st.restarts {
		if now.Sub(t) < restartWindow {
			recent = append(recent, t)
		}
	}
	st.restarts = recent
	if len(st.restarts) >= restartBudget {
		st.exhausted = true
		code := protocol.ErrorCodeExitNonzero
		if st.service.oom {
			code = protocol.ErrorCodeOomKilled
		}
		exit := "unknown"
		if st.service.exitCode != nil {
			exit = fmt.Sprint(*st.service.exitCode)
		}
		st.failure = &protocol.ErrorBody{
			Code:        string(code),
			Explanation: fmt.Sprintf("the container set exited %d times within %s (last exit code %s); stationd stopped restarting it", restartBudget, restartWindow, exit),
			Fix:         "Read the service logs, fix the cause and deploy again.",
		}
		st.health.state = protocol.HealthStateFailed
		s.log.Error("restart budget exhausted, service is red", "service", sp.ID, "exit_code", exit)
		return false
	}
	delay := backoffDelay(len(st.restarts))
	if now.Sub(st.downSince) < delay {
		return false
	}
	st.restarts = append(st.restarts, now)
	if st.exits == nil {
		st.exits = map[string]bool{}
	}
	for _, k := range fresh {
		st.exits[k] = true
	}
	return true
}

func (s *Station) createAndStart(ctx context.Context, spec docker.ContainerSpec, couplerID string) (string, *protocol.ErrorBody) {
	id, err := s.docker.CreateContainer(ctx, spec.JoinedTo(couplerID))
	if err != nil {
		code := protocol.ErrorCodeExitNonzero
		if strings.Contains(err.Error(), "pull ") {
			code = protocol.ErrorCodeSourceUnreachable
		}
		s.log.Error("create container", "name", spec.Name, "error", err)
		return "", dockerFailure(code, "create "+spec.Name, err)
	}
	if err := s.docker.Start(ctx, id); err != nil {
		s.log.Error("start container", "name", spec.Name, "error", err)
		return "", dockerFailure(protocol.ErrorCodeExitNonzero, "start "+spec.Name, err)
	}
	s.log.Info("started container", "name", spec.Name, "id", shortID(id))
	return id, nil
}

func (s *Station) remove(ctx context.Context, id string) {
	if id == "" {
		return
	}
	if err := s.docker.Remove(ctx, id); err != nil {
		s.log.Warn("remove container", "id", shortID(id), "error", err)
	}
}

func (s *Station) refresh(ctx context.Context, st *serviceState, sp *ServicePlan) {
	containers, err := s.docker.Containers(ctx)
	if err != nil {
		return
	}
	byName := map[string]container.Summary{}
	for _, c := range containers {
		byName[containerName(c)] = c
	}
	s.observe(ctx, st, byName, sp)
}

func (s *Station) observe(ctx context.Context, st *serviceState, byName map[string]container.Summary, sp *ServicePlan) {
	st.coupler = s.inspect(ctx, byName, sp.Coupler.Name, sp.NetworkName)
	st.service = s.inspect(ctx, byName, sp.Service.Name, sp.NetworkName)
	st.service.address = st.coupler.address
}

func (s *Station) inspect(ctx context.Context, byName map[string]container.Summary, name, networkName string) view {
	c, ok := byName[name]
	if !ok {
		return view{}
	}
	v := s.inspectID(ctx, c.ID, networkName)
	if v.state == "" {
		v.state = string(c.State)
	}
	return v
}

func (s *Station) inspectID(ctx context.Context, id, networkName string) view {
	v := view{id: id}
	full, err := s.docker.Inspect(ctx, id)
	if err != nil {
		return v
	}
	v.id = full.ID
	if full.State != nil {
		v.state = string(full.State.Status)
		v.oom = full.State.OOMKilled
		if !full.State.Running && full.State.Status != container.StateCreated {
			code := full.State.ExitCode
			v.exitCode = &code
			v.exitedAt = full.State.FinishedAt
		}
		if full.State.Running {
			v.startedAt = full.State.StartedAt
			v.pid = full.State.Pid
			if ino, err := netns.Inode(v.pid); err == nil {
				v.netns = ino
			}
		}
	}
	if full.NetworkSettings != nil {
		v.endpoints = full.NetworkSettings.Networks
		if ep := full.NetworkSettings.Networks[networkName]; ep != nil {
			v.address = ep.IPAddress
		}
	}
	return v
}

func (s *Station) anyDown() bool {
	for _, st := range s.services {
		if !st.downSince.IsZero() && !st.exhausted {
			return true
		}
	}
	return false
}

func (s *Station) healthTick(ctx context.Context, now time.Time) {
	for id, st := range s.services {
		h := &st.health
		if h.rule == nil || st.exhausted || st.service.state != string(container.StateRunning) {
			continue
		}
		switch h.rule.kind {
		case "alive":
			if now.Sub(h.since) >= h.rule.alive && h.passStreak == 0 {
				h.record(true, "alive", now)
			}
		case "tcp", "http":
			h.evaluate(now)
			if !h.due(now) || !st.service.address.IsValid() {
				continue
			}
			h.inflight = true
			h.nextCheck = now.Add(h.rule.interval)
			addr, rule, since := st.service.address, h.rule, h.since
			go func() {
				pass, result := probe(ctx, rule, addr)
				select {
				case s.results <- probeResult{serviceID: id, since: since, pass: pass, result: result, at: time.Now()}:
				case <-ctx.Done():
				}
			}()
		}
	}
}

func (s *Station) recordProbe(r probeResult) {
	st := s.services[r.serviceID]
	if st == nil || !st.health.since.Equal(r.since) {
		return
	}
	st.health.inflight = false
	before := st.health.state
	st.health.record(r.pass, r.result, r.at)
	if st.health.state != before {
		s.log.Info("health changed", "service", r.serviceID, "from", before, "to", st.health.state)
	}
	s.reportHealth()
}

func (s *Station) reportHealth() {
	for svcID, st := range s.services {
		depID := ""
		if sp := s.plan.Services[svcID]; sp != nil {
			depID = sp.DeploymentID
		}
		key := depID + "|" + st.healthFor + "|" + string(st.health.state)
		if st.health.state == protocol.HealthStateNone || depID == "" || st.reportedHealth == key {
			continue
		}
		st.reportedHealth = key
		var last *string
		if !st.health.lastCheck.IsZero() {
			last = stamp(st.health.lastCheck)
		}
		s.emit(protocol.MessageHealthResult, protocol.HealthResultBody{
			ServiceId: svcID, DeploymentId: depID, State: protocol.HealthResultState(st.health.state),
			Consecutive: st.health.consecutive(), LastCheck: last,
		})
	}
}

func containerName(c container.Summary) string {
	if len(c.Names) == 0 {
		return ""
	}
	return strings.TrimPrefix(c.Names[0], "/")
}

func dockerFailure(code protocol.ErrorCode, action string, err error) *protocol.ErrorBody {
	return dockerError(code, fmt.Errorf("%s: %w", action, err))
}

func dockerError(code protocol.ErrorCode, err error) *protocol.ErrorBody {
	return &protocol.ErrorBody{
		Code:        string(code),
		Explanation: err.Error(),
		Fix:         "Check the Docker daemon log and the generation, then apply again.",
	}
}

func (s *Station) startLink(ctx context.Context) {
	lctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	s.linkCancel, s.linkDone = cancel, done
	link := s.link
	go func() {
		defer close(done)
		link.Run(lctx)
	}()
}

func (s *Station) reportReady(ctx context.Context) {
	deadline := time.Now().Add(handoverTimeout)
	for !s.link.Connected() {
		if time.Now().After(deadline) || ctx.Err() != nil {
			s.log.Error("handover: not connected to Dispatch; not reporting ready, the old stationd keeps serving and kills this process")
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	unclaimed := upgrade.Unclaimed()
	if err := upgrade.SignalReady("connected"); err != nil {
		s.log.Error("handover: report ready", "error", err)
		return
	}
	s.log.Info("handover: reported ready to the old stationd", "sockets", upgrade.Live(), "unclaimed", unclaimed)
}
