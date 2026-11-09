//go:build linux

package deploy

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/harshjv/stationly/go/internal/hostconfig"
	"github.com/harshjv/stationly/go/internal/logstore"
	"github.com/harshjv/stationly/go/internal/netns"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/sandbox/runsc"
	"github.com/harshjv/stationly/go/internal/sandbox/store"
	"github.com/harshjv/stationly/go/internal/secrets"
)

const (
	sandboxLogCap     = 64 << 20
	sandboxLogPass    = 4 << 20
	sandboxLogDirName = "sandbox"
)

func growStorage(ctx context.Context, fs store.FS, size, free uint64) (uint64, uint64, error) {
	res, err := fs.Grow(ctx, size, free)
	return res.Bytes, res.FreeBytes, err
}

func growStepOf(err error) string {
	var ge *store.GrowError
	if errors.As(err, &ge) {
		return ge.Step
	}
	return ""
}

func recordStorageSize(etcDir string, size uint64) {
	c, err := hostconfig.Load(etcDir)
	if err != nil || c.Sandboxes == nil || c.Sandboxes.Image == nil {
		return
	}
	c.Sandboxes.Image.SizeBytes = size
	hostconfig.Save(etcDir, c)
}

func (s *Station) sandboxResources(r *protocol.Resources) {
	if !s.sandboxStorageReady() {
		return
	}
	r.SandboxDiskBytes = ptr(int(s.sbx.info.Bytes))
	r.SandboxDiskFreeBytes = ptr(int(s.sbx.info.FreeBytes))
}

type sbxLogFile struct {
	name string
	role string
}

func sandboxLogFiles(dir string) []sbxLogFile {
	out := []sbxLogFile{{"init.log", string(protocol.LogRoleInit)}, {"runsc.log", string(protocol.LogRoleRuntime)}, {"panic.log", string(protocol.LogRoleRuntime)}}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.Type().IsRegular() && strings.HasPrefix(e.Name(), "runsc.log.") && strings.HasSuffix(e.Name(), ".txt") {
			out = append(out, sbxLogFile{e.Name(), string(protocol.LogRoleRuntime)})
		}
	}
	return out
}

type sbxLogJob struct {
	id       string
	dir      string
	offsets  map[string]int64
	redactor *secrets.Redactor
}

func (s *Station) collectSandboxLogs(ctx context.Context) {
	if !s.sbx.logBusy.CompareAndSwap(false, true) {
		return
	}
	var jobs []sbxLogJob
	for id, st := range s.sbx.states {
		if !st.rec.DiskReady {
			continue
		}
		offsets := map[string]int64{}
		for k, v := range st.rec.LogOffsets {
			offsets[k] = v
		}
		jobs = append(jobs, sbxLogJob{id: id, dir: s.sbx.fs.LogDir(id), offsets: offsets, redactor: s.sandboxRedactor(id, nil)})
	}
	go func() {
		defer s.sbx.logBusy.Store(false)
		results := map[string]map[string]int64{}
		for _, j := range jobs {
			results[j.id] = s.copySandboxLogs(j)
		}
		s.post(ctx, func() {
			changed := false
			for id, offsets := range results {
				if st := s.sbx.states[id]; st != nil && !maps.Equal(st.rec.LogOffsets, offsets) {
					st.rec.LogOffsets = offsets
					changed = true
				}
			}
			if changed {
				s.saveSandboxes()
			}
		})
	}()
}

