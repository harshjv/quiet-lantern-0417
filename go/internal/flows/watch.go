//go:build linux

package flows

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/mdlayher/netlink"
	"github.com/mdlayher/socket"
	"github.com/ti-mo/conntrack"
	"golang.org/x/sys/unix"
)

const (
	eventBuffer      = 4 << 20
	resyncSpacing    = 30 * time.Second
	resyncBackoffMax = 5 * time.Minute
	tombLifetime     = 10 * time.Second
	driftTicks       = 3
)

type Snapshot struct {
	Groups     []GroupStat
	Entries    *int
	Truncated  bool
	Stale      bool
	Lossy      bool
	Accounting bool
	Timestamps bool
	First      bool
}

type Watch struct {
	m        *Monitor
	ns       *os.File
	inode    uint64
	ev       *socket.Conn
	gtMu     sync.Mutex
	gt       *getter
	classify Classifier

	accounting bool
	timestamps bool

	mu        sync.Mutex
	table     map[key]flow
	order     []key
	groups    []GroupKey
	groupIdx  map[GroupKey]int32
	closed    map[int32]*closedAcc
	tombs     map[key]tomb
	notStored int
	truncated bool
	stale     bool
	lossy     bool
	seeded    bool
	collected bool
	entries   *int
	drift     int
	failed    error

	lastSync time.Time
	backoff  time.Duration

	grant   chan struct{}
	synced  chan struct{}
	quit    chan struct{}
	ready   chan struct{}
	done    chan struct{}
	closing atomic.Bool
	once    sync.Once
}

func readSysctls(nsfd int, names ...string) ([]bool, error) {
	type result struct {
		values []bool
		err    error
	}
	ch := make(chan result, 1)
	go func() {
		runtime.LockOSThread()
		home, err := os.Open("/proc/thread-self/ns/net")
		if err != nil {
			runtime.UnlockOSThread()
			ch <- result{err: err}
			return
		}
		defer home.Close()
		if err := unix.Setns(nsfd, unix.CLONE_NEWNET); err != nil {
			runtime.UnlockOSThread()
			ch <- result{err: err}
			return
		}
		values := make([]bool, len(names))
		var readErr error
		for i, name := range names {
			b, err := os.ReadFile("/proc/sys/net/netfilter/" + name)
			if err != nil {
				readErr = err
				continue
			}
			values[i] = strings.TrimSpace(string(b)) != "0"
		}
		if err := unix.Setns(int(home.Fd()), unix.CLONE_NEWNET); err != nil {
			ch <- result{err: fmt.Errorf("return to the stationd namespace: %w", err)}
			return
		}
		runtime.UnlockOSThread()
		ch <- result{values: values, err: readErr}
	}()
	r := <-ch
	return r.values, r.err
}

func (m *Monitor) open(pid int, inode uint64, classify Classifier) (*Watch, error) {
	if pid <= 0 {
		return nil, errors.New("no process for the namespace")
	}
	ns, err := os.Open("/proc/" + strconv.Itoa(pid) + "/ns/net")
	if err != nil {
		return nil, err
	}
	var st syscall.Stat_t
	if err := syscall.Fstat(int(ns.Fd()), &st); err != nil {
		ns.Close()
		return nil, err
	}
	if inode != 0 && st.Ino != inode {
		ns.Close()
		return nil, fmt.Errorf("namespace of pid %d is %d, not %d", pid, st.Ino, inode)
	}
	ev, err := dialNetfilter(int(ns.Fd()), "conntrack-events")
	if err != nil {
		ns.Close()
		return nil, err
	}
	fail := func(err error) (*Watch, error) {
		ev.Close()
		ns.Close()
		return nil, err
	}
	if err := ev.SetsockoptInt(unix.SOL_SOCKET, unix.SO_RCVBUFFORCE, eventBuffer); err != nil {
		return fail(err)
	}
	if err := ev.Bind(&unix.SockaddrNetlink{Family: unix.AF_NETLINK, Groups: 1<<(groupNew-1) | 1<<(groupDestroy-1)}); err != nil {
		return fail(err)
	}
	gt, err := newGetter(int(ns.Fd()))
	if err != nil {
		return fail(err)
	}
	values, err := readSysctls(int(ns.Fd()), "nf_conntrack_acct", "nf_conntrack_timestamp")
	if err != nil {
		gt.close()
		return fail(err)
	}
	w := &Watch{
		m: m, ns: ns, inode: st.Ino, ev: ev, gt: gt, classify: classify,
		accounting: values[0],
		timestamps: values[1],
		table:      map[key]flow{},
		groupIdx:   map[GroupKey]int32{},
		closed:     map[int32]*closedAcc{},
		tombs:      map[key]tomb{},
		stale:      true,
		backoff:    resyncSpacing,
		grant:      make(chan struct{}, 1),
		synced:     make(chan struct{}, 1),
		quit:       make(chan struct{}),
		ready:      make(chan struct{}),
		done:       make(chan struct{}),
	}
	go w.read()
	return w, nil
}

