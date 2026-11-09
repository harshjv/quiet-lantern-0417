package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

const syncTimeout = 30 * time.Second

func (f FS) btrfs(ctx context.Context, args ...string) (string, error) {
	return run(ctx, "btrfs", args...)
}

func (f FS) CreatePartial(ctx context.Context, name string) (string, error) {
	if !validName(name) {
		return "", fmt.Errorf("%w: partial name %q", ErrInvalidPath, name)
	}
	path := f.partialPath(name)
	if f.partialExists(name) {
		if err := f.deleteSubvolume(ctx, path); err != nil {
			return "", err
		}
	}
	if _, err := f.btrfs(ctx, "subvolume", "create", path); err != nil {
		return "", err
	}
	return path, nil
}

func (f FS) PromoteBase(ctx context.Context, name string) error {
	if !validName(name) {
		return fmt.Errorf("%w: base name %q", ErrInvalidPath, name)
	}
	base := f.BasePath(name)
	if f.BaseExists(name) {
		if f.partialExists(name) {
			if err := f.deleteSubvolume(ctx, f.partialPath(name)); err != nil {
				return err
			}
		}
	} else if err := rename(f.partialPath(name), base); err != nil {
		return fmt.Errorf("promote base %s: %w", name, err)
	}
	_, err := f.btrfs(ctx, "property", "set", "-ts", base, "ro", "true")
	return err
}

func (f FS) MakeDisk(ctx context.Context, id, source string, limit uint64) error {
	if !validName(id) {
		return fmt.Errorf("%w: disk id %q", ErrInvalidPath, id)
	}
	src, err := f.subvolumePath(source)
	if err != nil {
		return err
	}
	if strings.HasPrefix(src, f.partialPath("")+"/") {
		return fmt.Errorf("%w: a disk cannot be made from %q", ErrInvalidPath, source)
	}
	if f.DiskExists(id) {
		return nil
	}
	if !isDir(src) {
		return fmt.Errorf("make disk %s: source %s does not exist", id, src)
	}
	tmp := "disk-" + id
	if f.partialExists(tmp) {
		if err := f.deleteSubvolume(ctx, f.partialPath(tmp)); err != nil {
			return err
		}
	}
	if _, err := f.btrfs(ctx, "subvolume", "snapshot", src, f.partialPath(tmp)); err != nil {
		return err
	}
	if err := f.SetLimit(ctx, f.partialPath(tmp), limit); err != nil {
		return err
	}
	if err := rename(f.partialPath(tmp), f.DiskPath(id)); err != nil {
		return fmt.Errorf("make disk %s: %w", id, err)
	}
	return nil
}

func (f FS) Snapshot(ctx context.Context, diskID, snapID string) error {
	if !validName(diskID) || !validName(snapID) {
		return fmt.Errorf("%w: snapshot %q of disk %q", ErrInvalidPath, snapID, diskID)
	}
	if f.SnapshotExists(snapID) {
		return nil
	}
	if !f.DiskExists(diskID) {
		return fmt.Errorf("snapshot %s: disk %s does not exist", snapID, diskID)
	}
	_, err := f.btrfs(ctx, "subvolume", "snapshot", "-r", f.DiskPath(diskID), f.SnapshotPath(snapID))
	return err
}

func (f FS) SetLimit(ctx context.Context, path string, limit uint64) error {
	p, err := f.subvolumePath(path)
	if err != nil {
		return err
	}
	value := "none"
	if limit > 0 {
		value = strconv.FormatUint(limit, 10)
	}
	_, err = f.btrfs(ctx, "qgroup", "limit", value, p)
	return err
}

func (f FS) Delete(ctx context.Context, path string) error {
	p, err := f.subvolumePath(path)
	if err != nil {
		return err
	}
	return f.deleteSubvolume(ctx, p)
}

func (f FS) deleteSubvolume(ctx context.Context, path string) error {
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	_, err := f.btrfs(ctx, "subvolume", "delete", path)
	return err
}

func (f FS) Subvolumes(ctx context.Context) (map[string]bool, error) {
	out, err := f.btrfs(ctx, "subvolume", "list", f.Mount)
	if err != nil {
		return nil, err
	}
	byID, err := parseSubvolumeList(out)
	if err != nil {
		return nil, err
	}
	subs := map[string]bool{}
	for _, p := range byID {
		if _, ok := relSubvolume(p); ok {
			subs[p] = true
		}
	}
	return subs, nil
}

func (f FS) CleanPartial(ctx context.Context) error {
	subs, err := f.Subvolumes(ctx)
	if err != nil {
		return err
	}
	var partial []string
	for p := range subs {
		if strings.HasPrefix(p, dirPartial+"/") {
			partial = append(partial, p)
		}
	}
	sort.Strings(partial)
	var errs []error
	for _, p := range partial {
		if err := f.Delete(ctx, p); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (f FS) Usage(ctx context.Context) (map[string]Usage, error) {
	out, err := f.btrfs(ctx, "qgroup", "show", "--raw", "-re", f.Mount)
	if err != nil {
		return nil, err
	}
	rows, err := parseQgroupShow(out)
	if err != nil {
		return nil, err
	}
	var paths map[string]string
	if rowsNeedPaths(rows) {
		list, err := f.btrfs(ctx, "subvolume", "list", f.Mount)
		if err != nil {
			return nil, err
		}
		if paths, err = parseSubvolumeList(list); err != nil {
			return nil, err
		}
	}
	return usageFromRows(rows, paths), nil
}

func (f FS) ClearStale(ctx context.Context) error {
	syncCtx, cancel := context.WithTimeout(ctx, syncTimeout)
	defer cancel()
	if _, err := f.btrfs(syncCtx, "subvolume", "sync", f.Mount); err != nil {
		if syncCtx.Err() != nil && ctx.Err() == nil {
			return fmt.Errorf("btrfs subvolume sync did not finish within %s: %w", syncTimeout, err)
		}
		return err
	}
	out, err := f.btrfs(ctx, "qgroup", "clear-stale", f.Mount)
	if err != nil && !onlyBusy(out) {
		return err
	}
	return nil
}

func onlyBusy(out string) bool {
	busy := false
	for _, line := range strings.Split(out, "\n") {
		if !strings.Contains(strings.ToLower(line), "error") {
			continue
		}
		if !strings.Contains(line, "busy") {
			return false
		}
		busy = true
	}
	return busy
}

func (f FS) enableDirectIO(ctx context.Context, info Info) error {
	if info.Backing != BackingLoopFile || info.DirectIO || info.LoopDevice == "" {
		return nil
	}
	_, err := run(ctx, "losetup", "--direct-io=on", info.LoopDevice)
	return err
}
