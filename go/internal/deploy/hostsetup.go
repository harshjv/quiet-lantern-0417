//go:build linux

package deploy

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"time"

	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/hostconfig"
	"github.com/harshjv/stationly/go/internal/identity"
	"github.com/harshjv/stationly/go/internal/ids"
)

const (
	DefaultPool         = "10.200.0.0/16"
	DefaultDispatchURL  = "http://127.0.0.1:7900"
	DefaultDaemonJSON   = "/etc/docker/daemon.json"
	DefaultSysctlFile   = "/etc/sysctl.d/90-stationly.conf"
	installStateFile    = "install.json"
	bootstrapTokenFile  = "bootstrap.token"
	registryIndex       = 3
	registryHost        = 2
	registryPort        = 5000
	resolverPort        = 53
	bootstrapTokenLabel = "sly-enroll-"
)

type InstallState struct {
	StationID           string `json:"station_id"`
	IpamPool            string `json:"ipam_pool"`
	SystemSubnet        string `json:"system_subnet"`
	IngressSubnet       string `json:"ingress_subnet"`
	RegistrySubnet      string `json:"registry_subnet"`
	RegistryAddress     string `json:"registry_address"`
	ResolverHostAddress string `json:"resolver_host_address"`
	InstalledAt         string `json:"installed_at"`
}

func installStatePath(stateDir string) string { return filepath.Join(stateDir, installStateFile) }

func BootstrapTokenPath(stateDir string) string { return filepath.Join(stateDir, bootstrapTokenFile) }

func LoadInstallState(stateDir string) (*InstallState, error) {
	b, err := os.ReadFile(installStatePath(stateDir))
	if err != nil {
		return nil, err
	}
	var st InstallState
	if err := json.Unmarshal(b, &st); err != nil {
		return nil, fmt.Errorf("%s: %w", installStatePath(stateDir), err)
	}
	return &st, nil
}

func slash24(pool netip.Prefix, index int) netip.Prefix {
	b := pool.Masked().Addr().As4()
	b[2] += byte(index)
	return netip.PrefixFrom(netip.AddrFrom4(b), 24)
}

func hostAt(p netip.Prefix, n int) netip.Addr {
	b := p.Masked().Addr().As4()
	b[3] = byte(n)
	return netip.AddrFrom4(b)
}

func hostPrefixesInUse() ([]netip.Prefix, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	var out []netip.Prefix
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			if n, ok := a.(*net.IPNet); ok {
				if p, err := netip.ParsePrefix(n.String()); err == nil && p.Addr().Is4() {
					out = append(out, p.Masked())
				}
			}
		}
	}
	return out, nil
}

func ChoosePool(inUse []netip.Prefix) (netip.Prefix, error) {
	for second := 200; second < 256; second++ {
		candidate := netip.PrefixFrom(netip.AddrFrom4([4]byte{10, byte(second), 0, 0}), 16)
		clash := false
		for _, p := range inUse {
			if candidate.Overlaps(p) {
				clash = true
				break
			}
		}
		if !clash {
			return candidate, nil
		}
	}
	return netip.Prefix{}, errors.New("every 10.x.0.0/16 from 10.200 to 10.255 overlaps a host interface")
}

func NewInstallState(pool netip.Prefix) InstallState {
	system, ingress, registry := slash24(pool, 0), slash24(pool, 1), slash24(pool, registryIndex)
	return InstallState{
		StationID:           ids.New("stn"),
		IpamPool:            pool.String(),
		SystemSubnet:        system.String(),
		IngressSubnet:       ingress.String(),
		RegistrySubnet:      registry.String(),
		RegistryAddress:     netip.AddrPortFrom(hostAt(registry, registryHost), registryPort).String(),
		ResolverHostAddress: netip.AddrPortFrom(hostAt(system, 1), resolverPort).String(),
		InstalledAt:         time.Now().UTC().Format(time.RFC3339),
	}
}

func writePrivate(path string, b []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func newBootstrapToken() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return bootstrapTokenLabel + base64.RawURLEncoding.EncodeToString(b), nil
}

