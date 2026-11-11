package outbox

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestEnforceBoundDropsRecordsOlderThanTheCutoffWithinTheSameSecond(t *testing.T) {
	dir := t.TempDir()
	line := `{"seq":1,"type":"health.result","generation":1,"at":"2026-11-03T10:00:05Z","body":{"seq":1}}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, logFile), []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	o, err := Open(dir, func(prefix string) string { return prefix + "_1" })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = o.Close() })

	at := time.Date(2026, 11, 3, 10, 0, 5, 0, time.UTC)
	o.enforceBound(at.Add(boundAge + 500*time.Millisecond))

	records := o.After(0, 10)
	if len(records) != 1 || records[0].Type != "outbox.gap" {
		t.Fatalf("records %+v, want the expired health.result replaced by one outbox.gap", records)
	}
}
