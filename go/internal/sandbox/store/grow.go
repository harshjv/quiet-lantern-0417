package store

import (
	"context"
	"fmt"
	"strconv"
	"strings"
)

type GrowResult struct {
	Bytes     uint64
	FreeBytes uint64
}

type GrowError struct {
	Step string
	Err  error
}

func (e *GrowError) Error() string {
	return fmt.Sprintf("grow sandbox filesystem, step %s: %v", e.Step, e.Err)
}

func (e *GrowError) Unwrap() error {
	return e.Err
}

func (f FS) growLoop(ctx context.Context, image, loopDevice string, imageSize, size, rootFree uint64) error {
	if err := CheckGrow(imageSize, size, rootFree); err != nil {
		return err
	}
	if _, err := run(ctx, "fallocate", "-l", strconv.FormatUint(size, 10), image); err != nil {
		return &GrowError{Step: "fallocate", Err: err}
	}
	if _, err := run(ctx, "losetup", "--set-capacity", loopDevice); err != nil {
		return &GrowError{Step: "loop", Err: err}
	}
	if _, err := f.btrfs(ctx, "filesystem", "resize", "max", f.Mount); err != nil {
		return &GrowError{Step: "resize", Err: err}
	}
	return nil
}

func (f FS) growDevice(ctx context.Context, device string, size uint64) error {
	out, err := run(ctx, "blockdev", "--getsize64", device)
	if err != nil {
		return &GrowError{Step: "resize", Err: err}
	}
	deviceSize, err := strconv.ParseUint(strings.TrimSpace(out), 10, 64)
	if err != nil {
		return &GrowError{Step: "resize", Err: fmt.Errorf("blockdev --getsize64 %s: %w", device, err)}
	}
	if size > deviceSize {
		return fmt.Errorf("%w: %d bytes is larger than the device %s (%d bytes); enlarge the device first", ErrInvalidSize, size, device, deviceSize)
	}
	if _, err := f.btrfs(ctx, "filesystem", "resize", "max", f.Mount); err != nil {
		return &GrowError{Step: "resize", Err: err}
	}
	return nil
}
