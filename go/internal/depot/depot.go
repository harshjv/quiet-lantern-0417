//go:build linux

package depot

import (
	"context"
	"fmt"
	"github.com/harshjv/stationly/go/internal/cidr"
	"io/fs"
	"log/slog"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/fsx"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/moby/moby/api/types/container"
)

const (
	ImageSource  = "docker.io/library/registry"
	readyTimeout = 30 * time.Second

	AwaitingGeneration = "waiting for a generation to start Depot"
)

type Settings struct {
	StationID string
	Front     netip.AddrPort
	Dist      netip.AddrPort
	Subnet    netip.Prefix
	IPRange   netip.Prefix
	KeyRef    string
	Image     string
}

func SettingsFrom(g *protocol.Generation) (Settings, error) {
	r := g.Station.Registry
	front, err := netip.ParseAddrPort(r.Address)
	if err != nil || !front.Addr().Is4() {
		return Settings{}, fmt.Errorf("registry.address %q is not an IPv4 ip:port", r.Address)
	}
	subnet, err := netip.ParsePrefix(r.Subnet)
	if err != nil || subnet.Bits() > 28 {
		return Settings{}, fmt.Errorf("registry.subnet %q is not an IPv4 prefix of /28 or larger", r.Subnet)
	}
	subnet = subnet.Masked()
	ipRange := cidr.UpperHalf(subnet)
	dist := DistAddress(front)
	for _, a := range []netip.Addr{front.Addr(), dist.Addr()} {
		if !subnet.Contains(a) || ipRange.Contains(a) || a == subnet.Addr() {
			return Settings{}, fmt.Errorf("registry.address %s and the Distribution address %s must lie in the lower half of %s", front, dist, subnet)
		}
	}
	if strings.ContainsAny(r.KeyRef, "/\\") || r.KeyRef == "" || r.KeyRef == "." || r.KeyRef == ".." {
		return Settings{}, fmt.Errorf("registry.key_ref %q must be a file name", r.KeyRef)
	}
	pin, ok := g.Components["depot"]
	if !ok || pin.Digest == nil {
		return Settings{}, fmt.Errorf("components.depot with a digest is required")
	}
	return Settings{StationID: g.StationId, Front: front, Dist: dist, Subnet: subnet, IPRange: ipRange, KeyRef: r.KeyRef, Image: ImageSource + "@" + *pin.Digest}, nil
}

func DistAddress(front netip.AddrPort) netip.AddrPort {
	return netip.AddrPortFrom(front.Addr().Next(), front.Port())
}

type Depot struct {
	log      *slog.Logger
	docker   *docker.Client
	stateDir string

	mu       sync.Mutex
	settings Settings
	signer   *Signer
	front    *Front
	client   *Client
	readonly bool

	stateMu    sync.Mutex
	state      protocol.RegistryState
	stateError string

	windowMu sync.Mutex
	window   chan struct{}
}

func New(log *slog.Logger, dc *docker.Client, stateDir string) *Depot {
	open := make(chan struct{})
	close(open)
	return &Depot{log: log, docker: dc, stateDir: stateDir, window: open, state: protocol.RegistryStateDown, stateError: AwaitingGeneration}
}

func (d *Depot) setState(state protocol.RegistryState, failure string) {
	d.stateMu.Lock()
	defer d.stateMu.Unlock()
	if state != d.state {
		switch state {
		case protocol.RegistryStateDown:
			d.log.Error("Depot is not serving", "error", failure)
		default:
			d.log.Info("Depot "+string(state), "front", d.settings.Front, "distribution", d.settings.Dist)
		}
	}
	d.state, d.stateError = state, failure
}

