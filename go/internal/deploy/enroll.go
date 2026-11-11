//go:build linux

package deploy

import (
	"context"
	"runtime"
	"time"

	"golang.org/x/sys/unix"

	"github.com/harshjv/stationly/go/internal/dispatch"
	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/hostprobe"
	"github.com/harshjv/stationly/go/internal/protocol"
)

func Version() string {
	return stationdVersion()
}

func EnrollInfo(ctx context.Context) (dispatch.EnrollInfo, error) {
	var uts unix.Utsname
	_ = unix.Uname(&uts)
	var si unix.Sysinfo_t
	_ = unix.Sysinfo(&si)
	var fs unix.Statfs_t
	_ = unix.Statfs("/", &fs)
	dockerVersion := ""
	dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if dc, err := docker.Connect(dctx); err == nil {
		if info, err := dc.Info(dctx); err == nil {
			dockerVersion = info.Info.ServerVersion
		}
		dc.Close()
	}
	host := hostprobe.Default().Probe(ctx, "")
	return dispatch.EnrollInfo{
		Os:   protocol.StationOsLinux,
		Arch: protocol.StationArch(runtime.GOARCH),
		Capabilities: protocol.StationCapabilities{
			Kernel:          unix.ByteSliceToString(uts.Release[:]),
			DockerVersion:   dockerVersion,
			StationdVersion: stationdVersion(),
			Host:            &host,
		},
		Routes: []any{},
		Resources: protocol.Resources{
			CpuMillis:     runtime.NumCPU() * 1000,
			MemoryBytes:   int(si.Totalram) * int(si.Unit),
			DiskBytes:     int(fs.Blocks) * int(fs.Bsize),
			DiskFreeBytes: int(fs.Bavail) * int(fs.Bsize),
		},
		Version: stationdVersion(),
	}, nil
}
