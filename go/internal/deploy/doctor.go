//go:build linux

package deploy

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/nftables"
	"github.com/harshjv/stationly/go/internal/depot"
	"github.com/harshjv/stationly/go/internal/dispatch"
	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/netns"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/workshop"
	mdns "github.com/miekg/dns"
	"golang.org/x/sys/unix"
)

const daemonJSON = DefaultDaemonJSON

func sysctl(name string) (string, bool) {
	b, err := os.ReadFile("/proc/sys/" + strings.ReplaceAll(name, ".", "/"))
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(b)), true
}

type checkBuilder struct {
	name    string
	status  protocol.DoctorStatus
	code    string
	finding []string
	fix     []string
	detail  map[string]any
}

func newCheck(name string) *checkBuilder {
	return &checkBuilder{name: name, status: protocol.DoctorStatusOk, detail: map[string]any{}}
}

func (c *checkBuilder) raise(status protocol.DoctorStatus, code, finding, fix string) {
	rank := map[protocol.DoctorStatus]int{protocol.DoctorStatusOk: 0, protocol.DoctorStatusWarn: 1, protocol.DoctorStatusFail: 2}
	if rank[status] > rank[c.status] {
		c.status, c.code = status, code
		c.finding = append([]string{finding}, c.finding...)
		if fix != "" {
			c.fix = append([]string{fix}, c.fix...)
		}
		return
	}
	c.finding = append(c.finding, finding)
	if fix != "" {
		c.fix = append(c.fix, fix)
	}
}

func (c *checkBuilder) note(finding string) {
	if c.status == protocol.DoctorStatusOk {
		c.finding = append(c.finding, finding)
	}
}

func (c *checkBuilder) build() protocol.DoctorCheck {
	out := protocol.DoctorCheck{Name: c.name, Status: c.status, Finding: strings.Join(c.finding, "; ")}
	if out.Finding == "" {
		out.Finding = "ok"
	}
	if c.code != "" {
		code := c.code
		out.Code = &code
	}
	if len(c.fix) > 0 {
		fix := strings.Join(c.fix, "; ")
		out.Fix = &fix
	}
	if len(c.detail) > 0 {
		out.Detail = c.detail
	}
	return out
}

func (s *Station) doctorRun(ctx context.Context, m dispatch.Message) {
	if !s.requireCapability(m, protocol.CapabilityDoctorV1) {
		return
	}
	ref := m.ID
	s.send(protocol.MessageDoctorReport, &ref, s.doctorReport(ctx))
}

func (s *Station) opDoctor(ctx context.Context, _ json.RawMessage, _ func(string, string)) (any, *protocol.ErrorBody) {
	done := make(chan protocol.DoctorReportBody, 1)
	s.post(ctx, func() { done <- s.doctorReport(ctx) })
	select {
	case r := <-done:
		return r, nil
	case <-ctx.Done():
		return nil, protocolError(protocol.ErrorCodeInternalError, "Retry.", "doctor interrupted")
	case <-time.After(30 * time.Second):
		return nil, protocolError(protocol.ErrorCodeInternalError, "Check the stationd log.", "doctor did not finish within 30 s")
	}
}

func (s *Station) doctorReport(ctx context.Context) protocol.DoctorReportBody {
	checks := []protocol.DoctorCheck{
		s.checkComponents(ctx),
		s.checkTrustedRoot(),
		s.checkDisk(ctx),
		s.checkKernel(),
		s.checkLogStore(),
		s.checkFirewallBackend(),
		s.checkMarkAccept(),
		s.checkWorkshopIsolation(),
		s.checkHostPrerequisites(ctx),
		s.checkNftTables(),
		s.checkResolver(ctx),
		s.checkLockfileMirror(),
		s.checkLitestream(ctx),
		s.checkSandboxRuntime(ctx),
		s.checkSandboxStorage(),
	}
	return protocol.DoctorReportBody{CheckedAt: tstamp(time.Now()), Checks: checks}
}