func (w *Watch) Inode() uint64 { return w.inode }

func (w *Watch) Ready() <-chan struct{} { return w.ready }

func (w *Watch) Failed() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.failed
}

func (w *Watch) Close() {
	w.once.Do(func() {
		w.closing.Store(true)
		close(w.quit)
		w.ev.Close()
		<-w.done
		w.gtMu.Lock()
		w.gt.close()
		w.gtMu.Unlock()
		w.ns.Close()
		w.mu.Lock()
		n := len(w.table)
		w.table = map[key]flow{}
		w.order = nil
		w.mu.Unlock()
		w.m.release(n)
		w.m.forget(w)
	})
}

func (w *Watch) read() {
	defer close(w.done)
	select {
	case <-w.grant:
		w.sync(true)
		w.synced <- struct{}{}
	case <-w.quit:
		return
	}
	buf := make([]byte, 64<<10)
	var msg message
	for {
		select {
		case <-w.grant:
			w.ev.SetReadDeadline(time.Time{})
			w.sync(false)
			w.synced <- struct{}{}
		default:
		}
		n, err := w.ev.ReadContext(context.Background(), buf)
		if err != nil {
			switch {
			case w.closing.Load():
				return
			case errors.Is(err, os.ErrDeadlineExceeded):
				w.ev.SetReadDeadline(time.Time{})
				continue
			case errors.Is(err, unix.ENOBUFS):
				w.overflow()
				continue
			}
			w.mu.Lock()
			w.failed, w.stale = err, true
			w.mu.Unlock()
			w.m.log.Warn("conntrack event socket failed", "netns", w.inode, "error", err)
			return
		}
		now := time.Now().UnixNano()
		messages(buf[:n], func(m []byte) {
			if decode(m, &msg) && (msg.kind == kindNew || msg.kind == kindDestroy) {
				w.apply(&msg, now)
			}
		})
	}
}

