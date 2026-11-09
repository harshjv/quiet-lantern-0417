package logstore

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	SegmentBytes = 64 << 20
	MaxLineBytes = 16 << 10
	TimeLayout   = "2006-01-02T15:04:05.000000000Z"
	DefaultTail  = 50
	MaxTail      = 5000
)

type Record struct {
	At     string `json:"at"`
	Role   string `json:"role"`
	Stream string `json:"stream"`
	Text   string `json:"text"`
}

type Source struct {
	Path  string
	Plain bool
	Role  string
}

type Entry struct {
	At     time.Time
	Role   string
	Stream string
	Text   string
	Level  string
	File   string
	End    int64
}

type Cursor struct {
	F string `json:"f"`
	O int64  `json:"o"`
}

func (c Cursor) Encode() string {
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b)
}

func DecodeCursor(s string) (Cursor, error) {
	b, err := base64.RawURLEncoding.Strict().DecodeString(s)
	if err != nil {
		return Cursor{}, fmt.Errorf("cursor is not base64url: %w", err)
	}
	var c Cursor
	if err := json.Unmarshal(b, &c); err != nil || c.F == "" || c.O < 0 {
		return Cursor{}, errors.New("cursor does not name a log position")
	}
	return c, nil
}

func FormatTime(t time.Time) string {
	return t.UTC().Format(TimeLayout)
}

type Store struct {
	Root    string
	mu      sync.Mutex
	writers map[string]*Writer
}

func New(root string) *Store {
	return &Store{Root: root, writers: map[string]*Writer{}}
}

type Writer struct {
	mu      sync.Mutex
	root    string
	dir     string
	prefix  string
	single  bool
	limit   int64
	n       int
	f       *os.File
	size    int64
	last    time.Time
	loaded  bool
	Dropped int64
}

func (s *Store) Segmented(dir, prefix string) *Writer {
	key := filepath.Join(dir, prefix) + "#seg"
	s.mu.Lock()
	defer s.mu.Unlock()
	if w := s.writers[key]; w != nil {
		return w
	}
	w := &Writer{root: s.Root, dir: dir, prefix: prefix}
	s.writers[key] = w
	return w
}

func (s *Store) Single(path string, limit int64) *Writer {
	key := path + "#one"
	s.mu.Lock()
	defer s.mu.Unlock()
	if w := s.writers[key]; w != nil {
		return w
	}
	w := &Writer{root: s.Root, dir: filepath.Dir(path), prefix: filepath.Base(path), single: true, limit: limit}
	s.writers[key] = w
	return w
}

func (s *Store) Release(w *Writer) {
	w.mu.Lock()
	if w.f != nil {
		w.f.Close()
		w.f = nil
	}
	w.mu.Unlock()
	s.mu.Lock()
	for k, v := range s.writers {
		if v == w {
			delete(s.writers, k)
		}
	}
	s.mu.Unlock()
}

func segmentNumber(name, prefix string) int {
	rest := strings.TrimSuffix(strings.TrimPrefix(name, prefix+"."), ".jsonl")
	n, err := strconv.Atoi(rest)
	if err != nil {
		return 0
	}
	return n
}

func (w *Writer) path(n int) string {
	if w.single {
		return filepath.Join(w.root, w.dir, w.prefix)
	}
	return filepath.Join(w.root, w.dir, fmt.Sprintf("%s.%d.jsonl", w.prefix, n))
}

func (w *Writer) load() {
	if w.loaded {
		return
	}
	w.loaded = true
	if w.single {
		w.last = lastTime(w.path(0))
		return
	}
	matches, _ := filepath.Glob(filepath.Join(w.root, w.dir, w.prefix+".*.jsonl"))
	for _, m := range matches {
		if n := segmentNumber(filepath.Base(m), w.prefix); n > w.n {
			w.n = n
		}
	}
	if w.n == 0 {
		w.n = 1
		return
	}
	w.last = lastTime(w.path(w.n))
}

func (w *Writer) Last() time.Time {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.load()
	return w.last
}

func (w *Writer) Path() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.load()
	rel, _ := filepath.Rel(w.root, w.path(w.n))
	return rel
}

