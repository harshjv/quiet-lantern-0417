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
