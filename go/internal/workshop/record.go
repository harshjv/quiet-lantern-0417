package workshop

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/harshjv/stationly/go/internal/fsx"
	"github.com/harshjv/stationly/go/internal/protocol"
)

type Timings struct {
	QueuedS   float64 `json:"queued_s"`
	WorkshopS float64 `json:"workshop_s"`
	PrepareS  float64 `json:"prepare_s,omitempty"`
	SolveS    float64 `json:"solve_s"`
	AttestS   float64 `json:"attest_s"`
	TotalS    float64 `json:"total_s"`
}

type Record struct {
	BuildID          string                   `json:"build_id"`
	DeploymentID     string                   `json:"deployment_id"`
	ProjectID        string                   `json:"project_id"`
	ServiceID        string                   `json:"service_id"`
	Builder          protocol.Builder         `json:"builder"`
	Source           map[string]string        `json:"source"`
	ExportName       string                   `json:"export_name"`
	Platform         string                   `json:"platform"`
	PlatformDigest   string                   `json:"platform_digest,omitempty"`
	Children         map[string]string        `json:"children,omitempty"`
	LogRef           string                   `json:"log_ref"`
	StartedAt        string                   `json:"started_at"`
	FinishedAt       string                   `json:"finished_at"`
	WorkshopStart    string                   `json:"workshop_start"`
	Vertices         int                      `json:"vertices"`
	CachedVertices   int                      `json:"cached_vertices"`
	Timings          Timings                  `json:"timings"`
	GeneratorVersion *string                  `json:"sbom_generator_version"`
	Tokens           []TokenEvent             `json:"tokens"`
	Pruned           bool                     `json:"pruned"`
	Result           protocol.BuildResultBody `json:"result"`
}

func recordsDir(stateDir string) string {
	return filepath.Join(stateDir, "builds")
}

func SaveRecord(stateDir string, r Record) error {
	if err := os.MkdirAll(recordsDir(stateDir), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	return fsx.WriteFile(filepath.Join(recordsDir(stateDir), r.BuildID+".json"), append(b, '\n'), 0o600)
}

func Records(stateDir string) ([]Record, error) {
	entries, err := os.ReadDir(recordsDir(stateDir))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []Record
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(recordsDir(stateDir), e.Name()))
		if err != nil {
			return nil, err
		}
		var r Record
		if err := json.Unmarshal(b, &r); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].FinishedAt > out[j].FinishedAt })
	return out, nil
}
