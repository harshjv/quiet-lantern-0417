//go:build linux

package diskfs

import (
	"archive/tar"
	"bytes"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func capabilityNetRaw() []byte {
	b := make([]byte, 20)
	binary.LittleEndian.PutUint32(b[0:], 0x02000000|0x1)
	binary.LittleEndian.PutUint32(b[4:], 1<<unix.CAP_NET_RAW)
	return b
}

func assertMode(t *testing.T, p string, want uint32) {
	t.Helper()
	if got := lstat(t, p).Mode & 0o7777; got != want {
		t.Errorf("%s mode %o, want %o", p, got, want)
	}
}

func assertOwner(t *testing.T, p string, uid, gid int) {
	t.Helper()
	if !isRoot() {
		return
	}
	st := lstat(t, p)
	if int(st.Uid) != uid || int(st.Gid) != gid {
		t.Errorf("%s owner %d:%d, want %d:%d", p, st.Uid, st.Gid, uid, gid)
	}
}

func assertMtime(t *testing.T, p string, want int64) {
	t.Helper()
	if got := lstat(t, p).Mtim.Sec; got != want {
		t.Errorf("%s mtime %d, want %d", p, got, want)
	}
}

func TestUnpackTree(t *testing.T) {
	d := newDirs(t)
	hostTarget := filepath.Join(d.canary, ".keep")

	rootDir := dirEntry("./", 0o755)
	home := dirEntry("./home/u/", 0o700)
	home.h.Uid, home.h.Gid = ids(1000, 1000)
	home.h.ModTime = year2001
	notes := regEntry("./home/u/notes", []byte("notes\n"))
	notes.h.Mode = 0o640
	notes.h.Uid, notes.h.Gid = ids(1000, 1000)
	notes.h.ModTime = year2001
	xping := regEntry("./bin/xping", []byte("#!/bin/sh\necho ping\n"))
	xping.h.Mode = 0o4755
	xping.h.Uid, xping.h.Gid = ids(1234, 5678)
	if isRoot() {
		xping.h.PAXRecords = map[string]string{
			"SCHILY.xattr.security.capability": string(capabilityNetRaw()),
			"SCHILY.xattr.user.note":           "dropped",
		}
	}
	abs := symEntry("./bin/abs", hostTarget)
	abs.h.Uid, abs.h.Gid = ids(1234, 5678)
	abs.h.ModTime = year2001
	fifo := fifoEntry("./run/fifo", 0o620)
	fifo.h.ModTime = year2001
	tmp := dirEntry("./tmp/", 0o1777)

	before := outsideSnapshot(t, d)
	stats, err := Unpack(d.root, archive(t,
		rootDir,
		dirEntry("./bin/", 0o755),
		xping,
		hardEntry("./bin/xping2", "./bin/xping"),
		hardEntry("bin/xping3", "bin/xping"),
		abs,
		symEntry("./bin/rel", "xping"),
		symEntry("./bin/s", "nowhere"),
		hardEntry("./bin/hs", "bin/s"),
		dirEntry("./home/", 0o755),
		home,
		notes,
		dirEntry("./run/", 0o755),
		fifo,
		tmp,
		dirEntry("./bin", 0o711),
		deviceEntry("./dev-null", tar.TypeChar),
	))
	if err != nil {
		t.Fatalf("unpack: %v", err)
	}
	assertOutsideUnchanged(t, before, outsideSnapshot(t, d))

	want := Stats{Entries: 17, Files: 2, Dirs: 7, Symlinks: 3, HardLinks: 3, FIFOs: 1, Skipped: 1, Bytes: int64(len(xping.body) + len(notes.body))}
	if stats != want {
		t.Errorf("stats %+v, want %+v", stats, want)
	}

	p := func(rel string) string { return filepath.Join(d.root, rel) }
	assertMode(t, p("bin"), 0o711)
	assertMode(t, p("bin/xping"), 0o4755)
	assertOwner(t, p("bin/xping"), 1234, 5678)
	assertMode(t, p("home/u"), 0o700)
	assertOwner(t, p("home/u"), 1000, 1000)
	assertMode(t, p("home/u/notes"), 0o640)
	assertMode(t, p("tmp"), 0o1777)
	assertMtime(t, p("home/u"), year2001.Unix())
	assertMtime(t, p("home/u/notes"), year2001.Unix())
	assertMtime(t, d.root, epoch.Unix())
	assertMtime(t, p("bin"), epoch.Unix())
	assertMtime(t, p("bin/abs"), year2001.Unix())
	assertOwner(t, p("bin/abs"), 1234, 5678)

	data, err := os.ReadFile(p("bin/xping"))
	if err != nil || !bytes.Equal(data, xping.body) {
		t.Errorf("xping content %q, %v", data, err)
	}

	if isRoot() {
		buf := make([]byte, 64)
		n, err := unix.Getxattr(p("bin/xping"), "security.capability", buf)
		if err != nil {
			t.Fatalf("getxattr: %v", err)
		}
		if !bytes.Equal(buf[:n], capabilityNetRaw()) {
			t.Errorf("capability %x, want %x", buf[:n], capabilityNetRaw())
		}
		if _, err := unix.Getxattr(p("bin/xping"), "user.note", buf); !errors.Is(err, unix.ENODATA) {
			t.Errorf("user.note xattr: %v, want ENODATA", err)
		}
	}

	for _, link := range []string{"bin/xping2", "bin/xping3"} {
		if lstat(t, p(link)).Ino != lstat(t, p("bin/xping")).Ino {
			t.Errorf("%s is not a hard link of bin/xping", link)
		}
	}
	hs := lstat(t, p("bin/hs"))
	if hs.Mode&unix.S_IFMT != unix.S_IFLNK || hs.Ino != lstat(t, p("bin/s")).Ino {
		t.Errorf("bin/hs is not a hard link of the symlink bin/s")
	}

	for rel, target := range map[string]string{"bin/abs": hostTarget, "bin/rel": "xping", "bin/s": "nowhere"} {
		got, err := os.Readlink(p(rel))
		if err != nil || got != target {
			t.Errorf("readlink %s = %q, %v; want %q", rel, got, err, target)
		}
	}

	st := lstat(t, p("run/fifo"))
	if st.Mode&unix.S_IFMT != unix.S_IFIFO || st.Mode&0o7777 != 0o620 {
		t.Errorf("run/fifo mode %o", st.Mode)
	}
	assertMtime(t, p("run/fifo"), year2001.Unix())

	if _, err := os.Lstat(p("dev-null")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("char device was created: %v", err)
	}
}

func TestUnpackSetuidSurvivesOwnerAndCapability(t *testing.T) {
	if !isRoot() {
		t.Skip("needs root to chown and set security.capability")
	}
	d := newDirs(t)
	f := regEntry("ping", []byte("x"))
	f.h.Mode = 0o6755
	f.h.Uid, f.h.Gid = 0, 0
	f.h.PAXRecords = map[string]string{"SCHILY.xattr.security.capability": string(capabilityNetRaw())}
	if _, err := Unpack(d.root, archive(t, f)); err != nil {
		t.Fatalf("unpack: %v", err)
	}
	assertMode(t, filepath.Join(d.root, "ping"), 0o6755)
	buf := make([]byte, 64)
	n, err := unix.Getxattr(filepath.Join(d.root, "ping"), "security.capability", buf)
	if err != nil || !bytes.Equal(buf[:n], capabilityNetRaw()) {
		t.Errorf("capability %x, %v", buf[:n], err)
	}
}

func TestUnpackHoles(t *testing.T) {
	d := newDirs(t)
	chunk := 64 << 10
	mixed := make([]byte, 5*chunk+6)
	copy(mixed[3*chunk:], "hello")
	mixed[len(mixed)-1] = 'x'
	zeros := make([]byte, 8<<20)
	tail := append([]byte("abc"), make([]byte, 1<<20)...)

	stats, err := Unpack(d.root, archive(t,
		regEntry("mixed", mixed),
		regEntry("zeros", zeros),
		regEntry("tail", tail),
		regEntry("empty", nil),
	))
	if err != nil {
		t.Fatalf("unpack: %v", err)
	}
	wantHoles := int64(4*chunk) + int64(len(zeros)) + int64(len(tail)-chunk)
	wantBytes := int64(chunk+6) + int64(chunk)
	if stats.HoleBytes != wantHoles || stats.Bytes != wantBytes {
		t.Errorf("holes %d bytes %d, want %d and %d", stats.HoleBytes, stats.Bytes, wantHoles, wantBytes)
	}
	for name, body := range map[string][]byte{"mixed": mixed, "zeros": zeros, "tail": tail, "empty": nil} {
		p := filepath.Join(d.root, name)
		got, err := os.ReadFile(p)
		if err != nil || !bytes.Equal(got, body) {
			t.Errorf("%s content differs (%d bytes, %v)", name, len(got), err)
		}
		st := lstat(t, p)
		if st.Size != int64(len(body)) {
			t.Errorf("%s size %d, want %d", name, st.Size, len(body))
		}
		if len(body) > 0 && st.Blocks*512 >= int64(len(body))/2 {
			t.Errorf("%s allocates %d bytes for %d, want holes", name, st.Blocks*512, len(body))
		}
	}
	if st := lstat(t, filepath.Join(d.root, "zeros")); st.Blocks != 0 {
		t.Errorf("zeros allocates %d blocks, want 0", st.Blocks)
	}
}

func TestUnpackFIFOTimes(t *testing.T) {
	d := newDirs(t)
	f := fifoEntry("pipe", 0o640)
	f.h.ModTime = year2001
	f.h.AccessTime = year2001.Add(3600e9)
	if _, err := Unpack(d.root, archive(t, f)); err != nil {
		t.Fatalf("unpack: %v", err)
	}
	st := lstat(t, filepath.Join(d.root, "pipe"))
	if st.Mtim.Sec != year2001.Unix() || st.Atim.Sec != year2001.Unix()+3600 {
		t.Errorf("fifo times atime %d mtime %d", st.Atim.Sec, st.Mtim.Sec)
	}
}

func TestUnpackTruncatedArchive(t *testing.T) {
	d := newDirs(t)
	r := archive(t, regEntry("big", bytes.Repeat([]byte("a"), 200<<10)))
	data := make([]byte, 100<<10)
	n, err := r.Read(data)
	if err != nil {
		t.Fatal(err)
	}
	_, err = Unpack(d.root, bytes.NewReader(data[:n]))
	if err == nil {
		t.Fatal("unpack of a truncated archive succeeded")
	}
	var refusal *Refusal
	if errors.As(err, &refusal) {
		t.Errorf("truncated archive refused as %v", refusal)
	}
}

func TestUnpackHostile(t *testing.T) {
	type check func(t *testing.T, d sandboxDirs, stats Stats, err error)
	refused := func(entry, reason string) check {
		return func(t *testing.T, _ sandboxDirs, _ Stats, err error) {
			var refusal *Refusal
			if !errors.As(err, &refusal) {
				t.Fatalf("error %v, want refusal %s", err, reason)
			}
			if refusal.Reason != reason || refusal.Entry != entry {
				t.Errorf("refusal %+v, want %s for %q", refusal, reason, entry)
			}
		}
	}
	failed := func(errno unix.Errno) check {
		return func(t *testing.T, _ sandboxDirs, _ Stats, err error) {
			var refusal *Refusal
			if err == nil || errors.As(err, &refusal) || !errors.Is(err, errno) {
				t.Errorf("error %v, want a failure with %v", err, errno)
			}
		}
	}
	both := func(checks ...check) check {
		return func(t *testing.T, d sandboxDirs, stats Stats, err error) {
			for _, c := range checks {
				c(t, d, stats, err)
			}
		}
	}
	exists := func(rel string, want bool) check {
		return func(t *testing.T, d sandboxDirs, _ Stats, _ error) {
			_, err := os.Lstat(filepath.Join(d.root, rel))
			if want && err != nil {
				t.Errorf("%s missing in root: %v", rel, err)
			}
			if !want && !errors.Is(err, os.ErrNotExist) {
				t.Errorf("%s exists in root: %v", rel, err)
			}
		}
	}
	inRootDirs := func(abs string) []tentry {
		var out []tentry
		parts := strings.Split(strings.Trim(abs, "/"), "/")
		for i := range parts {
			out = append(out, dirEntry(strings.Join(parts[:i+1], "/")+"/", 0o755))
		}
		return out
	}

	cases := []struct {
		name    string
		entries func(d sandboxDirs) []tentry
		check   check
	}{
		{
			name: "dotdot",
			entries: func(d sandboxDirs) []tentry {
				return []tentry{regEntry(climb(d.canary)+"/dotdot", []byte("pwned\n"))}
			},
			check: func(t *testing.T, d sandboxDirs, s Stats, err error) {
				refused(climb(d.canary)+"/dotdot", ReasonParentReference)(t, d, s, err)
			},
		},
		{
			name: "absolute",
			entries: func(d sandboxDirs) []tentry {
				return []tentry{regEntry(d.canary+"/absolute", []byte("pwned\n"))}
			},
			check: func(t *testing.T, d sandboxDirs, s Stats, err error) {
				refused(d.canary+"/absolute", ReasonAbsolutePath)(t, d, s, err)
			},
		},
		{
			name: "dot slash absolute",
			entries: func(d sandboxDirs) []tentry {
				return []tentry{regEntry(".//"+strings.TrimPrefix(d.canary, "/")+"/x", []byte("pwned\n"))}
			},
			check: func(t *testing.T, d sandboxDirs, s Stats, err error) {
				refused(".//"+strings.TrimPrefix(d.canary, "/")+"/x", ReasonAbsolutePath)(t, d, s, err)
			},
		},
		{
			name: "inner dotdot",
			entries: func(d sandboxDirs) []tentry {
				return []tentry{dirEntry("a/", 0o755), regEntry("a/../"+climb(d.canary)+"/inner", []byte("pwned\n"))}
			},
			check: func(t *testing.T, d sandboxDirs, s Stats, err error) {
				refused("a/../"+climb(d.canary)+"/inner", ReasonParentReference)(t, d, s, err)
			},
		},
		{
			name: "a/../..",
			entries: func(d sandboxDirs) []tentry {
				return []tentry{dirEntry("a/", 0o755), dirEntry("a/../..", 0o777)}
			},
			check: refused("a/../..", ReasonParentReference),
		},
		{
			name: "symlink escape absolute, missing in root",
			entries: func(d sandboxDirs) []tentry {
				return []tentry{symEntry("esc", d.canary), regEntry("esc/via-abs-symlink", []byte("pwned\n"))}
			},
			check: both(failed(unix.ENOENT), exists("esc/via-abs-symlink", false)),
		},
		{
			name: "symlink escape absolute, resolves in root",
			entries: func(d sandboxDirs) []tentry {
				return append(inRootDirs(d.canary), symEntry("esc", d.canary), regEntry("esc/via-abs-symlink", []byte("inside\n")))
			},
			check: func(t *testing.T, d sandboxDirs, _ Stats, err error) {
				if err != nil {
					t.Fatalf("unpack: %v", err)
				}
				got, err := os.ReadFile(filepath.Join(d.root, d.canary, "via-abs-symlink"))
				if err != nil || string(got) != "inside\n" {
					t.Errorf("in-root file %q, %v", got, err)
				}
			},
		},
		{
			name: "symlink escape relative, resolves in root",
			entries: func(d sandboxDirs) []tentry {
				return append(inRootDirs(d.canary), dirEntry("deep/", 0o755), symEntry("deep/up", climb(d.canary)), regEntry("deep/up/via-rel-symlink", []byte("inside\n")))
			},
			check: func(t *testing.T, d sandboxDirs, _ Stats, err error) {
				if err != nil {
					t.Fatalf("unpack: %v", err)
				}
				got, err := os.ReadFile(filepath.Join(d.root, d.canary, "via-rel-symlink"))
				if err != nil || string(got) != "inside\n" {
					t.Errorf("in-root file %q, %v", got, err)
				}
			},
		},
		{
			name: "symlink escape relative, missing in root",
			entries: func(d sandboxDirs) []tentry {
				return []tentry{symEntry("up", climb(d.canary)), regEntry("up/via-rel-symlink", []byte("pwned\n"))}
			},
			check: failed(unix.ENOENT),
		},
		{
			name: "directory over symlink",
			entries: func(d sandboxDirs) []tentry {
				return []tentry{symEntry("d", d.canary), dirEntry("d/", 0o777)}
			},
			check: failed(unix.ENOTDIR),
		},
		{
			name: "hardlink out",
			entries: func(d sandboxDirs) []tentry {
				return []tentry{hardEntry("hl", "../../../../etc/hostname")}
			},
			check: both(refused("hl", ReasonLinkOutsideRoot), exists("hl", false)),
		},
		{
			name: "hardlink absolute",
			entries: func(d sandboxDirs) []tentry {
				return []tentry{hardEntry("hl", "/etc/hostname")}
			},
			check: both(refused("hl", ReasonLinkOutsideRoot), exists("hl", false)),
		},
		{
			name: "hardlink via symlink",
			entries: func(d sandboxDirs) []tentry {
				return []tentry{dirEntry("etc/", 0o755), regEntry("etc/hostname", []byte("in-root\n")), symEntry("etcl", "/etc"), hardEntry("hl", "etcl/hostname")}
			},
			check: both(refused("hl", ReasonLinkOutsideRoot), exists("hl", false)),
		},
		{
			name: "hardlink via symlink to host",
			entries: func(d sandboxDirs) []tentry {
				return []tentry{symEntry("etcl", "/etc"), hardEntry("hl", "etcl/hostname")}
			},
			check: both(refused("hl", ReasonLinkOutsideRoot), exists("hl", false)),
		},
		{
			name: "regular file over symlink",
			entries: func(d sandboxDirs) []tentry {
				return []tentry{symEntry("x", d.canary+"/target"), regEntry("x", []byte("pwned\n"))}
			},
			check: func(t *testing.T, d sandboxDirs, s Stats, err error) {
				failed(unix.EEXIST)(t, d, s, err)
				if got, _ := os.Readlink(filepath.Join(d.root, "x")); got != d.canary+"/target" {
					t.Errorf("symlink x replaced, reads %q", got)
				}
			},
		},
		{
			name: "block device",
			entries: func(d sandboxDirs) []tentry {
				return []tentry{deviceEntry("dev-sda", tar.TypeBlock)}
			},
			check: func(t *testing.T, d sandboxDirs, s Stats, err error) {
				if err != nil {
					t.Fatalf("unpack: %v", err)
				}
				if s.Skipped != 1 || s.Entries != 1 {
					t.Errorf("stats %+v", s)
				}
				exists("dev-sda", false)(t, d, s, err)
			},
		},
		{
			name: "duplicate regular",
			entries: func(d sandboxDirs) []tentry {
				return []tentry{regEntry("dup", []byte("first\n")), regEntry("dup", []byte("second\n"))}
			},
			check: func(t *testing.T, d sandboxDirs, s Stats, err error) {
				failed(unix.EEXIST)(t, d, s, err)
				if got, _ := os.ReadFile(filepath.Join(d.root, "dup")); string(got) != "first\n" {
					t.Errorf("dup content %q", got)
				}
			},
		},
		{
			name: "duplicate symlink",
			entries: func(d sandboxDirs) []tentry {
				return []tentry{regEntry("f", []byte("first\n")), symEntry("f", d.canary)}
			},
			check: failed(unix.EEXIST),
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := newDirs(t)
			before := outsideSnapshot(t, d)
			stats, err := Unpack(d.root, archive(t, c.entries(d)...))
			c.check(t, d, stats, err)
			assertOutsideUnchanged(t, before, outsideSnapshot(t, d))
		})
	}
}

func TestIsNoSpace(t *testing.T) {
	for _, errno := range []unix.Errno{unix.ENOSPC, unix.EDQUOT} {
		err := errors.Join(errors.New("context"), errno)
		if !IsNoSpace(err) {
			t.Errorf("IsNoSpace(%v) = false", errno)
		}
	}
	if IsNoSpace(unix.EEXIST) {
		t.Error("IsNoSpace(EEXIST) = true")
	}
}
