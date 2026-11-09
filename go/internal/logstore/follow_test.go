package logstore

import (
	"os"
	"path/filepath"
	"testing"
)

func writeRunLog(t *testing.T, root, name, text string) Source {
	t.Helper()
	path := filepath.Join("logs", name)
	if err := os.MkdirAll(filepath.Join(root, "logs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, path), []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	return Source{Path: path, Plain: true}
}

func texts(entries []Entry) []string {
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		out = append(out, e.Text)
	}
	return out
}

func TestFollowerFromStartDeliversLinesWrittenBeforeItOpened(t *testing.T) {
	root := t.TempDir()
	page := Read(root, nil, Filter{}, 5000, nil)
	if page.Next != nil || len(page.Lines) != 0 {
		t.Fatalf("a run with no log file yet reads as an empty page without a cursor, got %+v", page)
	}
	source := writeRunLog(t, root, "run.log", "[run] hi\n[run] bye\n")
	got := texts(NewFollower(root, []Source{source}, nil, true).Poll([]Source{source}, Filter{}, 2000))
	if len(got) != 2 || got[0] != "[run] hi" || got[1] != "[run] bye" {
		t.Fatalf("follower from the start lost lines: %v", got)
	}
}

func TestFollowerWithoutCursorSkipsExistingLines(t *testing.T) {
	root := t.TempDir()
	source := writeRunLog(t, root, "service.log", "old\n")
	got := texts(NewFollower(root, []Source{source}, nil, false).Poll([]Source{source}, Filter{}, 2000))
	if len(got) != 0 {
		t.Fatalf("a live follow must start at the end of existing files: %v", got)
	}
}

func TestFollowerWithCursorResumesAfterThePage(t *testing.T) {
	root := t.TempDir()
	source := writeRunLog(t, root, "run.log", "[run] one\n")
	page := Read(root, []Source{source}, Filter{}, 5000, nil)
	if page.Next == nil || len(page.Lines) != 1 {
		t.Fatalf("unexpected page %+v", page)
	}
	f, err := os.OpenFile(filepath.Join(root, source.Path), os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	f.WriteString("[run] two\n")
	f.Close()
	got := texts(NewFollower(root, []Source{source}, page.Next, true).Poll([]Source{source}, Filter{}, 2000))
	if len(got) != 1 || got[0] != "[run] two" {
		t.Fatalf("follower after a cursor must neither repeat nor lose lines: %v", got)
	}
}
