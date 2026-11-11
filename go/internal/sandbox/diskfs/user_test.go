//go:build linux

package diskfs

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func writeFile(t *testing.T, p, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func symlink(t *testing.T, target, p string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, p); err != nil {
		t.Fatal(err)
	}
}

func TestLookupUser(t *testing.T) {
	d := newDirs(t)
	writeFile(t, filepath.Join(d.root, "etc/passwd"), "app:x:1000:1001::/home/app:/bin/sh\n")
	writeFile(t, filepath.Join(d.root, "etc/group"), "staff:x:50:app\n")
	cases := []struct {
		user     string
		uid, gid int
	}{
		{"app", 1000, 1001},
		{"app:staff", 1000, 50},
		{"4242:staff", 4242, 50},
	}
	for _, c := range cases {
		uid, gid, _, err := LookupUser(d.root, c.user)
		if err != nil || uid != c.uid || gid != c.gid {
			t.Errorf("LookupUser(%q) = %d, %d, %v; want %d, %d", c.user, uid, gid, err, c.uid, c.gid)
		}
	}
	for _, user := range []string{"nobody", "app:nogroup"} {
		if uid, gid, _, err := LookupUser(d.root, user); err == nil {
			t.Errorf("LookupUser(%q) = %d, %d, want an error", user, uid, gid)
		}
	}
}

func TestLookupUserNumericWithoutPasswd(t *testing.T) {
	d := newDirs(t)
	uid, gid, _, err := LookupUser(d.root, "1234")
	if err != nil || uid != 1234 || gid != 0 {
		t.Errorf("LookupUser = %d, %d, %v", uid, gid, err)
	}
	if _, _, _, err := LookupUser(d.root, "root"); err == nil {
		t.Error("LookupUser(root) without /etc/passwd in the disk succeeded, read the host's")
	}
}

func TestLookupUserHostileSymlink(t *testing.T) {
	d := newDirs(t)
	writeFile(t, filepath.Join(d.canary, "passwd"), "app:x:1:1::/:/bin/sh\n")
	writeFile(t, filepath.Join(d.canary, "group"), "staff:x:2:\n")
	writeFile(t, filepath.Join(d.root, d.canary, "passwd"), "app:x:4242:4343::/:/bin/sh\n")
	writeFile(t, filepath.Join(d.root, "srv/group"), "staff:x:77:\n")
	symlink(t, filepath.Join(d.canary, "passwd"), filepath.Join(d.root, "etc/passwd"))
	symlink(t, climb("srv/group"), filepath.Join(d.root, "etc/group"))

	uid, gid, _, err := LookupUser(d.root, "app")
	if err != nil || uid != 4242 || gid != 4343 {
		t.Errorf("LookupUser(app) = %d, %d, %v; want the in-root 4242, 4343", uid, gid, err)
	}
	uid, gid, _, err = LookupUser(d.root, "app:staff")
	if err != nil || uid != 4242 || gid != 77 {
		t.Errorf("LookupUser(app:staff) = %d, %d, %v; want 4242, 77", uid, gid, err)
	}
}

func TestLookupUserHostPasswdSymlink(t *testing.T) {
	d := newDirs(t)
	symlink(t, "/etc/passwd", filepath.Join(d.root, "etc/passwd"))
	if _, _, _, err := LookupUser(d.root, "root"); err == nil {
		t.Error("LookupUser(root) through a symlink to /etc/passwd read the host's file")
	}
}

func TestReadFile(t *testing.T) {
	d := newDirs(t)
	writeFile(t, filepath.Join(d.root, "data/file"), "content\n")
	writeFile(t, filepath.Join(d.canary, "secret"), "host secret\n")
	symlink(t, "/data/file", filepath.Join(d.root, "abs"))
	symlink(t, climb("data/file"), filepath.Join(d.root, "rel"))
	symlink(t, filepath.Join(d.canary, "secret"), filepath.Join(d.root, "host"))
	symlink(t, "/proc/self/root/etc/hostname", filepath.Join(d.root, "magic"))
	if err := unix.Mkfifo(filepath.Join(d.root, "fifo"), 0o644); err != nil {
		t.Fatal(err)
	}

	for _, name := range []string{"data/file", "/data/file", "abs", "rel", "../../data/file"} {
		got, err := ReadFile(d.root, name, 1<<20)
		if err != nil || string(got) != "content\n" {
			t.Errorf("ReadFile(%q) = %q, %v", name, got, err)
		}
	}
	for _, name := range []string{"host", "magic", "fifo", "data", "missing"} {
		done := make(chan error, 1)
		go func() {
			_, err := ReadFile(d.root, name, 1<<20)
			done <- err
		}()
		select {
		case err := <-done:
			if err == nil {
				t.Errorf("ReadFile(%q) succeeded", name)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("ReadFile(%q) blocked", name)
		}
	}
	if _, err := ReadFile(d.root, "data/file", 4); err == nil || !strings.Contains(err.Error(), "exceeds limit") {
		t.Errorf("ReadFile over limit: %v", err)
	}
}

func TestLookupUserSupplementaryGroups(t *testing.T) {
	d := newDirs(t)
	writeFile(t, filepath.Join(d.root, "etc/passwd"), "agent:x:1000:1000::/home/agent:/bin/bash\n")
	writeFile(t, filepath.Join(d.root, "etc/group"), "agent:x:1000:\ndocker:x:998:agent\n")
	_, _, groups, err := LookupUser(d.root, "agent")
	if err != nil || len(groups) != 1 || groups[0] != 998 {
		t.Errorf("LookupUser(agent) groups = %v, %v; want [998]", groups, err)
	}
}

func TestLookupUserSurvivesAnUnreadableGroupFile(t *testing.T) {
	d := newDirs(t)
	writeFile(t, filepath.Join(d.root, "etc/passwd"), "agent:x:1000:1000::/home/agent:/bin/bash\n")
	writeFile(t, filepath.Join(d.root, "etc/group"), strings.Repeat("x", accountsLimit+1))
	uid, gid, groups, err := LookupUser(d.root, "agent")
	if err != nil || uid != 1000 || gid != 1000 || len(groups) != 0 {
		t.Errorf("LookupUser(agent) = %d, %d, %v, %v; want 1000, 1000, no groups", uid, gid, groups, err)
	}
}
