//go:build linux

package workshop

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/netip"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/harshjv/stationly/go/internal/depot"
	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/netns"
	"github.com/harshjv/stationly/go/internal/protocol"
	bkclient "github.com/moby/buildkit/client"
	"github.com/moby/moby/api/types/container"
)

const (
	BuildkitSource    = "docker.io/moby/buildkit"
	RailpackSource    = "ghcr.io/railwayapp/railpack-frontend"
	SyftScannerSource = "docker.io/docker/buildkit-syft-scanner"
	maxDaemons        = 4
	workshopMemory    = 4 << 30
	readyTimeout      = 60 * time.Second
	stopTimeoutS      = 10
)

type Pins struct {
	Buildkit        string
	Railpack        string
	RailpackVersion string
	SyftScanner     string
	Coupler         string
}

func PinsFrom(g *protocol.Generation) (Pins, error) {
	get := func(name, source string) (string, string, error) {
		pin, ok := g.Components[name]
		if !ok || pin.Digest == nil {
			return "", "", fmt.Errorf("components.%s with a digest is required for builds", name)
		}
		return source + "@" + *pin.Digest, pin.Version, nil
	}
	var p Pins
	var err error
	if p.Buildkit, _, err = get("buildkit", BuildkitSource); err != nil {
		return p, err
	}
	if p.Railpack, p.RailpackVersion, err = get("railpack_frontend", RailpackSource); err != nil {
		return p, err
	}
	if p.SyftScanner, _, err = get("syft_scanner", SyftScannerSource); err != nil {
		return p, err
	}
	if p.Coupler, _, err = get("coupler_image", docker.CouplerSource); err != nil {
		return p, err
	}
	return p, nil
}

type Manager struct {
	log      *slog.Logger
	docker   *docker.Client
	depot    *depot.Depot
	stateDir string
	arch     string

	mu       sync.Mutex
	cond     *sync.Cond
	gen      *protocol.Generation
	projects map[string]*project
	apparmor *bool
	insecure []string
}

type project struct {
	ensure   sync.Mutex
	slots    chan struct{}
	running  int
	daemon   bool
	lastUsed time.Time
}

func NewManager(log *slog.Logger, dc *docker.Client, d *depot.Depot, stateDir string) *Manager {
	m := &Manager{log: log, docker: dc, depot: d, stateDir: stateDir, arch: runtime.GOARCH, projects: map[string]*project{}}
	m.cond = sync.NewCond(&m.mu)
	return m
}

func (m *Manager) Arch() string {
	return m.arch
}

func (m *Manager) SetGeneration(g *protocol.Generation) {
	m.mu.Lock()
	m.gen = g
	m.mu.Unlock()
}

func (m *Manager) SetInsecureRegistries(hosts []string) {
	m.mu.Lock()
	m.insecure = hosts
	m.mu.Unlock()
}

func (m *Manager) insecureRegistries() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.insecure
}

func (m *Manager) Generation() *protocol.Generation {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.gen
}

func (m *Manager) project(id string, maxBuilds int) *project {
	m.mu.Lock()
	defer m.mu.Unlock()
	p := m.projects[id]
	if p == nil {
		p = &project{slots: make(chan struct{}, max(maxBuilds, 1))}
		m.projects[id] = p
	}
	return p
}

func (m *Manager) daemonsRunning() int {
	n := 0
	for _, p := range m.projects {
		if p.daemon {
			n++
		}
	}
	return n
}

func (m *Manager) reserveDaemon(ctx context.Context, p *project, waiting func()) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	announced := false
	for !p.daemon && m.daemonsRunning() >= maxDaemons {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if !announced {
			waiting()
			announced = true
		}
		m.cond.Wait()
	}
	p.daemon = true
	p.running++
	p.lastUsed = time.Now()
	return nil
}

func (m *Manager) release(p *project) {
	m.mu.Lock()
	p.running--
	p.lastUsed = time.Now()
	m.mu.Unlock()
	m.cond.Broadcast()
}

func (m *Manager) Running() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, p := range m.projects {
		n += p.running
	}
	return n
}

