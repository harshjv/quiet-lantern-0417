//go:build linux

package runsc

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

const fakeRunsc = `#!/bin/sh
d=$(dirname "$0")
echo "$*" >> "$d/calls"
env > "$d/env"
while [ $# -gt 0 ]; do
  case "$1" in state|list|kill|delete|exec|create|start|do) break;; esac
  shift
done
cmd=$1; shift
case "$cmd" in
state)
  if [ -f "$d/st" ]; then
    printf '{"ociVersion":"1.2.1","id":"%s","status":"%s","pid":42,"bundle":"/b","created":"2026-11-08T10:00:00.5Z","owner":""}' "$1" "$(cat "$d/st")"
  else
    echo "loading container: file does not exist" >&2; exit 1
  fi;;
list)
  printf '[{"id":"a","status":"running","pid":7,"bundle":"/b/a","created":"2026-11-08T10:00:00Z"},{"id":"b","status":"stopped","pid":0,"bundle":"/b/b","created":"2026-11-08T11:00:00Z"}]';;
kill)
  [ -f "$d/st" ] || { echo "loading container: file does not exist" >&2; exit 1; }
  if [ "$2" = KILL ] || [ -f "$d/term-stops" ]; then echo stopped > "$d/st"; fi;;
delete)
  rm -f "$d/st";;
create)
  echo "create stdout"; echo "create stderr" >&2;;
start)
  :;;
exec)
  cat "$2"; echo
  if [ -t 0 ]; then
    echo "tty $(stty size)"
    while read line; do
      case "$line" in
      size) echo "size $(stty size)";;
      exit) exit 3;;
      esac
    done
  else
    read line; echo "in:$line"; echo "err" >&2; exit 7
  fi;;
esac
`

func fakeRuntime(t *testing.T) Runtime {
	t.Helper()
	lib, state := t.TempDir(), t.TempDir()
	rt := At(lib, state, "1.0")
	if err := os.MkdirAll(rt.Dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rt.Dir, "runsc"), []byte(fakeRunsc), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(rt.Root, 0o711); err != nil {
		t.Fatal(err)
	}
	return rt
}

func setState(t *testing.T, rt Runtime, status string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(rt.Dir, "st"), []byte(status), 0o644); err != nil {
		t.Fatal(err)
	}
}

func calls(t *testing.T, rt Runtime) []string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(rt.Dir, "calls"))
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	prefix := strings.Join(rt.globals(""), " ") + " "
	for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		out = append(out, strings.TrimPrefix(l, prefix))
	}
	return out
}

func TestStateAndList(t *testing.T) {
	rt := fakeRuntime(t)
	ctx := context.Background()
	if _, err := rt.State(ctx, "x"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing state err %v", err)
	}
	setState(t, rt, "running")
	st, err := rt.State(ctx, "x")
	if err != nil {
		t.Fatal(err)
	}
	want := State{ID: "x", Status: "running", Pid: 42, Bundle: "/b", Created: time.Date(2026, 11, 8, 10, 0, 0, 5e8, time.UTC)}
	if !st.Created.Equal(want.Created) || st.ID != want.ID || st.Status != want.Status || st.Pid != want.Pid || st.Bundle != want.Bundle {
		t.Errorf("state %+v", st)
	}
	env, err := os.ReadFile(filepath.Join(rt.Dir, "env"))
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range strings.Split(strings.TrimSpace(string(env)), "\n") {
		if !strings.HasPrefix(l, "PATH=") && !strings.HasPrefix(l, "PWD=") && !strings.HasPrefix(l, "SHLVL=") && !strings.HasPrefix(l, "_=") {
			t.Errorf("unexpected env %q", l)
		}
	}
	list, err := rt.List(ctx)
	if err != nil || len(list) != 2 || list[0].ID != "a" || list[1].Status != "stopped" || list[0].Pid != 7 {
		t.Errorf("list %+v %v", list, err)
	}
	none := At(t.TempDir(), filepath.Join(t.TempDir(), "absent"), "1.0")
	list, err = none.List(ctx)
	if err != nil || len(list) != 0 {
		t.Errorf("absent root list %+v %v", list, err)
	}
}

