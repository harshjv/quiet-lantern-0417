//go:build linux

package flows

import (
	"log/slog"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/mdlayher/netlink"
	"github.com/ti-mo/conntrack"
	"golang.org/x/sys/unix"
)

const (
	PerNamespaceFlows = 20000
	PerStationFlows   = 100000
	RefreshBudget     = 50 * time.Millisecond
	reapEvery         = 5 * time.Second
	reapMark          = 0x4f524e52
)

type syncRequest struct {
	w         *Watch
	notBefore time.Time
}

type Monitor struct {
	log          *slog.Logger
	perNamespace int
	perStation   int64
	budget       time.Duration

	flows atomic.Int64

	mu      sync.Mutex
	watches map[*Watch]bool
	queue   []syncRequest
	wake    chan struct{}
	stop    chan struct{}
	reaping bool

	hostMu sync.Mutex
	host   *getter

	Stats Stats
}

type Stats struct {
	Seeds        atomic.Int64
	Resyncs      atomic.Int64
	Reaps        atomic.Int64
	ReapNanos    atomic.Int64
	Refreshed    atomic.Int64
	RefreshNanos atomic.Int64
	HostLookups  atomic.Int64
}

func New(log *slog.Logger) *Monitor {
	m := &Monitor{
		log:          log,
		perNamespace: PerNamespaceFlows,
		perStation:   PerStationFlows,
		budget:       RefreshBudget,
		watches:      map[*Watch]bool{},
		wake:         make(chan struct{}, 1),
		stop:         make(chan struct{}),
	}
	go m.worker()
	return m
}

func (m *Monitor) Close() {
	m.mu.Lock()
	ws := make([]*Watch, 0, len(m.watches))
	for w := range m.watches {
		ws = append(ws, w)
	}
	m.mu.Unlock()
	for _, w := range ws {
		w.Close()
	}
	close(m.stop)
	m.hostMu.Lock()
	if m.host != nil {
		m.host.close()
		m.host = nil
	}
	m.hostMu.Unlock()
}

func (m *Monitor) Watch(pid int, inode uint64, classify Classifier) (*Watch, error) {
	w, err := m.open(pid, inode, classify)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	m.watches[w] = true
	if !m.reaping {
		m.reaping = true
		go m.reap()
	}
	m.mu.Unlock()
	m.enqueue(w, time.Time{})
	return w, nil
}

func (m *Monitor) Watching() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.watches)
}

func (m *Monitor) Flows() int64 { return m.flows.Load() }

func (m *Monitor) forget(w *Watch) {
	m.mu.Lock()
	delete(m.watches, w)
	kept := m.queue[:0]
	for _, r := range m.queue {
		if r.w != w {
			kept = append(kept, r)
		}
	}
	m.queue = kept
	idle := len(m.watches) == 0
	m.mu.Unlock()
	if idle {
		m.hostMu.Lock()
		if m.host != nil {
			m.host.close()
			m.host = nil
		}
		m.hostMu.Unlock()
	}
}

func (m *Monitor) reserve() bool {
	if m.flows.Add(1) > m.perStation {
		m.flows.Add(-1)
		return false
	}
	return true
}

func (m *Monitor) release(n int) {
	if n > 0 {
		m.flows.Add(-int64(n))
	}
}

