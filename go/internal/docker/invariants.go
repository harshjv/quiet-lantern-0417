package docker

import (
	"fmt"
	"github.com/harshjv/stationly/go/internal/protocol"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/api/types/network"
)

const (
	SecretsRoot   = "/run/stationly/secrets"
	SecretsTarget = "/run/secrets"
)

var dockerRuntimePaths = []string{
	"/var/run/docker.sock",
	"/run/docker.sock",
	"/var/run/docker",
	"/run/docker",
	"/run/containerd",
	"/var/lib/docker",
	"/var/lib/containerd",
}

type Violation struct {
	Container string
	Rule      string
	Detail    string
}

func (v *Violation) Error() string {
	return fmt.Sprintf("%s: %s: %s", v.Container, v.Rule, v.Detail)
}

func CheckInvariants(spec ContainerSpec, stateDir string) error {
	hc := spec.Create.HostConfig
	cfg := spec.Create.Config
	fail := func(rule, format string, args ...any) error {
		return &Violation{Container: spec.Name, Rule: rule, Detail: fmt.Sprintf(format, args...)}
	}
	if hc == nil || cfg == nil {
		return fail("complete spec", "config and host config are required")
	}
	if hc.Privileged {
		return fail("no privileged containers", "Privileged is true")
	}
	switch spec.Role {
	case RoleCoupler, RoleWorkshopCoupler, RoleGatewayCoupler, RoleDepot, RoleDispatch, RoleLitestream, RoleLitestreamTask:
		if !hc.NetworkMode.IsUserDefined() {
			return fail("no host network", "%s network mode %q is not a user-defined network", spec.Role, hc.NetworkMode)
		}
		if spec.Role != RoleDepot && spec.Role != RoleDispatch && len(hc.CapAdd) > 0 {
			return fail("capability allowlist", "Coupler adds capabilities %v", hc.CapAdd)
		}
	case RoleDepotGC, RoleDispatchCheck:
		if !hc.NetworkMode.IsNone() {
			return fail("no host network", "%s runs with network mode none, not %q", spec.Role, hc.NetworkMode)
		}
	default:
		if !hc.NetworkMode.IsContainer() || hc.NetworkMode.ConnectedContainer() != spec.Coupler {
			return fail("no host network", "network mode %q does not join Coupler %s", hc.NetworkMode, spec.Coupler)
		}
	}
	if hc.PublishAllPorts || (len(hc.PortBindings) > 0 && (spec.Role != RoleDispatch || !dispatchLoopbackOnly(hc.PortBindings))) {
		return fail("published ports", "only Dispatch publishes a port, %s:%d on the host loopback; 80, 443 and port allocations are DNAT in the host table", protocol.NetworkDispatchHostAddress, protocol.NetworkDispatchPort)
	}
	if !slices.Contains(hc.CapDrop, "ALL") {
		return fail("capability allowlist", "CapDrop does not contain ALL")
	}
	for _, c := range hc.CapAdd {
		name := strings.TrimPrefix(strings.ToUpper(c), "CAP_")
		if !slices.Contains(AppCapabilities, name) {
			return fail("capability allowlist", "capability %s is not on the allowlist", name)
		}
	}
	workshop := spec.Role == RoleWorkshop
	if !workshop && !slices.Contains(hc.SecurityOpt, "no-new-privileges") {
		return fail("no-new-privileges", "SecurityOpt lacks no-new-privileges")
	}
	if !workshop && (hc.MaskedPaths != nil || hc.ReadonlyPaths != nil) {
		return fail("default system paths", "MaskedPaths or ReadonlyPaths overridden")
	}
	for _, o := range hc.SecurityOpt {
		switch {
		case strings.HasPrefix(o, "seccomp") && strings.Contains(o, "unconfined") && !workshop:
			return fail("default seccomp", "SecurityOpt %q", o)
		case strings.HasPrefix(o, "apparmor") && o != "apparmor="+WorkshopAppArmorProfile:
			return fail("AppArmor profile", "SecurityOpt %q", o)
		case strings.HasPrefix(o, "apparmor") && !workshop:
			return fail("AppArmor profile", "only the Workshop runs under %s", WorkshopAppArmorProfile)
		}
	}
	if hc.Memory <= 0 || hc.NanoCPUs <= 0 {
		return fail("resource limits", "Memory %d and NanoCpus %d must both be set", hc.Memory, hc.NanoCPUs)
	}
	if hc.MemorySwap != hc.Memory {
		return fail("resource limits", "MemorySwap %d differs from Memory %d", hc.MemorySwap, hc.Memory)
	}
	if hc.CPUQuota != 0 || hc.CPUPeriod != 0 {
		return fail("resource limits", "CpuQuota or CpuPeriod set alongside NanoCpus")
	}
	if hc.RestartPolicy.Name != container.RestartPolicyDisabled {
		return fail("no restart policy", "RestartPolicy is %q", hc.RestartPolicy.Name)
	}
	if hc.LogConfig.Type != "local" || hc.LogConfig.Config["max-size"] == "" || hc.LogConfig.Config["max-file"] == "" {
		return fail("log driver", "LogConfig must be local with max-size and max-file")
	}
	if cfg.Labels[LabelStation] == "" || cfg.Labels[LabelRole] == "" {
		return fail("ownership labels", "stationly.station and stationly.role are required")
	}
	if len(hc.Binds) > 0 || len(hc.VolumesFrom) > 0 {
		return fail("no bind mounts", "Binds and VolumesFrom are never used")
	}
	for _, m := range hc.Mounts {
		if err := checkMount(m, stateDir); err != "" {
			return fail("no bind mounts", "%s", err)
		}
	}
	return nil
}

func checkMount(m mount.Mount, stateDir string) string {
	switch m.Type {
	case mount.TypeVolume:
		if m.VolumeOptions != nil && m.VolumeOptions.DriverConfig != nil && m.VolumeOptions.DriverConfig.Name != "local" {
			return fmt.Sprintf("volume %s uses driver %s", m.Source, m.VolumeOptions.DriverConfig.Name)
		}
		return ""
	case mount.TypeBind:
		src := filepath.Clean(m.Source)
		for _, p := range dockerRuntimePaths {
			if under(src, p) {
				return fmt.Sprintf("bind source %s is under the Docker runtime path %s", src, p)
			}
		}
		if under(src, SecretsRoot) && m.ReadOnly {
			return ""
		}
		if under(src, filepath.Clean(stateDir)) {
			return ""
		}
		return fmt.Sprintf("bind source %s is outside the carve-outs", src)
	case mount.TypeTmpfs:
		return ""
	default:
		return fmt.Sprintf("mount type %s is not allowed", m.Type)
	}
}

func under(path, root string) bool {
	return path == root || strings.HasPrefix(path, root+"/")
}

func dispatchLoopbackOnly(m network.PortMap) bool {
	if len(m) != 1 {
		return false
	}
	for port, bindings := range m {
		if port.Num() != protocol.NetworkDispatchPort || len(bindings) != 1 {
			return false
		}
		b := bindings[0]
		if b.HostIP.String() != protocol.NetworkDispatchHostAddress || b.HostPort != strconv.Itoa(protocol.NetworkDispatchPort) {
			return false
		}
	}
	return true
}