func TestCreateWritesToGivenFile(t *testing.T) {
	rt := fakeRuntime(t)
	logDir := t.TempDir()
	out, err := os.OpenFile(filepath.Join(logDir, "init.log"), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o640)
	if err != nil {
		t.Fatal(err)
	}
	if err := rt.Create(context.Background(), logDir, "/bundle", "sbx_1", out); err != nil {
		t.Fatal(err)
	}
	if err := out.Close(); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(logDir, "init.log"))
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "create stdout\ncreate stderr\n" {
		t.Errorf("init.log %q", b)
	}
	if err := rt.Start(context.Background(), logDir, "sbx_1"); err != nil {
		t.Fatal(err)
	}
	logs := "--log " + logDir + "/runsc.log --panic-log " + logDir + "/panic.log --debug-log " + logDir + "/ "
	got := calls(t, rt)
	if len(got) != 2 || got[0] != logs+"create --bundle /bundle sbx_1" || got[1] != logs+"start sbx_1" {
		t.Errorf("calls %q", got)
	}
}

func TestStopGraceful(t *testing.T) {
	rt := fakeRuntime(t)
	setState(t, rt, "running")
	if err := os.WriteFile(filepath.Join(rt.Dir, "term-stops"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := rt.Stop(context.Background(), "x", 2*time.Second); err != nil {
		t.Fatal(err)
	}
	if got := calls(t, rt); !slices.Equal(got, []string{"state x", "kill x TERM", "state x", "delete --force x"}) {
		t.Errorf("calls %q", got)
	}
}

func TestStopEscalates(t *testing.T) {
	rt := fakeRuntime(t)
	setState(t, rt, "running")
	start := time.Now()
	if err := rt.Stop(context.Background(), "x", 300*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d < 300*time.Millisecond {
		t.Errorf("did not wait the grace: %v", d)
	}
	got := calls(t, rt)
	if got[1] != "kill x TERM" || !slices.Contains(got, "kill x KILL") || got[len(got)-1] != "delete --force x" {
		t.Errorf("calls %q", got)
	}
	if n := strings.Count(strings.Join(got, "\n"), "state x"); n < 3 {
		t.Errorf("polled state %d times", n)
	}
}

func TestStopMissingContainer(t *testing.T) {
	rt := fakeRuntime(t)
	if err := rt.Stop(context.Background(), "x", time.Second); err != nil {
		t.Fatal(err)
	}
	if got := calls(t, rt); !slices.Equal(got, []string{"state x"}) {
		t.Errorf("calls %q", got)
	}
}

func TestStopCreatedSkipsSignals(t *testing.T) {
	rt := fakeRuntime(t)
	setState(t, rt, "created")
	if err := rt.Stop(context.Background(), "x", time.Second); err != nil {
		t.Fatal(err)
	}
	if got := calls(t, rt); !slices.Equal(got, []string{"state x", "delete --force x"}) {
		t.Errorf("calls %q", got)
	}
}

func TestStopWithoutTheBinaryLeavesTheScopeToKillScope(t *testing.T) {
	rt := At(t.TempDir(), t.TempDir(), "gone")
	if err := rt.Stop(context.Background(), "sbx_01ABC", time.Second); err != nil {
		t.Fatal(err)
	}
}

func TestProbe(t *testing.T) {
	rt := fakeRuntime(t)
	if err := rt.Probe(context.Background()); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(rt.Dir, "calls"))
	if err != nil {
		t.Fatal(err)
	}
	fields := strings.Fields(string(b))
	if len(fields) != 6 || fields[0] != "--root" || fields[2] != "--platform=systrap" || fields[3] != "--network=none" || fields[4] != "do" || fields[5] != "true" {
		t.Fatalf("probe args %q", fields)
	}
	if _, err := os.Stat(fields[1]); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("probe root left behind: %v", err)
	}
	broken := At(t.TempDir(), t.TempDir(), "x")
	if err := broken.Probe(context.Background()); err == nil {
		t.Error("probe of a missing binary passed")
	}
}
