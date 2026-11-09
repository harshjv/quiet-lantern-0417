package store

import "fmt"

func mountUnit(backing Backing, what string) string {
	options := "noatime"
	if backing == BackingLoopFile {
		options = "loop,noatime,nodiscard"
	}
	return fmt.Sprintf(`[Unit]
Description=Stationly sandbox filesystem

[Mount]
What=%s
Where=%s
Type=btrfs
Options=%s

[Install]
WantedBy=local-fs.target
`, what, Mount, options)
}
