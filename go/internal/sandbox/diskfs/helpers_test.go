//go:build linux

package diskfs

import (
	"archive/tar"
	"bytes"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

var (
	epoch    = time.Date(2024, 5, 6, 7, 8, 9, 0, time.UTC)
	year2001 = time.Date(2001, 2, 3, 4, 5, 6, 0, time.UTC)
)

type tentry struct {
	h    tar.Header
	body []byte
}

func isRoot() bool { return os.Geteuid() == 0 }

func ids(uid, gid int) (int, int) {
	if isRoot() {
		return uid, gid
	}
	return os.Getuid(), os.Getgid()
}

func header(name string, typ byte, mode int64) tar.Header {
	uid, gid := ids(0, 0)
	return tar.Header{Name: name, Typeflag: typ, Mode: mode, Uid: uid, Gid: gid, ModTime: epoch, Format: tar.FormatPAX}
}

func dirEntry(name string, mode int64) tentry {
	return tentry{h: header(name, tar.TypeDir, mode)}
}

func regEntry(name string, body []byte) tentry {
	h := header(name, tar.TypeReg, 0o644)
	h.Size = int64(len(body))
	return tentry{h: h, body: body}
}

func symEntry(name, target string) tentry {
	h := header(name, tar.TypeSymlink, 0o777)
	h.Linkname = target
	return tentry{h: h}
}

func hardEntry(name, target string) tentry {
	h := header(name, tar.TypeLink, 0o644)
	h.Linkname = target
	return tentry{h: h}
}

func fifoEntry(name string, mode int64) tentry {
	return tentry{h: header(name, tar.TypeFifo, mode)}
}

func deviceEntry(name string, typ byte) tentry {
	h := header(name, typ, 0o660)
	h.Devmajor = 8
	return tentry{h: h}
}

func archive(t *testing.T, entries ...tentry) *bytes.Reader {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, e := range entries {
		h := e.h
		if err := tw.WriteHeader(&h); err != nil {
			t.Fatalf("write header %q: %v", h.Name, err)
		}
		if _, err := tw.Write(e.body); err != nil {
			t.Fatalf("write body %q: %v", h.Name, err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("close archive: %v", err)
	}
	return bytes.NewReader(buf.Bytes())
}

type sandboxDirs struct {
	base, root, canary string
}

func newDirs(t *testing.T) sandboxDirs {
	t.Helper()
	base := t.TempDir()
	d := sandboxDirs{base: base, root: filepath.Join(base, "root"), canary: filepath.Join(base, "canary")}
	for _, dir := range []string{d.root, d.canary} {
		if err := os.Mkdir(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(d.canary, ".keep"), []byte("keep\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return d
}

func climb(target string) string {
	return strings.Repeat("../", 24) + strings.TrimPrefix(target, "/")
}

type fileState struct {
	mode  uint32
	uid   uint32
	gid   uint32
	size  int64
	mtime unix.Timespec
	ctime unix.Timespec
}

func lstat(t *testing.T, p string) unix.Stat_t {
	t.Helper()
	var st unix.Stat_t
	if err := unix.Lstat(p, &st); err != nil {
		t.Fatalf("lstat %s: %v", p, err)
	}
	return st
}

func outsideSnapshot(t *testing.T, d sandboxDirs) map[string]fileState {
	t.Helper()
	snap := map[string]fileState{}
	add := func(p string) {
		var st unix.Stat_t
		if err := unix.Lstat(p, &st); err != nil {
			return
		}
		snap[p] = fileState{mode: st.Mode, uid: st.Uid, gid: st.Gid, size: st.Size, mtime: st.Mtim, ctime: st.Ctim}
	}
	err := filepath.WalkDir(d.base, func(p string, e fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == d.root {
			return filepath.SkipDir
		}
		add(p)
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", d.base, err)
	}
	add("/etc/hostname")
	add("/etc/passwd")
	add("/etc")
	return snap
}

func assertOutsideUnchanged(t *testing.T, before, after map[string]fileState) {
	t.Helper()
	for p, s := range before {
		a, ok := after[p]
		if !ok {
			t.Errorf("outside path %s disappeared", p)
			continue
		}
		if a != s {
			t.Errorf("outside path %s changed: %+v -> %+v", p, s, a)
		}
	}
	for p := range after {
		if _, ok := before[p]; !ok {
			t.Errorf("outside path %s appeared", p)
		}
	}
}
