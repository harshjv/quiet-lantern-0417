//go:build linux

package deploy

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"golang.org/x/sys/unix"

	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/sandbox/diskfs"
	"github.com/harshjv/stationly/go/internal/sandbox/store"
)

type unpackError struct {
	reason string
	entry  string
	err    error
}

func (e *unpackError) Error() string {
	if e.entry != "" {
		return fmt.Sprintf("%s (%s): %v", e.reason, e.entry, e.err)
	}
	return fmt.Sprintf("%s: %v", e.reason, e.err)
}

func (e *unpackError) Unwrap() error { return e.err }

func unpackBase(ctx context.Context, fs store.FS, dc *docker.Client, stationID, key, ref string) (diskfs.Stats, error) {
	if err := dc.EnsureImage(ctx, ref); err != nil {
		return diskfs.Stats{}, &unpackError{reason: "export_failed", err: err}
	}
	partial, err := fs.CreatePartial(ctx, key)
	if err != nil {
		return diskfs.Stats{}, &unpackError{reason: "export_failed", err: fmt.Errorf("create the partial subvolume: %w", err)}
	}
	fail := func(e error) (diskfs.Stats, error) {
		if derr := fs.Delete(context.WithoutCancel(ctx), partial); derr != nil {
			e = errors.Join(e, derr)
		}
		return diskfs.Stats{}, e
	}
	rc, cleanup, err := dc.ExportImage(ctx, stationID, key, ref)
	if err != nil {
		return fail(&unpackError{reason: "export_failed", err: err})
	}
	defer cleanup()
	defer rc.Close()
	stats, err := diskfs.Unpack(partial, rc)
	if err != nil {
		var refusal *diskfs.Refusal
		switch {
		case errors.As(err, &refusal):
			return fail(&unpackError{reason: refusal.Reason, entry: refusal.Entry, err: err})
		case diskfs.IsNoSpace(err):
			return fail(&unpackError{reason: "no_space", err: err})
		}
		return fail(&unpackError{reason: "export_failed", err: err})
	}
	if err := fs.PromoteBase(ctx, key); err != nil {
		return fail(&unpackError{reason: "export_failed", err: fmt.Errorf("promote the base: %w", err)})
	}
	return stats, nil
}

func unpackFailure(err error) *protocol.ErrorBody {
	details := protocol.ErrorBodyDetails{"reason": "export_failed"}
	var ue *unpackError
	if errors.As(err, &ue) {
		details["reason"] = ue.reason
		if ue.entry != "" {
			details["entry"] = ue.entry
		}
	}
	return &protocol.ErrorBody{Code: string(protocol.ErrorCodeSandboxImageUnpackFailed), Explanation: "unpack the image into a sandbox base: " + err.Error(), Fix: "Check the image and the sandbox filesystem's free space, then start the sandbox again.", Details: details}
}

func watchOOM(ctx context.Context, path string, oom *atomic.Int64, killed func()) {
	read := func() uint64 {
		b, err := os.ReadFile(path)
		if err != nil {
			return 0
		}
		for _, line := range strings.Split(string(b), "\n") {
			if v, ok := strings.CutPrefix(line, "oom_kill "); ok {
				var n uint64
				_, _ = fmt.Sscan(v, &n)
				return n
			}
		}
		return 0
	}
	fd, err := unix.InotifyInit1(unix.IN_CLOEXEC | unix.IN_NONBLOCK)
	if err != nil {
		return
	}
	f := os.NewFile(uintptr(fd), "inotify")
	defer f.Close()
	if _, err := unix.InotifyAddWatch(fd, path, unix.IN_MODIFY|unix.IN_DELETE_SELF|unix.IN_IGNORED); err != nil {
		return
	}
	base := read()
	go func() {
		<-ctx.Done()
		f.Close()
	}()
	buf := make([]byte, 4096)
	for {
		n, err := f.Read(buf)
		if err != nil || n <= 0 {
			return
		}
		if n := read(); n > base {
			base = n
			oom.Store(time.Now().UnixNano())
			killed()
		}
		if ctx.Err() != nil {
			return
		}
	}
}
