//go:build linux

package hostprobe

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/harshjv/stationly/go/internal/protocol"
)

type fakeHost struct {
	cpuFlags string
	kvm      string
	virt     string
	virtErr  error
}

func (h fakeHost) prober(t *testing.T, arch string) Prober {
	t.Helper()
	root := t.TempDir()
	mustMkdir(t, filepath.Join(root, "proc"))
	mustMkdir(t, filepath.Join(root, "dev"))
	cpuinfo := "processor\t: 0\nvendor_id\t: GenuineIntel\n"
	if h.cpuFlags != "" {
		cpuinfo += "flags\t\t: " + h.cpuFlags + "\n"
	}
	mustWrite(t, filepath.Join(root, "proc", "cpuinfo"), cpuinfo)
	kvm := filepath.Join(root, "dev", "kvm")
	switch h.kvm {
	case "usable":
		mustWrite(t, kvm, "")
	case "unopenable":
		mustMkdir(t, kvm)
	}
	return Prober{Root: root, Arch: arch, DetectVirt: func(context.Context) (string, error) { return h.virt, h.virtErr }}
}

func mustMkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func virtualization(v *protocol.CpuVirtualization) string {
	if v == nil {
		return ""
	}
	return string(*v)
}

func hypervisorName(h *string) string {
	if h == nil {
		return "bare metal"
	}
	return *h
}

func TestProbe(t *testing.T) {
	cases := []struct {
		name           string
		host           fakeHost
		arch           string
		kvmPresent     bool
		kvmUsable      bool
		virtualization string
		hypervisor     string
	}{
		{"amd64 bare metal with vmx", fakeHost{cpuFlags: "fpu vme vmx sse2", kvm: "usable", virt: "none\n"}, "amd64", true, true, "vmx", "bare metal"},
		{"amd64 bare metal with svm", fakeHost{cpuFlags: "fpu svm sse2", kvm: "usable", virt: "none"}, "amd64", true, true, "svm", "bare metal"},
		{"amd64 cloud vm without nested virtualization", fakeHost{cpuFlags: "fpu sse2 hypervisor", virt: "kvm\n"}, "amd64", false, false, "", "kvm"},
		{"amd64 nested vm with kvm", fakeHost{cpuFlags: "fpu vmx hypervisor", kvm: "usable", virt: "microsoft"}, "amd64", true, true, "vmx", "microsoft"},
		{"arm64 with kvm", fakeHost{cpuFlags: "fp asimd evtstrm", kvm: "usable", virt: "none"}, "arm64", true, true, "", "bare metal"},
		{"arm64 flags never report virtualization", fakeHost{cpuFlags: "vmx", virt: "none"}, "arm64", false, false, "", "bare metal"},
		{"kvm device that cannot be opened", fakeHost{cpuFlags: "vmx", kvm: "unopenable", virt: "none"}, "amd64", true, false, "vmx", "bare metal"},
		{"no flags line", fakeHost{virt: "none"}, "amd64", false, false, "", "bare metal"},
		{"systemd-detect-virt fails", fakeHost{cpuFlags: "vmx", kvm: "usable", virtErr: errors.New("not found")}, "amd64", true, true, "vmx", unknownHypervisor},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := c.host.prober(t, c.arch).Probe(context.Background(), "")
			if got.KvmPresent != c.kvmPresent || got.KvmUsable != c.kvmUsable {
				t.Errorf("kvm present %v usable %v, want %v %v", got.KvmPresent, got.KvmUsable, c.kvmPresent, c.kvmUsable)
			}
			if v := virtualization(got.CpuVirtualization); v != c.virtualization {
				t.Errorf("cpu virtualization %q, want %q", v, c.virtualization)
			}
			if h := hypervisorName(got.Hypervisor); h != c.hypervisor {
				t.Errorf("hypervisor %q, want %q", h, c.hypervisor)
			}
			if got.SandboxFreeBytes != nil {
				t.Errorf("sandbox free bytes %d without a sandbox directory", *got.SandboxFreeBytes)
			}
			if got.CpuCores < 1 || got.MemoryBytes <= 0 {
				t.Errorf("cores %d memory %d", got.CpuCores, got.MemoryBytes)
			}
		})
	}
}

func TestFreeBytes(t *testing.T) {
	if free := FreeBytes(t.TempDir()); free == nil || *free <= 0 {
		t.Fatalf("free bytes of a temp dir: %v", free)
	}
	if free := FreeBytes(filepath.Join(t.TempDir(), "missing")); free != nil {
		t.Fatalf("free bytes of a missing dir: %d", *free)
	}
}
