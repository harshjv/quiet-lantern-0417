//go:build linux

package deploy

import (
	"context"
	"errors"
	"fmt"

	"github.com/harshjv/stationly/go/internal/hostconfig"
	"github.com/harshjv/stationly/go/internal/sandbox/store"
)

const sandboxLibState = "/var/lib/stationly"

func provisionSandboxes(ctx context.Context, opts InstallOptions) (bool, string, string, error) {
	kernel := kernelRelease()
	asked := opts.SandboxDevice != "" || opts.SandboxSize > 0
	if !store.KernelSupported(kernel) {
		detail := fmt.Sprintf("kernel %s is older than 6.7, which sandboxes need for btrfs simple quotas; everything else installs and the doctor's sandbox rows say why", kernel)
		if asked {
			return false, "refused", detail, fmt.Errorf("%s", detail)
		}
		return false, "skipped", detail, nil
	}
	free, err := rootFree(sandboxLibState)
	if err != nil {
		return false, "failed", err.Error(), err
	}
	units := opts.SandboxUnits
	if units == "" {
		units = "/etc/systemd/system"
	}
	inst, err := store.Provision(ctx, store.InstallOptions{Device: opts.SandboxDevice, Wipe: opts.SandboxWipe, Size: opts.SandboxSize, StateDir: sandboxLibState}, free, kernel, units)
	switch {
	case errors.Is(err, store.ErrTooLittleSpace) && !asked:
		return false, "skipped", fmt.Sprintf("only %s free on the root filesystem; a sandbox filesystem needs 20 GiB free (10 GiB for it, 10 GiB kept); add one later with stationd install --sandbox-size or --sandbox-device", human(free)), nil
	case err != nil && asked:
		return false, "refused", err.Error(), err
	case err != nil:
		return false, "failed", "sandbox filesystem not provisioned: " + err.Error() + "; everything else installs", nil
	}
	if host, herr := hostconfig.Load(opts.EtcDir); herr == nil {
		if inst.Backing == store.BackingDevice {
			host.Sandboxes = &hostconfig.Sandboxes{Device: inst.Path}
		} else {
			host.Sandboxes = &hostconfig.Sandboxes{Image: &hostconfig.SandboxImage{Path: inst.Path, SizeBytes: inst.SizeBytes}}
		}
		if serr := hostconfig.Save(opts.EtcDir, host); serr != nil {
			return true, "ok", "provisioned, but host.toml was not updated: " + serr.Error(), nil
		}
	}
	return true, "ok", fmt.Sprintf("btrfs %s at %s (%s), simple quotas on, mounted at %s by %s", inst.Backing, inst.Path, human(inst.SizeBytes), store.Mount, store.MountUnit), nil
}
