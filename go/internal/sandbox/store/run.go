package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

const outputLines = 20

type CommandError struct {
	Argv     []string
	Output   string
	ExitCode int
	Err      error
}

func (e *CommandError) Error() string {
	msg := fmt.Sprintf("%s: %v", strings.Join(e.Argv, " "), e.Err)
	if e.Output != "" {
		msg += ": " + e.Output
	}
	return msg
}

func (e *CommandError) Unwrap() error {
	return e.Err
}

func exitCode(err error) int {
	var ce *CommandError
	if errors.As(err, &ce) {
		return ce.ExitCode
	}
	return -1
}

var run = func(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C"}
	out, err := cmd.CombinedOutput()
	if err == nil {
		return string(out), nil
	}
	code := -1
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		code = ee.ExitCode()
	}
	return string(out), &CommandError{Argv: append([]string{name}, args...), Output: trimOutput(string(out)), ExitCode: code, Err: err}
}

var rename = os.Rename

func trimOutput(out string) string {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) > outputLines {
		lines = append(lines[:outputLines], fmt.Sprintf("... %d more lines", len(lines)-outputLines))
	}
	return strings.Join(lines, "\n")
}
