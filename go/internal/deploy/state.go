//go:build linux

package deploy

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/harshjv/stationly/go/internal/fsx"
	"github.com/harshjv/stationly/go/internal/protocol"
)

const DefaultStateDir = "/var/lib/stationly/stationd"

const (
	generationFile = "generation.json"
	ObservedFile   = "observed.json"
)

func ReadGeneration(path string) (*protocol.Generation, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var g protocol.Generation
	if err := json.Unmarshal(b, &g); err != nil {
		return nil, err
	}
	return &g, nil
}

func loadApplied(stateDir string) (*protocol.Generation, error) {
	g, err := ReadGeneration(filepath.Join(stateDir, generationFile))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	return g, err
}

func saveApplied(stateDir string, g *protocol.Generation) error {
	b, err := json.MarshalIndent(g, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(filepath.Join(stateDir, generationFile), b)
}

func writeAtomic(path string, b []byte) error {
	return fsx.WriteFile(path, append(b, '\n'), 0o600)
}
