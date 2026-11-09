//go:build linux

package deploy

import (
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/harshjv/stationly/go/internal/hostconfig"
	"github.com/harshjv/stationly/go/internal/litestream"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/verify"
)

func launchWith(t *testing.T, l *hostconfig.Litestream) dispatchLaunch {
	t.Helper()
	root := t.TempDir()
	etc, state := filepath.Join(root, "etc"), filepath.Join(root, "state", "stationd")
	if err := hostconfig.Save(etc, &hostconfig.Config{Dispatch: hostconfig.Dispatch{URL: "http://127.0.0.1:7900", MasterKey: "k"}, Litestream: func() hostconfig.Litestream {
		if l == nil {
			return hostconfig.Litestream{}
		}
		return *l
	}()}); err != nil {
		t.Fatal(err)
	}
	manifest := `{"schema":1,"release":"0.1.0","channel":"edge","published_at":"2026-11-07T00:00:00Z","changelog":"x","components":{"litestream":{"kind":"image","version":"0.5.17","source":"docker.io/litestream/litestream","digest":"sha256:` + strings.Repeat("a", 64) + `","platforms":{"linux/amd64":"sha256:` + strings.Repeat("b", 64) + `","linux/arm64":"sha256:` + strings.Repeat("c", 64) + `"}}}}`
	if err := os.MkdirAll(state, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(ReleaseDir(state), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ReleaseDir(state), manifestFile), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	return dispatchLaunch{stationID: "stn_1", stateDir: state, etcDir: etc, trust: verify.Trust{}, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
}

func TestNoBucketMeansNoSidecarPlan(t *testing.T) {
	l := launchWith(t, nil)
	plan, err := l.litestreamPlan()
	if plan != nil || err != nil || l.replicated() {
		t.Fatalf("plan %v err %v replicated %v", plan, err, l.replicated())
	}
}

func TestPlanFromHostTomlKeepsSecretsOutOfTheConfigFile(t *testing.T) {
	l := launchWith(t, &hostconfig.Litestream{Bucket: "sly", Endpoint: "http://10.0.0.5:9000", AccessKey: "AKIDEXAMPLE", SecretKey: "s3cr3t-value"})
	plan, err := l.litestreamPlan()
	if err != nil || plan == nil || !l.replicated() {
		t.Fatalf("plan %v err %v", plan, err)
	}
	if strings.Contains(string(plan.config), "AKIDEXAMPLE") || strings.Contains(string(plan.config), "s3cr3t-value") {
		t.Fatalf("the config file carries credentials:\n%s", plan.config)
	}
	if err := plan.writeConfig(); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(l.stateDir, "config", "litestream.yml"))
	if err != nil || string(got) != string(plan.config) {
		t.Fatalf("written config %q, %v", got, err)
	}
	joined := strings.Join(plan.env, "\n")
	for _, want := range []string{"LITESTREAM_ACCESS_KEY_ID=AKIDEXAMPLE", "LITESTREAM_SECRET_ACCESS_KEY=s3cr3t-value", "STATIONLY_LITESTREAM_CONFIG_SHA256="} {
		if !strings.Contains(joined, want) {
			t.Fatalf("env lacks %s: %v", want, plan.env)
		}
	}
}

func TestSidecarImageComesFromTheReleaseThenFromTheRecordedPin(t *testing.T) {
	l := launchWith(t, &hostconfig.Litestream{Bucket: "sly", AccessKey: "a", SecretKey: "s"})
	fromRelease, err := l.litestreamImage()
	if err != nil || !strings.HasPrefix(fromRelease, "docker.io/litestream/litestream@sha256:") {
		t.Fatalf("%q %v", fromRelease, err)
	}
	recorded := map[string]componentRecord{"litestream": {componentPin: componentPin{Version: "0.5.18", Digest: "sha256:" + strings.Repeat("d", 64)}}}
	b, _ := json.Marshal(recorded)
	if err := os.WriteFile(filepath.Join(l.stateDir, componentsFile), b, 0o600); err != nil {
		t.Fatal(err)
	}
	fromRecord, err := l.litestreamImage()
	if err != nil || !strings.HasSuffix(fromRecord, strings.Repeat("d", 64)) {
		t.Fatalf("%q %v", fromRecord, err)
	}
	l.litestreamPin = &componentPin{Version: "0.5.19", Digest: "sha256:" + strings.Repeat("e", 64)}
	override, err := l.litestreamImage()
	if err != nil || !strings.HasSuffix(override, strings.Repeat("e", 64)) {
		t.Fatalf("%q %v", override, err)
	}
}

func TestReplicaRowStatuses(t *testing.T) {
	now := time.Now()
	cases := []struct {
		name   string
		state  litestream.State
		status protocol.DoctorStatus
		code   string
	}{
		{"caught up", litestream.State{LocalTXID: 9, ReplicaTXID: 9, LastReplicated: now}, protocol.DoctorStatusOk, ""},
		{"a few transactions in flight", litestream.State{LocalTXID: 11, ReplicaTXID: 9, BehindTXIDs: 2, Lag: 3 * time.Second, LastReplicated: now}, protocol.DoctorStatusOk, ""},
		{"stalled", litestream.State{LocalTXID: 11, ReplicaTXID: 9, BehindTXIDs: 2, Lag: 6 * time.Minute, LastReplicated: now.Add(-time.Hour)}, protocol.DoctorStatusFail, "replication_stalled"},
		{"empty bucket", litestream.State{}, protocol.DoctorStatusWarn, "replica_empty"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			check := newCheck("litestream")
			raiseReplica(check, c.state)
			got := check.build()
			code := ""
			if got.Code != nil {
				code = *got.Code
			}
			if got.Status != c.status || code != c.code {
				t.Fatalf("%s %s: %s", got.Status, code, got.Finding)
			}
			if _, ok := got.Detail["behind_txids"]; !ok {
				t.Fatal("the row lacks behind_txids")
			}
		})
	}
}

func TestDoctorWithoutABucketStillWarns(t *testing.T) {
	s := &Station{opts: Options{}}
	got := s.checkLitestream(t.Context())
	if got.Status != protocol.DoctorStatusWarn || got.Code == nil || *got.Code != "no_offhost_backup" {
		t.Fatalf("%+v", got)
	}
}
