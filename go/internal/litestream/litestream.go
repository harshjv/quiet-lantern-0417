package litestream

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/goccy/go-yaml"
	"github.com/harshjv/stationly/go/internal/hostconfig"
)

const (
	ConfigTarget  = "/etc/litestream.yml"
	ReplicaPath   = "dispatch"
	AccessKeyEnv  = "LITESTREAM_ACCESS_KEY_ID"
	SecretKeyEnv  = "LITESTREAM_SECRET_ACCESS_KEY"
	StallAfter    = 5 * time.Minute
	r2Suffix      = ".r2.cloudflarestorage.com"
	metadataDirFn = ".%s-litestream"
)

type replicaConfig struct {
	Type     string `yaml:"type"`
	Bucket   string `yaml:"bucket"`
	Path     string `yaml:"path"`
	Endpoint string `yaml:"endpoint,omitempty"`
	Region   string `yaml:"region,omitempty"`
}

type databaseConfig struct {
	Path    string        `yaml:"path"`
	Replica replicaConfig `yaml:"replica"`
}

type fileConfig struct {
	DBs []databaseConfig `yaml:"dbs"`
}

func Config(l hostconfig.Litestream, database string) ([]byte, error) {
	if l.Bucket == "" {
		return nil, errors.New("no litestream.bucket")
	}
	r := replicaConfig{Type: "s3", Bucket: l.Bucket, Path: ReplicaPath, Endpoint: l.Endpoint}
	if strings.HasSuffix(hostOf(l.Endpoint), r2Suffix) {
		r.Region = "auto"
	}
	return yaml.Marshal(fileConfig{DBs: []databaseConfig{{Path: database, Replica: r}}})
}

func hostOf(endpoint string) string {
	rest := strings.TrimPrefix(strings.TrimPrefix(endpoint, "https://"), "http://")
	host, _, _ := strings.Cut(rest, "/")
	host, _, _ = strings.Cut(host, ":")
	return host
}

func Env(l hostconfig.Litestream) []string {
	return []string{AccessKeyEnv + "=" + l.AccessKey, SecretKeyEnv + "=" + l.SecretKey}
}

type Replica struct {
	MaxTXID  uint64
	NewestAt time.Time
}

type ltxFile struct {
	MaxTXID   string    `json:"max_txid"`
	Timestamp time.Time `json:"timestamp"`
}

func ParseReplica(raw []byte) (Replica, error) {
	var files []ltxFile
	if err := json.Unmarshal(raw, &files); err != nil {
		return Replica{}, fmt.Errorf("litestream ltx output: %w", err)
	}
	var r Replica
	for _, f := range files {
		id, err := strconv.ParseUint(f.MaxTXID, 16, 64)
		if err != nil {
			return Replica{}, fmt.Errorf("litestream ltx max_txid %q: %w", f.MaxTXID, err)
		}
		if id > r.MaxTXID {
			r.MaxTXID = id
		}
		if f.Timestamp.After(r.NewestAt) {
			r.NewestAt = f.Timestamp
		}
	}
	return r, nil
}

type LocalFile struct {
	TXID    uint64
	ModTime time.Time
}

func LocalFiles(volumeDir, database string) ([]LocalFile, error) {
	dir := filepath.Join(volumeDir, fmt.Sprintf(metadataDirFn, filepath.Base(database)), "ltx", "0")
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []LocalFile
	for _, e := range entries {
		_, max, ok := strings.Cut(strings.TrimSuffix(e.Name(), ".ltx"), "-")
		if !ok || !strings.HasSuffix(e.Name(), ".ltx") {
			continue
		}
		id, err := strconv.ParseUint(max, 16, 64)
		if err != nil {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, LocalFile{TXID: id, ModTime: info.ModTime()})
	}
	slices.SortFunc(out, func(a, b LocalFile) int { return int(a.TXID) - int(b.TXID) })
	return out, nil
}

type State struct {
	LocalTXID      uint64
	ReplicaTXID    uint64
	BehindTXIDs    uint64
	Lag            time.Duration
	LastReplicated time.Time
}

func Compute(now time.Time, replica Replica, local []LocalFile) State {
	st := State{ReplicaTXID: replica.MaxTXID, LastReplicated: replica.NewestAt, LocalTXID: replica.MaxTXID}
	for _, f := range local {
		if f.TXID > st.LocalTXID {
			st.LocalTXID = f.TXID
		}
		if f.TXID > replica.MaxTXID && st.Lag == 0 {
			st.Lag = max(now.Sub(f.ModTime), time.Nanosecond)
		}
	}
	st.BehindTXIDs = st.LocalTXID - st.ReplicaTXID
	return st
}

func (s State) Stalled() bool { return s.BehindTXIDs > 0 && s.Lag > StallAfter }