func (m *Manager) WaitIdle(ctx context.Context) error {
	for m.Running() > 0 {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
	return nil
}

type Observed struct {
	Running       bool
	BuildsRunning int
}

func (m *Manager) Observed() map[string]Observed {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := map[string]Observed{}
	for id, p := range m.projects {
		out[id] = Observed{Running: p.daemon, BuildsRunning: p.running}
	}
	return out
}

func (m *Manager) EnsureAppArmor() (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.apparmor != nil && (!*m.apparmor || ProfileLoaded()) {
		return *m.apparmor, nil
	}
	enabled, abi, err := EnsureProfile()
	if err != nil {
		return false, err
	}
	if enabled {
		m.log.Info("AppArmor profile loaded", "profile", docker.WorkshopAppArmorProfile, "body", abi, "path", profilePath)
	}
	m.apparmor = &enabled
	return enabled, nil
}

func (m *Manager) configDir(projectID string) string {
	return filepath.Join(m.stateDir, "config", "workshops", projectID)
}

func volumeNames(projectID string) docker.WorkshopVolumes {
	return docker.WorkshopVolumes{
		Home:   "or-workshop-" + projectID + "-home",
		Cache:  "or-workshop-" + projectID + "-cache",
		Socket: "or-workshop-" + projectID + "-sock",
	}
}

func railpackCacheVolume(projectID string) string {
	return "or-workshop-" + projectID + "-railpack"
}

func (m *Manager) labels(projectID string) map[string]string {
	return map[string]string{docker.LabelStation: m.Generation().StationId, docker.LabelRole: docker.RoleWorkshop, docker.LabelProject: projectID}
}

type Workshop struct {
	Socket    string
	CouplerID string
	Started   bool
}

func (m *Manager) ensure(ctx context.Context, projectID string, ws protocol.DesiredWorkshop, pins Pins) (Workshop, error) {
	g := m.Generation()
	overlaps, err := HostOverlaps(ws.UidBase)
	if err != nil {
		return Workshop{}, err
	}
	if len(overlaps) > 0 {
		return Workshop{}, fmt.Errorf("workshop uid range %d-%d overlaps host entries %v", ws.UidBase, ws.UidBase+rangeSize-1, overlaps)
	}
	apparmor, err := m.EnsureAppArmor()
	if err != nil {
		return Workshop{}, err
	}
	files, err := m.writeFiles(ctx, projectID, ws, pins)
	if err != nil {
		return Workshop{}, err
	}
	vols := volumeNames(projectID)
	var sockDir string
	for _, name := range []string{vols.Home, vols.Cache, vols.Socket} {
		v, _, err := m.docker.EnsureVolume(ctx, name, m.labels(projectID))
		if err != nil {
			return Workshop{}, err
		}
		if err := prepareVolume(v.Mountpoint, ws.UidBase, name == vols.Home); err != nil {
			return Workshop{}, err
		}
		if name == vols.Socket {
			sockDir = v.Mountpoint
		}
	}
	if _, _, err := m.docker.EnsureVolume(ctx, railpackCacheVolume(projectID), m.labels(projectID)); err != nil {
		return Workshop{}, err
	}

	couplerSpec := docker.WorkshopCoupler(g.StationId, projectID, pins.Coupler)
	cpus := int64(runtime.NumCPU()) * 1_000_000_000
	wsSpec := docker.Workshop(g.StationId, projectID, pins.Buildkit, ws.UidBase, files, vols, apparmor, workshopMemory, cpus)
	for _, spec := range []docker.ContainerSpec{couplerSpec, wsSpec} {
		if err := docker.CheckInvariants(spec, m.stateDir); err != nil {
			return Workshop{}, err
		}
	}
	coupler, couplerOK, err := m.docker.ContainerByName(ctx, couplerSpec.Name)
	if err != nil {
		return Workshop{}, err
	}
	daemon, daemonOK, err := m.docker.ContainerByName(ctx, wsSpec.Name)
	if err != nil {
		return Workshop{}, err
	}
	couplerUp := couplerOK && coupler.State == container.StateRunning && coupler.Labels[docker.LabelHash] == couplerSpec.Hash
	daemonUp := daemonOK && daemon.State == container.StateRunning && daemon.Labels[docker.LabelHash] == wsSpec.Hash
	started := false
	couplerID := coupler.ID
	if !couplerUp {
		if daemonOK {
			m.docker.Remove(ctx, daemon.ID)
		}
		if couplerOK {
			m.docker.Remove(ctx, coupler.ID)
		}
		daemonUp, daemonOK = false, false
		id, err := m.docker.CreateContainer(ctx, couplerSpec.Create)
		if err != nil {
			return Workshop{}, fmt.Errorf("create %s: %w", couplerSpec.Name, err)
		}
		if err := m.docker.Start(ctx, id); err != nil {
			return Workshop{}, fmt.Errorf("start %s: %w", couplerSpec.Name, err)
		}
		couplerID = id
		m.log.Info("started Workshop Coupler", "project", projectID, "id", id[:12])
	}
	if err := m.syncNamespace(ctx, couplerID); err != nil {
		return Workshop{}, err
	}
	if !daemonUp {
		if daemonOK {
			m.docker.Remove(ctx, daemon.ID)
		}
		id, err := m.docker.CreateContainer(ctx, wsSpec.JoinedTo(couplerID))
		if err != nil {
			return Workshop{}, fmt.Errorf("create %s: %w", wsSpec.Name, err)
		}
		if err := m.docker.Start(ctx, id); err != nil {
			return Workshop{}, fmt.Errorf("start %s: %w", wsSpec.Name, err)
		}
		started = true
		m.log.Info("started Workshop", "project", projectID, "id", id[:12], "uid_base", ws.UidBase, "apparmor", apparmor)
	}
	socket := "unix://" + filepath.Join(sockDir, "buildkitd.sock")
	if err := waitDaemon(ctx, socket); err != nil {
		return Workshop{}, err
	}
	return Workshop{Socket: socket, CouplerID: couplerID, Started: started}, nil
}

func waitDaemon(ctx context.Context, socket string) error {
	deadline := time.Now().Add(readyTimeout)
	var last error
	for time.Now().Before(deadline) {
		c, err := bkclient.New(ctx, socket)
		if err == nil {
			cctx, cancel := context.WithTimeout(ctx, 2*time.Second)
			_, err = c.ListWorkers(cctx)
			cancel()
			c.Close()
			if err == nil {
				return nil
			}
		}
		last = err
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
	return fmt.Errorf("buildkitd at %s not ready within %s: %v", socket, readyTimeout, last)
}

func prepareVolume(root string, uid int, home bool) error {
	if home {
		for _, sub := range []string{".local/tmp", ".local/share/buildkit", ".config/buildkit"} {
			p := filepath.Join(root, sub)
			if err := os.MkdirAll(p, 0o755); err != nil {
				return err
			}
			for dir := p; dir != root; dir = filepath.Dir(dir) {
				if err := os.Chown(dir, uid, uid); err != nil {
					return err
				}
			}
		}
	}
	return os.Chown(root, uid, uid)
}

func (m *Manager) writeFiles(ctx context.Context, projectID string, ws protocol.DesiredWorkshop, pins Pins) (docker.WorkshopFiles, error) {
	dir := m.configDir(projectID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return docker.WorkshopFiles{}, err
	}
	imagePasswd, err := m.docker.ImageFile(ctx, pins.Buildkit, "/etc/passwd")
	if err != nil {
		return docker.WorkshopFiles{}, err
	}
	imageGroup, err := m.docker.ImageFile(ctx, pins.Buildkit, "/etc/group")
	if err != nil {
		return docker.WorkshopFiles{}, err
	}
	passwd, err := remapPasswd(imagePasswd, ws.UidBase)
	if err != nil {
		return docker.WorkshopFiles{}, err
	}
	group, err := remapGroup(imageGroup, ws.UidBase)
	if err != nil {
		return docker.WorkshopFiles{}, err
	}
	f := docker.WorkshopFiles{
		Passwd: filepath.Join(dir, "passwd"),
		Group:  filepath.Join(dir, "group"),
		Subuid: filepath.Join(dir, "subuid"),
		Subgid: filepath.Join(dir, "subgid"),
		Config: filepath.Join(dir, "buildkitd.toml"),
	}
	for path, body := range map[string][]byte{
		f.Passwd: passwd,
		f.Group:  group,
		f.Subuid: subordinate(ws.UidBase),
		f.Subgid: subordinate(ws.UidBase),
		f.Config: BuildkitdTOML(ws, m.Generation().Station.Registry.Address, m.insecureRegistries()),
	} {
		if err := os.WriteFile(path, body, 0o644); err != nil {
			return docker.WorkshopFiles{}, err
		}
	}
	return f, nil
}

func (m *Manager) syncNamespace(ctx context.Context, couplerID string) error {
	full, err := m.docker.Inspect(ctx, couplerID)
	if err != nil {
		return err
	}
	if full.State == nil || !full.State.Running || full.NetworkSettings == nil {
		return fmt.Errorf("Workshop Coupler %s is not running", couplerID[:12])
	}
	ep := full.NetworkSettings.Networks[docker.DepotNetworkName]
	if ep == nil || !ep.IPAddress.IsValid() {
		return fmt.Errorf("Workshop Coupler %s has no address on %s", couplerID[:12], docker.DepotNetworkName)
	}
	ns, err := netns.Open(full.State.Pid)
	if err != nil {
		return err
	}
	defer ns.Close()
	front := m.depot.Settings().Front
	hosts, err := netns.HostAddresses()
	if err != nil {
		return err
	}
	var prefixes []netip.Prefix
	for _, a := range hosts {
		prefixes = append(prefixes, netip.PrefixFrom(a, 32))
	}
	result, err := ns.Sync(netns.Baseline{Resolver: front.Addr(), Self: ep.IPAddress, Allow: []netip.AddrPort{front}}, netns.Elements{HostAddrs: prefixes})
	if err != nil {
		return fmt.Errorf("write table inet %s into the Workshop Coupler: %w", netns.TableName, err)
	}
	if result != netns.Unchanged {
		m.log.Info("Workshop namespace ruleset synced", "coupler", couplerID[:12], "netns", ns.Inode, "result", result, "allow", front)
	}
	return nil
}

func (m *Manager) Reap(ctx context.Context, now time.Time) {
	g := m.Generation()
	if g == nil {
		return
	}
	daemons, err := m.docker.ContainersWithRole(ctx, docker.RoleWorkshop)
	if err != nil {
		return
	}
	couplers, err := m.docker.ContainersWithRole(ctx, docker.RoleWorkshopCoupler)
	if err != nil {
		return
	}
	m.mu.Lock()
	var stop []string
	present := map[string]bool{}
	for _, c := range append(daemons, couplers...) {
		id := c.Labels[docker.LabelProject]
		present[id] = true
		ws, desired := g.Workshops[id]
		p := m.projects[id]
		if p == nil {
			p = &project{slots: make(chan struct{}, max(ws.MaxBuilds, 1)), daemon: true, lastUsed: now}
			m.projects[id] = p
		}
		if p.running > 0 {
			continue
		}
		idle := time.Duration(ws.IdleTimeoutS) * time.Second
		if !desired || now.Sub(p.lastUsed) >= idle {
			stop = append(stop, id)
		}
	}
	for id, p := range m.projects {
		if !present[id] && p.running == 0 {
			p.daemon = false
		}
	}
	m.mu.Unlock()
	for _, id := range unique(stop) {
		m.stop(ctx, id, g)
	}
	if len(stop) > 0 {
		m.cond.Broadcast()
	}
	if vols, err := m.docker.VolumesWithLabel(ctx, docker.LabelProject); err == nil {
		for _, v := range vols {
			id := v.Labels[docker.LabelProject]
			if _, ok := g.Workshops[id]; !ok && v.Labels[docker.LabelStation] == g.StationId && v.Labels[docker.LabelRole] == docker.RoleWorkshop {
				m.log.Info("removing Workshop volume of a project absent from the generation", "volume", v.Name)
				m.docker.RemoveVolume(ctx, v.Name)
			}
		}
	}
}

func unique(ids []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

func (m *Manager) stop(ctx context.Context, projectID string, g *protocol.Generation) {
	m.mu.Lock()
	p := m.projects[projectID]
	m.mu.Unlock()
	if p != nil {
		p.ensure.Lock()
		defer p.ensure.Unlock()
		m.mu.Lock()
		busy := p.running > 0
		m.mu.Unlock()
		if busy {
			return
		}
	}
	_, desired := g.Workshops[projectID]
	m.log.Info("stopping Workshop", "project", projectID, "reason", map[bool]string{true: "idle timeout", false: "project absent from the generation"}[desired])
	for _, name := range []string{docker.WorkshopName(projectID), docker.WorkshopCouplerName(projectID)} {
		if c, ok, _ := m.docker.ContainerByName(ctx, name); ok {
			m.docker.Stop(ctx, c.ID, stopTimeoutS)
			m.docker.Remove(ctx, c.ID)
		}
	}
	m.mu.Lock()
	if p != nil {
		p.daemon = false
	}
	if !desired {
		delete(m.projects, projectID)
	}
	m.mu.Unlock()
}

func (m *Manager) secretsKey(projectID string) ([]byte, error) {
	path := filepath.Join(m.stateDir, "workshops", projectID, "secrets-hash.key")
	if b, err := os.ReadFile(path); err == nil && len(b) == 32 {
		return b, nil
	} else if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	return key, os.WriteFile(path, key, 0o600)
}

type Restart struct {
	ProjectID string `json:"project_id"`
	FromImage string `json:"from_image"`
	WaitedMs  int64  `json:"waited_ms"`
	TookMs    int64  `json:"took_ms"`
}

func (m *Manager) RestartDaemons(ctx context.Context, image string) ([]Restart, error) {
	daemons, err := m.docker.ContainersWithRole(ctx, docker.RoleWorkshop)
	if err != nil {
		return nil, err
	}
	var out []Restart
	for _, c := range daemons {
		if c.Image == image {
			continue
		}
		r, err := m.restartIdle(ctx, c.Labels[docker.LabelProject], c.ID, c.Image)
		if err != nil {
			return out, err
		}
		out = append(out, r)
	}
	return out, nil
}

func (m *Manager) restartIdle(ctx context.Context, projectID, containerID, from string) (Restart, error) {
	r := Restart{ProjectID: projectID, FromImage: from}
	began := time.Now()
	p := m.project(projectID, 1)
	for {
		for m.projectBusy(p) {
			select {
			case <-ctx.Done():
				return r, ctx.Err()
			case <-time.After(250 * time.Millisecond):
			}
		}
		p.ensure.Lock()
		if !m.projectBusy(p) {
			break
		}
		p.ensure.Unlock()
	}
	defer p.ensure.Unlock()
	r.WaitedMs = time.Since(began).Milliseconds()
	start := time.Now()
	g := m.Generation()
	ws, ok := g.Workshops[projectID]
	pins, err := PinsFrom(g)
	m.docker.Stop(ctx, containerID, stopTimeoutS)
	m.docker.Remove(ctx, containerID)
	m.log.Info("Workshop stopped for the BuildKit upgrade", "project", projectID, "from", from, "waited_ms", r.WaitedMs)
	if !ok || err != nil {
		r.TookMs = time.Since(start).Milliseconds()
		return r, nil
	}
	if _, err := m.ensure(ctx, projectID, ws, pins); err != nil {
		return r, fmt.Errorf("restart the Workshop of %s on %s: %w", projectID, pins.Buildkit, err)
	}
	r.TookMs = time.Since(start).Milliseconds()
	m.log.Info("Workshop restarted on the new BuildKit", "project", projectID, "image", pins.Buildkit, "took_ms", r.TookMs)
	return r, nil
}

func (m *Manager) projectBusy(p *project) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return p.running > 0
}
