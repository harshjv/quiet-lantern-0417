//go:build linux

package diskfs

import (
	"archive/tar"
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"math"
	"path"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

const (
	ReasonAbsolutePath    = "absolute_path"
	ReasonParentReference = "parent_reference"
	ReasonLinkOutsideRoot = "link_outside_root"
)

const (
	chunkSize        = 64 << 10
	readBufferSize   = 1 << 20
	dirCacheSize     = 128
	capabilityXattr  = "security.capability"
	capabilityRecord = "SCHILY.xattr." + capabilityXattr
)

type Refusal struct{ Entry, Reason string }

func (r *Refusal) Error() string {
	return fmt.Sprintf("refused %s: %q", r.Reason, r.Entry)
}

type Stats struct {
	Entries, Files, Dirs, Symlinks, HardLinks, FIFOs, Skipped int
	Bytes, HoleBytes                                          int64
}

func IsNoSpace(err error) bool {
	return errors.Is(err, unix.ENOSPC) || errors.Is(err, unix.EDQUOT)
}

type dirTime struct {
	rel   string
	times []unix.Timespec
}

type unpacker struct {
	root     int
	dirs     *dirCache
	dirTimes []dirTime
	stats    Stats
	buf      []byte
	zero     []byte
}

func Unpack(root string, r io.Reader) (stats Stats, err error) {
	rootfd, err := openRoot(root, unix.O_RDONLY)
	if err != nil {
		return Stats{}, err
	}
	u := &unpacker{
		root: rootfd,
		dirs: newDirCache(rootfd, dirCacheSize),
		buf:  make([]byte, chunkSize),
		zero: make([]byte, chunkSize),
	}
	defer func() {
		cerr := errors.Join(u.dirs.close(), closeErr(rootfd, root))
		if err == nil && cerr != nil {
			err = cerr
		}
	}()
	tr := tar.NewReader(bufio.NewReaderSize(r, readBufferSize))
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return u.stats, fmt.Errorf("read archive after %d entries: %w", u.stats.Entries, err)
		}
		u.stats.Entries++
		if err := u.entry(h, tr); err != nil {
			var refusal *Refusal
			if errors.As(err, &refusal) {
				return u.stats, refusal
			}
			return u.stats, fmt.Errorf("unpack entry %q: %w", h.Name, err)
		}
	}
	if err := u.applyDirTimes(); err != nil {
		return u.stats, err
	}
	return u.stats, nil
}

func closeErr(fd int, what string) error {
	if err := unix.Close(fd); err != nil {
		return fmt.Errorf("close %s: %w", what, err)
	}
	return nil
}

func closeInto(fd int, err *error) {
	if cerr := unix.Close(fd); cerr != nil && *err == nil {
		*err = fmt.Errorf("close: %w", cerr)
	}
}

func cleanName(name string) (string, string) {
	name = strings.TrimPrefix(name, "./")
	if strings.HasPrefix(name, "/") {
		return "", ReasonAbsolutePath
	}
	for part := range strings.SplitSeq(name, "/") {
		if part == ".." {
			return "", ReasonParentReference
		}
	}
	return path.Clean(name), ""
}

func splitParent(rel string) (string, string) {
	dir, base := path.Split(rel)
	if dir == "" {
		return ".", base
	}
	return path.Clean(dir), base
}

func timespecs(h *tar.Header) []unix.Timespec {
	atime := h.AccessTime
	if atime.IsZero() {
		atime = h.ModTime
	}
	return []unix.Timespec{toTimespec(atime), toTimespec(h.ModTime)}
}

func toTimespec(t time.Time) unix.Timespec {
	return unix.NsecToTimespec(t.UnixNano())
}

func owner(h *tar.Header) (int, int, error) {
	if h.Uid < 0 || h.Uid >= math.MaxUint32 || h.Gid < 0 || h.Gid >= math.MaxUint32 {
		return 0, 0, fmt.Errorf("invalid owner %d:%d", h.Uid, h.Gid)
	}
	return h.Uid, h.Gid, nil
}