type hostSetup struct {
	state      InstallState
	host       *hostconfig.Config
	daemonJSON string
	restarted  bool
	tokenNew   bool
}

func prepareHost(ctx context.Context, opts InstallOptions, insecure []string, step func(name, detail, result string, t time.Time)) (*hostSetup, error) {
	t := time.Now()
	gitPath, err := exec.LookPath("git")
	if err != nil {
		step("prerequisites", "git is not on PATH; stationd clones repository sources with the host's git", "refused", t)
		return nil, fmt.Errorf("git is a host prerequisite: install it (apt-get install git) and run the installer again")
	}
	step("prerequisites", "git "+gitPath, "ok", t)

	t = time.Now()
	hs := &hostSetup{}
	if st, err := LoadInstallState(opts.StateDir); err == nil {
		hs.state = *st
		step("ipam", "kept "+st.IpamPool+" from "+installStatePath(opts.StateDir), "ok", t)
	} else {
		inUse, err := hostPrefixesInUse()
		if err != nil {
			return nil, fmt.Errorf("list host interfaces: %w", err)
		}
		pool, err := ChoosePool(inUse)
		if err != nil {
			return nil, err
		}
		hs.state = NewInstallState(pool)
		b, _ := json.MarshalIndent(hs.state, "", "  ")
		if err := writePrivate(installStatePath(opts.StateDir), append(b, '\n')); err != nil {
			return nil, err
		}
		step("ipam", fmt.Sprintf("pool %s, registry %s, resolver host listener %s (%d host prefixes checked)", hs.state.IpamPool, hs.state.RegistryAddress, hs.state.ResolverHostAddress, len(inUse)), "ok", t)
	}

	t = time.Now()
	host, err := hostconfig.Load(opts.EtcDir)
	switch {
	case err == nil && (opts.Litestream != nil || opts.RecoveryKey != ""):
		return nil, fmt.Errorf("%s already exists; a restore installs on a host that has no Stationly state", hostconfig.Path(opts.EtcDir))
	case err == nil:
		step("host_config", "kept "+hostconfig.Path(opts.EtcDir), "ok", t)
	case errors.Is(err, os.ErrNotExist):
		key, keyOrigin := "", "a generated master key"
		if opts.RecoveryKey != "" {
			if key, err = hostconfig.MasterKeyFromRecovery(opts.RecoveryKey); err != nil {
				return nil, err
			}
			keyOrigin = "the master key from the recovery key"
		} else if key, err = hostconfig.NewMasterKey(); err != nil {
			return nil, err
		}
		host = &hostconfig.Config{
			Dispatch: hostconfig.Dispatch{URL: opts.DispatchURL, MasterKey: key},
			Stationd: hostconfig.Stationd{ResolverHostAddress: hs.state.ResolverHostAddress},
		}
		detail := "(dispatch.url, dispatch.master_key from " + keyOrigin + ", stationd.resolver_host_address"
		if opts.Litestream != nil {
			if err := opts.Litestream.Validate(); err != nil {
				return nil, err
			}
			host.Litestream = *opts.Litestream
			detail += ", litestream.* for bucket " + opts.Litestream.Bucket + "; stationd restores Dispatch's database from it before Dispatch starts"
		}
		if err := hostconfig.Save(opts.EtcDir, host); err != nil {
			return nil, err
		}
		step("host_config", "wrote "+hostconfig.Path(opts.EtcDir)+" "+detail+")", "ok", t)
	default:
		return nil, err
	}
	hs.host = host

	t = time.Now()
	switch {
	case identity.Exists(opts.StateDir):
		step("bootstrap_token", "the station is already enrolled", "skipped", t)
	case fileExists(BootstrapTokenPath(opts.StateDir)):
		step("bootstrap_token", "kept "+BootstrapTokenPath(opts.StateDir), "ok", t)
	default:
		tok, err := newBootstrapToken()
		if err != nil {
			return nil, err
		}
		if err := writePrivate(BootstrapTokenPath(opts.StateDir), []byte(tok+"\n")); err != nil {
			return nil, err
		}
		hs.tokenNew = true
		step("bootstrap_token", "wrote "+BootstrapTokenPath(opts.StateDir)+" (0600); Dispatch receives only its SHA-256", "ok", t)
	}

	t = time.Now()
	if err := writeSysctl(opts.SysctlFile); err != nil {
		return nil, err
	}
	step("sysctl", opts.SysctlFile+": net.ipv4.ip_forward=1", "ok", t)

	t = time.Now()
	changed, err := writeDaemonJSON(opts.DaemonJSON, hs.state, insecure)
	if err != nil {
		return nil, err
	}
	hs.daemonJSON = opts.DaemonJSON
	if !changed {
		step("daemon_json", opts.DaemonJSON+" already matches", "unchanged", t)
		return hs, nil
	}
	if err := restartDocker(ctx); err != nil {
		step("daemon_json", err.Error(), "failed", t)
		return nil, err
	}
	hs.restarted = true
	step("daemon_json", fmt.Sprintf("wrote %s (insecure-registries %v, default-address-pools %s) and restarted Docker", opts.DaemonJSON, append([]string{hs.state.RegistryAddress}, insecure...), hs.state.IpamPool), "written", t)
	return hs, nil
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func writeSysctl(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte("net.ipv4.ip_forward = 1\n"), 0o644); err != nil {
		return err
	}
	return os.WriteFile("/proc/sys/net/ipv4/ip_forward", []byte("1\n"), 0o644)
}