func (s *Station) copySandboxLogs(j sbxLogJob) map[string]int64 {
	dir := filepath.Join(logDir, j.id, sandboxLogDirName)
	for _, f := range sandboxLogFiles(j.dir) {
		path := filepath.Join(j.dir, f.name)
		file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
		if err != nil {
			continue
		}
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() {
			file.Close()
			continue
		}
		off := j.offsets[f.name]
		if info.Size() < off {
			off = 0
		}
		if info.Size() > off {
			r := bufio.NewReader(io.LimitReader(io.NewSectionReader(file, off, info.Size()-off), sandboxLogPass))
			w := s.logs.Segmented(dir, f.role)
			for {
				line, err := r.ReadBytes('\n')
				if err != nil {
					break
				}
				off += int64(len(line))
				w.Write(time.Now(), f.role, string(protocol.LogStreamStdout), j.redactor.Redact(string(bytes.TrimRight(line, "\r\n"))))
			}
		}
		file.Close()
		if off >= sandboxLogCap {
			if os.Truncate(path, 0) == nil {
				off = 0
			}
		}
		j.offsets[f.name] = off
	}
	return j.offsets
}

func (s *Station) sandboxLogTarget(id string, role *protocol.LogRole) logTarget {
	return logTarget{sources: func() []logstore.Source {
		var out []logstore.Source
		for _, r := range []string{string(protocol.LogRoleInit), string(protocol.LogRoleRuntime)} {
			if role != nil && string(*role) != r {
				continue
			}
			out = append(out, s.glob(filepath.Join(logDir, id, sandboxLogDirName, r+".*.jsonl"), false, r)...)
		}
		return logstore.Order(s.opts.StateDir, out)
	}, finished: func() bool { return false }}
}

func readCgroupInt(dir, name string) (uint64, bool) {
	b, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		return 0, false
	}
	v, err := strconv.ParseUint(strings.TrimSpace(string(b)), 10, 64)
	return v, err == nil
}

func readCgroupKey(dir, name, key string) (uint64, bool) {
	b, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		return 0, false
	}
	for _, line := range strings.Split(string(b), "\n") {
		k, v, ok := strings.Cut(line, " ")
		if ok && k == key {
			n, err := strconv.ParseUint(strings.TrimSpace(v), 10, 64)
			return n, err == nil
		}
	}
	return 0, false
}

func readIOStat(dir string) (read, write uint64) {
	b, err := os.ReadFile(filepath.Join(dir, "io.stat"))
	if err != nil {
		return 0, 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		for _, field := range strings.Fields(line) {
			k, v, ok := strings.Cut(field, "=")
			if !ok {
				continue
			}
			n, _ := strconv.ParseUint(v, 10, 64)
			switch k {
			case "rbytes":
				read += n
			case "wbytes":
				write += n
			}
		}
	}
	return read, write
}

type sbxSample struct {
	at                time.Time
	cpu, rd, wr       uint64
	rx, tx            uint64
	memory, memoryMax uint64
}

func sampleSandbox(cgroup string, pid int, now time.Time) sbxSample {
	dir := filepath.Join("/sys/fs/cgroup", cgroup)
	smp := sbxSample{at: now}
	smp.cpu, _ = readCgroupKey(dir, "cpu.stat", "usage_usec")
	smp.memory, _ = readCgroupInt(dir, "memory.current")
	if inactive, ok := readCgroupKey(dir, "memory.stat", "inactive_file"); ok && inactive < smp.memory {
		smp.memory -= inactive
	}
	smp.memoryMax, _ = readCgroupInt(dir, "memory.max")
	smp.rd, smp.wr = readIOStat(dir)
	if ns, err := netns.Open(pid); err == nil {
		rx, tx, err := ns.LinkCounters(netns.SandboxIf)
		if err == nil {
			smp.rx, smp.tx = tx, rx
		}
		ns.Close()
	}
	return smp
}

