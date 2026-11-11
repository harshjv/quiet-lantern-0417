//go:build linux

package deploy

import (
	"maps"
	"net/netip"
	"regexp"
	"slices"
	"time"

	"github.com/harshjv/stationly/go/internal/dns"
	"github.com/harshjv/stationly/go/internal/protocol"
)

var (
	digestRefPattern = regexp.MustCompile(`^[a-z0-9.\-]+(:[0-9]+)?(/[a-z0-9._\-]+)+@sha256:[a-f0-9]{64}$`)
	sandboxIDPattern = regexp.MustCompile(`^sb[xs]_[0-9A-Za-z]{6,40}$`)
)

type sbxAction int

const (
	sbxNothing sbxAction = iota
	sbxMakeDisk
	sbxStart
	sbxStop
	sbxDestroy
	sbxReportStopped
)

type sbxFacts struct {
	desired     protocol.DesiredSandbox
	diskReady   bool
	running     bool
	status      protocol.SandboxReportStatus
	heldHash    string
	everStarted bool
	wasRunning  bool
}

type sbxDecision struct {
	action sbxAction
	reason *protocol.SandboxStatusReason
}

func reasonOf(r protocol.SandboxStatusReason) *protocol.SandboxStatusReason { return &r }

func stopAtOf(d protocol.DesiredSandbox) (time.Time, bool) {
	if d.StopAt == nil {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339Nano, *d.StopAt)
	return t, err == nil
}

func wantsRun(d protocol.DesiredSandbox, now time.Time) bool {
	if d.Status != protocol.DesiredSandboxStatusActive || d.DesiredState != protocol.DesiredStateRunning {
		return false
	}
	if d.StopAt == nil {
		return true
	}
	at, ok := stopAtOf(d)
	return ok && now.Before(at)
}

func decideSandbox(f sbxFacts, now time.Time) sbxDecision {
	d := f.desired
	if d.Status == protocol.DesiredSandboxStatusDestroy {
		if f.running {
			return sbxDecision{action: sbxStop, reason: reasonOf(protocol.SandboxStatusReasonUser)}
		}
		return sbxDecision{action: sbxDestroy}
	}
	if !f.diskReady {
		return sbxDecision{action: sbxMakeDisk}
	}
	want := wantsRun(d, now)
	stopReason := reasonOf(protocol.SandboxStatusReasonUser)
	if d.DesiredState == protocol.DesiredStateRunning {
		stopReason = reasonOf(protocol.SandboxStatusReasonTtl)
	}
	switch {
	case f.running && !want:
		return sbxDecision{action: sbxStop, reason: stopReason}
	case f.running:
		return sbxDecision{}
	case want && f.heldHash != d.Hash:
		if f.wasRunning {
			return sbxDecision{action: sbxStart, reason: reasonOf(protocol.SandboxStatusReasonStationRestart)}
		}
		return sbxDecision{action: sbxStart}
	case !want && f.status != protocol.SandboxReportStatusStopped && f.status != protocol.SandboxReportStatusFailed:
		if !f.everStarted {
			return sbxDecision{action: sbxReportStopped, reason: reasonOf(protocol.SandboxStatusReasonCreatedStopped)}
		}
		return sbxDecision{action: sbxReportStopped, reason: stopReason}
	}
	return sbxDecision{}
}