func (s *Station) checkComponents(ctx context.Context) protocol.DoctorCheck {
	c := newCheck("component_health")
	if s.plan == nil {
		c.raise(protocol.DoctorStatusWarn, "no_generation", "no generation applied yet", "Wait for Dispatch to send the first generation.")
		return c.build()
	}
	state, failure := s.depot.State()
	c.detail["depot"] = string(state)
	if s.plan.Generation.Components["depot"].Digest != nil && state != protocol.RegistryStateServing {
		c.raise(protocol.DoctorStatusFail, "depot_down", fmt.Sprintf("Depot is %s: %s", state, failure), "Check stationd log for Depot and run sly platform doctor again.")
	} else {
		c.note("Depot " + string(state))
	}
	if s.system.failure != "" {
		c.raise(protocol.DoctorStatusFail, "system_network", s.system.failure, "Fix the system network and restart stationd.")
	}
	if gp := s.plan.Gateway; gp != nil && gp.Run {
		cur := s.gw.state.Current
		if cur == nil {
			c.raise(protocol.DoctorStatusFail, "gateway_down", "the Gateway is not running", "Check stationd's Gateway log lines.")
		} else {
			v := s.inspectID(ctx, docker.GatewayName(cur.Slot), docker.IngressNetworkName)
			c.detail["gateway"] = map[string]any{"slot": cur.Slot, "state": v.state}
			if v.state != "running" {
				c.raise(protocol.DoctorStatusFail, "gateway_down", "Gateway "+docker.GatewayName(cur.Slot)+" is "+v.state, "Check stationd's Gateway log lines.")
			} else {
				c.note("Gateway " + cur.Slot + " running")
			}
		}
		if s.gw.failure != nil {
			c.raise(protocol.DoctorStatusWarn, "gateway_failure", s.gw.failure.Explanation, s.gw.failure.Fix)
		}
	}
	ws := s.workshops.Observed()
	c.detail["workshops"] = len(ws)
	return c.build()
}

func (s *Station) checkTrustedRoot() protocol.DoctorCheck {
	c := newCheck("trusted_root")
	st := s.verifier.RootState()
	c.detail["digest"], c.detail["origin"] = st.Digest, st.Origin
	if !st.RefreshedAt.IsZero() {
		c.detail["refreshed_at"] = tstamp(st.RefreshedAt)
	}
	if st.RefreshError != "" {
		c.raise(protocol.DoctorStatusWarn, "trusted_root_stale", fmt.Sprintf("the last TUF refresh at %s failed (%s); verification used the saved trusted root %s from %s", tstamp(st.AttemptedAt), st.RefreshError, short(st.Digest), st.Origin), "stationd verify refresh (needs egress to the TUF mirror)")
		return c.build()
	}
	c.note(fmt.Sprintf("trusted root %s from %s", short(st.Digest), st.Origin))
	return c.build()
}

func short(d string) string {
	if len(d) > 19 {
		return d[:19]
	}
	return d
}

func usedPct(path string) (float64, uint64, uint64, error) {
	var fs unix.Statfs_t
	if err := unix.Statfs(path, &fs); err != nil {
		return 0, 0, 0, err
	}
	total := fs.Blocks * uint64(fs.Bsize)
	free := fs.Bavail * uint64(fs.Bsize)
	if total == 0 {
		return 0, 0, 0, fmt.Errorf("statfs %s reports 0 blocks", path)
	}
	return 100 * float64(total-free) / float64(total), total, free, nil
}

func dirSize(root string) int64 {
	var n int64
	filepath.WalkDir(root, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if info, err := d.Info(); err == nil {
				n += info.Size()
			}
		}
		return nil
	})
	return n
}

type diskFS struct {
	path  string
	pct   float64
	total uint64
	free  uint64
}

func (s *Station) diskThresholds() (warn, crit int) {
	warn, crit = 80, 90
	if s.plan != nil {
		if v := s.plan.Generation.Station.Settings.DiskWarningPct; v > 0 {
			warn = v
		}
		if v := s.plan.Generation.Station.Settings.DiskCriticalPct; v > 0 {
			crit = v
		}
	}
	return warn, crit
}