func (s *Station) syncSandboxMetrics(ctx context.Context, now time.Time) {
	want := map[string]bool{}
	for id, st := range s.sbx.states {
		if st.rec.Status != protocol.SandboxReportStatusRunning || st.rec.Cgroup == "" || st.pid <= 0 {
			continue
		}
		want[id] = true
		key := "sandbox:" + id
		u := s.sbx.usage["disks/"+id]
		used, limit := int(u.Exclusive), int(st.rec.Limit)
		s.metrics.mu.Lock()
		c := s.metrics.running[key]
		if c != nil && c.container != st.rec.Cgroup {
			c.cancel()
			c = nil
		}
		if c == nil {
			cctx, cancel := context.WithCancel(ctx)
			c = &collector{container: st.rec.Cgroup, pid: st.pid, cancel: cancel}
			s.metrics.running[key] = c
			go s.collectSandbox(cctx, id, key, c)
		}
		c.diskUsed.Store(int64(used))
		c.diskLimit.Store(int64(limit))
		s.metrics.mu.Unlock()
	}
	s.metrics.mu.Lock()
	for key, c := range s.metrics.running {
		id, ok := strings.CutPrefix(key, "sandbox:")
		if ok && !want[id] {
			c.cancel()
			delete(s.metrics.running, key)
			delete(s.metrics.latest, id)
		}
	}
	s.metrics.mu.Unlock()
}

func (s *Station) collectSandbox(ctx context.Context, id, key string, c *collector) {
	t := time.NewTicker(metricsEvery)
	defer t.Stop()
	prev := sampleSandbox(c.container, c.pid, time.Now())
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			cur := sampleSandbox(c.container, c.pid, now)
			dt := cur.at.Sub(prev.at).Seconds()
			cpu := 0.0
			if dt > 0 && cur.cpu >= prev.cpu {
				cpu = float64(cur.cpu-prev.cpu) / (dt * 1e6) * 100
			}
			used, limit := int(c.diskUsed.Load()), int(c.diskLimit.Load())
			smp := protocol.MetricSample{
				SandboxId:        ptr(id),
				ContainerId:      runsc.ScopeUnit(id),
				At:               logstore.FormatTime(cur.at),
				CpuPct:           float64(int(cpu*100)) / 100,
				MemoryBytes:      int(cur.memory),
				MemoryLimitBytes: int(cur.memoryMax),
				NetRxBps:         perSecond(cur.rx, prev.rx, dt),
				NetTxBps:         perSecond(cur.tx, prev.tx, dt),
				BlkReadBps:       perSecond(cur.rd, prev.rd, dt),
				BlkWriteBps:      perSecond(cur.wr, prev.wr, dt),
				DiskUsedBytes:    &used,
				DiskLimitBytes:   &limit,
			}
			s.metrics.mu.Lock()
			if s.metrics.running[key] == c {
				s.metrics.latest[id] = smp
			}
			s.metrics.mu.Unlock()
			prev = cur
		}
	}
}