func (w *Watch) apply(msg *message, now int64) {
	w.mu.Lock()
	_, held := w.table[msg.key]
	w.mu.Unlock()
	group := int32(-1)
	if !held {
		g, ok := w.classify(msg.key.orig, msg.reply)
		w.mu.Lock()
		group = w.intern(g, ok)
		w.mu.Unlock()
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if msg.kind == kindNew {
		w.applyNew(msg, group, now)
		return
	}
	w.applyDestroy(msg, group)
}

func (w *Watch) overflow() {
	w.mu.Lock()
	w.stale = true
	now := time.Now()
	notBefore := now
	if !w.lastSync.IsZero() && now.Sub(w.lastSync) < resyncSpacing {
		notBefore = now.Add(w.backoff)
		w.backoff = min(w.backoff*2, resyncBackoffMax)
	} else {
		w.backoff = resyncSpacing
	}
	w.mu.Unlock()
	w.m.log.Info("conntrack events lost, resyncing", "netns", w.inode, "not_before", notBefore.Format(time.RFC3339))
	w.m.enqueue(w, notBefore)
}

func (w *Watch) drain() int {
	rc, err := w.ev.SyscallConn()
	if err != nil {
		return 0
	}
	buf := make([]byte, 64<<10)
	drained := 0
	rc.Read(func(fd uintptr) bool {
		for {
			_, _, err := unix.Recvfrom(int(fd), buf, unix.MSG_DONTWAIT)
			switch {
			case err == nil:
				drained++
			case err == unix.ENOBUFS || err == unix.EINTR:
			default:
				return true
			}
		}
	})
	return drained
}

type seeded struct {
	k     key
	f     flow
	group GroupKey
	ok    bool
}

func (w *Watch) dump() ([]seeded, error) {
	c, err := conntrack.Dial(&netlink.Config{NetNS: int(w.ns.Fd())})
	if err != nil {
		return nil, err
	}
	defer c.Close()
	all, err := c.Dump(nil)
	if err != nil {
		return nil, err
	}
	now := time.Now().UnixNano()
	out := make([]seeded, 0, len(all))
	for i := range all {
		f := &all[i]
		if !f.TupleOrig.IP.SourceAddress.Is4() || !f.TupleOrig.IP.DestinationAddress.Is4() {
			continue
		}
		s := seeded{k: key{id: f.ID, orig: Tuple{
			Src: f.TupleOrig.IP.SourceAddress.As4(), Dst: f.TupleOrig.IP.DestinationAddress.As4(),
			SPort: f.TupleOrig.Proto.SourcePort, DPort: f.TupleOrig.Proto.DestinationPort, Proto: f.TupleOrig.Proto.Protocol,
		}}}
		var reply Tuple
		if f.TupleReply.IP.SourceAddress.Is4() {
			reply = Tuple{Src: f.TupleReply.IP.SourceAddress.As4(), Dst: f.TupleReply.IP.DestinationAddress.As4(),
				SPort: f.TupleReply.Proto.SourcePort, DPort: f.TupleReply.Proto.DestinationPort, Proto: f.TupleReply.Proto.Protocol}
		}
		s.f = flow{reply: reply.Src, read: now, orig: f.CountersOrig.Bytes, repl: f.CountersReply.Bytes}
		s.f.baseOrig, s.f.baseRepl = s.f.orig, s.f.repl
		if !f.Timestamp.Start.IsZero() {
			s.f.start, s.f.startKnown = f.Timestamp.Start.UnixNano(), true
		}
		if f.ProtoInfo.TCP != nil {
			s.f.tcp = f.ProtoInfo.TCP.State
		}
		s.group, s.ok = w.classify(s.k.orig, reply)
		out = append(out, s)
	}
	return out, nil
}

func (w *Watch) sync(initial bool) {
	start := time.Now()
	drained := 0
	if !initial {
		drained = w.drain()
	}
	got, err := w.dump()
	w.install(got, err, initial, drained, start)
}

func (w *Watch) install(got []seeded, err error, initial bool, drained int, start time.Time) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.lastSync = time.Now()
	if err != nil {
		w.m.log.Warn("conntrack dump failed", "netns", w.inode, "error", err)
		w.stale = true
		w.m.enqueue(w, w.lastSync.Add(w.backoff))
		return
	}
	old := w.table
	w.m.release(len(old))
	w.table = make(map[key]flow, len(got))
	w.order = w.order[:0]
	w.notStored = 0
	for i := range got {
		s := &got[i]
		if prev, ok := old[s.k]; ok {
			s.f.baseOrig, s.f.baseRepl = prev.baseOrig, prev.baseRepl
		}
		s.f.group = w.intern(s.group, s.ok)
		w.insert(s.k, s.f)
	}
	w.truncated = w.notStored > 0
	w.stale = false
	w.drift = 0
	if !initial {
		w.lossy = true
	}
	w.seeded = true
	w.markReady()
	level := slog.LevelInfo
	if initial {
		level = slog.LevelDebug
	}
	w.m.log.Log(context.Background(), level, "conntrack table synced", "netns", w.inode, "initial", initial, "flows", len(w.table), "drained", drained, "not_stored", w.notStored, "ms", time.Since(start).Milliseconds())
}

func (w *Watch) markReady() {
	select {
	case <-w.ready:
	default:
		close(w.ready)
	}
}

func (w *Watch) count() (int, error) {
	w.gtMu.Lock()
	defer w.gtMu.Unlock()
	return w.gt.entries()
}

func (w *Watch) tick(now int64) {
	count, err := w.count()
	w.recordCount(count, err, now)
}

func (w *Watch) recordCount(count int, err error, now int64) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if err != nil {
		w.entries = nil
		return
	}
	w.entries = &count
	held := len(w.table)
	if w.notStored > 0 && count <= held {
		w.notStored, w.truncated = 0, false
	}
	if !w.seeded || w.stale || w.truncated || w.notStored > 0 {
		w.drift = 0
		return
	}
	diff := count - held
	if diff < 0 {
		diff = -diff
	}
	if diff*10 > max(count, held) {
		w.drift++
	} else {
		w.drift = 0
	}
	if w.drift >= driftTicks && time.Unix(0, now).Sub(w.lastSync) >= resyncSpacing {
		w.drift = 0
		w.m.log.Info("conntrack table drifted from the kernel count, resyncing", "netns", w.inode, "held", held, "entries", count)
		w.m.enqueue(w, time.Unix(0, now))
	}
}

func (w *Watch) Collect(now time.Time) Snapshot {
	w.mu.Lock()
	unread := w.entries == nil
	w.mu.Unlock()
	if unread {
		if count, err := w.count(); err == nil {
			w.mu.Lock()
			w.entries = &count
			w.mu.Unlock()
		}
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	s := Snapshot{
		Groups:     w.collect(now.UnixNano()),
		Truncated:  w.truncated || w.notStored > 0,
		Stale:      w.stale || !w.seeded,
		Lossy:      w.lossy,
		Accounting: w.accounting,
		Timestamps: w.timestamps,
		First:      !w.collected,
	}
	if w.entries != nil {
		n := *w.entries
		s.Entries = &n
	}
	w.lossy = false
	w.collected = true
	return s
}
