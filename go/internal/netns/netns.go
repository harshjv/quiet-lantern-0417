//go:build linux

package netns

import (
	"fmt"
	"os"
	"strconv"
	"syscall"
)

type Namespace struct {
	file  *os.File
	Inode uint64
}

func path(pid int) string {
	return "/proc/" + strconv.Itoa(pid) + "/ns/net"
}

func Open(pid int) (*Namespace, error) {
	if pid <= 0 {
		return nil, fmt.Errorf("no process for the namespace")
	}
	return OpenPath(path(pid))
}

func OpenPath(p string) (*Namespace, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	var st syscall.Stat_t
	if err := syscall.Fstat(int(f.Fd()), &st); err != nil {
		f.Close()
		return nil, err
	}
	return &Namespace{file: f, Inode: st.Ino}, nil
}

func Inode(pid int) (uint64, error) {
	if pid <= 0 {
		return 0, fmt.Errorf("no process for the namespace")
	}
	var st syscall.Stat_t
	if err := syscall.Stat(path(pid), &st); err != nil {
		return 0, err
	}
	return st.Ino, nil
}

func (n *Namespace) fd() int {
	return int(n.file.Fd())
}

func (n *Namespace) Close() error {
	return n.file.Close()
}