func (d *Depot) Configure(s Settings) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.signer != nil && (d.settings.Front != s.Front || d.settings.KeyRef != s.KeyRef) {
		return fmt.Errorf("registry address or key_ref changed from %s/%s to %s/%s; they are fixed at install", d.settings.Front, d.settings.KeyRef, s.Front, s.KeyRef)
	}
	if d.settings.Image != "" {
		s.Image = d.settings.Image
	}
	d.settings = s
	if d.signer == nil {
		signer, err := LoadSigner(filepath.Join(d.stateDir, "identity", s.KeyRef))
		if err != nil {
			return fmt.Errorf("Depot signing key: %w", err)
		}
		d.signer = signer
		d.client = NewClient(signer, s.Front)
	}
	return nil
}

func (d *Depot) Image() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.settings.Image
}

func (d *Depot) SetImage(image string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.settings.Image = image
}

type UpgradeResult struct {
	From       string `json:"from"`
	To         string `json:"to"`
	ReadonlyMs int64  `json:"readonly_ms"`
	TookMs     int64  `json:"took_ms"`
}

func (d *Depot) Upgrade(ctx context.Context, image string, progress func(step, detail string)) (UpgradeResult, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	start := time.Now()
	res := UpgradeResult{From: d.settings.Image, To: image}
	restore := func(cause error) (UpgradeResult, error) {
		d.settings.Image, d.readonly = res.From, false
		if err := d.ensureContainer(context.WithoutCancel(ctx)); err != nil {
			d.setState(protocol.RegistryStateDown, "restart Depot on the previous image: "+err.Error())
		} else {
			d.setState(protocol.RegistryStateServing, "")
		}
		res.TookMs = time.Since(start).Milliseconds()
		return res, cause
	}
	d.settings.Image, d.readonly = image, true
	progress("readonly", "restarting Depot on "+image+" with maintenance.readonly.enabled: true")
	if err := d.ensureContainer(ctx); err != nil {
		return restore(fmt.Errorf("start Depot read-only on %s: %w", image, err))
	}
	d.setState(protocol.RegistryStateReadonly, "")
	ro := time.Now()
	d.readonly = false
	progress("writable", "restarting Depot writable on "+image)
	if err := d.ensureContainer(ctx); err != nil {
		return restore(fmt.Errorf("start Depot writable on %s: %w", image, err))
	}
	d.setState(protocol.RegistryStateServing, "")
	res.ReadonlyMs = time.Since(ro).Milliseconds()
	res.TookMs = time.Since(start).Milliseconds()
	return res, nil
}

func (d *Depot) Signer() *Signer {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.signer
}

func (d *Depot) Client() *Client {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.client
}

func (d *Depot) Settings() Settings {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.settings
}

func (d *Depot) State() (protocol.RegistryState, string) {
	d.stateMu.Lock()
	defer d.stateMu.Unlock()
	return d.state, d.stateError
}

func (d *Depot) configDir() string {
	return filepath.Join(d.stateDir, "config", "depot")
}

func (d *Depot) files(readonly bool) docker.DepotFiles {
	name := "config.yml"
	if readonly {
		name = "config-readonly.yml"
	}
	return docker.DepotFiles{
		ConfigHost: filepath.Join(d.configDir(), name), ConfigTarget: ConfigPath,
		JWKSHost: filepath.Join(d.configDir(), "stationd.jwks.json"), JWKSTarget: JWKSPath,
		StorageTarget: StoragePath,
	}
}

func (d *Depot) Ensure(ctx context.Context) {
	if !d.mu.TryLock() {
		return
	}
	defer d.mu.Unlock()
	if d.signer == nil {
		return
	}
	if err := d.ensure(ctx); err != nil {
		d.setState(protocol.RegistryStateDown, err.Error())
		return
	}
	d.setState(protocol.RegistryStateServing, "")
}

func (d *Depot) ensure(ctx context.Context) error {
	s := d.settings
	if err := d.writeFiles(); err != nil {
		return err
	}
	if err := d.ensureNetwork(ctx); err != nil {
		return err
	}
	if d.front == nil {
		f := NewFront(d.log, d.signer, s.Dist)
		if err := f.Listen(s.Front); err != nil {
			return fmt.Errorf("listen on %s: %w", s.Front, err)
		}
		d.front = f
	}
	written, err := EnsureFirewall(s.Dist)
	if err != nil {
		return fmt.Errorf("write table bridge %s: %w", FirewallTable, err)
	}
	if written {
		d.log.Info("Depot firewall written", "table", "bridge "+FirewallTable, "drops_forwarded_to", s.Dist)
	}
	return d.ensureContainer(ctx)
}