func (u *unpacker) entry(h *tar.Header, r io.Reader) error {
	rel, reason := cleanName(h.Name)
	if reason != "" {
		return &Refusal{Entry: h.Name, Reason: reason}
	}
	switch h.Typeflag {
	case tar.TypeChar, tar.TypeBlock, tar.TypeXGlobalHeader:
		u.stats.Skipped++
		return nil
	}
	if rel == "." {
		if h.Typeflag != tar.TypeDir {
			return fmt.Errorf("root entry has type %q, not a directory", h.Typeflag)
		}
		u.stats.Dirs++
		u.dirTimes = append(u.dirTimes, dirTime{rel: rel, times: timespecs(h)})
		return u.meta(u.root, h)
	}
	dir, base := splitParent(rel)
	pfd, err := u.dirs.get(dir)
	if err != nil {
		return fmt.Errorf("open parent %q: %w", dir, err)
	}
	switch h.Typeflag {
	case tar.TypeDir:
		return u.directory(pfd, rel, base, h)
	case tar.TypeReg, tar.TypeGNUSparse:
		return u.regular(pfd, base, h, r)
	case tar.TypeSymlink:
		return u.symlink(pfd, base, h)
	case tar.TypeLink:
		return u.hardLink(pfd, base, h)
	case tar.TypeFifo:
		return u.fifo(pfd, base, h)
	}
	return fmt.Errorf("unsupported entry type %q", h.Typeflag)
}

func (u *unpacker) meta(fd int, h *tar.Header) error {
	uid, gid, err := owner(h)
	if err != nil {
		return err
	}
	if err := unix.Fchown(fd, uid, gid); err != nil {
		return fmt.Errorf("fchown: %w", err)
	}
	if err := unix.Fchmod(fd, uint32(h.Mode&0o7777)); err != nil {
		return fmt.Errorf("fchmod: %w", err)
	}
	if value, ok := h.PAXRecords[capabilityRecord]; ok {
		if err := unix.Fsetxattr(fd, capabilityXattr, []byte(value), 0); err != nil {
			return fmt.Errorf("fsetxattr %s: %w", capabilityXattr, err)
		}
	}
	return nil
}

func setTimes(pfd int, base string, times []unix.Timespec) error {
	if err := unix.UtimesNanoAt(pfd, base, times, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return fmt.Errorf("utimensat: %w", err)
	}
	return nil
}

func (u *unpacker) directory(pfd int, rel, base string, h *tar.Header) (err error) {
	if err := unix.Mkdirat(pfd, base, 0o700); err != nil && !errors.Is(err, unix.EEXIST) {
		return fmt.Errorf("mkdirat: %w", err)
	}
	fd, err := openat2(pfd, base, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW, 0, resolveBeneath)
	if err != nil {
		return fmt.Errorf("open directory: %w", err)
	}
	defer closeInto(fd, &err)
	if err := u.meta(fd, h); err != nil {
		return err
	}
	u.stats.Dirs++
	u.dirTimes = append(u.dirTimes, dirTime{rel: rel, times: timespecs(h)})
	return nil
}

func (u *unpacker) regular(pfd int, base string, h *tar.Header, r io.Reader) (err error) {
	fd, err := openat2(pfd, base, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW, 0o600, resolveBeneath)
	if err != nil {
		return fmt.Errorf("create: %w", err)
	}
	defer closeInto(fd, &err)
	if err := u.writeContent(fd, r, h.Size); err != nil {
		return err
	}
	if err := u.meta(fd, h); err != nil {
		return err
	}
	if err := setTimes(pfd, base, timespecs(h)); err != nil {
		return err
	}
	u.stats.Files++
	return nil
}

