//go:build linux

package deploy

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/moby/moby/api/types/container"

	"github.com/harshjv/stationly/go/internal/dispatch"
	"github.com/harshjv/stationly/go/internal/logstore"
	"github.com/harshjv/stationly/go/internal/protocol"
)

const metricsEvery = 5 * time.Second

type collector struct {
	container  string
	deployment string
	pid        int
	cancel     context.CancelFunc
	restarts   atomic.Int64
	diskUsed   atomic.Int64
	diskLimit  atomic.Int64
}

type metricsHub struct {
	mu      sync.Mutex
	latest  map[string]protocol.MetricSample
	running map[string]*collector
}

func newMetricsHub() *metricsHub {
	return &metricsHub{latest: map[string]protocol.MetricSample{}, running: map[string]*collector{}}
}

func (h *metricsHub) samples(ids []string) []protocol.MetricSample {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := []protocol.MetricSample{}
	for _, id := range ids {
		if smp, ok := h.latest[id]; ok {
			out = append(out, smp)
		}
	}
	return out
}

func (s *Station) syncMetrics(ctx context.Context, now time.Time) {
	want := map[string]bool{}
	for id, st := range s.services {
		sp := s.plan.Services[id]
		if sp == nil || st.service.id == "" || st.service.state != "running" {
			continue
		}
		want[id] = true
		restarts := 0
		for _, t := range st.restarts {
			if now.Sub(t) <= restartWindow {
				restarts++
			}
		}
		s.metrics.mu.Lock()
		c := s.metrics.running[id]
		if c != nil && c.container != st.service.id {
			c.cancel()
			c = nil
		}
		if c == nil {
			cctx, cancel := context.WithCancel(ctx)
			c = &collector{container: st.service.id, deployment: sp.DeploymentID, pid: st.service.pid, cancel: cancel}
			s.metrics.running[id] = c
			go s.collect(cctx, id, c)
		}
		c.restarts.Store(int64(restarts))
		s.metrics.mu.Unlock()
	}
	s.metrics.mu.Lock()
	for id, c := range s.metrics.running {
		if !want[id] && !strings.HasPrefix(id, "sandbox:") {
			c.cancel()
			delete(s.metrics.running, id)
			delete(s.metrics.latest, id)
		}
	}
	s.metrics.mu.Unlock()
}

func blkio(entries []container.BlkioStatEntry) (read, write uint64) {
	for _, e := range entries {
		switch strings.ToLower(e.Op) {
		case "read":
			read += e.Value
		case "write":
			write += e.Value
		}
	}
	return
}

func procNetDev(pid int) (rx, tx uint64, ok bool) {
	if pid <= 0 {
		return 0, 0, false
	}
	f, err := os.Open(fmt.Sprintf("/proc/%d/net/dev", pid))
	if err != nil {
		return 0, 0, false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		name, rest, found := strings.Cut(sc.Text(), ":")
		if !found || strings.TrimSpace(name) == "lo" {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) < 9 {
			continue
		}
		r, _ := strconv.ParseUint(fields[0], 10, 64)
		t, _ := strconv.ParseUint(fields[8], 10, 64)
		rx, tx = rx+r, tx+t
	}
	return rx, tx, true
}

func perSecond(cur, prev uint64, dt float64) int {
	if dt <= 0 || cur < prev {
		return 0
	}
	return int(float64(cur-prev) / dt)
}

func (s *Station) collect(ctx context.Context, svcID string, c *collector) {
	body, err := s.docker.Stats(ctx, c.container)
	if err != nil {
		s.log.Debug("stats stream", "service", svcID, "error", err)
		return
	}
	defer body.Close()
	dec := json.NewDecoder(body)
	var prev *container.StatsResponse
	var prevRx, prevTx uint64
	for {
		var cur container.StatsResponse
		if err := dec.Decode(&cur); err != nil {
			return
		}
		rx, tx := uint64(0), uint64(0)
		for _, n := range cur.Networks {
			rx, tx = rx+n.RxBytes, tx+n.TxBytes
		}
		if len(cur.Networks) == 0 {
			rx, tx, _ = procNetDev(c.pid)
		}
		if prev != nil {
			dt := cur.Read.Sub(prev.Read).Seconds()
			cpu := 0.0
			cpuDelta := float64(cur.CPUStats.CPUUsage.TotalUsage) - float64(prev.CPUStats.CPUUsage.TotalUsage)
			sysDelta := float64(cur.CPUStats.SystemUsage) - float64(prev.CPUStats.SystemUsage)
			online := float64(cur.CPUStats.OnlineCPUs)
			if online == 0 {
				online = float64(len(cur.CPUStats.CPUUsage.PercpuUsage))
			}
			if sysDelta > 0 && cpuDelta > 0 {
				cpu = cpuDelta / sysDelta * online * 100
			}
			used := cur.MemoryStats.Usage
			if inactive, ok := cur.MemoryStats.Stats["inactive_file"]; ok && inactive < used {
				used -= inactive
			}
			r1, w1 := blkio(cur.BlkioStats.IoServiceBytesRecursive)
			r0, w0 := blkio(prev.BlkioStats.IoServiceBytesRecursive)
			smp := protocol.MetricSample{
				ServiceId:        ptr(svcID),
				ContainerId:      c.container,
				At:               logstore.FormatTime(cur.Read),
				CpuPct:           float64(int(cpu*100)) / 100,
				MemoryBytes:      int(used),
				MemoryLimitBytes: int(cur.MemoryStats.Limit),
				NetRxBps:         perSecond(rx, prevRx, dt),
				NetTxBps:         perSecond(tx, prevTx, dt),
				BlkReadBps:       perSecond(r1, r0, dt),
				BlkWriteBps:      perSecond(w1, w0, dt),
				Restarts:         protocol.MetricSampleRestarts(ptr(int(c.restarts.Load()))),
			}
			if c.deployment != "" {
				smp.DeploymentId = protocol.MetricSampleDeploymentId(ptr(c.deployment))
			}
			s.metrics.mu.Lock()
			if s.metrics.running[svcID] == c {
				s.metrics.latest[svcID] = smp
			}
			s.metrics.mu.Unlock()
		}
		p := cur
		prev, prevRx, prevTx = &p, rx, tx
	}
}

func (s *Station) sampleMetrics(_ context.Context, m dispatch.Message, b protocol.MetricsSampleBody) {
	ref := m.ID
	s.send(protocol.MessageMetricsSampleResult, &ref, protocol.MetricsSampleResultBody{Samples: s.metrics.samples(slices.Concat(b.ServiceIds, b.SandboxIds))})
}

func (s *Station) subscribeMetrics(ctx context.Context, m dispatch.Message, b protocol.MetricsSubscribeBody) {
	st, ok := s.openItemStream(m)
	if !ok {
		return
	}
	ids := slices.Concat(b.ServiceIds, b.SandboxIds)
	go func() {
		t := time.NewTicker(metricsEvery)
		defer t.Stop()
		for {
			if smp := s.metrics.samples(ids); len(smp) > 0 {
				if err := st.SendItems(ctx, smp); err != nil {
					return
				}
			}
			select {
			case <-st.Done():
				return
			case <-ctx.Done():
				st.End("stationd shutting down", nil)
				return
			case <-t.C:
			}
		}
	}()
}
