//go:build linux

package deploy

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"

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
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
