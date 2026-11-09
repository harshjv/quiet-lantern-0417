//go:build linux

package runsc

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	CgroupRoot     = "/sys/fs/cgroup"
	scopeKillPoll  = 20 * time.Millisecond
	ScopeKillLimit = 15 * time.Second
)

func systemctl(ctx context.Context, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "systemctl", args...)
	cmd.Env = []string{envPath}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == systemctlNotLoaded {
			return out, nil
		}
		return out, fmt.Errorf("systemctl %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return out, nil
}

func ScopeCgroup(ctx context.Context, id string) (string, error) {
	out, err := systemctl(ctx, "show", "-p", "ControlGroup", "--value", ScopeUnit(id))
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func GroupOOM(cgroup string) error {
	return writeCgroup(filepath.Join(CgroupRoot, cgroup), "memory.oom.group", "1")
}

func GroupsOOM(cgroup string) bool {
	b, err := os.ReadFile(filepath.Join(CgroupRoot, cgroup, "memory.oom.group"))
	return err == nil && strings.TrimSpace(string(b)) == "1"
}

func KillScope(ctx context.Context, id string) error {
	cg, err := ScopeCgroup(ctx, id)
	if err != nil {
		return err
	}
	if cg != "" {
		if err := KillCgroup(ctx, filepath.Join(CgroupRoot, cg)); err != nil {
			return fmt.Errorf("kill %s: %w", ScopeUnit(id), err)
		}
	}
	_, err = systemctl(ctx, "stop", ScopeUnit(id))
	return err
}

func KillCgroup(ctx context.Context, dir string) error {
	if err := writeCgroup(dir, "cgroup.kill", "1"); errors.Is(err, fs.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	ticker := time.NewTicker(scopeKillPoll)
	defer ticker.Stop()
	for {
		populated, err := cgroupPopulated(dir)
		if errors.Is(err, fs.ErrNotExist) || (err == nil && !populated) {
			return nil
		}
		if err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("processes remain in %s after cgroup.kill: %w", dir, ctx.Err())
		case <-ticker.C:
		}
	}
}

func writeCgroup(dir, name, value string) error {
	f, err := os.OpenFile(filepath.Join(dir, name), os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	_, err = f.WriteString(value)
	return errors.Join(err, f.Close())
}

func cgroupPopulated(dir string) (bool, error) {
	b, err := os.ReadFile(filepath.Join(dir, "cgroup.events"))
	if err != nil {
		return false, err
	}
	for _, line := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(line, "populated "); ok {
			return strings.TrimSpace(v) != "0", nil
		}
	}
	return false, fmt.Errorf("%s/cgroup.events has no populated line", dir)
}
