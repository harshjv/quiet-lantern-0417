//go:build linux

package diskfs

import (
	"container/list"
	"errors"
	"fmt"

	"golang.org/x/sys/unix"
)

const (
	resolveInRoot  = unix.RESOLVE_IN_ROOT | unix.RESOLVE_NO_MAGICLINKS
	resolveBeneath = unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS
	openat2Retries = 16
)

func openat2(dirfd int, name string, flags uint64, mode uint64, resolve uint64) (int, error) {
	how := &unix.OpenHow{Flags: flags | unix.O_CLOEXEC, Mode: mode, Resolve: resolve}
	var err error
	for range openat2Retries {
		var fd int
		fd, err = unix.Openat2(dirfd, name, how)
		if err == nil {
			return fd, nil
		}
		if !errors.Is(err, unix.EAGAIN) && !errors.Is(err, unix.EINTR) {
			return -1, err
		}
	}
	return -1, err
}

func openRoot(root string, flags int) (int, error) {
	fd, err := unix.Open(root, flags|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, fmt.Errorf("open root %s: %w", root, err)
	}
	return fd, nil
}

type cachedDir struct {
	dir string
	fd  int
}

type dirCache struct {
	root  int
	limit int
	order *list.List
	byDir map[string]*list.Element
}

func newDirCache(root, limit int) *dirCache {
	return &dirCache{root: root, limit: limit, order: list.New(), byDir: map[string]*list.Element{}}
}

func (c *dirCache) get(dir string) (int, error) {
	if e, ok := c.byDir[dir]; ok {
		c.order.MoveToFront(e)
		return e.Value.(*cachedDir).fd, nil
	}
	fd, err := openat2(c.root, dir, unix.O_PATH|unix.O_DIRECTORY, 0, resolveInRoot)
	if err != nil {
		return -1, err
	}
	c.byDir[dir] = c.order.PushFront(&cachedDir{dir: dir, fd: fd})
	if c.order.Len() > c.limit {
		oldest := c.order.Back()
		evicted := c.order.Remove(oldest).(*cachedDir)
		delete(c.byDir, evicted.dir)
		if err := unix.Close(evicted.fd); err != nil {
			return -1, fmt.Errorf("close %s: %w", evicted.dir, err)
		}
	}
	return fd, nil
}

func (c *dirCache) close() error {
	var errs []error
	for e := c.order.Front(); e != nil; e = e.Next() {
		d := e.Value.(*cachedDir)
		if err := unix.Close(d.fd); err != nil {
			errs = append(errs, fmt.Errorf("close %s: %w", d.dir, err))
		}
	}
	c.order.Init()
	clear(c.byDir)
	return errors.Join(errs...)
}