func DaemonConfig(st InstallState, insecure []string) map[string]any {
	registries := []string{st.RegistryAddress}
	for _, r := range insecure {
		if r != st.RegistryAddress {
			registries = append(registries, r)
		}
	}
	return map[string]any{
		"live-restore":          true,
		"features":              map[string]any{"cdi": true},
		"insecure-registries":   registries,
		"log-driver":            "local",
		"log-opts":              map[string]any{"max-size": "20m", "max-file": "5"},
		"firewall-backend":      "iptables",
		"bridge-accept-fwmark":  "0x10000/0x10000",
		"default-address-pools": []any{map[string]any{"base": st.IpamPool, "size": 24}},
		"userland-proxy":        false,
	}
}

func writeDaemonJSON(path string, st InstallState, insecure []string) (bool, error) {
	want := DaemonConfig(st, insecure)
	b, err := json.MarshalIndent(want, "", "  ")
	if err != nil {
		return false, err
	}
	if old, err := os.ReadFile(path); err == nil {
		var have, norm any
		if json.Unmarshal(old, &have) == nil && json.Unmarshal(b, &norm) == nil && reflect.DeepEqual(have, norm) {
			return false, nil
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return false, err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o644); err != nil {
		return false, err
	}
	return true, os.Rename(tmp, path)
}

func restartDocker(ctx context.Context) error {
	out, err := exec.CommandContext(ctx, "systemctl", "restart", "docker").CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl restart docker: %v: %s", err, strings.TrimSpace(string(out)))
	}
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		dc, err := docker.Connect(cctx)
		if err == nil {
			_, err = dc.Info(cctx)
			dc.Close()
		}
		cancel()
		if err == nil {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return errors.New("Docker did not answer within 60 s after the restart")
}

func DispatchEnv(stateDir, etcDir string) ([]string, error) {
	host, err := hostconfig.Load(etcDir)
	if err != nil {
		return nil, fmt.Errorf("read host.toml: %w", err)
	}
	env := []string{"STATIONLY_MASTER_KEY=" + host.Dispatch.MasterKey}
	if host.Stationd.ResolverHostAddress != "" {
		env = append(env, "STATIONLY_RESOLVER="+host.Stationd.ResolverHostAddress)
	}
	if raw, err := os.ReadFile(BootstrapTokenPath(stateDir)); err == nil && !identity.Exists(stateDir) {
		env = append(env, "STATIONLY_BOOTSTRAP_ENROLL_SHA256="+sha256Hex([]byte(strings.TrimSpace(string(raw)))))
	}
	return env, nil
}
