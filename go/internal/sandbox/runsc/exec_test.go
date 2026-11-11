//go:build linux

package runsc

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/harshjv/stationly/go/internal/sandbox"
)

func TestExecPipes(t *testing.T) {
	rt := fakeRuntime(t)
	bundle := t.TempDir()
	e, err := rt.Exec(context.Background(), sandbox.ExecSpec{
		ID: "sbx_1", BundleDir: bundle, Args: []string{"/bin/sh", "-c", "x"},
		Env: []string{"A=1", "B=2", "A=3"}, Cwd: "/tmp", UID: 1000, GID: 1000, Groups: []int{998},
	})
	if err != nil {
		t.Fatal(err)
	}
	left, err := os.ReadDir(bundle)
	if err != nil {
		t.Fatal(err)
	}
	if len(left) != 0 {
		t.Errorf("process file left in bundle: %v", left)
	}
	if e.Pid() <= 0 {
		t.Errorf("pid %d", e.Pid())
	}
	if _, err := io.WriteString(e.Stdin(), "hello\n"); err != nil {
		t.Fatal(err)
	}
	if err := e.Stdin().Close(); err != nil {
		t.Fatal(err)
	}
	var stderr []byte
	var serr error
	var wg sync.WaitGroup
	wg.Go(func() { stderr, serr = io.ReadAll(e.Stderr()) })
	stdout, err := io.ReadAll(e.Stdout())
	if err != nil {
		t.Fatal(err)
	}
	wg.Wait()
	if serr != nil {
		t.Fatal(serr)
	}
	code, err := e.Wait()
	if err != nil || code != 7 {
		t.Fatalf("exit %d %v", code, err)
	}
	if string(stderr) != "err\n" {
		t.Errorf("stderr %q", stderr)
	}
	lines := strings.Split(strings.TrimSpace(string(stdout)), "\n")
	if len(lines) != 2 || lines[1] != "in:hello" {
		t.Fatalf("stdout %q", stdout)
	}
	var p ociProcess
	if err := json.Unmarshal([]byte(lines[0]), &p); err != nil {
		t.Fatal(err)
	}
	if p.Terminal || p.Cwd != "/tmp" || p.User.UID != 1000 || p.User.GID != 1000 || !slices.Equal(p.User.AdditionalGids, []int{998}) || !p.NoNewPrivileges {
		t.Errorf("process %+v", p)
	}
	if strings.Join(p.Env, ",") != "A=3,B=2" || strings.Join(p.Args, " ") != "/bin/sh -c x" || len(p.Capabilities.Bounding) != 16 || len(p.Rlimits) != 1 {
		t.Errorf("process %+v", p)
	}
	got := calls(t, rt)
	if len(got) != 1 || got[0] != "exec --process /proc/self/fd/3 sbx_1" {
		t.Errorf("calls %q", got)
	}
	if err := e.Resize(10, 10); err != nil {
		t.Errorf("resize on pipes: %v", err)
	}
}

type collector struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (c *collector) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.buf.Write(p)
}

func (c *collector) waitFor(t *testing.T, s string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		c.mu.Lock()
		ok := strings.Contains(c.buf.String(), s)
		c.mu.Unlock()
		if ok {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	t.Fatalf("no %q in %q", s, c.buf.String())
}

func TestExecTTY(t *testing.T) {
	rt := fakeRuntime(t)
	e, err := rt.Exec(context.Background(), sandbox.ExecSpec{
		ID: "sbx_1", BundleDir: t.TempDir(), Args: []string{"/bin/bash"}, TTY: true, Rows: 40, Cols: 132,
	})
	if err != nil {
		t.Fatal(err)
	}
	if e.Stderr() != nil {
		t.Error("stderr set for a tty")
	}
	out := &collector{}
	done := make(chan error, 1)
	go func() {
		_, err := io.Copy(out, e.Stdout())
		done <- err
	}()
	out.waitFor(t, `"terminal":true`)
	out.waitFor(t, "tty 40 132")
	if err := e.Resize(50, 200); err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(e.Stdin(), "size\n"); err != nil {
		t.Fatal(err)
	}
	out.waitFor(t, "size 50 200")
	if _, err := io.WriteString(e.Stdin(), "exit\n"); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("copy: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("stdout did not end")
	}
	code, err := e.Wait()
	if err != nil || code != 3 {
		t.Fatalf("exit %d %v", code, err)
	}
}

func TestExecKill(t *testing.T) {
	rt := fakeRuntime(t)
	e, err := rt.Exec(context.Background(), sandbox.ExecSpec{ID: "sbx_1", BundleDir: t.TempDir(), Args: []string{"sh"}, TTY: true})
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		_, _ = io.Copy(io.Discard, e.Stdout())
	}()
	if err := e.Kill(); err != nil {
		t.Fatal(err)
	}
	code, err := e.Wait()
	if err != nil || code != 137 {
		t.Fatalf("exit %d %v", code, err)
	}
	if err := e.Kill(); err != nil {
		t.Errorf("second kill: %v", err)
	}
}
