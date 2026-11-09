//go:build linux

package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"golang.org/x/sys/unix"
)

const (
	mountInfoPath = "/proc/self/mountinfo"
	sysBtrfs      = "/sys/fs/btrfs"
	sysBlock      = "/sys/block"
)

var loopName = regexp.MustCompile(`^loop[0-9]+$`)

func (f FS) Inspect(ctx context.Context) (Info, error) {
	var info Info
	data, err := os.ReadFile(mountInfoPath)
	if err != nil {
		return info, err
	}
	entry, ok, err := parseMountInfo(string(data), f.Mount)
	if err != nil || !ok {
		return info, err
	}
	info.Mounted = true
	var st unix.Statfs_t
	if err := unix.Statfs(f.Mount, &st); err != nil {
		return info, fmt.Errorf("statfs %s: %w", f.Mount, err)
	}
	info.Btrfs = entry.FSType == "btrfs" && uint64(st.Type) == btrfsSuperMagic
	if !info.Btrfs {
		return info, nil
	}
	info.Bytes = st.Blocks * uint64(st.Bsize)
	info.FreeBytes = st.Bavail * uint64(st.Bsize)
	source := entry.Source
	if resolved, err := filepath.EvalSymlinks(source); err == nil {
		source = resolved
	}
	dev := filepath.Base(source)
	if loopName.MatchString(dev) {
		info.Backing = BackingLoopFile
		info.LoopDevice = source
		backing, err := readSys(filepath.Join(sysBlock, dev, "loop", "backing_file"))
		if err != nil {
			return info, err
		}
		info.Device = backing
		dio, err := readSys(filepath.Join(sysBlock, dev, "loop", "dio"))
		if err != nil {
			return info, err
		}
		info.DirectIO = dio == "1"
	} else {
		info.Backing = BackingDevice
		info.Device = source
	}
	if err := f.inspectQuota(ctx, &info, source, dev); err != nil {
		return info, err
	}
	out, err := f.btrfs(ctx, "device", "stats", f.Mount)
	if err != nil {
		return info, err
	}
	if info.DeviceErrors, err = parseDeviceStats(out); err != nil {
		return info, err
	}
	return info, nil
}

func (f FS) inspectQuota(ctx context.Context, info *Info, source, dev string) error {
	dir, err := sysfsDir(dev)
	if err != nil {
		return err
	}
	if dir != "" {
		qgroups := filepath.Join(dir, "qgroups")
		enabled, err := readSys(filepath.Join(qgroups, "enabled"))
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		info.QuotaOn = enabled == "1"
		mode, err := readSys(filepath.Join(qgroups, "mode"))
		if err == nil {
			info.SimpleQuota = info.QuotaOn && mode == "squota"
			return nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	} else if _, err := f.btrfs(ctx, "qgroup", "show", f.Mount); err == nil {
		info.QuotaOn = true
	}
	out, err := f.btrfs(ctx, "inspect-internal", "dump-super", source)
	if err != nil {
		return err
	}
	flags, err := parseIncompatFlags(out)
	if err != nil {
		return err
	}
	info.SimpleQuota = info.QuotaOn && flags&incompatSimpleQta != 0
	return nil
}

func sysfsDir(dev string) (string, error) {
	entries, err := os.ReadDir(sysBtrfs)
	if err != nil {
		return "", err
	}
	for _, e := range entries {
		if e.Name() == "features" {
			continue
		}
		dir := filepath.Join(sysBtrfs, e.Name())
		if _, err := os.Lstat(filepath.Join(dir, "devices", dev)); err == nil {
			return dir, nil
		}
	}
	return "", nil
}

func readSys(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

func (f FS) EnableDirectIO(ctx context.Context) error {
	info, err := f.Inspect(ctx)
	if err != nil {
		return err
	}
	return f.enableDirectIO(ctx, info)
}
