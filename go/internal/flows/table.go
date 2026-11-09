//go:build linux

package flows

import (
	"golang.org/x/sys/unix"
)

const tcpEstablished = 3

type Peer struct {
	Kind         string
	ServiceID    string
	DeploymentID string
	Address      string
}

type GroupKey struct {
	Out   bool
	Peer  Peer
	Port  uint16
	Proto uint8
}

type Classifier func(orig, reply Tuple) (GroupKey, bool)

type flow struct {
	reply      [4]byte
	start      int64
	read       int64
	orig       uint64
	repl       uint64
	baseOrig   uint64
	baseRepl   uint64
	group      int32
	tcp        uint8
	startKnown bool
}

type closedAcc struct {
	orig, repl           uint64
	deltaOrig, deltaRepl uint64
}

type tomb struct {
	orig, repl uint64
	group      int32
	at         int64
}

type GroupStat struct {
	Key          GroupKey
	Flows        int
	Established  int
	Orig, Repl   uint64
	DeltaOrig    uint64
	DeltaRepl    uint64
	OldestStart  int64
	StartUnknown bool
	OldestRead   int64
}

func refreshable(proto uint8) bool {
	return proto == unix.IPPROTO_TCP || proto == unix.IPPROTO_UDP
}

func (w *Watch) intern(g GroupKey, ok bool) int32 {
	if !ok {
		return -1
	}
	if i, found := w.groupIdx[g]; found {
		return i
	}
	i := int32(len(w.groups))
	w.groups = append(w.groups, g)
	w.groupIdx[g] = i
	return i
}

func (w *Watch) insert(k key, f flow) bool {
	if len(w.table) >= w.m.perNamespace || !w.m.reserve() {
		w.notStored++
		return false
	}
	w.table[k] = f
	if refreshable(k.orig.Proto) {
		w.order = append(w.order, k)
	}
	return true
}

func (w *Watch) remove(k key) {
	if _, ok := w.table[k]; !ok {
		return
	}
	delete(w.table, k)
	w.m.release(1)
}

func (w *Watch) addClosed(group int32, orig, repl, baseOrig, baseRepl uint64) {
	if group < 0 {
		return
	}
	acc := w.closed[group]
	if acc == nil {
		acc = &closedAcc{}
		w.closed[group] = acc
	}
	acc.orig += orig
	acc.repl += repl
	if orig > baseOrig {
		acc.deltaOrig += orig - baseOrig
	}
	if repl > baseRepl {
		acc.deltaRepl += repl - baseRepl
	}
}

func (w *Watch) applyNew(m *message, group int32, now int64) {
	if _, ok := w.table[m.key]; ok {
		return
	}
	f := flow{start: now, read: now, group: group, tcp: m.tcp, startKnown: true}
	if m.hasReply {
		f.reply = m.reply.Src
	}
	if m.start != 0 {
		f.start = m.start
	}
	if m.counters {
		f.orig, f.repl = m.origB, m.replB
	}
	w.insert(m.key, f)
}

func (w *Watch) applyDestroy(m *message, group int32) {
	if f, ok := w.table[m.key]; ok {
		if m.counters {
			w.addClosed(f.group, m.origB, m.replB, f.baseOrig, f.baseRepl)
		}
		w.remove(m.key)
		return
	}
	if !m.counters {
		return
	}
	if t, ok := w.tombs[m.key]; ok {
		delete(w.tombs, m.key)
		w.addClosed(t.group, m.origB-min(m.origB, t.orig), m.replB-min(m.replB, t.repl), 0, 0)
		return
	}
	w.addClosed(group, m.origB, m.replB, 0, 0)
}

func (w *Watch) applyGet(k key, r *getResult, now int64) {
	f, ok := w.table[k]
	if !ok {
		return
	}
	if r.err == unix.ENOENT || (r.err == 0 && r.msg.key.id != k.id) {
		w.addClosed(f.group, f.orig, f.repl, f.baseOrig, f.baseRepl)
		w.tombs[k] = tomb{orig: f.orig, repl: f.repl, group: f.group, at: now}
		w.remove(k)
		return
	}
	w.order = append(w.order, k)
	if r.err != 0 {
		return
	}
	if r.msg.counters {
		f.orig, f.repl = r.msg.origB, r.msg.replB
	}
	if r.msg.hasTCP {
		f.tcp = r.msg.tcp
	}
	f.read = now
	w.table[k] = f
}

func (w *Watch) headRead(before int64) (int64, bool) {
	for len(w.order) > 0 {
		f, ok := w.table[w.order[0]]
		if !ok {
			w.order = w.order[1:]
			continue
		}
		if f.read >= before {
			return 0, false
		}
		return f.read, true
	}
	return 0, false
}

func (w *Watch) takeBatch(before int64, n int, keys []key, tuples []Tuple) ([]key, []Tuple) {
	for len(w.order) > 0 && len(keys) < n {
		k := w.order[0]
		f, ok := w.table[k]
		if ok && f.read >= before {
			break
		}
		w.order = w.order[1:]
		if !ok {
			continue
		}
		keys = append(keys, k)
		tuples = append(tuples, k.orig)
	}
	if cap(w.order) > 2*len(w.table)+1024 {
		w.order = append(make([]key, 0, len(w.order)+len(w.order)/2), w.order...)
	}
	return keys, tuples
}

func (w *Watch) collect(now int64) []GroupStat {
	stats := make([]GroupStat, len(w.groups))
	used := make([]bool, len(w.groups))
	for k, f := range w.table {
		if f.group < 0 {
			continue
		}
		g := &stats[f.group]
		used[f.group] = true
		g.Flows++
		if k.orig.Proto == unix.IPPROTO_TCP && f.tcp == tcpEstablished {
			g.Established++
		}
		g.Orig += f.orig
		g.Repl += f.repl
		if f.orig > f.baseOrig {
			g.DeltaOrig += f.orig - f.baseOrig
		}
		if f.repl > f.baseRepl {
			g.DeltaRepl += f.repl - f.baseRepl
		}
		if !f.startKnown {
			g.StartUnknown = true
		} else if g.OldestStart == 0 || f.start < g.OldestStart {
			g.OldestStart = f.start
		}
		if g.OldestRead == 0 || f.read < g.OldestRead {
			g.OldestRead = f.read
		}
		f.baseOrig, f.baseRepl = f.orig, f.repl
		w.table[k] = f
	}
	for i, acc := range w.closed {
		g := &stats[i]
		used[i] = true
		g.Orig += acc.orig
		g.Repl += acc.repl
		g.DeltaOrig += acc.deltaOrig
		g.DeltaRepl += acc.deltaRepl
		if g.OldestRead == 0 {
			g.OldestRead = now
		}
	}
	clear(w.closed)
	for k, t := range w.tombs {
		if now-t.at > int64(tombLifetime) {
			delete(w.tombs, k)
		}
	}
	out := make([]GroupStat, 0, len(stats))
	for i := range stats {
		if used[i] {
			stats[i].Key = w.groups[i]
			out = append(out, stats[i])
		}
	}
	return out
}
