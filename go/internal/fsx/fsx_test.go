package fsx

import (
	"os"
	"path/filepath"
	"testing"
)

func entries(t *testing.T, dir string) []string {
	t.Helper()
	list, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(list))
	for _, e := range list {
		names = append(names, e.Name())
	}
	return names
}

func TestWriteFileReplacesTheFileWithTheExactMode(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	if err := os.WriteFile(path, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := WriteFile(path, []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new" || info.Mode().Perm() != 0o600 {
		t.Fatalf("file holds %q with mode %v, want \"new\" with 0600", got, info.Mode().Perm())
	}
	if names := entries(t, dir); len(names) != 1 {
		t.Fatalf("directory holds %v, want only state.json", names)
	}
}

func TestWriteFileRemovesItsTempFileWhenTheRenameFails(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "target")
	if err := os.MkdirAll(filepath.Join(path, "occupied"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := WriteFile(path, []byte("body"), 0o600); err == nil {
		t.Fatal("WriteFile over a non-empty directory succeeded, want an error")
	}
	if names := entries(t, dir); len(names) != 1 || names[0] != "target" {
		t.Fatalf("directory holds %v after the failed write, want only target", names)
	}
}

func TestWriteIfChangedSkipsIdenticalContent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yml")
	changed, err := WriteIfChanged(path, []byte("a"), 0o644)
	if err != nil || !changed {
		t.Fatalf("first write: changed=%v err=%v, want true and no error", changed, err)
	}
	changed, err = WriteIfChanged(path, []byte("a"), 0o644)
	if err != nil || changed {
		t.Fatalf("identical write: changed=%v err=%v, want false and no error", changed, err)
	}
	changed, err = WriteIfChanged(path, []byte("b"), 0o644)
	if err != nil || !changed {
		t.Fatalf("different write: changed=%v err=%v, want true and no error", changed, err)
	}
}

func TestDirSizeCountsRegularFilesOnly(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "big.log")
	sizes := map[string]int{filepath.Join(dir, "a.log"): 3, filepath.Join(dir, "nested", "b.log"): 5, filepath.Join(dir, "nested", "c.txt"): 7, outside: 1000}
	for path, size := range sizes {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, make([]byte, size), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(outside, filepath.Join(dir, "link.log")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Dir(outside), filepath.Join(dir, "linked-dir")); err != nil {
		t.Fatal(err)
	}
	if got := DirSize(dir, nil); got != 15 {
		t.Fatalf("DirSize = %d, want 15 from the three regular files", got)
	}
	if got := DirSize(dir, func(name string) bool { return filepath.Ext(name) == ".log" }); got != 8 {
		t.Fatalf("DirSize of .log files = %d, want 8", got)
	}
	if got := DirSize(filepath.Join(dir, "missing"), nil); got != 0 {
		t.Fatalf("DirSize of a missing root = %d, want 0", got)
	}
}
