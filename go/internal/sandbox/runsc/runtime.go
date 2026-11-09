//go:build linux

package runsc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"strings"
	"time"
)

const (
	StatusCreated = "created"
	StatusRunning = "running"
	StatusPaused  = "paused"
	StatusStopped = "stopped"

	probeTimeout       = 30 * time.Second
	pollInterval       = 100 * time.Millisecond
	killWait           = 5 * time.Second
	stateTimeout       = 10 * time.Second
	systemctlNotLoaded = 5
)

type State struct {
	ID      string
	Status  string
	Pid     int
	Bundle  string
	Created time.Time
}

type stateJSON struct {
	ID      string    `json:"id"`
	Status  string    `json:"status"`
	Pid     int       `json:"pid"`
	Bundle  string    `json:"bundle"`
	Created time.Time `json:"created"`
}

func (s stateJSON) state() State {
	return State{ID: s.ID, Status: s.Status, Pid: s.Pid, Bundle: s.Bundle, Created: s.Created}
}

func (rt Runtime) run(ctx context.Context, logDir string, args ...string) ([]byte, error) {
	cmd := rt.Command(ctx, logDir, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		wrapped := fmt.Errorf("runsc %s: %w: %s", strings.Join(args, " "), err, msg)
		if isNotFound(msg) {
			return nil, fmt.Errorf("%w: %w", ErrNotFound, wrapped)
		}
		return nil, wrapped
	}
	return stdout.Bytes(), nil
}

func isNotFound(msg string) bool {
	m := strings.ToLower(msg)
	return strings.Contains(m, "does not exist") || strings.Contains(m, "no such file or directory") || strings.Contains(m, "not found")
}

func (rt Runtime) State(ctx context.Context, id string) (State, error) {
	out, err := rt.run(ctx, "", "state", id)
	if err != nil {
		return State{}, err
	}
	var s stateJSON
	if err := json.Unmarshal(out, &s); err != nil {
		return State{}, fmt.Errorf("runsc state %s: %w", id, err)
	}
	return s.state(), nil
}

func (rt Runtime) List(ctx context.Context) ([]State, error) {
	if _, err := os.Stat(rt.Root); errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	out, err := rt.run(ctx, "", "list", "--format=json")
	if err != nil {
		return nil, err
	}
	var list []stateJSON
	if err := json.Unmarshal(out, &list); err != nil {
		return nil, fmt.Errorf("runsc list: %w", err)
	}
	states := make([]State, 0, len(list))
	for _, s := range list {
		states = append(states, s.state())
	}
	return states, nil
}

func (rt Runtime) Create(ctx context.Context, logDir, bundle, id string, stdout *os.File) error {
	cmd := rt.Command(ctx, logDir, "create", "--bundle", bundle, id)
	cmd.Stdin = nil
	cmd.Stdout = stdout
	cmd.Stderr = stdout
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("runsc create %s: %w", id, err)
	}
	return nil
}

func (rt Runtime) Start(ctx context.Context, logDir, id string) error {
	_, err := rt.run(ctx, logDir, "start", id)
	return err
}

func (rt Runtime) Kill(ctx context.Context, id string, sig string) error {
	_, err := rt.run(ctx, "", "kill", id, sig)
	return err
}

func (rt Runtime) Delete(ctx context.Context, id string, force bool) error {
	args := []string{"delete"}
	if force {
		args = append(args, "--force")
	}
	_, err := rt.run(ctx, "", append(args, id)...)
	return err
}

func (rt Runtime) Stop(ctx context.Context, id string, grace time.Duration) error {
	if _, err := os.Stat(rt.binary()); errors.Is(err, fs.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	st, err := rt.boundedState(ctx, id)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	var killErr error
	if st.Status == StatusRunning || st.Status == StatusPaused {
		killErr = rt.Kill(ctx, id, "TERM")
		stopped, err := rt.waitStopped(ctx, id, grace)
		if err != nil {
			return errors.Join(killErr, err)
		}
		if !stopped {
			killErr = errors.Join(killErr, rt.Kill(ctx, id, "KILL"))
			if _, err := rt.waitStopped(ctx, id, killWait); err != nil {
				return errors.Join(killErr, err)
			}
		}
	}
	if err := rt.Delete(ctx, id, true); err != nil && !errors.Is(err, ErrNotFound) {
		return errors.Join(killErr, err)
	}
	return nil
}

func (rt Runtime) waitStopped(ctx context.Context, id string, limit time.Duration) (bool, error) {
	deadline := time.Now().Add(limit)
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		st, err := rt.boundedState(ctx, id)
		if errors.Is(err, ErrNotFound) {
			return true, nil
		}
		if err == nil && st.Status == StatusStopped {
			return true, nil
		}
		if ctx.Err() != nil {
			return false, ctx.Err()
		}
		if !time.Now().Before(deadline) {
			return false, nil
		}
		select {
		case <-ctx.Done():
			return false, ctx.Err()
		case <-ticker.C:
		}
	}
}

func (rt Runtime) boundedState(ctx context.Context, id string) (State, error) {
	sctx, cancel := context.WithTimeout(ctx, stateTimeout)
	defer cancel()
	return rt.State(sctx, id)
}

func (rt Runtime) Probe(ctx context.Context) (err error) {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	tmp, err := os.MkdirTemp("", "runsc-probe-")
	if err != nil {
		return err
	}
	defer func() {
		err = errors.Join(err, os.RemoveAll(tmp))
	}()
	args := []string{"--root", tmp, "--platform=systrap", "--network=none", "do", "true"}
	if err := CheckArgs(args); err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, rt.binary(), args...)
	cmd.Env = []string{envPath}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("runsc probe %s: %w: %s", rt.Version, err, strings.TrimSpace(string(out)))
	}
	return nil
}
