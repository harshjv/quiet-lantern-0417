package store

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	dirBases     = "bases"
	dirDisks     = "disks"
	dirSnapshots = "snapshots"
	dirPartial   = "partial"
	dirLogs      = "logs"
	maxNameLen   = 200
)

var subvolumeKinds = []string{dirBases, dirDisks, dirSnapshots, dirPartial}

func validName(name string) bool {
	if name == "" || len(name) > maxNameLen || name[0] == '.' || name[0] == '-' {
		return false
	}
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '.', r == '_', r == '-', r == ':', r == '+':
		default:
			return false
		}
	}
	return true
}

func isKind(kind string) bool {
	for _, k := range subvolumeKinds {
		if k == kind {
			return true
		}
	}
	return false
}

func (f FS) BasePath(name string) string    { return filepath.Join(f.Mount, dirBases, name) }
func (f FS) DiskPath(id string) string      { return filepath.Join(f.Mount, dirDisks, id) }
func (f FS) SnapshotPath(id string) string  { return filepath.Join(f.Mount, dirSnapshots, id) }
func (f FS) LogDir(id string) string        { return filepath.Join(f.Mount, dirLogs, id) }
func (f FS) partialPath(name string) string { return filepath.Join(f.Mount, dirPartial, name) }
func (f FS) BaseExists(name string) bool    { return validName(name) && isDir(f.BasePath(name)) }
func (f FS) DiskExists(id string) bool      { return validName(id) && isDir(f.DiskPath(id)) }
func (f FS) SnapshotExists(id string) bool  { return validName(id) && isDir(f.SnapshotPath(id)) }
func (f FS) partialExists(name string) bool { return isDir(f.partialPath(name)) }

func isDir(path string) bool {
	st, err := os.Lstat(path)
	return err == nil && st.IsDir()
}

func relSubvolume(rel string) (string, bool) {
	parts := strings.Split(rel, "/")
	if len(parts) != 2 || !isKind(parts[0]) || !validName(parts[1]) {
		return "", false
	}
	return rel, true
}

func (f FS) subvolumePath(path string) (string, error) {
	rel := path
	if filepath.IsAbs(path) {
		prefix := strings.TrimSuffix(f.Mount, "/") + "/"
		if !strings.HasPrefix(path, prefix) {
			return "", fmt.Errorf("%w: %q", ErrInvalidPath, path)
		}
		rel = strings.TrimPrefix(path, prefix)
	}
	if _, ok := relSubvolume(rel); !ok {
		return "", fmt.Errorf("%w: %q", ErrInvalidPath, path)
	}
	return filepath.Join(f.Mount, rel), nil
}