func (w *Writer) open() error {
	if w.f != nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Join(w.root, w.dir), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(w.path(w.n), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	w.f, w.size = f, st.Size()
	return nil
}

func (w *Writer) Write(at time.Time, role, stream, text string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.load()
	if len(text) > MaxLineBytes {
		text = text[:MaxLineBytes]
	}
	b, err := json.Marshal(Record{At: FormatTime(at), Role: role, Stream: stream, Text: text})
	if err != nil {
		return err
	}
	b = append(b, '\n')
	if err := w.open(); err != nil {
		return err
	}
	if w.limit > 0 && w.size+int64(len(b)) > w.limit {
		w.Dropped += int64(len(b))
		return nil
	}
	if !w.single && w.size > 0 && w.size+int64(len(b)) > SegmentBytes {
		w.f.Close()
		w.f = nil
		w.n++
		if err := w.open(); err != nil {
			return err
		}
	}
	if _, err := w.f.Write(b); err != nil {
		return err
	}
	w.size += int64(len(b))
	if at.After(w.last) {
		w.last = at
	}
	return nil
}

func lastTime(path string) time.Time {
	f, err := os.Open(path)
	if err != nil {
		return time.Time{}
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.Size() == 0 {
		return time.Time{}
	}
	off := max(int64(0), st.Size()-64<<10)
	buf := make([]byte, st.Size()-off)
	if _, err := f.ReadAt(buf, off); err != nil && !errors.Is(err, io.EOF) {
		return time.Time{}
	}
	lines := bytes.Split(bytes.TrimRight(buf, "\n"), []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		var r Record
		if json.Unmarshal(lines[i], &r) == nil {
			if t, err := time.Parse(time.RFC3339Nano, r.At); err == nil {
				return t
			}
		}
	}
	return time.Time{}
}

func FirstTime(root string, src Source) time.Time {
	full := filepath.Join(root, src.Path)
	if src.Plain {
		st, err := os.Stat(full)
		if err != nil {
			return time.Time{}
		}
		return st.ModTime()
	}
	f, err := os.Open(full)
	if err != nil {
		return time.Time{}
	}
	defer f.Close()
	line, _ := bufio.NewReaderSize(f, 64<<10).ReadBytes('\n')
	var r Record
	if json.Unmarshal(line, &r) == nil {
		if t, err := time.Parse(time.RFC3339Nano, r.At); err == nil {
			return t
		}
	}
	st, err := f.Stat()
	if err != nil {
		return time.Time{}
	}
	return st.ModTime()
}

func Order(root string, sources []Source) []Source {
	type keyed struct {
		s Source
		t time.Time
	}
	ks := make([]keyed, len(sources))
	for i, s := range sources {
		ks[i] = keyed{s, FirstTime(root, s)}
	}
	sort.SliceStable(ks, func(i, j int) bool {
		if !ks[i].t.Equal(ks[j].t) {
			return ks[i].t.Before(ks[j].t)
		}
		return ks[i].s.Path < ks[j].s.Path
	})
	out := make([]Source, len(ks))
	for i, k := range ks {
		out[i] = k.s
	}
	return out
}

var (
	levelRanks = map[string]int{"trace": 0, "debug": 1, "info": 2, "warn": 3, "error": 4, "fatal": 5}
	levelWord  = regexp.MustCompile(`(?i)^\W{0,3}(trace|debug|info|warning|warn|error|err|fatal|panic|critical|crit)\b`)
	levelKV    = regexp.MustCompile(`(?i)\b(?:level|lvl|severity)=["']?(\w+)`)
)

func normalizeLevel(v string) string {
	switch strings.ToLower(v) {
	case "trace":
		return "trace"
	case "debug", "dbg":
		return "debug"
	case "info", "information", "notice":
		return "info"
	case "warn", "warning":
		return "warn"
	case "error", "err":
		return "error"
	case "fatal", "panic", "critical", "crit", "emerg", "alert":
		return "fatal"
	}
	return ""
}

func ParseLevel(text string) string {
	t := strings.TrimSpace(text)
	if strings.HasPrefix(t, "{") {
		var m map[string]any
		if json.Unmarshal([]byte(t), &m) == nil {
			for _, k := range []string{"level", "lvl", "severity"} {
				if v, ok := m[k].(string); ok {
					return normalizeLevel(v)
				}
			}
		}
	}
	if m := levelWord.FindStringSubmatch(t); m != nil {
		return normalizeLevel(m[1])
	}
	if m := levelKV.FindStringSubmatch(t); m != nil {
		return normalizeLevel(m[1])
	}
	return ""
}

type Filter struct {
	Since    time.Time
	Until    time.Time
	Grep     string
	re       *regexp.Regexp
	MinLevel int
	Role     string
}

func NewFilter(since, until time.Time, grep, level string) (Filter, error) {
	f := Filter{Since: since, Until: until, MinLevel: -1}
	if strings.HasPrefix(grep, "re:") {
		re, err := regexp.Compile(grep[3:])
		if err != nil {
			return f, fmt.Errorf("grep: %w", err)
		}
		f.re = re
	} else {
		f.Grep = strings.ToLower(grep)
	}
	if level != "" {
		n := normalizeLevel(level)
		if n == "" {
			return f, fmt.Errorf("level %q is not one of trace, debug, info, warn, error, fatal", level)
		}
		f.MinLevel = levelRanks[n]
	}
	return f, nil
}

func (f Filter) Match(e *Entry) bool {
	if f.Role != "" && e.Role != f.Role {
		return false
	}
	if !f.Since.IsZero() && e.At.Before(f.Since) {
		return false
	}
	if !f.Until.IsZero() && e.At.After(f.Until) {
		return false
	}
	if f.re != nil && !f.re.MatchString(e.Text) {
		return false
	}
	if f.Grep != "" && !strings.Contains(strings.ToLower(e.Text), f.Grep) {
		return false
	}
	if f.MinLevel >= 0 && e.Level != "" && levelRanks[e.Level] < f.MinLevel {
		return false
	}
	return true
}

func parseLine(src Source, line []byte, mod time.Time) Entry {
	text := strings.TrimRight(string(line), "\r\n")
	e := Entry{At: mod, Role: src.Role, Stream: "stdout", Text: text, File: src.Path}
	if !src.Plain {
		var r Record
		if json.Unmarshal(line, &r) == nil {
			if t, err := time.Parse(time.RFC3339Nano, r.At); err == nil {
				e.At = t
			}
			e.Text, e.Stream = r.Text, r.Stream
			if r.Role != "" {
				e.Role = r.Role
			}
		}
	}
	if len(e.Text) > MaxLineBytes {
		e.Text = e.Text[:MaxLineBytes]
	}
	e.Level = ParseLevel(e.Text)
	return e
}

func Scan(root string, src Source, from int64, visit func(Entry) bool) (int64, error) {
	f, err := os.Open(filepath.Join(root, src.Path))
	if err != nil {
		return from, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return from, err
	}
	if from > st.Size() {
		from = st.Size()
	}
	if _, err := f.Seek(from, io.SeekStart); err != nil {
		return from, err
	}
	r := bufio.NewReaderSize(f, 256<<10)
	pos := from
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 && line[len(line)-1] == '\n' {
			pos += int64(len(line))
			e := parseLine(src, line, st.ModTime())
			e.End = pos
			if !visit(e) {
				return pos, nil
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return pos, nil
			}
			return pos, err
		}
	}
}

func size(root, path string) int64 {
	st, err := os.Stat(filepath.Join(root, path))
	if err != nil {
		return 0
	}
	return st.Size()
}

type Page struct {
	Lines     []Entry
	Next      *Cursor
	Truncated bool
}

func Read(root string, sources []Source, filter Filter, tail int, cursor *Cursor) Page {
	if tail <= 0 {
		tail = DefaultTail
	}
	tail = min(tail, MaxTail)
	var page Page
	if len(sources) == 0 {
		return page
	}
	last := sources[len(sources)-1]
	end := &Cursor{F: last.Path, O: size(root, last.Path)}
	if cursor != nil {
		start := -1
		for i, s := range sources {
			if s.Path == cursor.F {
				start = i
				break
			}
		}
		offset := cursor.O
		if start < 0 {
			start, offset, page.Truncated = 0, 0, true
		}
		for i := start; i < len(sources) && len(page.Lines) < tail; i++ {
			from := int64(0)
			if i == start {
				from = offset
			}
			Scan(root, sources[i], from, func(e Entry) bool {
				if filter.Match(&e) {
					page.Lines = append(page.Lines, e)
				}
				return len(page.Lines) < tail
			})
		}
		if len(page.Lines) == tail {
			l := page.Lines[len(page.Lines)-1]
			page.Next = &Cursor{F: l.File, O: l.End}
		} else {
			page.Next = end
		}
		return page
	}
	var collected []Entry
	for i := len(sources) - 1; i >= 0 && len(collected) < tail; i-- {
		src := sources[i]
		if !filter.Since.IsZero() {
			if st, err := os.Stat(filepath.Join(root, src.Path)); err == nil && st.ModTime().Before(filter.Since) {
				continue
			}
		}
		var matched []Entry
		need := tail - len(collected)
		Scan(root, src, 0, func(e Entry) bool {
			if filter.Match(&e) {
				matched = append(matched, e)
				if len(matched) > need {
					matched = matched[1:]
				}
			}
			return true
		})
		collected = append(matched, collected...)
	}
	sort.SliceStable(collected, func(i, j int) bool { return collected[i].At.Before(collected[j].At) })
	page.Lines = collected
	page.Next = end
	if !filter.Until.IsZero() && len(collected) > 0 {
		l := collected[len(collected)-1]
		page.Next = &Cursor{F: l.File, O: l.End}
	}
	return page
}

type Follower struct {
	root    string
	offsets map[string]int64
}

func NewFollower(root string, sources []Source, cursor *Cursor, fromStart bool) *Follower {
	f := &Follower{root: root, offsets: map[string]int64{}}
	at := -1
	if cursor != nil {
		for i, s := range sources {
			if s.Path == cursor.F {
				at = i
			}
		}
	}
	for i, s := range sources {
		switch {
		case cursor != nil && at < 0:
			f.offsets[s.Path] = 0
		case cursor != nil && i == at:
			f.offsets[s.Path] = cursor.O
		case cursor != nil && i > at:
			f.offsets[s.Path] = 0
		case fromStart:
			f.offsets[s.Path] = 0
		default:
			f.offsets[s.Path] = size(root, s.Path)
		}
	}
	return f
}

func (f *Follower) Poll(sources []Source, filter Filter, limit int) []Entry {
	var out []Entry
	for _, s := range sources {
		from, known := f.offsets[s.Path]
		if !known {
			from = 0
		}
		if size(f.root, s.Path) <= from {
			f.offsets[s.Path] = from
			continue
		}
		pos, _ := Scan(f.root, s, from, func(e Entry) bool {
			if filter.Match(&e) {
				out = append(out, e)
			}
			return len(out) < limit
		})
		f.offsets[s.Path] = pos
		if len(out) >= limit {
			break
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].At.Before(out[j].At) })
	return out
}

