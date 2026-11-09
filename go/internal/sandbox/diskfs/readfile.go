//go:build linux

package diskfs

import (
	"fmt"
	"io"
	"os"

	"golang.org/x/sys/unix"
)

func ReadFile(root, name string, limit int64) (data []byte, err error) {
	if limit < 0 {
		return nil, fmt.Errorf("read %q: invalid limit %d", name, limit)
	}
	rootfd, err := openRoot(root, unix.O_PATH)
	if err != nil {
		return nil, err
	}
	defer closeInto(rootfd, &err)
	pathfd, err := openat2(rootfd, name, unix.O_PATH, 0, resolveInRoot)
	if err != nil {
		return nil, fmt.Errorf("open %q: %w", name, err)
	}
	defer closeInto(pathfd, &err)
	before, err := regularStat(pathfd, name, limit)
	if err != nil {
		return nil, err
	}
	fd, err := openat2(rootfd, name, unix.O_RDONLY|unix.O_NONBLOCK|unix.O_NOCTTY, 0, resolveInRoot)
	if err != nil {
		return nil, fmt.Errorf("open %q: %w", name, err)
	}
	f := os.NewFile(uintptr(fd), name)
	defer func() {
		if cerr := f.Close(); cerr != nil && err == nil {
			err = fmt.Errorf("close %q: %w", name, cerr)
		}
	}()
	after, err := regularStat(fd, name, limit)
	if err != nil {
		return nil, err
	}
	if before.Dev != after.Dev || before.Ino != after.Ino {
		return nil, fmt.Errorf("read %q: file changed while opening", name)
	}
	data, err = io.ReadAll(io.LimitReader(f, limit))
	if err != nil {
		return nil, fmt.Errorf("read %q: %w", name, err)
	}
	return data, nil
}

func regularStat(fd int, name string, limit int64) (unix.Stat_t, error) {
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return st, fmt.Errorf("stat %q: %w", name, err)
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG {
		return st, fmt.Errorf("read %q: not a regular file", name)
	}
	if st.Size > limit {
		return st, fmt.Errorf("read %q: size %d exceeds limit %d", name, st.Size, limit)
	}
	return st, nil
}
