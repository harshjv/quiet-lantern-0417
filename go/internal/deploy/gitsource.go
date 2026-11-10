//go:build linux

package deploy

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/harshjv/stationly/go/internal/protocol"
)

const (
	gitTokenKey     = "STATIONLY_GIT_TOKEN"
	gitFetchTimeout = 10 * time.Minute
)

type shaMismatch struct {
	expected, fetched string
}

func (e *shaMismatch) Error() string {
	return fmt.Sprintf("the fetched commit %s is not the approved %s", e.fetched, e.expected)
}

func gitToken(delivery protocol.SecretsDeliverBody, ok bool) (string, error) {
	if !ok {
		return "", nil
	}
	for _, v := range delivery.Values {
		if v.Key != gitTokenKey {
			continue
		}
		raw, err := base64.RawURLEncoding.DecodeString(v.Value)
		if err != nil {
			return "", fmt.Errorf("the clone credential is not base64url: %w", err)
		}
		return string(raw), nil
	}
	return "", nil
}

func gitEnv(home, token string) []string {
	env := []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=" + home,
		"GIT_TERMINAL_PROMPT=0",
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_ASKPASS=/bin/false",
		"LC_ALL=C",
	}
	if token == "" {
		return append(env, "GIT_CONFIG_COUNT=0")
	}
	basic := base64.StdEncoding.EncodeToString([]byte("x-access-token:" + token))
	return append(env, "GIT_CONFIG_COUNT=1", "GIT_CONFIG_KEY_0=http.extraHeader", "GIT_CONFIG_VALUE_0=Authorization: Basic "+basic)
}

func runGit(ctx context.Context, dir string, env []string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = env
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %s: %w: %s", args[0], err, strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(stdout.String()), nil
}

func fetchGit(ctx context.Context, src protocol.BuildSource, token, dst string) (string, error) {
	if src.Url == nil || src.Sha == nil || *src.Sha == "" {
		return "", fmt.Errorf("a git source needs url and sha")
	}
	ctx, cancel := context.WithTimeout(ctx, gitFetchTimeout)
	defer cancel()
	if err := os.MkdirAll(dst, 0o700); err != nil {
		return "", err
	}
	home := filepath.Join(filepath.Dir(dst), "."+filepath.Base(dst)+"-home")
	if err := os.MkdirAll(home, 0o700); err != nil {
		return "", err
	}
	defer os.RemoveAll(home)
	env := gitEnv(home, token)
	want := *src.Sha
	if src.Ref != nil && *src.Ref != "" {
		want = *src.Ref
	}
	if _, err := runGit(ctx, dst, env, "init", "--quiet"); err != nil {
		return "", err
	}
	if _, err := runGit(ctx, dst, env, "fetch", "--quiet", "--depth", "1", "--no-tags", *src.Url, want); err != nil {
		return "", err
	}
	fetched, err := runGit(ctx, dst, env, "rev-parse", "FETCH_HEAD")
	if err != nil {
		return "", err
	}
	if fetched != *src.Sha {
		return fetched, &shaMismatch{expected: *src.Sha, fetched: fetched}
	}
	if _, err := runGit(ctx, dst, env, "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", "FETCH_HEAD"); err != nil {
		return fetched, err
	}
	return fetched, os.RemoveAll(filepath.Join(dst, ".git"))
}
