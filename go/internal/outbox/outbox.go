package outbox

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/harshjv/stationly/go/internal/fsx"
)

const (
	logFile      = "records.jsonl"
	stateFile    = "state.json"
	boundBytes   = 256 << 20
	boundAge     = 7 * 24 * time.Hour
	compactAfter = 512
)

var droppable = []string{"health.result", "container.exited"}

type Record struct {
	Seq        int             `json:"seq"`
	Type       string          `json:"type"`
	Generation int             `json:"generation"`
	At         string          `json:"at"`
	Body       json.RawMessage `json:"body"`
}

type state struct {
	Epoch string `json:"epoch"`
	Acked int    `json:"acked"`
}

type Outbox struct {
	dir     string
	mu      sync.Mutex
	st      state
	next    int
	pending []Record
	size    int64
	file    *os.File
	stale   int
	notify  chan struct{}
	newID   func(string) string
}

func Open(dir string, newID func(prefix string) string) (*Outbox, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	o := &Outbox{dir: dir, notify: make(chan struct{}, 1), newID: newID}
	b, err := os.ReadFile(filepath.Join(dir, stateFile))
	switch {
	case errors.Is(err, fs.ErrNotExist):
		o.st = state{Epoch: newID("obx")}
		if err := o.saveState(); err != nil {
			return nil, err
		}
	case err != nil:
		return nil, err
	default:
		if err := json.Unmarshal(b, &o.st); err != nil {
			return nil, fmt.Errorf("outbox %s: %w", stateFile, err)
		}
		if o.st.Epoch == "" {
			return nil, fmt.Errorf("outbox %s: no epoch", stateFile)
		}
	}
	if err := o.load(); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, logFile), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	o.file = f
	return o, nil
}

func (o *Outbox) load() error {
	f, err := os.Open(filepath.Join(o.dir, logFile))
	if errors.Is(err, fs.ErrNotExist) {
		o.next = o.st.Acked + 1
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	last := o.st.Acked
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 8<<20)
	for sc.Scan() {
		line := sc.Bytes()
		var r Record
		if err := json.Unmarshal(line, &r); err != nil {
			continue
		}
		last = max(last, r.Seq)
		if r.Seq <= o.st.Acked {
			o.stale++
			continue
		}
		o.pending = append(o.pending, r)
		o.size += int64(len(line)) + 1
	}
	o.next = last + 1
	return sc.Err()
}

func (o *Outbox) saveState() error {
	b, err := json.Marshal(o.st)
	if err != nil {
		return err
	}
	return fsx.WriteFile(filepath.Join(o.dir, stateFile), b, 0o600)
}

func (o *Outbox) Notify() <-chan struct{} {
	return o.notify
}

func (o *Outbox) Append(typ string, generation int, body any) (Record, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return Record{}, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return Record{}, fmt.Errorf("outboxed body of %s is not an object: %w", typ, err)
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	seq := o.next
	fields["seq"] = json.RawMessage(fmt.Sprint(seq))
	withSeq, err := json.Marshal(fields)
	if err != nil {
		return Record{}, err
	}
	r := Record{Seq: seq, Type: typ, Generation: generation, At: time.Now().UTC().Format(time.RFC3339Nano), Body: withSeq}
	line, err := json.Marshal(r)
	if err != nil {
		return Record{}, err
	}
	line = append(line, '\n')
	if _, err := o.file.Write(line); err != nil {
		return Record{}, err
	}
	if err := o.file.Sync(); err != nil {
		return Record{}, err
	}
	o.next++
	o.pending = append(o.pending, r)
	o.size += int64(len(line))
	o.enforceBound()
	select {
	case o.notify <- struct{}{}:
	default:
	}
	return r, nil
}

func (o *Outbox) enforceBound() {
	cutoff := time.Now().Add(-boundAge).UTC().Format(time.RFC3339Nano)
	if o.size <= boundBytes && (len(o.pending) == 0 || o.pending[0].At >= cutoff) {
		return
	}
	var dropped []Record
	kept := o.pending[:0]
	over := o.size
	for _, r := range o.pending {
		if (over > boundBytes || r.At < cutoff) && slices.Contains(droppable, r.Type) {
			dropped = append(dropped, r)
			over -= int64(len(r.Body))
			continue
		}
		kept = append(kept, r)
	}
	o.pending = kept
	if len(dropped) == 0 {
		return
	}
	types := []string{}
	for _, r := range dropped {
		if !slices.Contains(types, r.Type) {
			types = append(types, r.Type)
		}
	}
	gap, _ := json.Marshal(map[string]any{"seq": o.next, "from_seq": dropped[0].Seq, "to_seq": dropped[len(dropped)-1].Seq, "types": types})
	r := Record{Seq: o.next, Type: "outbox.gap", At: time.Now().UTC().Format(time.RFC3339Nano), Body: gap}
	line, _ := json.Marshal(r)
	if _, err := o.file.Write(append(line, '\n')); err == nil && o.file.Sync() == nil {
		o.next++
		o.pending = append(o.pending, r)
	}
	o.rewrite()
}

func (o *Outbox) Epoch() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.st.Epoch
}

func (o *Outbox) Range() (epoch string, first, last int) {
	o.mu.Lock()
	defer o.mu.Unlock()
	last = o.next - 1
	first = o.next
	if len(o.pending) > 0 {
		first = o.pending[0].Seq
	}
	return o.st.Epoch, first, last
}

func (o *Outbox) LastSeq() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.next - 1
}

func (o *Outbox) After(seq, limit int) []Record {
	o.mu.Lock()
	defer o.mu.Unlock()
	i, _ := slices.BinarySearchFunc(o.pending, seq+1, func(r Record, s int) int { return r.Seq - s })
	end := min(len(o.pending), i+limit)
	return slices.Clone(o.pending[i:end])
}

func (o *Outbox) Full() bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.size > boundBytes
}

func (o *Outbox) Pending() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.pending)
}

func (o *Outbox) Ack(epoch string, upTo int) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if epoch != o.st.Epoch || upTo <= o.st.Acked {
		return 0, nil
	}
	upTo = min(upTo, o.next-1)
	i, _ := slices.BinarySearchFunc(o.pending, upTo+1, func(r Record, s int) int { return r.Seq - s })
	acked := i
	for _, r := range o.pending[:i] {
		b, _ := json.Marshal(r)
		o.size -= int64(len(b)) + 1
	}
	o.pending = slices.Clone(o.pending[i:])
	o.st.Acked = upTo
	o.stale += acked
	if err := o.saveState(); err != nil {
		return acked, err
	}
	if o.stale >= compactAfter || len(o.pending) == 0 && o.stale > 0 {
		o.rewrite()
	}
	return acked, nil
}

func (o *Outbox) rewrite() {
	var buf bytes.Buffer
	for _, r := range o.pending {
		b, _ := json.Marshal(r)
		buf.Write(b)
		buf.WriteByte('\n')
	}
	if err := fsx.WriteFile(filepath.Join(o.dir, logFile), buf.Bytes(), 0o600); err != nil {
		return
	}
	o.file.Close()
	nf, err := os.OpenFile(filepath.Join(o.dir, logFile), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	o.file = nf
	o.size = int64(buf.Len())
	o.stale = 0
}

func (o *Outbox) Close() error {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.file.Close()
}
