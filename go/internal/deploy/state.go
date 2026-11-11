//go:build linux

package deploy

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/harshjv/stationly/go/internal/fsx"
	"github.com/harshjv/stationly/go/internal/protocol"
)

const DefaultStateDir = "/var/lib/stationly/stationd"

const (
	generationFile = "generation.json"
	ObservedFile   = "observed.json"
)

func readJSON[T any](path string) (T, error) {
	var v T
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return v, nil
	}
	if err != nil {
		return v, err
	}
	if err := json.Unmarshal(b, &v); err != nil {
		var zero T
		return zero, err
	}
	return v, nil
}

func readJSONDir[T any](dir string) ([]*T, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []*T
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, err
		}
		v := new(T)
		if err := json.Unmarshal(b, v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return fsx.WriteFile(path, append(b, '\n'), 0o600)
}

func loadApplied(stateDir string) (*protocol.Generation, error) {
	return readJSON[*protocol.Generation](filepath.Join(stateDir, generationFile))
}

func saveApplied(stateDir string, g *protocol.Generation) error {
	return writeJSON(filepath.Join(stateDir, generationFile), g)
}
