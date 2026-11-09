//go:build linux

package runsc

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fakeCgroup(t *testing.T, populated string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range map[string]string{"cgroup.kill": "", "cgroup.events": "populated " + populated + "\nfrozen 0\n", "memory.oom.group": "0\n"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestKillCgroupWaitsUntilTheScopeIsEmpty(t *testing.T) {
	dir := fakeCgroup(t, "1")
	go func() {
		for {
			if b, _ := os.ReadFile(filepath.Join(dir, "cgroup.kill")); string(b) == "1" {
				os.WriteFile(filepath.Join(dir, "cgroup.events"), []byte("populated 0\nfrozen 0\n"), 0o644)
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := KillCgroup(ctx, dir); err != nil {
		t.Fatal(err)
	}
}

func TestKillCgroupReportsProcessesThatRemain(t *testing.T) {
	dir := fakeCgroup(t, "1")
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	err := KillCgroup(ctx, dir)
	if err == nil || !strings.Contains(err.Error(), "processes remain") {
		t.Fatalf("a scope that stays populated must be an error, got %v", err)
	}
}

func TestKillCgroupOfAGoneScopeIsDone(t *testing.T) {
	if err := KillCgroup(context.Background(), filepath.Join(t.TempDir(), "absent")); err != nil {
		t.Fatal(err)
	}
}

func TestKillScopeKillsThenStopsTheUnit(t *testing.T) {
	if _, err := os.Stat("/.dockerenv"); err != nil {
		t.Skip("places a fake systemctl in /usr/local/sbin, so runs only in a container")
	}
	bin := t.TempDir()
	script := "#!/bin/sh\necho \"$*\" >> " + bin + "/systemctl.args\n"
	if err := os.WriteFile(filepath.Join(bin, "systemctl"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(bin, "systemctl"), "/usr/local/sbin/systemctl"); err != nil {
		t.Skipf("cannot place a fake systemctl: %v", err)
	}
	t.Cleanup(func() {
		if err := os.Remove("/usr/local/sbin/systemctl"); err != nil {
			t.Error(err)
		}
	})
	if err := KillScope(context.Background(), "sbx_01ABC"); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(bin, "systemctl.args"))
	if err != nil {
		t.Fatal(err)
	}
	want := "show -p ControlGroup --value sbx-sbx_01abc.scope\nstop sbx-sbx_01abc.scope"
	if strings.TrimSpace(string(b)) != want {
		t.Errorf("systemctl %q", b)
	}
}
