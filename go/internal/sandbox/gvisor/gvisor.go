//go:build linux

package gvisor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/harshjv/stationly/go/internal/fsx"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/sandbox"
	"github.com/harshjv/stationly/go/internal/sandbox/runsc"
)

const Name protocol.SandboxRuntime = "gvisor"

const (
	configFile     = "config.json"
	panicFile      = "panic.log"
	runtimeLog     = "runsc.log"
	stationdCgroup = "stationd.service"
	maxPanicLine   = 500
)

var helpers = []string{"runsc-fd-parking", "gvisor_sentry", "runsc"}

type Runtime struct {
	libDir    string
	stateBase string
}

func New() *Runtime {
	return &Runtime{libDir: runsc.LibDir, stateBase: runsc.StateBase}
}

func (r *Runtime) at(version string) runsc.Runtime {
	return runsc.At(r.libDir, r.stateBase, version)
}

func (r *Runtime) Name() protocol.SandboxRuntime {
	return Name
}

func (r *Runtime) Versions() []string {
	versions, _ := runsc.Installed(r.libDir)
	return versions
}

func (r *Runtime) Install(ctx context.Context, version string, archive io.Reader) error {
	if err := runsc.Install(r.libDir, version, archive); err != nil {
		return fmt.Errorf("unpack runsc %s: %w", version, err)
	}
	if err := r.Probe(ctx, version); err != nil {
		return errors.Join(fmt.Errorf("probe runsc %s on systrap: %w", version, err), r.Remove(version))
	}
	return nil
}

func (r *Runtime) Verify(version string) ([]string, error) {
	return r.at(version).Verify()
}

func (r *Runtime) Probe(ctx context.Context, version string) error {
	return r.at(version).Probe(ctx)
}

func (r *Runtime) Remove(version string) error {
	return runsc.Remove(r.libDir, r.stateBase, version)
}

func (r *Runtime) Create(ctx context.Context, version string, spec sandbox.Spec) error {
	config, err := runsc.Config(spec)
	if err != nil {
		return fmt.Errorf("build %s: %w", configFile, err)
	}
	for name, body := range runsc.HostFiles(spec) {
		if err := fsx.WriteFile(filepath.Join(spec.BundleDir, name), body, 0o644); err != nil {
			return fmt.Errorf("write %s: %w", name, err)
		}
	}
	configPath := filepath.Join(spec.BundleDir, configFile)
	if err := fsx.WriteFile(configPath, config, 0o600); err != nil {
		return fmt.Errorf("write %s: %w", configFile, err)
	}
	rt := r.at(version)
	_ = rt.Delete(ctx, spec.ID, true)
	if err := rt.Create(ctx, spec.LogDir, spec.BundleDir, spec.ID, spec.Output); err != nil {
		return errors.Join(fmt.Errorf("runsc create: %w%s", err, panicSuffix(spec.LogDir)), os.Remove(configPath))
	}
	return nil
}

func (r *Runtime) Start(ctx context.Context, version string, spec sandbox.Spec) (string, error) {
	defer os.Remove(filepath.Join(spec.BundleDir, configFile))
	rt := r.at(version)
	if err := rt.Start(ctx, spec.LogDir, spec.ID); err != nil {
		_ = rt.Delete(ctx, spec.ID, true)
		return "", fmt.Errorf("runsc start: %w%s", err, panicSuffix(spec.LogDir))
	}
	cg, err := runsc.ScopeCgroup(ctx, spec.ID)
	if err == nil && cg == "" {
		err = errors.New("the scope has no control group")
	}
	if err == nil {
		err = runsc.GroupOOM(cg)
	}
	if err != nil {
		_ = rt.Stop(ctx, spec.ID, 0)
		_ = runsc.KillScope(ctx, spec.ID)
		return "", fmt.Errorf("set memory.oom.group on %s: %w", runsc.ScopeUnit(spec.ID), err)
	}
	return cg, nil
}

