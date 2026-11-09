//go:build linux

package runsc

import (
	"archive/tar"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"

	"github.com/klauspost/compress/zstd"
)

type entry struct {
	name string
	typ  byte
	mode int64
	body string
	link string
}

func archive(t *testing.T, entries []entry) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw, err := zstd.NewWriter(&buf)
	if err != nil {
		t.Fatal(err)
	}
	tw := tar.NewWriter(zw)
	for _, e := range entries {
		h := &tar.Header{Name: e.name, Typeflag: e.typ, Mode: e.mode, Size: int64(len(e.body)), Linkname: e.link}
		if e.typ != tar.TypeReg {
			h.Size = 0
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if e.typ == tar.TypeReg {
			if _, err := tw.Write([]byte(e.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func goodEntries() []entry {
	return []entry{
		{name: "./", typ: tar.TypeDir, mode: 0o755},
		{name: "./gvisor-bin/", typ: tar.TypeDir, mode: 0o775},
		{name: "./gvisor-bin/gvisor_sentry", typ: tar.TypeReg, mode: 0o775, body: "sentry"},
		{name: "./gvisor-bin/runsc-fd-parking", typ: tar.TypeReg, mode: 0o4755, body: "parking"},
		{name: "./runsc", typ: tar.TypeReg, mode: 0o755, body: "runsc-binary"},
	}
}

func requireRoot(t *testing.T) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("needs root")
	}
}

func sum(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func TestInstallGood(t *testing.T) {
	requireRoot(t)
	lib := t.TempDir()
	if err := Install(lib, "20261102.0", bytes.NewReader(archive(t, goodEntries()))); err != nil {
		t.Fatal(err)
	}
	versions, err := Installed(lib)
	if err != nil || !slices.Equal(versions, []string{"20261102.0"}) {
		t.Fatalf("installed %v %v", versions, err)
	}
	sums, err := os.ReadFile(filepath.Join(lib, "runsc-20261102.0.sums"))
	if err != nil {
		t.Fatal(err)
	}
	want := sum("sentry") + "  gvisor-bin/gvisor_sentry\n" + sum("parking") + "  gvisor-bin/runsc-fd-parking\n" + sum("runsc-binary") + "  runsc\n"
	if string(sums) != want {
		t.Errorf("sums\n%s\nwant\n%s", sums, want)
	}
	modes := map[string]fs.FileMode{
		".":                           fs.ModeDir | 0o755,
		"gvisor-bin":                  fs.ModeDir | 0o755,
		"gvisor-bin/gvisor_sentry":    0o755,
		"gvisor-bin/runsc-fd-parking": 0o755,
		"runsc":                       0o755,
	}
	dir := filepath.Join(lib, "runsc-20261102.0")
	for rel, mode := range modes {
		fi, err := os.Lstat(filepath.Join(dir, rel))
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode() != mode {
			t.Errorf("%s mode %v want %v", rel, fi.Mode(), mode)
		}
		st := fi.Sys().(*syscall.Stat_t)
		if st.Uid != 0 || st.Gid != 0 {
			t.Errorf("%s owner %d:%d", rel, st.Uid, st.Gid)
		}
	}
	if _, err := os.Lstat(dir + ".partial"); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("partial left: %v", err)
	}
	problems, err := At(lib, t.TempDir(), "20261102.0").Verify()
	if err != nil || len(problems) != 0 {
		t.Errorf("verify %v %v", problems, err)
	}
	if err := Install(lib, "20261102.0", strings.NewReader("not an archive")); err != nil {
		t.Errorf("second install: %v", err)
	}
}

func TestInstallRefusesBadArchives(t *testing.T) {
	requireRoot(t)
	bad := map[string][]entry{
		"dotdot":         {{name: "../evil", typ: tar.TypeReg, mode: 0o644, body: "x"}},
		"inner dotdot":   {{name: "gvisor-bin/../../evil", typ: tar.TypeReg, mode: 0o644, body: "x"}},
		"absolute":       {{name: "/etc/evil", typ: tar.TypeReg, mode: 0o644, body: "x"}},
		"symlink":        {{name: "gvisor-bin/link", typ: tar.TypeSymlink, link: "/etc/shadow"}},
		"hardlink":       {{name: "gvisor-bin/link", typ: tar.TypeLink, link: "runsc"}},
		"device":         {{name: "gvisor-bin/dev", typ: tar.TypeChar}},
		"other file":     {{name: "containerd-shim-runsc-v1", typ: tar.TypeReg, mode: 0o755, body: "x"}},
		"runsc as dir":   {{name: "runsc/", typ: tar.TypeDir, mode: 0o755}},
		"no runsc":       {{name: "gvisor-bin/", typ: tar.TypeDir, mode: 0o755}},
		"no gvisor-bin":  {{name: "runsc", typ: tar.TypeReg, mode: 0o755, body: "x"}},
		"duplicate file": {{name: "runsc", typ: tar.TypeReg, mode: 0o755, body: "x"}, {name: "runsc", typ: tar.TypeReg, mode: 0o755, body: "y"}},
	}
	for name, entries := range bad {
		lib := t.TempDir()
		all := append(goodEntries(), entries...)
		if name == "no runsc" || name == "no gvisor-bin" {
			all = entries
		}
		if err := Install(lib, "1.0", bytes.NewReader(archive(t, all))); err == nil {
			t.Errorf("%s: installed", name)
		}
		left, err := os.ReadDir(lib)
		if err != nil {
			t.Fatal(err)
		}
		if len(left) != 0 {
			t.Errorf("%s: left %v", name, left)
		}
		if _, err := os.Lstat(filepath.Join(filepath.Dir(lib), "evil")); err == nil {
			t.Errorf("%s: wrote outside", name)
		}
	}
	if err := Install(t.TempDir(), "../x", bytes.NewReader(archive(t, goodEntries()))); err == nil {
		t.Error("bad version accepted")
	}
}

func TestInstalledIgnoresPartial(t *testing.T) {
	lib := t.TempDir()
	for _, d := range []string{"runsc-1.0", "runsc-2.0.partial", "other"} {
		if err := os.Mkdir(filepath.Join(lib, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(lib, "runsc-1.0.sums"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	versions, err := Installed(lib)
	if err != nil || !slices.Equal(versions, []string{"1.0"}) {
		t.Fatalf("%v %v", versions, err)
	}
	versions, err = Installed(filepath.Join(lib, "missing"))
	if err != nil || len(versions) != 0 {
		t.Fatalf("%v %v", versions, err)
	}
}

func installed(t *testing.T) Runtime {
	t.Helper()
	requireRoot(t)
	lib := t.TempDir()
	if err := Install(lib, "1.0", bytes.NewReader(archive(t, goodEntries()))); err != nil {
		t.Fatal(err)
	}
	return At(lib, t.TempDir(), "1.0")
}

func verifyProblems(t *testing.T, rt Runtime) []string {
	t.Helper()
	problems, err := rt.Verify()
	if err != nil {
		t.Fatal(err)
	}
	return problems
}

func TestVerifyDetectsChanges(t *testing.T) {
	rt := installed(t)
	f, err := os.OpenFile(filepath.Join(rt.Dir, "gvisor-bin/gvisor_sentry"), os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString("tampered"); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if got := verifyProblems(t, rt); !slices.Equal(got, []string{"checksum of gvisor-bin/gvisor_sentry differs"}) {
		t.Errorf("modified: %q", got)
	}

	rt = installed(t)
	if err := os.Chmod(filepath.Join(rt.Dir, "runsc"), 0o775); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(rt.Dir, "gvisor-bin"), 0o757); err != nil {
		t.Fatal(err)
	}
	got := verifyProblems(t, rt)
	if !slices.Contains(got, "runsc is writable by group or others") || !slices.Contains(got, "gvisor-bin is writable by group or others") || len(got) != 2 {
		t.Errorf("writable: %q", got)
	}

	rt = installed(t)
	if err := os.Lchown(filepath.Join(rt.Dir, "runsc"), 1000, 0); err != nil {
		t.Fatal(err)
	}
	if got := verifyProblems(t, rt); !slices.Equal(got, []string{"runsc is not root-owned"}) {
		t.Errorf("owner: %q", got)
	}

	rt = installed(t)
	if err := os.WriteFile(filepath.Join(rt.Dir, "gvisor-bin/extra"), []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(rt.Dir, "gvisor-bin/runsc-fd-parking")); err != nil {
		t.Fatal(err)
	}
	if got := verifyProblems(t, rt); !slices.Equal(got, []string{"unexpected file gvisor-bin/extra", "missing gvisor-bin/runsc-fd-parking"}) {
		t.Errorf("extra/missing: %q", got)
	}

	rt = installed(t)
	if err := os.RemoveAll(filepath.Join(rt.Dir, "gvisor-bin")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(rt.Dir, "runsc")); err != nil {
		t.Fatal(err)
	}
	if got := verifyProblems(t, rt); !slices.Equal(got, []string{"missing runsc", "missing gvisor-bin"}) {
		t.Errorf("missing: %q", got)
	}

	rt = installed(t)
	if err := os.Remove(rt.Dir + ".sums"); err != nil {
		t.Fatal(err)
	}
	if got := verifyProblems(t, rt); !slices.Equal(got, []string{"missing runsc-1.0.sums"}) {
		t.Errorf("no sums: %q", got)
	}

	missing := At(t.TempDir(), t.TempDir(), "9.9")
	if got := verifyProblems(t, missing); !slices.Equal(got, []string{"missing runsc", "missing gvisor-bin"}) {
		t.Errorf("not installed: %q", got)
	}
}

func TestRemove(t *testing.T) {
	requireRoot(t)
	lib, state := t.TempDir(), t.TempDir()
	if err := Install(lib, "1.0", bytes.NewReader(archive(t, goodEntries()))); err != nil {
		t.Fatal(err)
	}
	if err := Install(lib, "2.0", bytes.NewReader(archive(t, goodEntries()))); err != nil {
		t.Fatal(err)
	}
	vstate := filepath.Join(state, "1.0")
	if err := os.MkdirAll(vstate, 0o711); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(vstate, "null-netns"), nil, 0o444); err != nil {
		t.Fatal(err)
	}
	if err := Remove(lib, state, "1.0"); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{filepath.Join(lib, "runsc-1.0"), filepath.Join(lib, "runsc-1.0.sums"), vstate} {
		if _, err := os.Lstat(p); !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("%s still there: %v", p, err)
		}
	}
	versions, err := Installed(lib)
	if err != nil || !slices.Equal(versions, []string{"2.0"}) {
		t.Errorf("%v %v", versions, err)
	}
	if err := Remove(lib, state, "1.0"); err != nil {
		t.Errorf("second remove: %v", err)
	}
	if err := Remove(lib, state, ".."); err == nil {
		t.Error("bad version accepted")
	}
}
