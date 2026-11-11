//go:build linux

package deploy

import (
	"sort"
	"time"

	"github.com/harshjv/stationly/go/internal/protocol"
)

const (
	diskCheckInterval   = 10 * time.Second
	diskConsumersListed = 5
	diskLevelNone       = protocol.DiskThreshold("")
)

func diskLevelOf(pct float64, warn, crit int) protocol.DiskThreshold {
	switch {
	case pct >= float64(crit):
		return protocol.DiskThresholdCritical
	case pct >= float64(warn):
		return protocol.DiskThresholdWarning
	default:
		return diskLevelNone
	}
}

func diskRank(level protocol.DiskThreshold) int {
	switch level {
	case protocol.DiskThresholdCritical:
		return 2
	case protocol.DiskThresholdWarning:
		return 1
	default:
		return 0
	}
}

func largestConsumers(breakdown map[string]int64) []any {
	names := make([]string, 0, len(breakdown))
	for name := range breakdown {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool {
		if breakdown[names[i]] != breakdown[names[j]] {
			return breakdown[names[i]] > breakdown[names[j]]
		}
		return names[i] < names[j]
	})
	if len(names) > diskConsumersListed {
		names = names[:diskConsumersListed]
	}
	out := make([]any, 0, len(names))
	for _, name := range names {
		out = append(out, map[string]any{"name": name, "bytes": breakdown[name]})
	}
	return out
}

func (s *Station) tickDiskPressure(now time.Time) {
	if s.plan == nil || now.Sub(s.diskCheckedAt) < diskCheckInterval {
		return
	}
	s.diskCheckedAt = now
	found, unreadable := s.diskFilesystems()
	for _, err := range unreadable {
		s.log.Warn("disk usage unreadable", "error", err)
	}
	s.observeDisk(found)
}

func (s *Station) observeDisk(found []diskFS) {
	warn, crit := s.diskThresholds()
	var worst *diskFS
	for i := range found {
		if worst == nil || found[i].pct > worst.pct {
			worst = &found[i]
		}
	}
	if worst == nil {
		return
	}
	level := diskLevelOf(worst.pct, warn, crit)
	previous := s.diskLevel
	s.diskLevel = level
	if diskRank(level) <= diskRank(previous) {
		return
	}
	s.log.Warn("disk pressure", "threshold", string(level), "path", worst.path, "used_pct", int(worst.pct+0.5), "free_bytes", worst.free)
	s.emit(protocol.MessageDiskPressure, protocol.DiskPressureBody{
		FreeBytes:        int(worst.free),
		Threshold:        level,
		LargestConsumers: largestConsumers(s.diskBreakdown()),
	})
}