type Retention struct {
	RuntimeDays         int
	RuntimeBytesService int64
	RunDays             int
	BuildDays           int
	SystemDays          int
}

func isRuntime(name string) bool {
	return strings.HasPrefix(name, "runtime.") || strings.HasPrefix(name, "coupler.") || strings.HasPrefix(name, "guard.") || strings.HasPrefix(name, "init.")
}

type Swept struct {
	Files int
	Bytes int64
}

func Sweep(root string, r Retention, now time.Time) Swept {
	var out Swept
	remove := func(path string, size int64) {
		if os.Remove(path) == nil {
			out.Files++
			out.Bytes += size
		}
	}
	logs := filepath.Join(root, "logs")
	services, _ := os.ReadDir(logs)
	for _, svc := range services {
		if !svc.IsDir() {
			continue
		}
		type seg struct {
			path string
			size int64
			mod  time.Time
		}
		var runtime []seg
		deployments, _ := os.ReadDir(filepath.Join(logs, svc.Name()))
		for _, dep := range deployments {
			if !dep.IsDir() {
				continue
			}
			dir := filepath.Join(logs, svc.Name(), dep.Name())
			files, _ := os.ReadDir(dir)
			for _, file := range files {
				info, err := file.Info()
				if err != nil || file.IsDir() {
					continue
				}
				path := filepath.Join(dir, file.Name())
				age := now.Sub(info.ModTime())
				name := file.Name()
				switch {
				case strings.HasPrefix(name, "system."):
					if age > time.Duration(r.SystemDays)*24*time.Hour {
						remove(path, info.Size())
					}
				case isRuntime(name):
					if age > time.Duration(r.RuntimeDays)*24*time.Hour {
						remove(path, info.Size())
						continue
					}
					runtime = append(runtime, seg{path, info.Size(), info.ModTime()})
				case name == "build.log":
					if age > time.Duration(r.BuildDays)*24*time.Hour {
						remove(path, info.Size())
					}
				default:
					if age > time.Duration(r.RunDays)*24*time.Hour {
						remove(path, info.Size())
					}
				}
			}
			if left, _ := os.ReadDir(dir); len(left) == 0 {
				os.Remove(dir)
			}
		}
		sort.Slice(runtime, func(i, j int) bool { return runtime[i].mod.Before(runtime[j].mod) })
		var total int64
		for _, s := range runtime {
			total += s.size
		}
		for _, s := range runtime {
			if total <= r.RuntimeBytesService || now.Sub(s.mod) < time.Minute {
				break
			}
			remove(s.path, s.size)
			total -= s.size
		}
		if left, _ := os.ReadDir(filepath.Join(logs, svc.Name())); len(left) == 0 {
			os.Remove(filepath.Join(logs, svc.Name()))
		}
	}
	return out
}
