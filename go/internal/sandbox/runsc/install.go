//go:build linux

package runsc

import (
	"archive/tar"
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"syscall"

	"github.com/klauspost/compress/zstd"
)

const (
	binaryName  = "runsc"
	sidecarDir  = "gvisor-bin"
	partialExt  = ".partial"
	sumsExt     = ".sums"
	dirMode     = 0o755
	sumsMode    = 0o644
	maxFileMode = 0o755
)

func Installed(libDir string) ([]string, error) {
	entries, err := os.ReadDir(libDir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var versions []string
	for _, e := range entries {
		v, ok := strings.CutPrefix(e.Name(), "runsc-")
		if !ok || !e.IsDir() || strings.HasSuffix(v, partialExt) || checkVersion(v) != nil {
			continue
		}
		versions = append(versions, v)
	}
	slices.Sort(versions)
	return versions, nil
}

func Install(libDir, version string, archive io.Reader) error {
	if err := checkVersion(version); err != nil {
		return err
	}
	final := filepath.Join(libDir, "runsc-"+version)
	fi, err := os.Lstat(final)
	if err == nil {
		if fi.IsDir() {
			return nil
		}
		return fmt.Errorf("runsc: %s exists and is not a directory", final)
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(libDir, dirMode); err != nil {
		return err
	}
	partial := final + partialExt
	sums := final + sumsExt
	if err := os.RemoveAll(partial); err != nil {
		return err
	}
	if err := unpack(partial, sums, archive); err != nil {
		return errors.Join(err, os.RemoveAll(partial), os.RemoveAll(sums))
	}
	if err := os.Rename(partial, final); err != nil {
		return errors.Join(err, os.RemoveAll(partial), os.RemoveAll(sums))
	}
	return syncDir(libDir)
}

func unpack(partial, sumsPath string, archive io.Reader) error {
	zr, err := zstd.NewReader(archive)
	if err != nil {
		return err
	}
	defer zr.Close()
	if err := os.Mkdir(partial, 0o700); err != nil {
		return err
	}
	modes := map[string]fs.FileMode{}
	tr := tar.NewReader(zr)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("runsc: reading archive: %w", err)
		}
		rel, err := entryPath(h)
		if err != nil {
			return err
		}
		if rel == "" {
			continue
		}
		target := filepath.Join(partial, filepath.FromSlash(rel))
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o700); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
				return err
			}
			if err := writeFile(target, tr); err != nil {
				return err
			}
			modes[rel] = fs.FileMode(h.Mode) & maxFileMode
		}
	}
	if fi, err := os.Lstat(filepath.Join(partial, binaryName)); err != nil || !fi.Mode().IsRegular() {
		return errors.New("runsc: archive has no runsc binary")
	}
	if fi, err := os.Lstat(filepath.Join(partial, sidecarDir)); err != nil || !fi.IsDir() {
		return errors.New("runsc: archive has no gvisor-bin directory")
	}
	if err := seal(partial, modes); err != nil {
		return err
	}
	lines, err := checksums(partial)
	if err != nil {
		return err
	}
	return writeSums(sumsPath, lines)
}

func entryPath(h *tar.Header) (string, error) {
	name := h.Name
	if path.IsAbs(name) || strings.HasPrefix(name, "\\") {
		return "", fmt.Errorf("runsc: archive entry %q is absolute", name)
	}
	for _, seg := range strings.Split(name, "/") {
		if seg == ".." {
			return "", fmt.Errorf("runsc: archive entry %q leaves the directory", name)
		}
	}
	rel := path.Clean(name)
	switch h.Typeflag {
	case tar.TypeDir:
		if rel == "." {
			return "", nil
		}
		if rel == sidecarDir || strings.HasPrefix(rel, sidecarDir+"/") {
			return rel, nil
		}
	case tar.TypeReg:
		if rel == binaryName || strings.HasPrefix(rel, sidecarDir+"/") {
			return rel, nil
		}
	default:
		return "", fmt.Errorf("runsc: archive entry %q has unsupported type %q", name, h.Typeflag)
	}
	return "", fmt.Errorf("runsc: archive entry %q is outside runsc and gvisor-bin", name)
}

func writeFile(target string, r io.Reader) error {
	f, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, r); err != nil {
		return errors.Join(err, f.Close())
	}
	if err := f.Sync(); err != nil {
		return errors.Join(err, f.Close())
	}
	return f.Close()
}

func seal(root string, modes map[string]fs.FileMode) error {
	var dirs []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := os.Lchown(p, 0, 0); err != nil {
			return err
		}
		if d.IsDir() {
			dirs = append(dirs, p)
			return os.Chmod(p, dirMode)
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		return os.Chmod(p, modes[filepath.ToSlash(rel)])
	})
	if err != nil {
		return err
	}
	for _, d := range dirs {
		if err := syncDir(d); err != nil {
			return err
		}
	}
	return nil
}

