//go:build linux

package hostprobe

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"

	"golang.org/x/sys/unix"

	"github.com/harshjv/stationly/go/internal/protocol"
)

const unknownHypervisor = "unknown"

type Prober struct {
	Root       string
	Arch       string
	DetectVirt func(ctx context.Context) (string, error)
}

func Default() Prober {
	return Prober{Root: "/", Arch: runtime.GOARCH, DetectVirt: systemdDetectVirt}
}

func (p Prober) Probe(ctx context.Context, sandboxDir string) protocol.HostProbe {
	present, usable := p.kvm()
	return protocol.HostProbe{
		KvmPresent:        present,
		KvmUsable:         usable,
		CpuVirtualization: p.cpuVirtualization(),
		Hypervisor:        p.hypervisor(ctx),
		CpuCores:          runtime.NumCPU(),
		MemoryBytes:       memoryBytes(),
		SandboxFreeBytes:  FreeBytes(sandboxDir),
	}
}

func FreeBytes(dir string) *int {
	if dir == "" {
		return nil
	}
	var fs unix.Statfs_t
	if err := unix.Statfs(dir, &fs); err != nil {
		return nil
	}
	free := int(fs.Bavail) * int(fs.Bsize)
	return &free
}

func (p Prober) kvm() (present, usable bool) {
	path := filepath.Join(p.Root, "dev", "kvm")
	if _, err := os.Stat(path); err != nil {
		return false, false
	}
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return true, false
	}
	_ = f.Close()
	return true, true
}

func (p Prober) cpuVirtualization() *protocol.CpuVirtualization {
	if p.Arch != "amd64" {
		return nil
	}
	flags := p.cpuFlags()
	for _, v := range []protocol.CpuVirtualization{protocol.CpuVirtualizationVmx, protocol.CpuVirtualizationSvm} {
		if slices.Contains(flags, string(v)) {
			return &v
		}
	}
	return nil
}

func (p Prober) cpuFlags() []string {
	f, err := os.Open(filepath.Join(p.Root, "proc", "cpuinfo"))
	if err != nil {
		return nil
	}
	defer func() { _ = f.Close() }()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		key, value, ok := strings.Cut(scanner.Text(), ":")
		if ok && strings.TrimSpace(key) == "flags" {
			return strings.Fields(value)
		}
	}
	return nil
}

func (p Prober) hypervisor(ctx context.Context) *string {
	out, _ := p.DetectVirt(ctx)
	name := strings.TrimSpace(out)
	switch name {
	case "none":
		return nil
	case "":
		name = unknownHypervisor
	}
	return &name
}

func systemdDetectVirt(ctx context.Context) (string, error) {
	out, err := exec.CommandContext(ctx, "systemd-detect-virt", "--vm").Output()
	return string(out), err
}

func memoryBytes() int {
	var si unix.Sysinfo_t
	if err := unix.Sysinfo(&si); err != nil {
		return 0
	}
	return int(si.Totalram) * int(si.Unit)
}
