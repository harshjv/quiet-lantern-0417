//go:build linux

package store

import (
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestEnsureLayout(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root")
	}
	f := Open(t.TempDir())
	if err := os.Mkdir(filepath.Join(f.Mount, "disks"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := f.EnsureLayout(); err != nil {
		t.Fatal(err)
	}
	if err := f.EnsureLayout(); err != nil {
		t.Fatal(err)
	}
	for _, d := range layoutDirs {
		st, err := os.Lstat(filepath.Join(f.Mount, d))
		if err != nil {
			t.Fatal(err)
		}
		if !st.IsDir() || st.Mode().Perm() != 0o700 {
			t.Errorf("%s: mode %v", d, st.Mode())
		}
	}
}

func TestEnsureLayoutRefusesSymlink(t *testing.T) {
	f := Open(t.TempDir())
	target := t.TempDir()
	if err := os.Symlink(target, filepath.Join(f.Mount, "bases")); err != nil {
		t.Fatal(err)
	}
	if err := f.EnsureLayout(); err == nil {
		t.Fatal("symlinked bases accepted")
	}
	entries, err := os.ReadDir(target)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("wrote through the symlink: %v", entries)
	}
}

func TestEnsureLayoutRefusesFile(t *testing.T) {
	f := Open(t.TempDir())
	if err := os.WriteFile(filepath.Join(f.Mount, "logs"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := f.EnsureLayout(); err == nil {
		t.Fatal("file named logs accepted")
	}
}

func TestLogFile(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root")
	}
	f := Open(t.TempDir())
	if err := f.EnsureLayout(); err != nil {
		t.Fatal(err)
	}
	for _, line := range []string{"one\n", "two\n"} {
		lf, err := f.LogFile("sbx_1", "init.log")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(lf, line); err != nil {
			t.Fatal(err)
		}
		if err := lf.Close(); err != nil {
			t.Fatal(err)
		}
	}
	b, err := os.ReadFile(filepath.Join(f.LogDir("sbx_1"), "init.log"))
	if err != nil || string(b) != "one\ntwo\n" {
		t.Fatalf("log = %q, %v", b, err)
	}
	st, err := os.Stat(filepath.Join(f.LogDir("sbx_1"), "init.log"))
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("log mode %v, %v", st.Mode(), err)
	}
	dst, err := os.Stat(f.LogDir("sbx_1"))
	if err != nil || dst.Mode().Perm() != 0o700 {
		t.Fatalf("log dir mode %v, %v", dst.Mode(), err)
	}

	outside := filepath.Join(t.TempDir(), "victim")
	if err := os.Symlink(outside, filepath.Join(f.LogDir("sbx_1"), "runsc.log")); err != nil {
		t.Fatal(err)
	}
	if _, err := f.LogFile("sbx_1", "runsc.log"); err == nil {
		t.Fatal("symlinked log accepted")
	}
	if _, err := os.Lstat(outside); !os.IsNotExist(err) {
		t.Fatalf("created through the symlink: %v", err)
	}

	if err := os.Symlink(t.TempDir(), filepath.Join(f.Mount, "logs", "sbx_2")); err != nil {
		t.Fatal(err)
	}
	if _, err := f.LogFile("sbx_2", "init.log"); err == nil {
		t.Fatal("symlinked log directory accepted")
	}
	for _, bad := range [][2]string{{"../x", "init.log"}, {"sbx_1", "../init.log"}, {"sbx_1", ""}, {"", "init.log"}} {
		if _, err := f.LogFile(bad[0], bad[1]); err == nil {
			t.Errorf("LogFile(%q, %q) accepted", bad[0], bad[1])
		}
	}
}
