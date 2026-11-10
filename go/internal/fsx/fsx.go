package fsx

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/google/renameio/v2"
)

func WriteFile(path string, data []byte, perm fs.FileMode) error {
	dir := filepath.Dir(path)
	f, err := renameio.NewPendingFile(path, renameio.WithTempDir(dir), renameio.WithStaticPermissions(perm))
	if err != nil {
		return err
	}
	defer func() { _ = f.Cleanup() }()
	if _, err := f.Write(data); err != nil {
		return err
	}
	if err := f.CloseAtomicallyReplace(); err != nil {
		return err
	}
	return syncDir(dir)
}

func WriteIfChanged(path string, data []byte, perm fs.FileMode) (bool, error) {
	have, err := os.ReadFile(path)
	if err == nil && bytes.Equal(have, data) {
		return false, nil
	}
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return false, err
	}
	if err := WriteFile(path, data, perm); err != nil {
		return false, err
	}
	return true, nil
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func DirSize(root string, match func(name string) bool) int64 {
	var total int64
	_ = filepath.WalkDir(root, func(_ string, e fs.DirEntry, err error) error {
		if err == nil && e.Type().IsRegular() && (match == nil || match(e.Name())) {
			if info, err := e.Info(); err == nil {
				total += info.Size()
			}
		}
		return nil
	})
	return total
}