func checksums(root string) ([]string, error) {
	var lines []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.Type().IsRegular() {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		sum, err := fileSum(p)
		if err != nil {
			return err
		}
		lines = append(lines, sum+"  "+filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return nil, err
	}
	slices.SortFunc(lines, func(a, b string) int {
		return strings.Compare(a[66:], b[66:])
	})
	return lines, nil
}

func fileSum(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", errors.Join(err, f.Close())
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func writeSums(p string, lines []string) error {
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_TRUNC|syscall.O_NOFOLLOW, sumsMode)
	if err != nil {
		return err
	}
	if _, err := io.WriteString(f, strings.Join(lines, "\n")+"\n"); err != nil {
		return errors.Join(err, f.Close())
	}
	if err := f.Chown(0, 0); err != nil {
		return errors.Join(err, f.Close())
	}
	if err := f.Chmod(sumsMode); err != nil {
		return errors.Join(err, f.Close())
	}
	if err := f.Sync(); err != nil {
		return errors.Join(err, f.Close())
	}
	return f.Close()
}

func syncDir(p string) error {
	d, err := os.Open(p)
	if err != nil {
		return err
	}
	if err := d.Sync(); err != nil {
		return errors.Join(err, d.Close())
	}
	return d.Close()
}

func readSums(p string) (map[string]string, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	sums := map[string]string{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		sum, rel, ok := strings.Cut(sc.Text(), "  ")
		if !ok || len(sum) != 64 || rel == "" {
			return nil, errors.Join(fmt.Errorf("runsc: malformed line in %s", p), f.Close())
		}
		sums[rel] = sum
	}
	if err := sc.Err(); err != nil {
		return nil, errors.Join(err, f.Close())
	}
	return sums, f.Close()
}

func (rt Runtime) Verify() ([]string, error) {
	var problems []string
	missing := map[string]bool{}
	for _, name := range []string{binaryName, sidecarDir} {
		_, err := os.Lstat(filepath.Join(rt.Dir, name))
		if errors.Is(err, fs.ErrNotExist) {
			problems = append(problems, "missing "+name)
			missing[name] = true
			continue
		}
		if err != nil {
			return nil, err
		}
	}
	if _, err := os.Lstat(rt.Dir); errors.Is(err, fs.ErrNotExist) {
		return problems, nil
	} else if err != nil {
		return nil, err
	}
	sumsPath := rt.Dir + sumsExt
	want, err := readSums(sumsPath)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		problems = append(problems, "missing "+filepath.Base(sumsPath))
		want = nil
	case err != nil:
		return nil, err
	default:
		fi, err := os.Lstat(sumsPath)
		if err != nil {
			return nil, err
		}
		problems = append(problems, ownership(filepath.Base(sumsPath), fi)...)
	}
	err = filepath.WalkDir(rt.Dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(rt.Dir, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		fi, err := d.Info()
		if err != nil {
			return err
		}
		label := rel
		if rel == "." {
			label = filepath.Base(rt.Dir)
		}
		problems = append(problems, ownership(label, fi)...)
		switch {
		case d.IsDir():
			return nil
		case !fi.Mode().IsRegular():
			problems = append(problems, "unexpected non-regular file "+rel)
			return nil
		}
		sum, err := fileSum(p)
		if err != nil {
			return err
		}
		expected, listed := want[rel]
		switch {
		case want == nil:
		case !listed:
			problems = append(problems, "unexpected file "+rel)
		case expected != sum:
			problems = append(problems, "checksum of "+rel+" differs")
		}
		delete(want, rel)
		return nil
	})
	if err != nil {
		return nil, err
	}
	rest := make([]string, 0, len(want))
	for rel := range want {
		if !missing[rel] && !missing[strings.SplitN(rel, "/", 2)[0]] {
			rest = append(rest, rel)
		}
	}
	slices.Sort(rest)
	for _, rel := range rest {
		problems = append(problems, "missing "+rel)
	}
	return problems, nil
}

func ownership(label string, fi fs.FileInfo) []string {
	var problems []string
	if fi.Mode().Perm()&0o022 != 0 {
		problems = append(problems, label+" is writable by group or others")
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok && (st.Uid != 0 || st.Gid != 0) {
		problems = append(problems, label+" is not root-owned")
	}
	return problems
}

func Remove(libDir, stateBase, version string) error {
	if err := checkVersion(version); err != nil {
		return err
	}
	dir := filepath.Join(libDir, "runsc-"+version)
	return errors.Join(
		os.RemoveAll(dir),
		os.RemoveAll(dir+partialExt),
		os.RemoveAll(dir+sumsExt),
		os.RemoveAll(filepath.Join(stateBase, version)),
	)
}
