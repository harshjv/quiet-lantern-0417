package runsc

import (
	"encoding/json"
	"errors"
	"strings"

	"github.com/harshjv/stationly/go/internal/sandbox"
)

const (
	ociVersion   = "1.2.1"
	nofileLimit  = 1048576
	pidsLimit    = 16384
	cpuPeriod    = 100000
	ScopeSlice   = "stationly-sandboxes.slice"
	scopePrefix  = "sbx"
	defaultCwd   = "/"
	rlimitNofile = "RLIMIT_NOFILE"
)

var capabilities = []string{
	"CAP_CHOWN",
	"CAP_DAC_OVERRIDE",
	"CAP_FSETID",
	"CAP_FOWNER",
	"CAP_MKNOD",
	"CAP_NET_RAW",
	"CAP_SETGID",
	"CAP_SETUID",
	"CAP_SETFCAP",
	"CAP_SETPCAP",
	"CAP_NET_BIND_SERVICE",
	"CAP_SYS_CHROOT",
	"CAP_KILL",
	"CAP_AUDIT_WRITE",
	"CAP_SYS_ADMIN",
	"CAP_NET_ADMIN",
}

type ociSpec struct {
	OCIVersion string     `json:"ociVersion"`
	Process    ociProcess `json:"process"`
	Root       ociRoot    `json:"root"`
	Hostname   string     `json:"hostname"`
	Mounts     []ociMount `json:"mounts"`
	Linux      ociLinux   `json:"linux"`
}

type ociProcess struct {
	Terminal        bool            `json:"terminal"`
	User            ociUser         `json:"user"`
	Args            []string        `json:"args"`
	Env             []string        `json:"env"`
	Cwd             string          `json:"cwd"`
	Capabilities    ociCapabilities `json:"capabilities"`
	Rlimits         []ociRlimit     `json:"rlimits"`
	NoNewPrivileges bool            `json:"noNewPrivileges"`
}

type ociUser struct {
	UID            int   `json:"uid"`
	GID            int   `json:"gid"`
	AdditionalGids []int `json:"additionalGids,omitempty"`
}

type ociCapabilities struct {
	Bounding  []string `json:"bounding"`
	Effective []string `json:"effective"`
	Permitted []string `json:"permitted"`
}

type ociRlimit struct {
	Type string `json:"type"`
	Hard uint64 `json:"hard"`
	Soft uint64 `json:"soft"`
}

type ociRoot struct {
	Path     string `json:"path"`
	Readonly bool   `json:"readonly"`
}

type ociMount struct {
	Destination string   `json:"destination"`
	Type        string   `json:"type"`
	Source      string   `json:"source"`
	Options     []string `json:"options,omitempty"`
}

type ociLinux struct {
	Namespaces  []ociNamespace `json:"namespaces"`
	Resources   ociResources   `json:"resources"`
	CgroupsPath string         `json:"cgroupsPath"`
}

type ociNamespace struct {
	Type string `json:"type"`
	Path string `json:"path,omitempty"`
}

type ociResources struct {
	Memory ociMemory `json:"memory"`
	CPU    ociCPU    `json:"cpu"`
	Pids   ociPids   `json:"pids"`
}

type ociMemory struct {
	Limit int64 `json:"limit"`
	Swap  int64 `json:"swap"`
}

type ociCPU struct {
	Period uint64 `json:"period"`
	Quota  int64  `json:"quota"`
}

type ociPids struct {
	Limit int64 `json:"limit"`
}

func Config(s sandbox.Spec) ([]byte, error) {
	if err := validateSpec(s); err != nil {
		return nil, err
	}
	env := mergeEnv(s.ImageEnv, []string{"HOSTNAME=" + s.Hostname, "STATIONLY_SANDBOX_ID=" + s.ID}, s.Env)
	spec := ociSpec{
		OCIVersion: ociVersion,
		Process:    process(s.Args, env, s.Cwd, 0, 0, nil, false),
		Root:       ociRoot{Path: s.DiskPath, Readonly: false},
		Hostname:   s.Hostname,
		Mounts:     mounts(s.BundleDir),
		Linux: ociLinux{
			Namespaces: []ociNamespace{
				{Type: "pid"},
				{Type: "ipc"},
				{Type: "uts"},
				{Type: "mount"},
				{Type: "cgroup"},
				{Type: "network", Path: s.NetNSPath},
			},
			Resources: ociResources{
				Memory: ociMemory{Limit: s.MemoryBytes, Swap: s.MemoryBytes},
				CPU:    ociCPU{Period: cpuPeriod, Quota: s.CPUMillis * 100},
				Pids:   ociPids{Limit: pidsLimit},
			},
			CgroupsPath: ScopeSlice + ":" + scopePrefix + ":" + strings.ToLower(s.ID),
		},
	}
	return json.MarshalIndent(spec, "", "  ")
}