func (r *Runtime) Wait(ctx context.Context, version, id string) (*int, error) {
	out, err := r.at(version).Command(ctx, "", "wait", id).Output()
	if err != nil {
		return nil, err
	}
	var w struct {
		ExitStatus *int `json:"exitStatus"`
	}
	if jerr := json.Unmarshal(out, &w); jerr != nil {
		return nil, fmt.Errorf("runsc wait answered %q: %w", strings.TrimSpace(string(out)), jerr)
	}
	if w.ExitStatus != nil && *w.ExitStatus > 255 {
		code := *w.ExitStatus >> 8
		return &code, nil
	}
	return w.ExitStatus, nil
}

func (r *Runtime) Stop(ctx context.Context, version, id string, grace time.Duration) error {
	return r.at(version).Stop(ctx, id, grace)
}

func (r *Runtime) Kill(ctx context.Context, id string) error {
	ctx, cancel := context.WithTimeout(ctx, runsc.ScopeKillLimit)
	defer cancel()
	return runsc.KillScope(ctx, id)
}

func (r *Runtime) List(ctx context.Context, version string) ([]sandbox.State, error) {
	states, err := r.at(version).List(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]sandbox.State, 0, len(states))
	for _, s := range states {
		out = append(out, sandbox.State{ID: s.ID, Running: s.Status == runsc.StatusRunning})
	}
	return out, nil
}

func (r *Runtime) Exec(ctx context.Context, version string, spec sandbox.ExecSpec) (sandbox.Process, error) {
	return r.at(version).Exec(ctx, spec)
}

func (r *Runtime) Unit(id string) string {
	return runsc.ScopeUnit(id)
}

func (r *Runtime) Cgroup(ctx context.Context, id string) (string, error) {
	return runsc.ScopeCgroup(ctx, id)
}

func (r *Runtime) AssertOOMGroup(cgroup string) (bool, error) {
	if runsc.GroupsOOM(cgroup) {
		return false, nil
	}
	if err := runsc.GroupOOM(cgroup); err != nil {
		return false, err
	}
	return true, nil
}

func (r *Runtime) Strays(known map[string]bool) []string {
	entries, _ := os.ReadDir("/proc")
	var out []string
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		exe, err := os.Readlink(filepath.Join("/proc", e.Name(), "exe"))
		if err != nil || !strings.HasPrefix(exe, r.libDir+"/runsc-") {
			continue
		}
		base := filepath.Base(exe)
		if !slices.Contains(helpers, base) {
			continue
		}
		cg, err := os.ReadFile(filepath.Join("/proc", e.Name(), "cgroup"))
		if err != nil {
			continue
		}
		path := strings.TrimSpace(strings.TrimPrefix(string(cg), "0::"))
		inSlice := strings.Contains(path, "/"+runsc.ScopeSlice+"/")
		if !inSlice && strings.Contains(path, stationdCgroup) {
			continue
		}
		if !inSlice || !known[path] {
			out = append(out, fmt.Sprintf("%s pid %d in %s", base, pid, path))
		}
	}
	slices.Sort(out)
	return out
}

func (r *Runtime) LogFiles(logDir string) []string {
	out := []string{runtimeLog, panicFile}
	entries, _ := os.ReadDir(logDir)
	for _, e := range entries {
		if e.Type().IsRegular() && strings.HasPrefix(e.Name(), runtimeLog+".") && strings.HasSuffix(e.Name(), ".txt") {
			out = append(out, e.Name())
		}
	}
	return out
}

func (r *Runtime) Panic(logDir string) string {
	return panicLine(logDir)
}

func panicLine(logDir string) string {
	b, err := os.ReadFile(filepath.Join(logDir, panicFile))
	if err != nil || len(b) == 0 {
		return ""
	}
	line, _, _ := strings.Cut(strings.TrimSpace(string(b)), "\n")
	return line[:min(len(line), maxPanicLine)]
}

func panicSuffix(logDir string) string {
	if line := panicLine(logDir); line != "" {
		return "; " + line
	}
	return ""
}
