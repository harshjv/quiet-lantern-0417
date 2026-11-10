//go:build linux

package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"github.com/harshjv/stationly/go/internal/fsx"
)

func Provision(ctx context.Context, o InstallOptions, rootFree uint64, kernel string, unitDir string) (Installed, error) {
	if !KernelSupported(kernel) {
		return Installed{}, fmt.Errorf("%w; this host runs %s, so no sandbox filesystem is created", ErrKernelTooOld, kernel)
	}
	f := Open(Mount)
	info, err := f.Inspect(ctx)
	if err != nil {
		return Installed{}, err
	}
	if info.Mounted && !info.Btrfs {
		return Installed{}, fmt.Errorf("%s is mounted but is not btrfs", Mount)
	}
	if !info.Mounted {
		if info, err = provisionFilesystem(ctx, f, o, rootFree, unitDir); err != nil {
			return Installed{}, err
		}
	}
	if info.QuotaOn && !info.SimpleQuota {
		return Installed{}, fmt.Errorf("%s runs full qgroups; sandboxes need simple quotas (btrfs quota disable, then btrfs quota enable --simple)", Mount)
	}
	if !info.QuotaOn {
		if _, err := f.btrfs(ctx, "quota", "enable", "--simple", Mount); err != nil {
			return Installed{}, err
		}
	}
	if err := f.enableDirectIO(ctx, info); err != nil {
		return Installed{}, err
	}
	if err := f.EnsureLayout(); err != nil {
		return Installed{}, err
	}
	size := info.Bytes
	if info.Backing == BackingLoopFile {
		st, err := os.Stat(info.Device)
		if err != nil {
			return Installed{}, err
		}
		size = uint64(st.Size())
	}
	return Installed{Backing: info.Backing, Path: info.Device, SizeBytes: size}, nil
}

func provisionFilesystem(ctx context.Context, f FS, o InstallOptions, rootFree uint64, unitDir string) (Info, error) {
	backing, what := BackingLoopFile, ImageFile
	var err error
	if o.Device != "" {
		backing, what = BackingDevice, o.Device
		err = formatDevice(ctx, o.Device, o.Wipe)
	} else {
		err = createImage(ctx, o, rootFree)
	}
	if err != nil {
		return Info{}, err
	}
	if err := writeUnit(unitDir, mountUnit(backing, what)); err != nil {
		return Info{}, err
	}
	if _, err := run(ctx, "systemctl", "daemon-reload"); err != nil {
		return Info{}, err
	}
	if _, err := run(ctx, "systemctl", "enable", "--now", MountUnit); err != nil {
		return Info{}, err
	}
	info, err := f.Inspect(ctx)
	if err != nil {
		return Info{}, err
	}
	if !info.Mounted || !info.Btrfs {
		return Info{}, fmt.Errorf("%s did not mount %s as btrfs", MountUnit, what)
	}
	return info, nil
}

func signature(ctx context.Context, path string) (map[string]string, error) {
	out, err := run(ctx, "blkid", "-p", "-o", "export", path)
	if exitCode(err) == 2 {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return parseBlkid(out), nil
}

func formatDevice(ctx context.Context, device string, wipe bool) error {
	sig, err := signature(ctx, device)
	if err != nil {
		return err
	}
	if sig != nil && sig["TYPE"] == "btrfs" && sig["LABEL"] == Label && !wipe {
		return nil
	}
	if sig != nil && !wipe {
		return fmt.Errorf("%s holds a filesystem signature or partition table (%s); pass --sandbox-device-wipe to erase it", device, describeSignature(sig))
	}
	if sig != nil {
		if _, err := run(ctx, "wipefs", "-a", device); err != nil {
			return err
		}
	}
	_, err = run(ctx, "mkfs.btrfs", "-f", "-L", Label, device)
	return err
}

func describeSignature(sig map[string]string) string {
	if t := sig["TYPE"]; t != "" {
		return "TYPE=" + t
	}
	if t := sig["PTTYPE"]; t != "" {
		return "PTTYPE=" + t
	}
	return "unknown"
}

func createImage(ctx context.Context, o InstallOptions, rootFree uint64) error {
	if _, err := os.Lstat(ImageFile); err == nil {
		sig, err := signature(ctx, ImageFile)
		if err != nil {
			return err
		}
		if sig["TYPE"] != "btrfs" || sig["LABEL"] != Label {
			return fmt.Errorf("%s exists but is not the sandbox filesystem; remove it or pass --sandbox-device", ImageFile)
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	size := o.Size
	if size > 0 {
		if err := CheckSize(size, rootFree); err != nil {
			return err
		}
	} else {
		var ok bool
		if size, ok = DefaultSize(rootFree); !ok {
			return fmt.Errorf("%w: %d bytes free, at least 20 GiB needed", ErrTooLittleSpace, rootFree)
		}
	}
	if o.StateDir != "" {
		if err := os.MkdirAll(o.StateDir, 0o755); err != nil {
			return err
		}
	}
	if _, err := run(ctx, "fallocate", "-l", strconv.FormatUint(size, 10), ImageFile); err != nil {
		return errors.Join(err, removeIfExists(ImageFile))
	}
	if _, err := run(ctx, "mkfs.btrfs", "-L", Label, ImageFile); err != nil {
		return errors.Join(err, removeIfExists(ImageFile))
	}
	return nil
}

func removeIfExists(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func writeUnit(unitDir, text string) error {
	return fsx.WriteFile(filepath.Join(unitDir, MountUnit), []byte(text), 0o644)
}