func (s *Station) checkSandboxRuntime(ctx context.Context) protocol.DoctorCheck {
	c := newCheck("sandbox_runtime")
	if !s.sbx.kernelOK {
		c.raise(protocol.DoctorStatusWarn, "sandbox_kernel_too_old", fmt.Sprintf("kernel %s is older than 6.7, which sandboxes need for btrfs simple quotas; everything else runs", s.sbx.kernel), "Run sandboxes on a host with kernel 6.7 or later, such as Ubuntu 24.04 or Debian 13.")
		return c.build()
	}
	pinned, installed := s.pinnedRunsc()
	c.detail["pinned"] = pinned
	versions, _ := runsc.Installed(runsc.LibDir)
	c.detail["installed"] = strings.Join(versions, ",")
	var missing, older []string
	for id, st := range s.sbx.states {
		if st.rec.Status != protocol.SandboxReportStatusRunning {
			continue
		}
		if !slices.Contains(versions, st.rec.Runsc) {
			missing = append(missing, id)
		} else if st.rec.Runsc != pinned {
			older = append(older, id+"@"+st.rec.Runsc)
		}
	}
	slices.Sort(missing)
	slices.Sort(older)
	switch {
	case pinned == "":
		c.raise(protocol.DoctorStatusWarn, "runsc_version", "no runsc version is pinned on this station yet", "Wait for a generation that pins runsc, or run sly platform upgrade.")
	case !installed:
		c.raise(protocol.DoctorStatusFail, "runsc_missing", fmt.Sprintf("the pinned runsc %s is not installed under %s", pinned, runsc.LibDir), "Run sly platform upgrade so stationd downloads and verifies the runsc archive again.")
	default:
		rt := runsc.At(runsc.LibDir, runsc.StateBase, pinned)
		problems, err := rt.Verify()
		if err != nil {
			c.raise(protocol.DoctorStatusFail, "runsc_missing", fmt.Sprintf("runsc %s: %v", pinned, err), "Run sly platform upgrade so stationd installs runsc again.")
		}
		for _, p := range problems {
			code := "runsc_modified"
			if strings.HasPrefix(p, "missing") {
				code = "runsc_missing"
			}
			c.raise(protocol.DoctorStatusFail, code, "runsc "+pinned+": "+p, "Reinstall runsc from the verified release archive; remove the directory and run sly platform upgrade.")
		}
		pctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		if err := rt.Probe(pctx); err != nil {
			c.raise(protocol.DoctorStatusFail, "runsc_unusable", fmt.Sprintf("probe sandbox with runsc %s on systrap failed: %v", pinned, err), "Read the stationd log and the kernel log for the probe's error.")
		}
		cancel()
	}
	if len(missing) > 0 {
		c.raise(protocol.DoctorStatusFail, "runsc_missing", "running sandboxes whose runsc version directory is gone: "+strings.Join(missing, ", "), "Stop those sandboxes; stationd stops them through their systemd scope.")
	}
	if len(older) > 0 {
		c.raise(protocol.DoctorStatusWarn, "runsc_version", "sandboxes still running on an older runsc: "+strings.Join(older, ", "), "Stop and start them to move them to the pinned version, or let their time to live end.")
	}
	if stray := s.strayHelpers(); len(stray) > 0 {
		c.raise(protocol.DoctorStatusFail, "sandbox_helper_stray", "gVisor host processes outside every known sandbox scope: "+strings.Join(stray, ", "), "Stop the processes; they belong to no sandbox stationd knows.")
	}
	if c.status == protocol.DoctorStatusOk {
		c.note(fmt.Sprintf("runsc %s installed, verified and usable on systrap", pinned))
	}
	return c.build()
}

func (s *Station) strayHelpers() []string {
	known := map[string]bool{}
	for _, st := range s.sbx.states {
		if st.rec.Cgroup != "" && (st.rec.Status == protocol.SandboxReportStatusRunning || st.busy) {
			known[st.rec.Cgroup] = true
		}
	}
	entries, _ := os.ReadDir("/proc")
	var out []string
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		exe, err := os.Readlink(filepath.Join("/proc", e.Name(), "exe"))
		if err != nil || !strings.HasPrefix(exe, runsc.LibDir+"/runsc-") {
			continue
		}
		base := filepath.Base(exe)
		if base != "runsc-fd-parking" && base != "gvisor_sentry" && base != "runsc" {
			continue
		}
		cg, err := os.ReadFile(filepath.Join("/proc", e.Name(), "cgroup"))
		if err != nil {
			continue
		}
		path := strings.TrimSpace(strings.TrimPrefix(string(cg), "0::"))
		if !strings.Contains(path, "/stationly-sandboxes.slice/") {
			if strings.Contains(path, "stationd.service") {
				continue
			}
			out = append(out, fmt.Sprintf("%s pid %d in %s", base, pid, path))
			continue
		}
		if !known[path] {
			out = append(out, fmt.Sprintf("%s pid %d in %s", base, pid, path))
		}
	}
	slices.Sort(out)
	return out
}

