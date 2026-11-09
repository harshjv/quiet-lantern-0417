//go:build linux

package store

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

const dirFlags = unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC

func openDir(path string) (int, error) {
	fd, err := unix.Open(path, dirFlags, 0)
	if err != nil {
		return -1, fmt.Errorf("open %s: %w", path, err)
	}
	return fd, nil
}

func ensureDirAt(parent int, parentPath, name string) (int, error) {
	path := filepath.Join(parentPath, name)
	if err := unix.Mkdirat(parent, name, 0o700); err != nil && !errors.Is(err, unix.EEXIST) {
		return -1, fmt.Errorf("mkdir %s: %w", path, err)
	}
	fd, err := unix.Openat(parent, name, dirFlags, 0)
	if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) {
		return -1, fmt.Errorf("%s exists and is not a directory", path)
	}
	if err != nil {
		return -1, fmt.Errorf("open %s: %w", path, err)
	}
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return -1, errors.Join(fmt.Errorf("stat %s: %w", path, err), unix.Close(fd))
	}
	if st.Uid != 0 || st.Gid != 0 {
		if err := unix.Fchown(fd, 0, 0); err != nil {
			return -1, errors.Join(fmt.Errorf("chown %s: %w", path, err), unix.Close(fd))
		}
	}
	if st.Mode&0o7777 != 0o700 {
		if err := unix.Fchmod(fd, 0o700); err != nil {
			return -1, errors.Join(fmt.Errorf("chmod %s: %w", path, err), unix.Close(fd))
		}
	}
	return fd, nil
}

func (f FS) EnsureLayout() error {
	root, err := openDir(f.Mount)
	if err != nil {
		return err
	}
	defer unix.Close(root)
	for _, name := range layoutDirs {
		fd, err := ensureDirAt(root, f.Mount, name)
		if err != nil {
			return err
		}
		if err := unix.Close(fd); err != nil {
			return err
		}
	}
	return nil
}

func (f FS) LogFile(id, name string) (*os.File, error) {
	if !validName(id) || !validName(name) {
		return nil, fmt.Errorf("%w: log %q of %q", ErrInvalidPath, name, id)
	}
	root, err := openDir(f.Mount)
	if err != nil {
		return nil, err
	}
	defer unix.Close(root)
	logs, err := unix.Openat(root, dirLogs, dirFlags, 0)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", filepath.Join(f.Mount, dirLogs), err)
	}
	defer unix.Close(logs)
	dir, err := ensureDirAt(logs, filepath.Join(f.Mount, dirLogs), id)
	if err != nil {
		return nil, err
	}
	defer unix.Close(dir)
	path := filepath.Join(f.LogDir(id), name)
	fd, err := unix.Openat(dir, name, unix.O_WRONLY|unix.O_APPEND|unix.O_CREAT|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return nil, errors.Join(fmt.Errorf("stat %s: %w", path, err), unix.Close(fd))
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG {
		return nil, errors.Join(fmt.Errorf("%s is not a regular file", path), unix.Close(fd))
	}
	if err := unix.SetNonblock(fd, false); err != nil {
		return nil, errors.Join(fmt.Errorf("open %s: %w", path, err), unix.Close(fd))
	}
	return os.NewFile(uintptr(fd), path), nil
}
