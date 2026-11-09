//go:build linux

package store

import (
	"context"
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

func (f FS) Grow(ctx context.Context, size uint64, rootFree uint64) (GrowResult, error) {
	info, err := f.Inspect(ctx)
	if err != nil {
		return GrowResult{}, err
	}
	if !info.Mounted || !info.Btrfs {
		return GrowResult{}, fmt.Errorf("%s is not a mounted btrfs filesystem", f.Mount)
	}
	switch info.Backing {
	case BackingLoopFile:
		st, err := os.Stat(info.Device)
		if err != nil {
			return GrowResult{}, err
		}
		if err := f.growLoop(ctx, info.Device, info.LoopDevice, uint64(st.Size()), size, rootFree); err != nil {
			return GrowResult{}, err
		}
	case BackingDevice:
		if err := f.growDevice(ctx, info.Device, size); err != nil {
			return GrowResult{}, err
		}
	default:
		return GrowResult{}, fmt.Errorf("unknown sandbox filesystem backing %q", info.Backing)
	}
	var st unix.Statfs_t
	if err := unix.Statfs(f.Mount, &st); err != nil {
		return GrowResult{}, fmt.Errorf("statfs %s: %w", f.Mount, err)
	}
	return GrowResult{Bytes: st.Blocks * uint64(st.Bsize), FreeBytes: st.Bavail * uint64(st.Bsize)}, nil
}