func (s *Station) checkSandboxStorage() protocol.DoctorCheck {
	c := newCheck("sandbox_storage")
	if !s.sbx.kernelOK {
		c.raise(protocol.DoctorStatusWarn, "sandbox_kernel_too_old", fmt.Sprintf("kernel %s is older than 6.7, which btrfs simple quotas need; the installer skipped the sandbox filesystem", s.sbx.kernel), "Run sandboxes on a host with kernel 6.7 or later, such as Ubuntu 24.04 or Debian 13.")
		return c.build()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	info, err := s.sbx.fs.Inspect(ctx)
	if err != nil || !info.Mounted || !info.Btrfs {
		detail := store.Mount + " is not a mounted btrfs filesystem"
		if err != nil {
			detail += ": " + err.Error()
		}
		c.raise(protocol.DoctorStatusFail, "sandbox_fs_missing", detail, "Run stationd install --sandbox-size <size> or --sandbox-device <path> on the host, then start "+store.MountUnit+".")
		return c.build()
	}
	c.detail["backing"] = string(info.Backing)
	c.detail["bytes"] = strconv.FormatUint(info.Bytes, 10)
	c.detail["free_bytes"] = strconv.FormatUint(info.FreeBytes, 10)
	if !info.QuotaOn || !info.SimpleQuota {
		c.raise(protocol.DoctorStatusFail, "sandbox_quota_off", "btrfs simple quotas are not on for "+store.Mount, "Run btrfs quota enable --simple "+store.Mount+"; full qgroups are never used.")
	}
	if info.Backing == store.BackingLoopFile && !info.DirectIO {
		c.raise(protocol.DoctorStatusWarn, "sandbox_loop_buffered", "the loop device "+info.LoopDevice+" of the sandbox filesystem has direct I/O off", "Run losetup --direct-io=on "+info.LoopDevice+"; stationd also turns it on at start.")
	}
	free, _ := rootFree(s.opts.StateDir)
	maxBytes := info.Bytes
	if info.Backing == store.BackingLoopFile {
		maxBytes = store.MaxGrow(info.Bytes, free)
	}
	c.detail["max_size_bytes"] = strconv.FormatUint(maxBytes, 10)
	minFree := info.Bytes / 20
	switch {
	case info.FreeBytes < minFree:
		c.raise(protocol.DoctorStatusFail, "sandbox_fs_low", fmt.Sprintf("the sandbox filesystem has %s free, below min_free_bytes %s", human(info.FreeBytes), human(minFree)), fmt.Sprintf("Run sly platform storage grow --size <bytes>, at most %d.", maxBytes))
	case info.FreeBytes < 2*minFree:
		c.raise(protocol.DoctorStatusWarn, "sandbox_fs_low", fmt.Sprintf("the sandbox filesystem has %s free, below twice min_free_bytes %s", human(info.FreeBytes), human(minFree)), fmt.Sprintf("Run sly platform storage grow --size <bytes>, at most %d.", maxBytes))
	}
	var errs []string
	for k, v := range info.DeviceErrors {
		if v > 0 {
			errs = append(errs, fmt.Sprintf("%s=%d", k, v))
		}
	}
	if len(errs) > 0 {
		slices.Sort(errs)
		c.raise(protocol.DoctorStatusWarn, "sandbox_fs_errors", "btrfs device stats report errors: "+strings.Join(errs, ", "), "Check the disk under the sandbox filesystem and the kernel log.")
	}
	if pct, _, _, err := usedPct(s.opts.StateDir); err == nil {
		warn, _ := s.diskThresholds()
		if pct >= float64(warn) {
			c.raise(protocol.DoctorStatusWarn, "sandbox_root_low", fmt.Sprintf("the root filesystem is %.0f%% used; no sandbox Coupler can be created on a full root", pct), "Free space on the root filesystem.")
		}
	}
	if c.status == protocol.DoctorStatusOk {
		c.note(fmt.Sprintf("btrfs %s with simple quotas, %s of %s free", info.Backing, human(info.FreeBytes), human(info.Bytes)))
	}
	return c.build()
}
