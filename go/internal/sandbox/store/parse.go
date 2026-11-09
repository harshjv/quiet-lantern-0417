package store

import (
	"fmt"
	"strconv"
	"strings"
)

type qgroupRow struct {
	ID         string
	Referenced uint64
	Exclusive  uint64
	Limit      uint64
	Path       string
}

func parseQgroupShow(out string) ([]qgroupRow, error) {
	var rows []qgroupRow
	hasMaxRef, hasMaxExcl, header := false, false, false
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || strings.HasPrefix(fields[0], "--") {
			continue
		}
		if strings.EqualFold(fields[0], "qgroupid") {
			header = true
			hasMaxRef = strings.Contains(line, "Max referenced") || strings.Contains(line, "max_rfer")
			hasMaxExcl = strings.Contains(line, "Max exclusive") || strings.Contains(line, "max_excl")
			continue
		}
		if !header {
			return nil, fmt.Errorf("qgroup show: row before header: %q", line)
		}
		if len(fields) < 3 {
			return nil, fmt.Errorf("qgroup show: short row: %q", line)
		}
		row := qgroupRow{ID: fields[0]}
		var err error
		if row.Referenced, err = strconv.ParseUint(fields[1], 10, 64); err != nil {
			return nil, fmt.Errorf("qgroup show: referenced in %q: %w", line, err)
		}
		if row.Exclusive, err = strconv.ParseUint(fields[2], 10, 64); err != nil {
			return nil, fmt.Errorf("qgroup show: exclusive in %q: %w", line, err)
		}
		next := 3
		var maxRef, maxExcl uint64
		for _, present := range []struct {
			on  bool
			dst *uint64
		}{{hasMaxRef, &maxRef}, {hasMaxExcl, &maxExcl}} {
			if !present.on {
				continue
			}
			if next >= len(fields) {
				return nil, fmt.Errorf("qgroup show: missing limit in %q", line)
			}
			if fields[next] != "none" {
				if *present.dst, err = strconv.ParseUint(fields[next], 10, 64); err != nil {
					return nil, fmt.Errorf("qgroup show: limit in %q: %w", line, err)
				}
			}
			next++
		}
		row.Limit = maxRef
		if row.Limit == 0 {
			row.Limit = maxExcl
		}
		if next < len(fields) {
			row.Path = strings.Join(fields[next:], " ")
		}
		rows = append(rows, row)
	}
	if !header {
		return nil, fmt.Errorf("qgroup show: no header in output")
	}
	return rows, nil
}

func parseSubvolumeList(out string) (map[string]string, error) {
	byID := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		at := strings.Index(line, " path ")
		if len(fields) < 2 || fields[0] != "ID" || at < 0 {
			return nil, fmt.Errorf("subvolume list: unexpected line %q", line)
		}
		if _, err := strconv.ParseUint(fields[1], 10, 64); err != nil {
			return nil, fmt.Errorf("subvolume list: id in %q: %w", line, err)
		}
		byID[fields[1]] = strings.TrimPrefix(line[at+len(" path "):], "<FS_TREE>/")
	}
	return byID, nil
}

func usageFromRows(rows []qgroupRow, paths map[string]string) map[string]Usage {
	usage := map[string]Usage{}
	for _, r := range rows {
		level, id, ok := strings.Cut(r.ID, "/")
		if !ok || level != "0" {
			continue
		}
		path := r.Path
		if path == "" || strings.HasPrefix(path, "<") {
			path = paths[id]
		}
		if _, ok := relSubvolume(path); !ok {
			continue
		}
		usage[path] = Usage{Referenced: r.Referenced, Exclusive: r.Exclusive, Limit: r.Limit}
	}
	return usage
}

func rowsNeedPaths(rows []qgroupRow) bool {
	for _, r := range rows {
		if strings.HasPrefix(r.ID, "0/") && r.Path == "" {
			return true
		}
	}
	return false
}

func parseDeviceStats(out string) (map[string]uint64, error) {
	stats := map[string]uint64{}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		if len(fields) != 2 || !strings.HasPrefix(fields[0], "[") {
			return nil, fmt.Errorf("device stats: unexpected line %q", line)
		}
		n, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			return nil, fmt.Errorf("device stats: counter in %q: %w", line, err)
		}
		stats[strings.Replace(strings.TrimPrefix(fields[0], "["), "].", ".", 1)] = n
	}
	return stats, nil
}

type mountEntry struct {
	MountPoint string
	FSType     string
	Source     string
	Options    string
}

func parseMountInfo(data, mountPoint string) (mountEntry, bool, error) {
	var found mountEntry
	ok := false
	for _, line := range strings.Split(data, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		left, right, cut := strings.Cut(line, " - ")
		lf, rf := strings.Fields(left), strings.Fields(right)
		if !cut || len(lf) < 6 || len(rf) < 2 {
			return mountEntry{}, false, fmt.Errorf("mountinfo: unexpected line %q", line)
		}
		mp := unescapeMount(lf[4])
		if mp != mountPoint {
			continue
		}
		found = mountEntry{MountPoint: mp, FSType: rf[0], Source: unescapeMount(rf[1]), Options: lf[5]}
		ok = true
	}
	return found, ok, nil
}

func unescapeMount(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			if n, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(n))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func parseIncompatFlags(out string) (uint64, error) {
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[0] == "incompat_flags" {
			v, err := strconv.ParseUint(strings.TrimPrefix(fields[1], "0x"), 16, 64)
			if err != nil {
				return 0, fmt.Errorf("dump-super: incompat_flags %q: %w", fields[1], err)
			}
			return v, nil
		}
	}
	return 0, fmt.Errorf("dump-super: no incompat_flags line")
}

func parseBlkid(out string) map[string]string {
	kv := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if ok {
			kv[k] = v
		}
	}
	return kv
}
