package sandbox

import (
	"context"
	"io"
	"net/netip"
	"os"
	"time"

	"github.com/harshjv/stationly/go/internal/protocol"
)

const CgroupRoot = "/sys/fs/cgroup"

type Spec struct {
	ID          string
	Hostname    string
	DiskPath    string
	BundleDir   string
	LogDir      string
	Output      *os.File
	NetNSPath   string
	Resolver    netip.Addr
	Args        []string
	Env         []string
	ImageEnv    []string
	Cwd         string
	MemoryBytes int64
	CPUMillis   int64
}

type ExecSpec struct {
	ID        string
	BundleDir string
	Args      []string
	Env       []string
	Cwd       string
	UID       int
	GID       int
	TTY       bool
	Rows      int
	Cols      int
}

type Process interface {
	Stdin() io.WriteCloser
	Stdout() io.Reader
	Stderr() io.Reader
	Resize(rows, cols int) error
	Wait() (int, error)
	Kill() error
}

type State struct {
	ID      string
	Running bool
}

type Installer interface {
	Versions() []string
	Install(ctx context.Context, version string, archive io.Reader) error
	Verify(version string) ([]string, error)
	Probe(ctx context.Context, version string) error
	Remove(version string) error
}

type Runtime interface {
	Installer
	Name() protocol.SandboxRuntime
	Create(ctx context.Context, version string, spec Spec) error
	Start(ctx context.Context, version string, spec Spec) (cgroup string, err error)
	Wait(ctx context.Context, version, id string) (*int, error)
	Stop(ctx context.Context, version, id string, grace time.Duration) error
	Kill(ctx context.Context, id string) error
	List(ctx context.Context, version string) ([]State, error)
	Exec(ctx context.Context, version string, spec ExecSpec) (Process, error)
	Unit(id string) string
	Cgroup(ctx context.Context, id string) (string, error)
	AssertOOMGroup(cgroup string) (changed bool, err error)
	Strays(known map[string]bool) []string
	LogFiles(logDir string) []string
	Panic(logDir string) string
}