func (s *Station) diskBreakdown() map[string]int64 {
	breakdown := map[string]int64{"logs": dirSize(filepath.Join(s.opts.StateDir, "logs")), "backups": dirSize(s.backupRoot())}
	for name, size := range s.volumeSizes {
		switch {
		case name == docker.DepotVolume:
			breakdown["depot"] += size
		case strings.HasPrefix(name, "or-workshop-") || strings.HasPrefix(name, "or-railpack-"):
			breakdown["build_cache"] += size
		case strings.HasPrefix(name, "or-"):
			breakdown["platform"] += size
		default:
			breakdown["volumes"] += size
		}
	}
	return breakdown
}

func (s *Station) diskFilesystems() (found []diskFS, unreadable []error) {
	seen := map[string]bool{}
	for _, path := range []string{s.info.DockerRootDir, s.opts.StateDir, s.backupRoot()} {
		if path == "" {
			continue
		}
		var st unix.Stat_t
		probe := path
		for {
			if unix.Stat(probe, &st) == nil {
				break
			}
			probe = filepath.Dir(probe)
		}
		key := strconv.FormatUint(uint64(st.Dev), 10)
		if seen[key] {
			continue
		}
		seen[key] = true
		pct, total, free, err := usedPct(probe)
		if err != nil {
			unreadable = append(unreadable, err)
			continue
		}
		found = append(found, diskFS{path: path, pct: pct, total: total, free: free})
	}
	return found, unreadable
}

func (s *Station) checkDisk(ctx context.Context) protocol.DoctorCheck {
	c := newCheck("disk")
	warn, crit := s.diskThresholds()
	c.detail["warning_pct"], c.detail["critical_pct"] = warn, crit
	c.detail["breakdown_bytes"] = s.diskBreakdown()
	found, unreadable := s.diskFilesystems()
	for _, err := range unreadable {
		c.raise(protocol.DoctorStatusWarn, "disk_unreadable", err.Error(), "")
	}
	for _, fsys := range found {
		c.detail[fsys.path] = map[string]any{"used_pct": int(fsys.pct + 0.5), "total_bytes": fsys.total, "free_bytes": fsys.free}
		line := fmt.Sprintf("%s %.0f%% used (%s free)", fsys.path, fsys.pct, human(fsys.free))
		switch {
		case fsys.pct >= float64(crit):
			c.raise(protocol.DoctorStatusFail, "disk_critical", line+fmt.Sprintf(", at or above disk.critical_pct %d", crit), "Free space: sly platform doctor lists the breakdown; prune Depot (registry gc), build caches or logs, or raise disk.critical_pct.")
		case fsys.pct >= float64(warn):
			c.raise(protocol.DoctorStatusWarn, "disk_warning", line+fmt.Sprintf(", at or above disk.warning_pct %d", warn), "Free space before disk.critical_pct is reached, or raise disk.warning_pct.")
		default:
			c.note(line)
		}
	}
	return c.build()
}

func human(b uint64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := uint64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(b)/float64(div), "KMGTPE"[exp])
}