func (d *Depot) writeFiles() error {
	if err := os.MkdirAll(d.configDir(), 0o700); err != nil {
		return err
	}
	jwks, err := d.signer.JWKS()
	if err != nil {
		return err
	}
	s := d.settings
	for name, body := range map[string][]byte{
		"stationd.jwks.json":  jwks,
		"config.yml":          Config(s.Front, s.Dist, false),
		"config-readonly.yml": Config(s.Front, s.Dist, true),
	} {
		if _, err := fsx.WriteIfChanged(filepath.Join(d.configDir(), name), body, 0o644); err != nil {
			return err
		}
	}
	return nil
}

func (d *Depot) ensureNetwork(ctx context.Context) error {
	s := d.settings
	spec := docker.DepotNetwork(s.StationID, s.Subnet, s.IPRange, s.Front.Addr())
	_, labels, ok, err := d.docker.NetworkByName(ctx, spec.Name)
	if err != nil {
		return err
	}
	if ok {
		if labels[docker.LabelHash] != spec.Hash {
			return fmt.Errorf("network %s exists with other settings; the Depot subnet is fixed at install, remove the network to recreate it", spec.Name)
		}
		return nil
	}
	id, err := d.docker.CreateNetwork(ctx, spec)
	if err != nil {
		return fmt.Errorf("create network %s: %w", spec.Name, err)
	}
	d.log.Info("created Depot network", "name", spec.Name, "bridge", docker.DepotBridgeName, "id", id[:12], "subnet", s.Subnet, "front", s.Front.Addr(), "dynamic_range", s.IPRange)
	return nil
}

func (d *Depot) spec() docker.ContainerSpec {
	return docker.Depot(d.settings.StationID, d.settings.Image, d.settings.Dist.Addr(), d.files(d.readonly))
}

func (d *Depot) ensureContainer(ctx context.Context) error {
	spec := d.spec()
	if err := docker.CheckInvariants(spec, d.stateDir); err != nil {
		return err
	}
	c, ok, err := d.docker.ContainerByName(ctx, spec.Name)
	if err != nil {
		return err
	}
	if ok && c.Labels[docker.LabelHash] == spec.Hash && c.State == container.StateRunning {
		return nil
	}
	if ok {
		if c.Labels[docker.LabelHash] == spec.Hash && c.State != container.StateRunning {
			d.log.Warn("Depot container is not running, recreating", "state", c.State)
		}
		if err := d.docker.Remove(ctx, c.ID); err != nil {
			return err
		}
	}
	id, err := d.docker.CreateContainer(ctx, spec.Create)
	if err != nil {
		return fmt.Errorf("create %s: %w", spec.Name, err)
	}
	if err := d.docker.Start(ctx, id); err != nil {
		return fmt.Errorf("start %s: %w", spec.Name, err)
	}
	d.log.Info("started Depot", "id", id[:12], "address", d.settings.Dist, "readonly", d.readonly)
	return d.waitReady(ctx)
}

