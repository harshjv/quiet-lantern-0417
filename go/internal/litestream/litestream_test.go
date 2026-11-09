package litestream

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/harshjv/stationly/go/internal/hostconfig"
)

func TestConfigNamesTheBucketAndLeavesCredentialsToTheEnvironment(t *testing.T) {
	cases := []struct {
		name string
		in   hostconfig.Litestream
		want string
	}{
		{"aws s3", hostconfig.Litestream{Bucket: "my-bucket", AccessKey: "AK", SecretKey: "SK"}, "dbs:\n- path: /data/dispatch.sqlite\n  replica:\n    type: s3\n    bucket: my-bucket\n    path: dispatch\n"},
		{"r2", hostconfig.Litestream{Bucket: "sly", Endpoint: "https://abc123.r2.cloudflarestorage.com", AccessKey: "AK", SecretKey: "SK"}, "dbs:\n- path: /data/dispatch.sqlite\n  replica:\n    type: s3\n    bucket: sly\n    path: dispatch\n    endpoint: https://abc123.r2.cloudflarestorage.com\n    region: auto\n"},
		{"minio", hostconfig.Litestream{Bucket: "sly", Endpoint: "http://10.0.0.5:9000", AccessKey: "AK", SecretKey: "SK"}, "dbs:\n- path: /data/dispatch.sqlite\n  replica:\n    type: s3\n    bucket: sly\n    path: dispatch\n    endpoint: http://10.0.0.5:9000\n"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := Config(c.in, "/data/dispatch.sqlite")
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != c.want {
				t.Fatalf("config:\n%s\nwant:\n%s", got, c.want)
			}
			for _, secret := range []string{c.in.AccessKey, c.in.SecretKey} {
				if strings.Contains(string(got), secret) {
					t.Fatalf("the config file carries %q", secret)
				}
			}
		})
	}
}

func TestConfigRefusesAHostWithoutABucket(t *testing.T) {
	if _, err := Config(hostconfig.Litestream{}, "/data/dispatch.sqlite"); err == nil {
		t.Fatal("expected an error")
	}
}

func TestEnvCarriesTheCredentials(t *testing.T) {
	got := Env(hostconfig.Litestream{AccessKey: "AK", SecretKey: "SK"})
	if len(got) != 2 || got[0] != "LITESTREAM_ACCESS_KEY_ID=AK" || got[1] != "LITESTREAM_SECRET_ACCESS_KEY=SK" {
		t.Fatalf("env %v", got)
	}
}

const ltxListing = `[
 {"level":0,"min_txid":"0000000000000001","max_txid":"0000000000000001","size":567,"timestamp":"2026-11-07T17:18:25Z"},
 {"level":0,"min_txid":"0000000000000002","max_txid":"0000000000000004","size":201,"timestamp":"2026-11-07T17:19:24Z"},
 {"level":1,"min_txid":"0000000000000001","max_txid":"000000000000000a","size":270,"timestamp":"2026-11-07T17:19:30Z"}
]`

func TestParseReplicaTakesTheNewestTransactionAndTimestamp(t *testing.T) {
	r, err := ParseReplica([]byte(ltxListing))
	if err != nil {
		t.Fatal(err)
	}
	if r.MaxTXID != 10 || !r.NewestAt.Equal(time.Date(2026, 11, 7, 17, 19, 30, 0, time.UTC)) {
		t.Fatalf("replica %+v", r)
	}
}

func TestParseReplicaRejectsGarbage(t *testing.T) {
	for _, in := range []string{"", "{}", `[{"max_txid":"zz"}]`} {
		if _, err := ParseReplica([]byte(in)); err == nil {
			t.Fatalf("%q parsed", in)
		}
	}
}

func TestParseReplicaOfAnEmptyBucketIsZero(t *testing.T) {
	r, err := ParseReplica([]byte("[]"))
	if err != nil || r.MaxTXID != 0 {
		t.Fatalf("%+v %v", r, err)
	}
}

func writeLocal(t *testing.T, dir string, name string, mod time.Time) {
	t.Helper()
	path := filepath.Join(dir, ".dispatch.sqlite-litestream", "ltx", "0")
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(path, name)
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(file, mod, mod); err != nil {
		t.Fatal(err)
	}
}

func TestLocalFilesListTheSidecarsTransactionsInOrder(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	writeLocal(t, dir, "0000000000000003-0000000000000003.ltx", now)
	writeLocal(t, dir, "0000000000000001-0000000000000001.ltx", now.Add(-time.Hour))
	writeLocal(t, dir, "ignored.txt", now)
	got, err := LocalFiles(dir, "/data/dispatch.sqlite")
	if err != nil || len(got) != 2 || got[0].TXID != 1 || got[1].TXID != 3 {
		t.Fatalf("%+v %v", got, err)
	}
}

func TestLocalFilesOfAVolumeWithoutTheSidecarIsEmpty(t *testing.T) {
	got, err := LocalFiles(t.TempDir(), "/data/dispatch.sqlite")
	if err != nil || len(got) != 0 {
		t.Fatalf("%+v %v", got, err)
	}
}

func TestComputeMeasuresTheOldestUnreplicatedTransaction(t *testing.T) {
	now := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	replica := Replica{MaxTXID: 5, NewestAt: now.Add(-time.Hour)}
	local := []LocalFile{{TXID: 5, ModTime: now.Add(-time.Hour)}, {TXID: 6, ModTime: now.Add(-90 * time.Second)}, {TXID: 7, ModTime: now.Add(-10 * time.Second)}}
	st := Compute(now, replica, local)
	if st.BehindTXIDs != 2 || st.Lag != 90*time.Second || st.LocalTXID != 7 || st.Stalled() {
		t.Fatalf("%+v", st)
	}
}

func TestComputeOfAReplicatedDatabaseHasNoLag(t *testing.T) {
	now := time.Now()
	st := Compute(now, Replica{MaxTXID: 5, NewestAt: now}, []LocalFile{{TXID: 5, ModTime: now}})
	if st.BehindTXIDs != 0 || st.Lag != 0 || st.Stalled() {
		t.Fatalf("%+v", st)
	}
}

func TestReplicationStallsAfterFiveMinutesOfUnreplicatedWrites(t *testing.T) {
	now := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	st := Compute(now, Replica{MaxTXID: 1, NewestAt: now.Add(-time.Hour)}, []LocalFile{{TXID: 2, ModTime: now.Add(-6 * time.Minute)}})
	if !st.Stalled() {
		t.Fatalf("%+v", st)
	}
	st = Compute(now, Replica{MaxTXID: 1}, []LocalFile{{TXID: 2, ModTime: now.Add(-4 * time.Minute)}})
	if st.Stalled() {
		t.Fatalf("%+v", st)
	}
}