func validateSpec(s sandbox.Spec) error {
	var errs []error
	for name, v := range map[string]string{"ID": s.ID, "Hostname": s.Hostname, "DiskPath": s.DiskPath, "BundleDir": s.BundleDir, "NetNSPath": s.NetNSPath} {
		if v == "" {
			errs = append(errs, errors.New("runsc: spec "+name+" is empty"))
		}
	}
	if len(s.Args) == 0 {
		errs = append(errs, errors.New("runsc: spec Args is empty"))
	}
	if s.MemoryBytes <= 0 {
		errs = append(errs, errors.New("runsc: spec MemoryBytes must be positive"))
	}
	if s.CPUMillis <= 0 {
		errs = append(errs, errors.New("runsc: spec CPUMillis must be positive"))
	}
	return errors.Join(errs...)
}

func process(args, env []string, cwd string, uid, gid int, groups []int, terminal bool) ociProcess {
	if cwd == "" {
		cwd = defaultCwd
	}
	return ociProcess{
		Terminal: terminal,
		User:     ociUser{UID: uid, GID: gid, AdditionalGids: groups},
		Args:     args,
		Env:      env,
		Cwd:      cwd,
		Capabilities: ociCapabilities{
			Bounding:  append([]string(nil), capabilities...),
			Effective: append([]string(nil), capabilities...),
			Permitted: append([]string(nil), capabilities...),
		},
		Rlimits:         []ociRlimit{{Type: rlimitNofile, Hard: nofileLimit, Soft: nofileLimit}},
		NoNewPrivileges: true,
	}
}

func mounts(bundleDir string) []ociMount {
	return []ociMount{
		{Destination: "/proc", Type: "proc", Source: "proc"},
		{Destination: "/dev", Type: "tmpfs", Source: "tmpfs", Options: []string{"nosuid", "strictatime", "mode=755", "size=65536k"}},
		{Destination: "/dev/pts", Type: "devpts", Source: "devpts", Options: []string{"nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620"}},
		{Destination: "/dev/shm", Type: "tmpfs", Source: "shm", Options: []string{"nosuid", "noexec", "nodev", "mode=1777", "size=65536k"}},
		{Destination: "/dev/mqueue", Type: "mqueue", Source: "mqueue", Options: []string{"nosuid", "noexec", "nodev"}},
		{Destination: "/sys", Type: "sysfs", Source: "sysfs", Options: []string{"nosuid", "noexec", "nodev", "ro"}},
		{Destination: "/sys/fs/cgroup", Type: "cgroup", Source: "cgroup", Options: []string{"nosuid", "noexec", "nodev", "relatime", "rw"}},
		{Destination: "/run", Type: "tmpfs", Source: "tmpfs", Options: []string{"nosuid", "nodev", "mode=755", "size=256m"}},
		{Destination: "/etc/resolv.conf", Type: "bind", Source: bundleDir + "/resolv.conf", Options: []string{"rbind", "ro"}},
		{Destination: "/etc/hosts", Type: "bind", Source: bundleDir + "/hosts", Options: []string{"rbind", "ro"}},
		{Destination: "/etc/hostname", Type: "bind", Source: bundleDir + "/hostname", Options: []string{"rbind", "ro"}},
	}
}

func mergeEnv(lists ...[]string) []string {
	index := map[string]int{}
	var out []string
	for _, list := range lists {
		for _, kv := range list {
			key, _, _ := strings.Cut(kv, "=")
			if i, ok := index[key]; ok {
				out[i] = kv
				continue
			}
			index[key] = len(out)
			out = append(out, kv)
		}
	}
	return out
}

func HostFiles(s sandbox.Spec) map[string][]byte {
	return map[string][]byte{
		"resolv.conf": []byte("nameserver " + s.Resolver.String() + "\n"),
		"hosts":       []byte("127.0.0.1 localhost\n169.254.1.2 " + s.Hostname + "\n"),
		"hostname":    []byte(s.Hostname + "\n"),
	}
}

func ScopeUnit(id string) string {
	return scopePrefix + "-" + strings.ToLower(id) + ".scope"
}
