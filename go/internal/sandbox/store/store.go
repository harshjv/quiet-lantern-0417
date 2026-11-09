package store

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

const (
	Mount     = "/var/lib/stationly/sandboxes"
	ImageFile = "/var/lib/stationly/sandboxes.img"
	MountUnit = "var-lib-stationly-sandboxes.mount"
	Label     = "stationly-sandboxes"

	GiB         = 1 << 30
	MinSize     = 10 * GiB
	RootReserve = 10 * GiB

	btrfsSuperMagic   = 0x9123683E
	incompatSimpleQta = 0x10000
)

type Backing string

const (
	BackingLoopFile Backing = "loop_file"
	BackingDevice   Backing = "device"
)

var (
	ErrInvalidSize    = errors.New("invalid sandbox filesystem size")
	ErrTooLittleSpace = errors.New("too little free space for the sandbox filesystem")
	ErrKernelTooOld   = errors.New("sandboxes need kernel 6.7 or later")
	ErrInvalidPath    = errors.New("not a sandbox subvolume path")
)

type Info struct {
	Mounted      bool
	Btrfs        bool
	SimpleQuota  bool
	QuotaOn      bool
	Backing      Backing
	Device       string
	LoopDevice   string
	DirectIO     bool
	Bytes        uint64
	FreeBytes    uint64
	DeviceErrors map[string]uint64
}

type FS struct {
	Mount string
}

func Open(mount string) FS {
	return FS{Mount: mount}
}

type Usage struct {
	Referenced uint64
	Exclusive  uint64
	Limit      uint64
}

type InstallOptions struct {
	Device   string
	Wipe     bool
	Size     uint64
	StateDir string
}

type Installed struct {
	Backing   Backing
	Path      string
	SizeBytes uint64
}

func DefaultSize(free uint64) (uint64, bool) {
	if free < MinSize+RootReserve {
		return 0, false
	}
	return max(MinSize, min(free/2, free-RootReserve)), true
}

func CheckSize(size, free uint64) error {
	if size < MinSize {
		return fmt.Errorf("%w: %d bytes is below the minimum of %d bytes (10 GiB)", ErrInvalidSize, size, uint64(MinSize))
	}
	if size > free || free-size < RootReserve {
		return fmt.Errorf("%w: %d bytes would leave less than 10 GiB free on the root filesystem (%d bytes free)", ErrInvalidSize, size, free)
	}
	return nil
}

func CheckGrow(current, requested, rootFree uint64) error {
	if requested <= current {
		return fmt.Errorf("%w: %d bytes is not larger than the current %d bytes", ErrInvalidSize, requested, current)
	}
	if requested > MaxGrow(current, rootFree) {
		return fmt.Errorf("%w: growing to %d bytes would leave less than 10 GiB free on the root filesystem (%d bytes free); the largest size is %d bytes", ErrInvalidSize, requested, rootFree, MaxGrow(current, rootFree))
	}
	return nil
}

func MaxGrow(current, rootFree uint64) uint64 {
	if rootFree <= RootReserve {
		return current
	}
	return current + rootFree - RootReserve
}

func KernelSupported(release string) bool {
	major, minor, ok := kernelVersion(release)
	if !ok {
		return false
	}
	return major > 6 || (major == 6 && minor >= 7)
}

func kernelVersion(release string) (int, int, bool) {
	end := strings.IndexFunc(release, func(r rune) bool { return (r < '0' || r > '9') && r != '.' })
	if end >= 0 {
		release = release[:end]
	}
	parts := strings.Split(release, ".")
	if len(parts) < 2 {
		return 0, 0, false
	}
	major, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, false
	}
	minor, err := strconv.Atoi(parts[1])
	if err != nil {
		return 0, 0, false
	}
	return major, minor, true
}
