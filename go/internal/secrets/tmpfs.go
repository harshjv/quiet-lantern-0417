//go:build linux

package secrets

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/moby/sys/mountinfo"
	"golang.org/x/sys/unix"
)

const Root = "/run/stationly/secrets"

type Owner struct {
	UID int `json:"uid"`
	GID int `json:"gid"`
}

func Dir(deploymentID string) string {
	return filepath.Join(Root, deploymentID)
}

func mountPoints() (map[string]bool, error) {
	mounts, err := mountinfo.GetMounts(mountinfo.PrefixFilter(Root))
	if err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for _, m := range mounts {
		out[m.Mountpoint] = true
	}
	return out, nil
}

func Mounted(deploymentID string) bool {
	points, err := mountPoints()
	return err == nil && points[Dir(deploymentID)]
}

func MountedDeployments() ([]string, error) {
	points, err := mountPoints()
	if err != nil {
		return nil, err
	}
	var out []string
	for p := range points {
		if filepath.Dir(p) == Root {
			out = append(out, filepath.Base(p))
		}
	}
	entries, err := os.ReadDir(Root)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	for _, e := range entries {
		if e.IsDir() && !points[filepath.Join(Root, e.Name())] {
			out = append(out, e.Name())
		}
	}
	return out, nil
}

func Mount(deploymentID string, owner Owner, files []Entry) (bool, error) {
	dir := Dir(deploymentID)
	if Mounted(deploymentID) {
		return false, nil
	}
	if err := os.MkdirAll(Root, 0o700); err != nil {
		return false, err
	}
	if err := os.Mkdir(dir, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
		return false, err
	}
	size := 1 << 20
	for _, f := range files {
		size += len(f.Value)
	}
	opts := fmt.Sprintf("size=%d,mode=0700,uid=%d,gid=%d", size, owner.UID, owner.GID)
	if err := unix.Mount("tmpfs", dir, "tmpfs", unix.MS_NOEXEC|unix.MS_NOSUID|unix.MS_NODEV, opts); err != nil {
		return false, fmt.Errorf("mount tmpfs at %s: %w", dir, err)
	}
	for _, f := range files {
		if err := writeFile(filepath.Join(dir, f.Key), f.Value, owner); err != nil {
			_ = Unmount(deploymentID)
			return false, err
		}
	}
	return true, nil
}

func writeFile(path string, value []byte, owner Owner) error {
	fd, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o400)
	if err != nil {
		return err
	}
	if _, err := fd.Write(value); err != nil {
		fd.Close()
		return err
	}
	if err := fd.Chown(owner.UID, owner.GID); err != nil {
		fd.Close()
		return err
	}
	return fd.Close()
}

func Unmount(deploymentID string) error {
	dir := Dir(deploymentID)
	if Mounted(deploymentID) {
		if err := unix.Unmount(dir, 0); err != nil {
			return fmt.Errorf("unmount %s: %w", dir, err)
		}
	}
	if err := os.Remove(dir); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}
