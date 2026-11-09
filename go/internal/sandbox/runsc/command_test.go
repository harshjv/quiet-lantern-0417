package runsc

import (
	"context"
	"reflect"
	"testing"
)

func TestAt(t *testing.T) {
	rt := At(LibDir, StateBase, "20261102.0")
	want := Runtime{Version: "20261102.0", Dir: "/usr/local/lib/stationly/runsc-20261102.0", Root: "/run/stationly/runsc/20261102.0"}
	if rt != want {
		t.Fatalf("%+v", rt)
	}
}

func TestCommandFlags(t *testing.T) {
	rt := At(LibDir, StateBase, "20261102.0")
	cmd := rt.Command(context.Background(), "", "state", "sbx_1")
	if cmd.Path != "/usr/local/lib/stationly/runsc-20261102.0/runsc" {
		t.Errorf("path %q", cmd.Path)
	}
	want := []string{cmd.Path, "--root", "/run/stationly/runsc/20261102.0", "--platform=systrap", "--overlay2=none", "--net-raw", "--network=sandbox", "state", "sbx_1"}
	if !reflect.DeepEqual(cmd.Args, want) {
		t.Errorf("args %q", cmd.Args)
	}
	if !reflect.DeepEqual(cmd.Env, []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}) {
		t.Errorf("env %q", cmd.Env)
	}
	if cmd.Err != nil {
		t.Errorf("err %v", cmd.Err)
	}
	logged := rt.Command(context.Background(), "/var/log/sbx", "start", "sbx_1")
	wantLogged := []string{logged.Path, "--root", "/run/stationly/runsc/20261102.0", "--platform=systrap", "--overlay2=none", "--net-raw", "--network=sandbox",
		"--log", "/var/log/sbx/runsc.log", "--panic-log", "/var/log/sbx/panic.log", "--debug-log", "/var/log/sbx/", "start", "sbx_1"}
	if !reflect.DeepEqual(logged.Args, wantLogged) {
		t.Errorf("args %q", logged.Args)
	}
	if err := CheckArgs(logged.Args[1:]); err != nil {
		t.Errorf("globals rejected: %v", err)
	}
}

func TestCommandRefusesForbiddenArgs(t *testing.T) {
	rt := At(LibDir, StateBase, "1")
	cmd := rt.Command(context.Background(), "", "--network=host", "create", "x")
	if cmd.Err == nil {
		t.Fatal("forbidden arg accepted")
	}
	if err := cmd.Run(); err == nil {
		t.Fatal("command ran")
	}
}

func TestCheckArgs(t *testing.T) {
	forbidden := [][]string{
		{"--network=host"},
		{"--network", "host"},
		{"-network=host"},
		{"--allow-packet-socket-write"},
		{"--host-uds=all"},
		{"--host-uds", "open"},
		{"--host-fifo=open"},
		{"--rootless"},
		{"--rootless=false"},
		{"--ignore-cgroups"},
		{"--allow-flag-override"},
		{"--allow-suid"},
		{"--profile"},
		{"--profile-cpu=/tmp/x"},
		{"--reproduce-nat"},
		{"--reproduce-nftables"},
		{"--nvproxy"},
		{"--nvproxy-docker"},
		{"--tpuproxy"},
		{"--TESTONLY-unsafe-nonroot"},
		{"--TESTONLY-test-name-env=x"},
		{"--platform=ptrace"},
		{"--platform=kvm"},
		{"--platform", "kvm"},
		{"--directfs=false"},
		{"--directfs"},
		{"--file-access=shared"},
		{"--file-access-mounts=exclusive"},
		{"--overlay2=root:self"},
		{"--debug"},
		{"--network"},
	}
	for _, args := range forbidden {
		if err := CheckArgs(append([]string{"--root", "/r"}, args...)); err == nil {
			t.Errorf("%q accepted", args)
		}
	}
	allowed := [][]string{
		{"--root", "/r", "--platform=systrap", "--overlay2=none", "--net-raw", "--network=sandbox", "state", "x"},
		{"--root", "/tmp/p", "--platform=systrap", "--network=none", "do", "true"},
		{"--host-uds=none", "--host-fifo=none"},
		{"--debug-log", "/d/", "--panic-log", "/d/panic.log", "--log", "/d/runsc.log"},
		{"exec", "--process", "/proc/self/fd/3", "x"},
		{"delete", "--force", "x"},
		{"list", "--format=json"},
	}
	for _, args := range allowed {
		if err := CheckArgs(args); err != nil {
			t.Errorf("%q rejected: %v", args, err)
		}
	}
}

func TestCheckVersion(t *testing.T) {
	for _, v := range []string{"", "..", "../x", "a/b", "1.partial", ".hidden", "a..b"} {
		if checkVersion(v) == nil {
			t.Errorf("%q accepted", v)
		}
	}
	for _, v := range []string{"20261102.0", "release-20261102.0"} {
		if err := checkVersion(v); err != nil {
			t.Errorf("%q rejected", v)
		}
	}
}
