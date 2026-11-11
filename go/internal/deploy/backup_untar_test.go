//go:build linux

package deploy

import (
	"archive/tar"
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type tarEntry struct {
	name     string
	kind     byte
	body     string
	linkname string
}

func tarOf(t *testing.T, entries []tarEntry) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, e := range entries {
		hdr := &tar.Header{
			Name:     e.name,
			Typeflag: e.kind,
			Linkname: e.linkname,
			Mode:     0o644,
			Size:     int64(len(e.body)),
			Uid:      os.Getuid(),
			Gid:      os.Getgid(),
			ModTime:  time.Unix(1_700_000_000, 0),
		}
		if e.kind == tar.TypeDir {
			hdr.Mode = 0o755
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(e.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return &buf
}

func TestUntarRestoresFilesDirectoriesAndSymlinks(t *testing.T) {
	dir := t.TempDir()
	size, files, err := untar(dir, tarOf(t, []tarEntry{
		{
			name: "data",
			kind: tar.TypeDir,
		},
		{
			name: "data/a.txt",
			kind: tar.TypeReg,
			body: "hello",
		},
		{
			name:     "data/link",
			kind:     tar.TypeSymlink,
			linkname: "a.txt",
		},
	}))
	if err != nil {
		t.Fatal(err)
	}
	if size != 5 || files != 1 {
		t.Fatalf("size %d files %d, want 5 and 1", size, files)
	}
	got, err := os.ReadFile(filepath.Join(dir, "data", "link"))
	if err != nil || string(got) != "hello" {
		t.Fatalf("link reads %q, %v", got, err)
	}
}

func TestUntarRefusesToWriteThroughASymlinkOutOfTheVolume(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	_, _, err := untar(dir, tarOf(t, []tarEntry{
		{
			name:     "escape",
			kind:     tar.TypeSymlink,
			linkname: outside,
		},
		{
			name: "escape/planted",
			kind: tar.TypeReg,
			body: "owned",
		},
	}))
	if err == nil {
		t.Fatal("untar wrote through a symlink that leaves the volume")
	}
	if _, err := os.Stat(filepath.Join(outside, "planted")); !os.IsNotExist(err) {
		t.Fatalf("a file appeared outside the volume: %v", err)
	}
}

func TestUntarRefusesAnEntryForTheVolumeRoot(t *testing.T) {
	_, _, err := untar(t.TempDir(), tarOf(t, []tarEntry{
		{
			name: "../",
			kind: tar.TypeDir,
		},
	}))
	if err == nil {
		t.Fatal("untar accepted an entry naming the volume root")
	}
}
