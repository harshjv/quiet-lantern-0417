package runsc

import (
	"encoding/json"
	"net/netip"
	"reflect"
	"strings"
	"testing"
)

func testSpec() Spec {
	return Spec{
		ID:          "sbx_01JCB4ABC",
		Hostname:    "box",
		DiskPath:    "/var/lib/stationly/sandboxes/disks/sbx_01JCB4ABC",
		BundleDir:   "/run/stationly/sandboxes/sbx_01JCB4ABC",
		NetNSPath:   "/run/stationly/netns/sbx_01JCB4ABC",
		Args:        []string{"/usr/local/bin/sandbox-init"},
		Env:         []string{"PATH=/custom", "TOKEN=x", "HOSTNAME=override"},
		ImageEnv:    []string{"PATH=/image", "HOME=/root", "TOKEN=image"},
		MemoryBytes: 1 << 30,
		CPUMillis:   1500,
	}
}

func decodeConfig(t *testing.T, s Spec) (ociSpec, map[string]any) {
	t.Helper()
	b, err := Config(s)
	if err != nil {
		t.Fatal(err)
	}
	var spec ociSpec
	if err := json.Unmarshal(b, &spec); err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatal(err)
	}
	return spec, raw
}

func TestConfigMounts(t *testing.T) {
	spec, _ := decodeConfig(t, testSpec())
	var got []string
	for _, m := range spec.Mounts {
		got = append(got, m.Destination+" "+m.Type+" "+m.Source)
	}
	b := testSpec().BundleDir
	want := []string{
		"/proc proc proc",
		"/dev tmpfs tmpfs",
		"/dev/pts devpts devpts",
		"/dev/shm tmpfs shm",
		"/dev/mqueue mqueue mqueue",
		"/sys sysfs sysfs",
		"/sys/fs/cgroup cgroup cgroup",
		"/run tmpfs tmpfs",
		"/etc/resolv.conf bind " + b + "/resolv.conf",
		"/etc/hosts bind " + b + "/hosts",
		"/etc/hostname bind " + b + "/hostname",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("mounts\n got %q\nwant %q", got, want)
	}
	for _, m := range spec.Mounts {
		switch m.Destination {
		case "/sys":
			if !strings.Contains(strings.Join(m.Options, ","), "ro") {
				t.Errorf("/sys not read-only: %v", m.Options)
			}
		case "/run":
			if !strings.Contains(strings.Join(m.Options, ","), "size=256m") {
				t.Errorf("/run options %v", m.Options)
			}
		case "/etc/resolv.conf", "/etc/hosts", "/etc/hostname":
			if !reflect.DeepEqual(m.Options, []string{"rbind", "ro"}) {
				t.Errorf("%s options %v", m.Destination, m.Options)
			}
		}
	}
}

func TestConfigProcess(t *testing.T) {
	spec, _ := decodeConfig(t, testSpec())
	p := spec.Process
	wantCaps := []string{"CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_FSETID", "CAP_FOWNER", "CAP_MKNOD", "CAP_NET_RAW", "CAP_SETGID", "CAP_SETUID", "CAP_SETFCAP", "CAP_SETPCAP", "CAP_NET_BIND_SERVICE", "CAP_SYS_CHROOT", "CAP_KILL", "CAP_AUDIT_WRITE", "CAP_SYS_ADMIN", "CAP_NET_ADMIN"}
	for name, set := range map[string][]string{"bounding": p.Capabilities.Bounding, "effective": p.Capabilities.Effective, "permitted": p.Capabilities.Permitted} {
		if !reflect.DeepEqual(set, wantCaps) {
			t.Errorf("%s caps %v", name, set)
		}
	}
	if p.Terminal || !p.NoNewPrivileges || p.Cwd != "/" || p.User != (ociUser{}) {
		t.Errorf("process %+v", p)
	}
	if !reflect.DeepEqual(p.Rlimits, []ociRlimit{{Type: "RLIMIT_NOFILE", Hard: 1048576, Soft: 1048576}}) {
		t.Errorf("rlimits %v", p.Rlimits)
	}
	wantEnv := []string{"PATH=/custom", "HOME=/root", "TOKEN=x", "HOSTNAME=override", "STATIONLY_SANDBOX_ID=sbx_01JCB4ABC"}
	if !reflect.DeepEqual(p.Env, wantEnv) {
		t.Errorf("env\n got %q\nwant %q", p.Env, wantEnv)
	}
	s := testSpec()
	s.Env = nil
	s.Cwd = "/work"
	s.UID, s.GID = 1000, 1001
	spec, _ = decodeConfig(t, s)
	if spec.Process.Cwd != "/work" || spec.Process.User != (ociUser{UID: 1000, GID: 1001}) {
		t.Errorf("process %+v", spec.Process)
	}
	if !reflect.DeepEqual(spec.Process.Env, []string{"PATH=/image", "HOME=/root", "TOKEN=image", "HOSTNAME=box", "STATIONLY_SANDBOX_ID=sbx_01JCB4ABC"}) {
		t.Errorf("env %q", spec.Process.Env)
	}
}

