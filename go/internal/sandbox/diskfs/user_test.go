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

const (
	testPasswd = "root:x:0:0:root:/root:/bin/sh\n# comment\n\nbroken:x:nope:1::/:/bin/sh\napp:x:1000:1001::/home/app:/bin/sh\n"
	testGroup  = "root:x:0:\nstaff:x:50:app\n"
)

func TestLookupUser(t *testing.T) {
	d := newDirs(t)
	writeFile(t, filepath.Join(d.root, "etc/passwd"), testPasswd)
	writeFile(t, filepath.Join(d.root, "etc/group"), testGroup)
	cases := []struct {
		user     string
		uid, gid int
	}{
		{"app", 1000, 1001},
		{"app:staff", 1000, 50},
		{"app:7", 1000, 7},
		{"1000", 1000, 1001},
		{"4242", 4242, 0},
		{"4242:43", 4242, 43},
		{"4242:staff", 4242, 50},
		{"root", 0, 0},
		{"0:0", 0, 0},
	}
	for _, c := range cases {
		uid, gid, err := LookupUser(d.root, c.user)
		if err != nil || uid != c.uid || gid != c.gid {
			t.Errorf("LookupUser(%q) = %d, %d, %v; want %d, %d", c.user, uid, gid, err, c.uid, c.gid)
		}
	}
	for _, user := range []string{"", ":", "app:", ":staff", "nobody", "broken", "app:nogroup", "-1", "4294967295", "app:4294967295"} {
		if uid, gid, err := LookupUser(d.root, user); err == nil {
			t.Errorf("LookupUser(%q) = %d, %d, want an error", user, uid, gid)
		}
	}
}

func TestLookupUserNumericWithoutPasswd(t *testing.T) {
	d := newDirs(t)
	uid, gid, err := LookupUser(d.root, "1234")
	if err != nil || uid != 1234 || gid != 0 {
		t.Errorf("LookupUser = %d, %d, %v", uid, gid, err)
	}
	if _, _, err := LookupUser(d.root, "root"); err == nil {
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

	uid, gid, err := LookupUser(d.root, "app")
	if err != nil || uid != 4242 || gid != 4343 {
		t.Errorf("LookupUser(app) = %d, %d, %v; want the in-root 4242, 4343", uid, gid, err)
	}
	uid, gid, err = LookupUser(d.root, "app:staff")
	if err != nil || uid != 4242 || gid != 77 {
		t.Errorf("LookupUser(app:staff) = %d, %d, %v; want 4242, 77", uid, gid, err)
	}
}

func TestLookupUserHostPasswdSymlink(t *testing.T) {
	d := newDirs(t)
	symlink(t, "/etc/passwd", filepath.Join(d.root, "etc/passwd"))
	if _, _, err := LookupUser(d.root, "root"); err == nil {
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
