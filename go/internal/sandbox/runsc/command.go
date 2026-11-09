package runsc

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

const (
	LibDir    = "/usr/local/lib/stationly"
	StateBase = "/run/stationly/runsc"
	envPath   = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
)

var ErrNotFound = errors.New("runsc: container not found")

type Runtime struct {
	Version string
	Dir     string
	Root    string
}

func At(libDir, stateBase, version string) Runtime {
	return Runtime{
		Version: version,
		Dir:     filepath.Join(libDir, "runsc-"+version),
		Root:    filepath.Join(stateBase, version),
	}
}

func (rt Runtime) binary() string {
	return filepath.Join(rt.Dir, "runsc")
}

func (rt Runtime) globals(logDir string) []string {
	g := []string{"--root", rt.Root, "--platform=systrap", "--overlay2=none", "--net-raw", "--network=sandbox"}
	if logDir != "" {
		g = append(g,
			"--log", filepath.Join(logDir, "runsc.log"),
			"--panic-log", filepath.Join(logDir, "panic.log"),
			"--debug-log", logDir+"/",
		)
	}
	return g
}

func (rt Runtime) Command(ctx context.Context, logDir string, args ...string) *exec.Cmd {
	argv := append(rt.globals(logDir), args...)
	cmd := exec.CommandContext(ctx, rt.binary(), argv...)
	cmd.Env = []string{envPath}
	if err := CheckArgs(argv); err != nil {
		cmd.Err = err
	}
	return cmd
}

var forbiddenFlags = []string{
	"allow-packet-socket-write",
	"rootless",
	"ignore-cgroups",
	"allow-flag-override",
	"allow-suid",
	"reproduce-nat",
	"reproduce-nftables",
	"debug",
	"directfs",
}

var forbiddenPrefixes = []string{
	"TESTONLY-",
	"profile",
	"nvproxy",
	"tpuproxy",
	"file-access",
}

var allowedValues = map[string][]string{
	"network":   {"sandbox", "none"},
	"platform":  {"systrap"},
	"host-uds":  {"none"},
	"host-fifo": {"none"},
	"overlay2":  {"none"},
}

func CheckArgs(args []string) error {
	var errs []error
	for i, a := range args {
		name, ok := flagName(a)
		if !ok {
			continue
		}
		name, value, hasValue := strings.Cut(name, "=")
		for _, f := range forbiddenFlags {
			if strings.EqualFold(name, f) {
				errs = append(errs, fmt.Errorf("runsc: flag %q is forbidden", a))
			}
		}
		for _, p := range forbiddenPrefixes {
			if len(name) >= len(p) && strings.EqualFold(name[:len(p)], p) {
				errs = append(errs, fmt.Errorf("runsc: flag %q is forbidden", a))
			}
		}
		allowed, valued := allowedValues[strings.ToLower(name)]
		if !valued {
			continue
		}
		if !hasValue {
			if i+1 >= len(args) {
				errs = append(errs, fmt.Errorf("runsc: flag %q has no value", a))
				continue
			}
			value = args[i+1]
		}
		if !slices.Contains(allowed, value) {
			errs = append(errs, fmt.Errorf("runsc: flag --%s=%s is forbidden", name, value))
		}
	}
	return errors.Join(errs...)
}

func flagName(arg string) (string, bool) {
	switch {
	case strings.HasPrefix(arg, "--"):
		arg = arg[2:]
	case strings.HasPrefix(arg, "-"):
		arg = arg[1:]
	default:
		return "", false
	}
	return arg, arg != ""
}

var versionPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

func checkVersion(version string) error {
	if !versionPattern.MatchString(version) || strings.Contains(version, "..") || strings.HasSuffix(version, ".partial") {
		return fmt.Errorf("runsc: invalid version %q", version)
	}
	return nil
}