func isRuntimeSegment(name string) bool {
	for _, prefix := range []string{"runtime.", "coupler.", "guard."} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

func moduleAvailable(name string) bool {
	if _, err := os.Stat("/sys/module/" + name); err == nil {
		return true
	}
	return exec.Command("modprobe", "-n", name).Run() == nil
}

func (s *Station) checkKernel() protocol.DoctorCheck {
	c := newCheck("kernel_features")
	conn, err := nftables.New()
	if err == nil {
		_, err = conn.ListTables()
	}
	if err != nil {
		c.raise(protocol.DoctorStatusFail, "nftables_missing", "nftables over netlink fails: "+err.Error(), "Use a kernel with nf_tables (Ubuntu 22.04 and Debian 12 ship it).")
	} else {
		c.note("nftables")
	}
	nfq := moduleAvailable("nfnetlink_queue")
	wg := moduleAvailable("wireguard")
	c.detail["nfqueue"], c.detail["wireguard"] = nfq, wg
	c.note(fmt.Sprintf("nfqueue %t (phase 1b), wireguard %t (phase 2)", nfq, wg))
	return c.build()
}

func (s *Station) checkLogStore() protocol.DoctorCheck {
	c := newCheck("log_store")
	r := s.retention()
	root := filepath.Join(s.opts.StateDir, logDir)
	services, _ := os.ReadDir(root)
	total := int64(0)
	for _, svc := range services {
		if !svc.IsDir() {
			continue
		}
		var runtime int64
		filepath.WalkDir(filepath.Join(root, svc.Name()), func(path string, d fs.DirEntry, err error) error {
			if err == nil && !d.IsDir() && isRuntimeSegment(d.Name()) {
				if info, err := d.Info(); err == nil {
					runtime += info.Size()
				}
			}
			return nil
		})
		total += dirSize(filepath.Join(root, svc.Name()))
		if runtime > r.RuntimeBytesService+r.RuntimeBytesService/10 {
			c.raise(protocol.DoctorStatusWarn, "log_store_over_budget", fmt.Sprintf("%s holds %s of runtime logs, over logs.retention.runtime_bytes_per_service %s", svc.Name(), human(uint64(runtime)), human(uint64(r.RuntimeBytesService))), "stationd's retention sweep runs every few minutes; check its log lines if this stays.")
		}
	}
	c.detail["bytes"] = total
	c.note(fmt.Sprintf("%s in %s", human(uint64(total)), root))
	return c.build()
}

func daemonConfig() (map[string]any, error) {
	b, err := os.ReadFile(daemonJSON)
	if err != nil {
		return nil, err
	}
	var cfg map[string]any
	return cfg, json.Unmarshal(b, &cfg)
}

func (s *Station) checkFirewallBackend() protocol.DoctorCheck {
	c := newCheck("firewall_backend")
	cfg, err := daemonConfig()
	if err != nil {
		c.raise(protocol.DoctorStatusFail, "daemon_json_unreadable", daemonJSON+": "+err.Error(), "Run the installer again; it writes daemon.json.")
		return c.build()
	}
	backend, _ := cfg["firewall-backend"].(string)
	if backend == "" {
		backend = "iptables (default)"
	}
	c.detail["firewall_backend"] = backend
	if backend == "nftables" {
		c.raise(protocol.DoctorStatusFail, "firewall_backend_nftables", "daemon.json sets firewall-backend nftables", "Set \"firewall-backend\": \"iptables\" in "+daemonJSON+" and reboot before any workload runs (a live switch breaks container egress).")
		return c.build()
	}
	c.note("firewall-backend " + backend)
	return c.build()
}

func raiseMarkAccept(c *checkBuilder, state netns.MarkAcceptState, err error) {
	rule := strings.Join(netns.MarkAcceptRule(), " ")
	c.detail["chain"] = netns.DockerUserChain
	c.detail["rule"] = rule
	switch {
	case err != nil:
		c.raise(protocol.DoctorStatusFail, "mark_accept_unchecked", "read "+netns.DockerUserChain+": "+err.Error(), "Check that iptables works as root: iptables -S "+netns.DockerUserChain+".")
	case state == netns.MarkAcceptChainMissing:
		c.raise(protocol.DoctorStatusFail, "docker_user_chain_missing", "the iptables chain "+netns.DockerUserChain+" does not exist, so nothing accepts the flows stationd translates (public 80 and 443, Gateway to service)", "Start Docker, which creates the chain; stationd then adds its accept at its next reconcile (30 s).")
	case state == netns.MarkAcceptAbsent:
		c.raise(protocol.DoctorStatusFail, "mark_accept_missing", "stationd's accept of translated flows is not in "+netns.DockerUserChain+", so Docker drops public 80 and 443, port allocations and Gateway flows to services", "stationd re-adds it at the end of its next reconcile (30 s); if it stays missing, restart stationd, or run: iptables -I "+netns.DockerUserChain+" 1 "+rule+".")
	default:
		c.note(netns.DockerUserChain + " accepts translated flows")
	}
}

func (s *Station) checkMarkAccept() protocol.DoctorCheck {
	c := newCheck("mark_accept")
	if cfg, err := daemonConfig(); err == nil {
		if backend, _ := cfg["firewall-backend"].(string); backend == "nftables" {
			c.note("firewall-backend nftables: Docker writes the accept per network")
			return c.build()
		}
	}
	if s.plan == nil {
		c.note("no Gateway planned, nothing is translated")
		return c.build()
	}
	state, err := netns.MarkAcceptStatus()
	raiseMarkAccept(c, state, err)
	return c.build()
}

func (s *Station) checkWorkshopIsolation() protocol.DoctorCheck {
	c := newCheck("workshop_isolation")
	v, _ := sysctl("user.max_user_namespaces")
	c.detail["user.max_user_namespaces"] = v
	if v == "" || v == "0" {
		c.raise(protocol.DoctorStatusFail, "user_namespaces_disabled", "user.max_user_namespaces is "+v, "sysctl -w user.max_user_namespaces=15000 and persist it in /etc/sysctl.d/")
	}
	if v, ok := sysctl("kernel.unprivileged_userns_clone"); ok {
		c.detail["kernel.unprivileged_userns_clone"] = v
		if v != "1" {
			c.raise(protocol.DoctorStatusFail, "unprivileged_userns_clone_off", "kernel.unprivileged_userns_clone is "+v, "sysctl -w kernel.unprivileged_userns_clone=1 and persist it in /etc/sysctl.d/")
		}
	}
	if workshop.AppArmorEnabled() {
		_, abi := workshop.ProfileBody()
		c.detail["apparmor"] = abi
		if !workshop.ParserInstalled() {
			c.raise(protocol.DoctorStatusFail, "apparmor_parser_missing", "AppArmor is enabled in the kernel but apparmor_parser is not installed, so the "+docker.WorkshopAppArmorProfile+" profile cannot load and every build fails", "apt-get install apparmor, then restart stationd")
		} else if !workshop.ProfileLoaded() {
			c.raise(protocol.DoctorStatusFail, "apparmor_profile_missing", "AppArmor is enabled and the "+docker.WorkshopAppArmorProfile+" profile is not loaded", "Restart stationd, which loads the profile ("+abi+" body), or apparmor_parser -r /etc/apparmor.d/"+docker.WorkshopAppArmorProfile)
		} else {
			c.note("AppArmor profile " + docker.WorkshopAppArmorProfile + " loaded (" + abi + ")")
		}
	}
	if s.plan != nil {
		ids := sortedKeys(s.plan.Generation.Workshops)
		c.detail["workshops"] = len(ids)
		for _, id := range ids {
			ws := s.plan.Generation.Workshops[id]
			overlaps, err := workshop.HostOverlaps(ws.UidBase)
			if err != nil {
				c.raise(protocol.DoctorStatusWarn, "uid_range_unreadable", err.Error(), "")
				continue
			}
			if len(overlaps) > 0 {
				var entries []string
				for _, o := range overlaps {
					entries = append(entries, o.Source+" "+o.Entry)
				}
				c.raise(protocol.DoctorStatusFail, "uid_range_overlap", fmt.Sprintf("project %s Workshop range %d-%d overlaps %s", id, ws.UidBase, ws.UidBase+65535, strings.Join(entries, ", ")), "Remove or move the overlapping host account or subordinate id range; Workshop uids must not map to a host account.")
			}
		}
		if len(ids) > 0 {
			c.note(fmt.Sprintf("%d Workshop range(s) clear of /etc/passwd, /etc/subuid and /etc/subgid", len(ids)))
		}
	}
	return c.build()
}

func (s *Station) checkHostPrerequisites(ctx context.Context) protocol.DoctorCheck {
	c := newCheck("host_prerequisites")
	if p, err := exec.LookPath("git"); err != nil {
		c.raise(protocol.DoctorStatusFail, "git_missing", "git is not on PATH; stationd clones repository sources with the host's git", "apt-get install git")
	} else {
		c.note("git " + p)
	}
	if fwd, _ := sysctl("net.ipv4.ip_forward"); fwd != "1" {
		c.raise(protocol.DoctorStatusFail, "ip_forward_off", "net.ipv4.ip_forward is "+fwd, "sysctl -w net.ipv4.ip_forward=1 (the installer writes "+DefaultSysctlFile+")")
	}
	cfg, err := daemonConfig()
	if err != nil {
		c.raise(protocol.DoctorStatusFail, "daemon_json_unreadable", daemonJSON+": "+err.Error(), "Run the installer again; it writes daemon.json.")
		return c.build()
	}
	if live, _ := cfg["live-restore"].(bool); !live {
		c.raise(protocol.DoctorStatusFail, "live_restore_off", "daemon.json does not set live-restore true", "Set \"live-restore\": true in "+daemonJSON+" before any container runs and restart Docker.")
	}
	mark, markOK := bridgeAcceptFwmark(daemonJSON)
	if !markOK {
		c.raise(protocol.DoctorStatusFail, "bridge_accept_fwmark", "bridge-accept-fwmark: "+mark, "Set \"bridge-accept-fwmark\": \"0x10000/0x10000\" in "+daemonJSON+" and restart Docker (an install-time step).")
	}
	if s.registryAddr != "" {
		info, err := s.docker.Info(ctx)
		if err == nil {
			if ok, _ := InsecureRegistryListed(info.Info.RegistryConfig, s.registryAddr); !ok {
				c.raise(protocol.DoctorStatusFail, "insecure_registry_missing", "insecure-registries does not list Depot at "+s.registryAddr, "Add "+s.registryAddr+" to insecure-registries in "+daemonJSON+" and run systemctl reload docker.")
			}
		}
	}
	c.note("ip_forward, live-restore, bridge-accept-fwmark and Depot's insecure-registries entry in place")
	return c.build()
}

func (s *Station) checkNftTables() protocol.DoctorCheck {
	c := newCheck("nft_tables")
	conn, err := nftables.New()
	if err != nil {
		c.raise(protocol.DoctorStatusFail, "nftables_missing", err.Error(), "")
		return c.build()
	}
	want := []struct {
		family nftables.TableFamily
		label  string
		name   string
		needed bool
	}{
		{nftables.TableFamilyINet, "inet", netns.HostTableName, s.plan != nil},
		{nftables.TableFamilyBridge, "bridge", depot.FirewallTable, func() bool { st, _ := s.depot.State(); return st != protocol.RegistryStateDown }()},
	}
	var present []string
	for _, w := range want {
		if !w.needed {
			continue
		}
		if _, err := conn.ListTableOfFamily(w.name, w.family); err != nil {
			c.raise(protocol.DoctorStatusFail, "nft_table_missing", fmt.Sprintf("table %s %s is missing", w.label, w.name), "stationd re-creates it at its next full reconcile (30 s); if it stays missing, restart stationd and look for what deletes it (nft list ruleset)")
			continue
		}
		present = append(present, w.label+" "+w.name)
	}
	c.detail["present"] = present
	if len(present) > 0 {
		c.note("present: " + strings.Join(present, ", "))
	}
	return c.build()
}

func (s *Station) expectedListeners() map[netip.Addr]string {
	want := map[netip.Addr]string{}
	if s.plan != nil {
		for _, envID := range sortedKeys(s.plan.Generation.Environments) {
			if st := s.envs[envID]; st != nil && st.networkID != "" && st.failure == nil {
				want[s.envNet(envID).gateway] = "environment " + envID
			}
		}
		if gp := s.plan.Gateway; gp != nil && gp.Run && s.gw.ingressID != "" {
			want[gp.Bridge] = "ingress"
		}
	}
	if st, _ := s.depot.State(); st != protocol.RegistryStateDown {
		want[s.depot.Settings().Front.Addr()] = "Depot front"
	}
	if s.system.id != "" && s.system.failure == "" {
		want[s.system.hostAddr.Addr()] = "host listener"
	}
	return want
}

func (s *Station) checkResolver(ctx context.Context) protocol.DoctorCheck {
	c := newCheck("resolver")
	c.detail["upstream"] = s.resolver.Upstream()
	bound := map[netip.Addr]bool{}
	for _, a := range s.resolver.Listening() {
		bound[a] = true
	}
	want := s.expectedListeners()
	var missing, listening []string
	for a, what := range want {
		if bound[a] {
			listening = append(listening, a.String()+" ("+what+")")
		} else {
			missing = append(missing, a.String()+" ("+what+")")
		}
	}
	sort.Strings(listening)
	sort.Strings(missing)
	c.detail["listening"] = listening
	if len(missing) > 0 {
		c.raise(protocol.DoctorStatusFail, "resolver_listener_down", "not listening on "+strings.Join(missing, ", "), "Check stationd's \"resolver listen\" log lines; another process may hold port 53 on that address.")
	}
	if s.system.failure != "" {
		c.raise(protocol.DoctorStatusFail, "resolver_host_listener", s.system.failure, "Fix stationd.resolver_host_address in host.toml or the system network, then restart stationd.")
	} else if s.system.id == "" {
		c.raise(protocol.DoctorStatusWarn, "resolver_host_unconfigured", "no host listener: Dispatch's lookups have no resolver", "Run the installer, which writes stationd.resolver_host_address into host.toml.")
	} else {
		addr, stats := s.resolver.Host()
		m := new(mdns.Msg)
		m.SetQuestion("doctor-probe.internal.", mdns.TypeA)
		cl := &mdns.Client{Net: "udp", Timeout: 2 * time.Second}
		resp, rtt, err := cl.ExchangeContext(ctx, m, netip.AddrPortFrom(addr, resolverPort).String())
		c.detail["host_listener"] = map[string]any{"address": s.system.hostAddr.String(), "queries": stats.Queries.Load(), "forwarded": stats.Forwarded.Load(), "refused": stats.Refused.Load(), "failed": stats.Failed.Load()}
		switch {
		case err != nil:
			c.raise(protocol.DoctorStatusFail, "resolver_host_listener", "the host listener at "+s.system.hostAddr.String()+" did not answer: "+err.Error(), "Restart stationd.")
		case resp.Rcode != mdns.RcodeRefused:
			c.raise(protocol.DoctorStatusFail, "resolver_host_listener", "the host listener answered a .internal probe with "+mdns.RcodeToString[resp.Rcode]+", not REFUSED", "Restart stationd.")
		default:
			c.note(fmt.Sprintf("host listener %s answers (probe %d µs; %d queries, %d forwarded)", s.system.hostAddr, rtt.Microseconds(), stats.Queries.Load(), stats.Forwarded.Load()))
		}
	}
	c.note(fmt.Sprintf("%d listener(s), upstream %s", len(listening), s.resolver.Upstream()))
	return c.build()
}

func (s *Station) checkLockfileMirror() protocol.DoctorCheck {
	c := newCheck("lockfile_mirror")
	path := filepath.Join(s.opts.EtcDir, "platform.lock.json")
	c.detail["path"] = path
	if s.plan == nil || s.plan.Generation.Station.Settings.PlatformLockfile == nil {
		c.note("no lockfile yet (sly setup writes it)")
		return c.build()
	}
	want, ok := s.lockMirror(s.plan.Generation)
	if !ok {
		c.raise(protocol.DoctorStatusWarn, "lockfile_unmirrorable", "the generation's platform.lockfile does not match schema 2", "")
		return c.build()
	}
	have, err := os.ReadFile(path)
	switch {
	case err != nil:
		c.raise(protocol.DoctorStatusFail, "lockfile_mirror_missing", path+": "+err.Error(), "stationd rewrites it at its next full reconcile (30 s).")
	case !sameMirror(have, want):
		c.raise(protocol.DoctorStatusFail, "lockfile_mirror_tampered", path+" differs from the lockfile stationd mirrored; stationd is its only writer", "stationd rewrites it at its next full reconcile (30 s); find what edited it. The platform.lockfile setting in Dispatch is the source of truth.")
	default:
		c.note(path + " matches the lockfile")
	}
	return c.build()
}

func bridgeAcceptFwmark(path string) (string, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return err.Error() + "; DNAT'd 80, 443, port allocations and Gateway flows are dropped by Docker without it", false
	}
	var cfg struct {
		Mark string `json:"bridge-accept-fwmark"`
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		return "parse " + path + ": " + err.Error(), false
	}
	if cfg.Mark == "" {
		return "absent", false
	}
	value, maskText, hasMask := strings.Cut(cfg.Mark, "/")
	v, err1 := strconv.ParseUint(value, 0, 32)
	m := uint64(0xffffffff)
	var err2 error
	if hasMask {
		m, err2 = strconv.ParseUint(maskText, 0, 32)
	}
	if err1 != nil || err2 != nil {
		return "cannot parse " + cfg.Mark, false
	}
	return cfg.Mark, v&m == netns.AcceptMark&m && m&netns.AcceptMark != 0
}