func (u *unpacker) writeContent(fd int, r io.Reader, size int64) error {
	if size < 0 {
		return fmt.Errorf("invalid size %d", size)
	}
	var off int64
	for off < size {
		chunk := u.buf[:min(int64(chunkSize), size-off)]
		if _, err := io.ReadFull(r, chunk); err != nil {
			return fmt.Errorf("read content at offset %d: %w", off, err)
		}
		if bytes.Equal(chunk, u.zero[:len(chunk)]) {
			u.stats.HoleBytes += int64(len(chunk))
		} else {
			if err := pwriteAll(fd, chunk, off); err != nil {
				return err
			}
			u.stats.Bytes += int64(len(chunk))
		}
		off += int64(len(chunk))
	}
	if err := unix.Ftruncate(fd, size); err != nil {
		return fmt.Errorf("ftruncate: %w", err)
	}
	return nil
}

func pwriteAll(fd int, p []byte, off int64) error {
	for len(p) > 0 {
		n, err := unix.Pwrite(fd, p, off)
		if err != nil {
			if errors.Is(err, unix.EINTR) {
				continue
			}
			return fmt.Errorf("pwrite at offset %d: %w", off, err)
		}
		if n == 0 {
			return fmt.Errorf("pwrite at offset %d: %w", off, io.ErrShortWrite)
		}
		p = p[n:]
		off += int64(n)
	}
	return nil
}

func (u *unpacker) symlink(pfd int, base string, h *tar.Header) error {
	uid, gid, err := owner(h)
	if err != nil {
		return err
	}
	if err := unix.Symlinkat(h.Linkname, pfd, base); err != nil {
		return fmt.Errorf("symlinkat: %w", err)
	}
	if err := unix.Fchownat(pfd, base, uid, gid, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return fmt.Errorf("fchownat: %w", err)
	}
	if err := setTimes(pfd, base, timespecs(h)); err != nil {
		return err
	}
	u.stats.Symlinks++
	return nil
}

func (u *unpacker) hardLink(pfd int, base string, h *tar.Header) (err error) {
	target, reason := cleanName(h.Linkname)
	if reason != "" || target == "." {
		return &Refusal{Entry: h.Name, Reason: ReasonLinkOutsideRoot}
	}
	tfd, err := openat2(u.root, target, unix.O_PATH|unix.O_NOFOLLOW, 0, resolveInRoot|unix.RESOLVE_NO_SYMLINKS)
	if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.EXDEV) {
		return &Refusal{Entry: h.Name, Reason: ReasonLinkOutsideRoot}
	}
	if err != nil {
		return fmt.Errorf("open link target %q: %w", h.Linkname, err)
	}
	defer closeInto(tfd, &err)
	if err := unix.Linkat(tfd, "", pfd, base, unix.AT_EMPTY_PATH); err != nil {
		return fmt.Errorf("linkat to %q: %w", h.Linkname, err)
	}
	u.stats.HardLinks++
	return nil
}

func (u *unpacker) fifo(pfd int, base string, h *tar.Header) (err error) {
	if err := unix.Mknodat(pfd, base, unix.S_IFIFO|0o600, 0); err != nil {
		return fmt.Errorf("mknodat: %w", err)
	}
	fd, err := openat2(pfd, base, unix.O_RDONLY|unix.O_NONBLOCK|unix.O_NOFOLLOW, 0, resolveBeneath)
	if err != nil {
		return fmt.Errorf("open fifo: %w", err)
	}
	defer closeInto(fd, &err)
	if err := u.meta(fd, h); err != nil {
		return err
	}
	if err := setTimes(pfd, base, timespecs(h)); err != nil {
		return err
	}
	u.stats.FIFOs++
	return nil
}

func (u *unpacker) applyDirTimes() error {
	for _, d := range u.dirTimes {
		if d.rel == "." {
			if err := setTimes(u.root, ".", d.times); err != nil {
				return fmt.Errorf("set times of root: %w", err)
			}
			continue
		}
		dir, base := splitParent(d.rel)
		pfd, err := u.dirs.get(dir)
		if err != nil {
			return fmt.Errorf("set times of %q: open parent: %w", d.rel, err)
		}
		if err := setTimes(pfd, base, d.times); err != nil {
			return fmt.Errorf("set times of %q: %w", d.rel, err)
		}
	}
	return nil
}
