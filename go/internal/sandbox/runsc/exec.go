//go:build linux

package runsc

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"

	"golang.org/x/sys/unix"

	"github.com/harshjv/stationly/go/internal/sandbox"
)

const (
	processFD   = "/proc/self/fd/3"
	defaultRows = 24
	defaultCols = 80
)

type Exec struct {
	stdin  io.WriteCloser
	stdout io.Reader
	stderr io.Reader
	cmd    *exec.Cmd
	master *os.File
}

func (rt Runtime) Exec(ctx context.Context, s sandbox.ExecSpec) (*Exec, error) {
	if s.ID == "" || s.BundleDir == "" || len(s.Args) == 0 {
		return nil, errors.New("runsc: exec needs an ID, a bundle directory and args")
	}
	body, err := json.Marshal(process(s.Args, mergeEnv(s.Env), s.Cwd, s.UID, s.GID, s.TTY))
	if err != nil {
		return nil, err
	}
	pf, err := processFile(s.BundleDir, body)
	if err != nil {
		return nil, err
	}
	cmd := rt.Command(ctx, "", "exec", "--process", processFD, s.ID)
	cmd.ExtraFiles = []*os.File{pf}
	e := &Exec{cmd: cmd}
	if s.TTY {
		err = e.startTTY(s.Rows, s.Cols)
	} else {
		err = e.startPipes()
	}
	if err := errors.Join(err, pf.Close()); err != nil {
		if e.cmd.Process != nil {
			kerr := e.Kill()
			_, werr := e.Wait()
			return nil, errors.Join(err, kerr, werr)
		}
		return nil, err
	}
	return e, nil
}

func processFile(dir string, body []byte) (*os.File, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return nil, err
	}
	p := filepath.Join(dir, "process-"+hex.EncodeToString(b[:])+".json")
	f, err := os.OpenFile(p, os.O_RDWR|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, err
	}
	if err := os.Remove(p); err != nil {
		return nil, errors.Join(err, f.Close())
	}
	if _, err := f.Write(body); err != nil {
		return nil, errors.Join(err, f.Close())
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, errors.Join(err, f.Close())
	}
	return f, nil
}

func (e *Exec) startPipes() error {
	stdin, err := e.cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := e.cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := e.cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := e.cmd.Start(); err != nil {
		return fmt.Errorf("runsc exec: %w", err)
	}
	e.stdin, e.stdout, e.stderr = stdin, stdout, stderr
	return nil
}

func (e *Exec) startTTY(rows, cols int) error {
	if rows <= 0 {
		rows = defaultRows
	}
	if cols <= 0 {
		cols = defaultCols
	}
	master, replica, err := openPTY(rows, cols)
	if err != nil {
		return err
	}
	e.cmd.Stdin, e.cmd.Stdout, e.cmd.Stderr = replica, replica, replica
	e.cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if err := e.cmd.Start(); err != nil {
		return errors.Join(fmt.Errorf("runsc exec: %w", err), replica.Close(), master.Close())
	}
	if err := replica.Close(); err != nil {
		return errors.Join(err, e.cmd.Process.Kill(), master.Close())
	}
	e.master = master
	e.stdin = ttyInput{master}
	e.stdout = ttyOutput{master}
	return nil
}

func openPTY(rows, cols int) (*os.File, *os.File, error) {
	master, err := os.OpenFile("/dev/ptmx", os.O_RDWR|unix.O_NOCTTY, 0)
	if err != nil {
		return nil, nil, err
	}
	var n uint32
	err = control(master, func(fd int) error {
		if err := unix.IoctlSetPointerInt(fd, unix.TIOCSPTLCK, 0); err != nil {
			return err
		}
		var err error
		n, err = unix.IoctlGetUint32(fd, unix.TIOCGPTN)
		if err != nil {
			return err
		}
		return unix.IoctlSetWinsize(fd, unix.TIOCSWINSZ, &unix.Winsize{Row: uint16(rows), Col: uint16(cols)})
	})
	if err != nil {
		return nil, nil, errors.Join(err, master.Close())
	}
	replica, err := os.OpenFile("/dev/pts/"+strconv.FormatUint(uint64(n), 10), os.O_RDWR|unix.O_NOCTTY, 0)
	if err != nil {
		return nil, nil, errors.Join(err, master.Close())
	}
	return master, replica, nil
}

func control(f *os.File, fn func(fd int) error) error {
	rc, err := f.SyscallConn()
	if err != nil {
		return err
	}
	var ferr error
	if err := rc.Control(func(fd uintptr) { ferr = fn(int(fd)) }); err != nil {
		return err
	}
	return ferr
}

type ttyInput struct{ f *os.File }

func (t ttyInput) Write(p []byte) (int, error) { return t.f.Write(p) }

func (t ttyInput) Close() error { return nil }

type ttyOutput struct{ f *os.File }

func (t ttyOutput) Read(p []byte) (int, error) {
	n, err := t.f.Read(p)
	if errors.Is(err, syscall.EIO) {
		return n, io.EOF
	}
	return n, err
}

func (e *Exec) Stdin() io.WriteCloser { return e.stdin }

func (e *Exec) Stdout() io.Reader { return e.stdout }

func (e *Exec) Stderr() io.Reader { return e.stderr }

func (e *Exec) Resize(rows, cols int) error {
	if e.master == nil {
		return nil
	}
	return control(e.master, func(fd int) error {
		return unix.IoctlSetWinsize(fd, unix.TIOCSWINSZ, &unix.Winsize{Row: uint16(rows), Col: uint16(cols)})
	})
}

func (e *Exec) Wait() (int, error) {
	err := e.cmd.Wait()
	if e.master != nil {
		if cerr := e.master.Close(); cerr != nil && !errors.Is(cerr, os.ErrClosed) {
			err = errors.Join(err, cerr)
		}
	}
	if err == nil {
		return 0, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		if ws, ok := exitErr.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			return 128 + int(ws.Signal()), nil
		}
		return exitErr.ExitCode(), nil
	}
	return -1, err
}

func (e *Exec) Kill() error {
	if e.cmd.Process == nil {
		return nil
	}
	if err := e.cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	return nil
}

func (e *Exec) Pid() int {
	if e.cmd.Process == nil {
		return 0
	}
	return e.cmd.Process.Pid
}
