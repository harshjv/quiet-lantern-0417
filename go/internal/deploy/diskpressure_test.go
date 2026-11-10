//go:build linux

package deploy

import (
	"encoding/json"
	"io"
	"log/slog"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/harshjv/stationly/go/internal/dispatch"
	"github.com/harshjv/stationly/go/internal/identity"
	"github.com/harshjv/stationly/go/internal/ids"
	"github.com/harshjv/stationly/go/internal/outbox"
	"github.com/harshjv/stationly/go/internal/protocol"
)

func TestDiskLevelOfFollowsTheWarningAndCriticalThresholds(t *testing.T) {
	cases := []struct {
		pct  float64
		want protocol.DiskThreshold
	}{
		{0, diskLevelNone},
		{79.99, diskLevelNone},
		{80, protocol.DiskThresholdWarning},
		{89.9, protocol.DiskThresholdWarning},
		{90, protocol.DiskThresholdCritical},
		{100, protocol.DiskThresholdCritical},
	}
	for _, c := range cases {
		if got := diskLevelOf(c.pct, 80, 90); got != c.want {
			t.Errorf("diskLevelOf(%v, 80, 90) = %q, want %q", c.pct, got, c.want)
		}
	}
	if got := diskLevelOf(2, 1, 90); got != protocol.DiskThresholdWarning {
		t.Errorf("a lowered disk.warning_pct of 1 at 2%% used = %q, want warning", got)
	}
}

func TestDiskRankOrdersTheLevelsSoOnlyRisingCrossingsEmit(t *testing.T) {
	if diskRank(diskLevelNone) >= diskRank(protocol.DiskThresholdWarning) || diskRank(protocol.DiskThresholdWarning) >= diskRank(protocol.DiskThresholdCritical) {
		t.Fatal("none < warning < critical must hold")
	}
}

func TestLargestConsumersListsTheBiggestFirstAndAtMostFive(t *testing.T) {
	got := largestConsumers(map[string]int64{"depot": 900, "logs": 10, "backups": 500, "build_cache": 500, "platform": 7, "volumes": 3})
	want := []any{
		map[string]any{"name": "depot", "bytes": int64(900)},
		map[string]any{"name": "backups", "bytes": int64(500)},
		map[string]any{"name": "build_cache", "bytes": int64(500)},
		map[string]any{"name": "logs", "bytes": int64(10)},
		map[string]any{"name": "platform", "bytes": int64(7)},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("largestConsumers = %v, want %v", got, want)
	}
}

func diskTestStation(t *testing.T, warn, crit int) (*Station, *outbox.Outbox) {
	t.Helper()
	dir := t.TempDir()
	ob, err := outbox.Open(filepath.Join(dir, "outbox"), ids.New)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ob.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	link, err := dispatch.New(log, &identity.Identity{Station: identity.Station{DispatchURL: "http://127.0.0.1:1"}}, ob, "test")
	if err != nil {
		t.Fatal(err)
	}
	g := &protocol.Generation{}
	g.Station.Settings.DiskWarningPct = warn
	g.Station.Settings.DiskCriticalPct = crit
	return &Station{log: log, link: link, opts: Options{StateDir: dir, BackupRoot: dir}, plan: &Plan{Generation: g}}, ob
}

func emitted(t *testing.T, ob *outbox.Outbox) []protocol.DiskPressureBody {
	t.Helper()
	var out []protocol.DiskPressureBody
	for _, r := range ob.After(0, 100) {
		if r.Type != protocol.MessageDiskPressure {
			continue
		}
		var b protocol.DiskPressureBody
		if err := json.Unmarshal(r.Body, &b); err != nil {
			t.Fatalf("a disk.pressure record must match its schema: %v", err)
		}
		out = append(out, b)
	}
	return out
}

func TestObserveDiskSendsDiskPressureWhenUsageCrossesTheWarningThreshold(t *testing.T) {
	s, ob := diskTestStation(t, 80, 90)
	s.observeDisk([]diskFS{{path: "/var/lib/docker", pct: 79, total: 100, free: 21}})
	if got := emitted(t, ob); len(got) != 0 {
		t.Fatalf("below the warning threshold nothing is sent, got %d records", len(got))
	}
	s.observeDisk([]diskFS{{path: "/var/lib/docker", pct: 81, total: 100, free: 19}})
	got := emitted(t, ob)
	if len(got) != 1 || got[0].Threshold != protocol.DiskThresholdWarning || got[0].FreeBytes != 19 {
		t.Fatalf("want one warning record with free_bytes 19, got %+v", got)
	}
	s.observeDisk([]diskFS{{path: "/var/lib/docker", pct: 85, total: 100, free: 15}})
	if got := emitted(t, ob); len(got) != 1 {
		t.Fatalf("staying in the warning band sends nothing more, got %d records", len(got))
	}
}

func TestObserveDiskEscalatesToCriticalAndRearmsAfterRecovery(t *testing.T) {
	s, ob := diskTestStation(t, 80, 90)
	s.observeDisk([]diskFS{{path: "/a", pct: 81, free: 19}})
	s.observeDisk([]diskFS{{path: "/a", pct: 95, free: 5}})
	got := emitted(t, ob)
	if len(got) != 2 || got[1].Threshold != protocol.DiskThresholdCritical || got[1].FreeBytes != 5 {
		t.Fatalf("want a warning then a critical record, got %+v", got)
	}
	s.observeDisk([]diskFS{{path: "/a", pct: 50, free: 50}})
	s.observeDisk([]diskFS{{path: "/a", pct: 82, free: 18}})
	if got := emitted(t, ob); len(got) != 3 || got[2].Threshold != protocol.DiskThresholdWarning {
		t.Fatalf("a crossing after recovery must send again, got %+v", got)
	}
}

func TestObserveDiskReportsTheFullestFilesystemAndHonoursLoweredThresholds(t *testing.T) {
	s, ob := diskTestStation(t, 1, 99)
	s.observeDisk([]diskFS{{path: "/a", pct: 3, free: 97}, {path: "/b", pct: 40, free: 60}})
	got := emitted(t, ob)
	if len(got) != 1 || got[0].Threshold != protocol.DiskThresholdWarning || got[0].FreeBytes != 60 {
		t.Fatalf("want one warning for the fullest filesystem, got %+v", got)
	}
}