func TestConfigLinux(t *testing.T) {
	spec, raw := decodeConfig(t, testSpec())
	if spec.Linux.CgroupsPath != "stationly-sandboxes.slice:sbx:sbx_01jcb4abc" {
		t.Errorf("cgroupsPath %q", spec.Linux.CgroupsPath)
	}
	wantNS := []ociNamespace{{Type: "pid"}, {Type: "ipc"}, {Type: "uts"}, {Type: "mount"}, {Type: "cgroup"}, {Type: "network", Path: "/run/stationly/netns/sbx_01JCB4ABC"}}
	if !reflect.DeepEqual(spec.Linux.Namespaces, wantNS) {
		t.Errorf("namespaces %v", spec.Linux.Namespaces)
	}
	wantRes := ociResources{Memory: ociMemory{Limit: 1 << 30, Swap: 1 << 30}, CPU: ociCPU{Period: 100000, Quota: 150000}, Pids: ociPids{Limit: 16384}}
	if spec.Linux.Resources != wantRes {
		t.Errorf("resources %+v", spec.Linux.Resources)
	}
	if spec.Root != (ociRoot{Path: testSpec().DiskPath}) || spec.Hostname != "box" {
		t.Errorf("root %+v hostname %q", spec.Root, spec.Hostname)
	}
	if _, ok := raw["annotations"]; ok {
		t.Error("annotations set")
	}
	linux := raw["linux"].(map[string]any)
	if _, ok := linux["seccomp"]; ok {
		t.Error("seccomp set")
	}
	process := raw["process"].(map[string]any)
	for _, k := range []string{"apparmorProfile", "selinuxLabel", "consoleSize"} {
		if _, ok := process[k]; ok {
			t.Errorf("%s set", k)
		}
	}
	caps := process["capabilities"].(map[string]any)
	for _, k := range []string{"inheritable", "ambient"} {
		if _, ok := caps[k]; ok {
			t.Errorf("%s capabilities set", k)
		}
	}
	for _, k := range []string{"devices", "uidMappings", "gidMappings", "sysctl", "maskedPaths"} {
		if _, ok := linux[k]; ok {
			t.Errorf("linux.%s set", k)
		}
	}
}

func TestConfigRejectsIncompleteSpec(t *testing.T) {
	for name, mutate := range map[string]func(*Spec){
		"no id":     func(s *Spec) { s.ID = "" },
		"no netns":  func(s *Spec) { s.NetNSPath = "" },
		"no args":   func(s *Spec) { s.Args = nil },
		"no memory": func(s *Spec) { s.MemoryBytes = 0 },
		"no cpu":    func(s *Spec) { s.CPUMillis = 0 },
	} {
		s := testSpec()
		mutate(&s)
		if _, err := Config(s); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestHostFilesAndScope(t *testing.T) {
	files := HostFiles(testSpec(), netip.MustParseAddr("10.77.0.53"), "box")
	want := map[string]string{
		"resolv.conf": "nameserver 10.77.0.53\n",
		"hosts":       "127.0.0.1 localhost\n169.254.1.2 box\n",
		"hostname":    "box\n",
	}
	if len(files) != len(want) {
		t.Fatalf("files %v", files)
	}
	for k, v := range want {
		if string(files[k]) != v {
			t.Errorf("%s = %q", k, files[k])
		}
	}
	if got := ScopeUnit("sbx_01JCB4ABC"); got != "sbx-sbx_01jcb4abc.scope" {
		t.Errorf("scope %q", got)
	}
}