func (d *Depot) waitReady(ctx context.Context) error {
	url := "http://" + d.settings.Dist.String() + "/v2/"
	hc := &http.Client{Timeout: 2 * time.Second}
	deadline := time.Now().Add(readyTimeout)
	for time.Now().Before(deadline) {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if resp, err := hc.Do(req); err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusUnauthorized {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
	return fmt.Errorf("Distribution at %s did not answer /v2/ with 401 within %s", d.settings.Dist, readyTimeout)
}

func (d *Depot) BeginMaintenance() bool {
	d.windowMu.Lock()
	defer d.windowMu.Unlock()
	select {
	case <-d.window:
		d.window = make(chan struct{})
		return true
	default:
		return false
	}
}

func (d *Depot) EndMaintenance() {
	d.windowMu.Lock()
	defer d.windowMu.Unlock()
	select {
	case <-d.window:
	default:
		close(d.window)
	}
}

func (d *Depot) WaitWritable(ctx context.Context, waiting func()) error {
	d.windowMu.Lock()
	w := d.window
	d.windowMu.Unlock()
	select {
	case <-w:
		return nil
	default:
	}
	waiting()
	select {
	case <-w:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

type GCResult struct {
	DeletedBlobs int    `json:"deleted_blobs"`
	FreedBytes   int64  `json:"freed_bytes"`
	BytesBefore  int64  `json:"bytes_before"`
	BytesAfter   int64  `json:"bytes_after"`
	DurationS    int    `json:"duration_s"`
	ReadonlyS    string `json:"readonly_window_s"`
	ExitCode     int64  `json:"exit_code"`
	Output       string `json:"output"`
}

func (d *Depot) GC(ctx context.Context, progress func(step, detail string)) (GCResult, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	var res GCResult
	start := time.Now()
	vol, _, err := d.docker.EnsureVolume(ctx, docker.DepotVolume, nil)
	if err != nil {
		return res, err
	}
	res.BytesBefore = dirSize(vol.Mountpoint)
	progress("readonly", "restarting Depot with maintenance.readonly.enabled: true")
	d.readonly = true
	defer func() {
		d.readonly = false
		if err := d.ensureContainer(context.WithoutCancel(ctx)); err != nil {
			d.setState(protocol.RegistryStateDown, "restart Depot writable: "+err.Error())
			return
		}
		d.setState(protocol.RegistryStateServing, "")
	}()
	if err := d.ensureContainer(ctx); err != nil {
		return res, err
	}
	d.setState(protocol.RegistryStateReadonly, "")
	roStart := time.Now()
	progress("garbage-collect", "registry garbage-collect --delete-untagged")
	gc := docker.DepotGC(d.settings.StationID, d.settings.Image, d.files(true))
	if err := docker.CheckInvariants(gc, d.stateDir); err != nil {
		return res, err
	}
	if c, ok, _ := d.docker.ContainerByName(ctx, gc.Name); ok {
		d.docker.Remove(ctx, c.ID)
	}
	id, err := d.docker.CreateContainer(ctx, gc.Create)
	if err != nil {
		return res, err
	}
	defer d.docker.Remove(context.WithoutCancel(ctx), id)
	if err := d.docker.Start(ctx, id); err != nil {
		return res, err
	}
	code, err := d.docker.Wait(ctx, id)
	if err != nil {
		return res, err
	}
	out, _ := d.docker.Logs(ctx, id)
	res.ExitCode = code
	res.Output = out
	res.DeletedBlobs = strings.Count(out, "blob eligible for deletion")
	if code != 0 {
		return res, fmt.Errorf("garbage-collect exited %d", code)
	}
	progress("writable", "restarting Depot writable")
	d.readonly = false
	if err := d.ensureContainer(ctx); err != nil {
		return res, err
	}
	d.setState(protocol.RegistryStateServing, "")
	res.ReadonlyS = fmt.Sprintf("%.2f", time.Since(roStart).Seconds())
	res.BytesAfter = dirSize(vol.Mountpoint)
	res.FreedBytes = max(res.BytesBefore-res.BytesAfter, 0)
	res.DurationS = int(time.Since(start).Round(time.Second).Seconds())
	return res, nil
}

func dirSize(root string) int64 {
	var total int64
	filepath.WalkDir(root, func(_ string, e fs.DirEntry, err error) error {
		if err == nil && e.Type().IsRegular() {
			if info, err := e.Info(); err == nil {
				total += info.Size()
			}
		}
		return nil
	})
	return total
}

func (d *Depot) Close() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.front != nil {
		d.front.Close()
		d.front = nil
	}
}