func checkSandboxes(g *protocol.Generation, pool netip.Prefix, taken map[string]netip.Prefix, held func(kind, id string) bool) *Rejection {
	invalid := func(format string, args ...any) *Rejection {
		return reject(protocol.ErrorCodeGenerationInvalid, "Fix the generation and send it again.", format, args...)
	}
	isolated := false
	for _, id := range slices.Sorted(maps.Keys(g.Sandboxes)) {
		sb := g.Sandboxes[id]
		if !sandboxIDPattern.MatchString(id) || id[:4] != "sbx_" {
			return invalid("sandbox key %q is not a sandbox id", id)
		}
		if sb.Status == protocol.DesiredSandboxStatusDestroy {
			continue
		}
		if sb.Network == protocol.SandboxNetworkEnvironment {
			if _, ok := g.Environments[sb.EnvironmentId]; !ok {
				return invalid("sandbox %s joins environment %s, which the generation does not contain", id, sb.EnvironmentId)
			}
		} else {
			isolated = true
		}
		if !digestRefPattern.MatchString(sb.Image.ImageRef) {
			return invalid("sandbox %s image_ref %q is not a digest reference", id, sb.Image.ImageRef)
		}
		if sb.Size.CpuMillis <= 0 || sb.Size.MemoryBytes <= 0 || sb.Size.DiskBytes <= 0 {
			return invalid("sandbox %s size must be positive in cpu_millis, memory_bytes and disk_bytes", id)
		}
		if sb.Egress.Mode != protocol.SandboxEgressModeOpen && sb.Egress.Mode != protocol.SandboxEgressModeAllowlist {
			return invalid("sandbox %s egress mode %q", id, sb.Egress.Mode)
		}
		if _, err := dns.ParseDomains(allowDomains(sb.Egress)); err != nil {
			return invalid("sandbox %s egress: %v", id, err)
		}
		if f := sb.Disk.From; f != nil && !held("sandbox", id) {
			switch {
			case f.SnapshotId != nil && f.SandboxId != nil:
				return invalid("sandbox %s disk.from names both a snapshot and a sandbox", id)
			case f.SnapshotId != nil:
				if _, ok := g.SandboxSnapshots[*f.SnapshotId]; !ok && !held("snapshot", *f.SnapshotId) {
					return invalid("sandbox %s forks snapshot %s, which is not on this station", id, *f.SnapshotId)
				}
			case f.SandboxId != nil:
				if _, ok := g.Sandboxes[*f.SandboxId]; !ok && !held("sandbox", *f.SandboxId) {
					return invalid("sandbox %s forks sandbox %s, which is not on this station", id, *f.SandboxId)
				}
			}
		}
	}
	for _, id := range slices.Sorted(maps.Keys(g.SandboxSnapshots)) {
		snap := g.SandboxSnapshots[id]
		if !sandboxIDPattern.MatchString(id) || id[:4] != "sbs_" {
			return invalid("snapshot key %q is not a snapshot id", id)
		}
		if _, ok := g.Sandboxes[snap.SandboxId]; !ok && !held("sandbox", snap.SandboxId) && !held("snapshot", id) {
			return invalid("snapshot %s names sandbox %s, which is neither in the generation nor on this station", id, snap.SandboxId)
		}
	}
	n := g.Station.SandboxNetwork
	if n == nil {
		if isolated {
			return invalid("an isolated sandbox needs station.sandbox_network")
		}
		return nil
	}
	subnet, err := netip.ParsePrefix(n.Subnet)
	if err != nil {
		return invalid("sandbox_network subnet %q: %v", n.Subnet, err)
	}
	gateway, err := netip.ParseAddr(n.Gateway)
	if err != nil || !subnet.Contains(gateway) {
		return invalid("sandbox_network gateway %q is not inside %s", n.Gateway, subnet)
	}
	if !pool.Contains(subnet.Addr()) || subnet.Bits() < pool.Bits() {
		return invalid("sandbox_network subnet %s lies outside ipam.pool %s", subnet, pool)
	}
	for name, p := range taken {
		if p.Overlaps(subnet) {
			return invalid("sandbox_network subnet %s overlaps %s %s", subnet, name, p)
		}
	}
	if !dockerNamePattern.MatchString(n.BridgeName) {
		return invalid("sandbox_network bridge_name %q is not a valid Docker network name", n.BridgeName)
	}
	return nil
}

func allowDomains(e protocol.SandboxEgress) []dns.AllowDomain {
	out := make([]dns.AllowDomain, 0, len(e.Domains))
	for _, d := range e.Domains {
		ports := make([]uint16, 0, len(d.Ports))
		for _, p := range d.Ports {
			if p > 0 && p < 65536 {
				ports = append(ports, uint16(p))
			}
		}
		out = append(out, dns.AllowDomain{Domain: d.Domain, Wildcard: d.Wildcard, Ports: ports})
	}
	return out
}

func allowPorts(domains []dns.AllowDomain) []uint16 {
	seen := map[uint16]bool{}
	for _, d := range domains {
		for _, p := range d.Ports {
			seen[p] = true
		}
	}
	return slices.Sorted(maps.Keys(seen))
}