func (m *Monitor) enqueue(w *Watch, notBefore time.Time) {
	m.mu.Lock()
	if !m.watches[w] {
		m.mu.Unlock()
		return
	}
	for i, r := range m.queue {
		if r.w == w {
			if notBefore.Before(r.notBefore) {
				m.queue[i].notBefore = notBefore
			}
			m.mu.Unlock()
			return
		}
	}
	m.queue = append(m.queue, syncRequest{w: w, notBefore: notBefore})
	m.mu.Unlock()
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

func (m *Monitor) next(now time.Time) (*Watch, time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	wait := time.Duration(-1)
	for i, r := range m.queue {
		if !r.notBefore.After(now) {
			m.queue = append(m.queue[:i], m.queue[i+1:]...)
			return r.w, 0
		}
		if d := r.notBefore.Sub(now); wait < 0 || d < wait {
			wait = d
		}
	}
	return nil, wait
}

func (m *Monitor) worker() {
	for {
		w, wait := m.next(time.Now())
		if w != nil {
			m.grant(w)
			continue
		}
		if wait < 0 {
			wait = time.Hour
		}
		t := time.NewTimer(wait)
		select {
		case <-m.stop:
			t.Stop()
			return
		case <-m.wake:
		case <-t.C:
		}
		t.Stop()
	}
}

func (m *Monitor) grant(w *Watch) {
	w.mu.Lock()
	initial := !w.seeded
	w.mu.Unlock()
	select {
	case w.grant <- struct{}{}:
	default:
		return
	}
	w.ev.SetReadDeadline(time.Now())
	select {
	case <-w.synced:
		if initial {
			m.Stats.Seeds.Add(1)
		} else {
			m.Stats.Resyncs.Add(1)
		}
	case <-w.done:
	}
}

func (m *Monitor) reap() {
	t := time.NewTicker(reapEvery)
	defer t.Stop()
	filter := conntrack.NewFilter().Mark(reapMark)
	for {
		select {
		case <-m.stop:
			return
		case <-t.C:
		}
		m.mu.Lock()
		if len(m.watches) == 0 {
			m.reaping = false
			m.mu.Unlock()
			return
		}
		m.mu.Unlock()
		start := time.Now()
		c, err := conntrack.Dial(&netlink.Config{})
		if err != nil {
			m.log.Warn("conntrack reaper dial", "error", err)
			continue
		}
		if _, err := c.DumpFilter(filter, nil); err != nil {
			m.log.Warn("conntrack reaper dump", "error", err)
		}
		c.Close()
		m.Stats.Reaps.Add(1)
		m.Stats.ReapNanos.Add(int64(time.Since(start)))
	}
}

func threadCPU() time.Duration {
	var ru unix.Rusage
	if err := unix.Getrusage(unix.RUSAGE_THREAD, &ru); err != nil {
		return 0
	}
	return time.Duration(ru.Utime.Nano() + ru.Stime.Nano())
}

func (m *Monitor) snapshot() []*Watch {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*Watch, 0, len(m.watches))
	for w := range m.watches {
		out = append(out, w)
	}
	return out
}

func (m *Monitor) Tick(now time.Time) {
	ws := m.snapshot()
	m.refresh(ws, now.UnixNano())
	for _, w := range ws {
		w.tick(now.UnixNano())
	}
}

func (m *Monitor) refresh(ws []*Watch, before int64) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	start := threadCPU()
	var keys []key
	var tuples []Tuple
	var results []getResult
	done := map[*Watch]bool{}
	for threadCPU()-start < m.budget {
		var best *Watch
		var oldest int64
		for _, w := range ws {
			if done[w] {
				continue
			}
			w.mu.Lock()
			read, ok := w.headRead(before)
			w.mu.Unlock()
			if !ok {
				done[w] = true
				continue
			}
			if best == nil || read < oldest {
				best, oldest = w, read
			}
		}
		if best == nil {
			break
		}
		best.mu.Lock()
		keys, tuples = best.takeBatch(before, getBatch, keys[:0], tuples[:0])
		best.mu.Unlock()
		if len(keys) == 0 {
			done[best] = true
			continue
		}
		if cap(results) < len(keys) {
			results = make([]getResult, len(keys))
		}
		results = results[:len(keys)]
		clear(results)
		best.gtMu.Lock()
		err := best.gt.get(tuples, ctaTupleOrig, results)
		best.gtMu.Unlock()
		now := time.Now().UnixNano()
		best.mu.Lock()
		for i, k := range keys {
			if err != nil {
				best.order = append(best.order, k)
				continue
			}
			best.applyGet(k, &results[i], now)
		}
		best.mu.Unlock()
		if err != nil {
			m.log.Debug("conntrack refresh", "netns", best.inode, "error", err)
			done[best] = true
			continue
		}
		m.Stats.Refreshed.Add(int64(len(keys)))
	}
	m.Stats.RefreshNanos.Add(int64(threadCPU() - start))
}

func (m *Monitor) HostOriginal(reply Tuple) (Tuple, bool) {
	m.hostMu.Lock()
	defer m.hostMu.Unlock()
	if m.host == nil {
		g, err := newGetter(0)
		if err != nil {
			m.log.Warn("host conntrack socket", "error", err)
			return Tuple{}, false
		}
		m.host = g
	}
	var out [1]getResult
	if err := m.host.get([]Tuple{reply}, ctaTupleReply, out[:]); err != nil {
		m.log.Debug("host conntrack lookup", "error", err)
		return Tuple{}, false
	}
	m.Stats.HostLookups.Add(1)
	if out[0].err != 0 {
		return Tuple{}, false
	}
	return out[0].msg.key.orig, true
}
