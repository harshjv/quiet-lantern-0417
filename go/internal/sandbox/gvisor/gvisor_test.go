//go:build linux

package gvisor

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestLogFilesListRunscLogsAndItsPerCommandDebugFiles(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"init.log", "runsc.log.20261108-140211.create.txt", "runsc.log.old", "other.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got := New().LogFiles(dir)
	want := []string{"runsc.log", "panic.log", "runsc.log.20261108-140211.create.txt"}
	if !slices.Equal(got, want) {
		t.Fatalf("log files\n got %q\nwant %q", got, want)
	}
}

func TestPanicQuotesTheFirstLineOfPanicLogBounded(t *testing.T) {
	dir := t.TempDir()
	if got := New().Panic(dir); got != "" {
		t.Fatalf("no panic.log means no panic line, got %q", got)
	}
	long := strings.Repeat("x", 600)
	if err := os.WriteFile(filepath.Join(dir, "panic.log"), []byte("\npanic: "+long+"\ngoroutine 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	got := New().Panic(dir)
	if !strings.HasPrefix(got, "panic: x") || len(got) != maxPanicLine {
		t.Fatalf("panic line %q (%d bytes)", got, len(got))
	}
}
