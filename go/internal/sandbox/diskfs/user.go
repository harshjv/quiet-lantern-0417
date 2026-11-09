//go:build linux

package diskfs

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

const (
	passwdPath    = "/etc/passwd"
	groupPath     = "/etc/group"
	accountsLimit = 4 << 20
)

func LookupUser(root, user string) (uid, gid int, err error) {
	name, group, hasGroup := strings.Cut(user, ":")
	if name == "" || (hasGroup && group == "") {
		return 0, 0, fmt.Errorf("invalid user %q", user)
	}
	uid, gid, err = lookupPasswd(root, name, !hasGroup)
	if err != nil {
		return 0, 0, err
	}
	if !hasGroup {
		return uid, gid, nil
	}
	gid, err = lookupGroup(root, group)
	if err != nil {
		return 0, 0, err
	}
	return uid, gid, nil
}

func parseID(s string) (int, bool) {
	n, err := strconv.ParseUint(s, 10, 32)
	if err != nil || n == math.MaxUint32 {
		return 0, false
	}
	return int(n), true
}

func lookupPasswd(root, name string, needGID bool) (int, int, error) {
	uid, numeric := parseID(name)
	if numeric && !needGID {
		return uid, 0, nil
	}
	data, err := ReadFile(root, passwdPath, accountsLimit)
	if numeric && errors.Is(err, unix.ENOENT) {
		return uid, 0, nil
	}
	if err != nil {
		return 0, 0, fmt.Errorf("look up user %q: %w", name, err)
	}
	for fields := range accountLines(data) {
		if len(fields) < 4 {
			continue
		}
		entryUID, ok := parseID(fields[2])
		if !ok {
			continue
		}
		entryGID, ok := parseID(fields[3])
		if !ok {
			continue
		}
		if numeric && entryUID == uid || !numeric && fields[0] == name {
			return entryUID, entryGID, nil
		}
	}
	if numeric {
		return uid, 0, nil
	}
	return 0, 0, fmt.Errorf("look up user %q: no such user in %s", name, passwdPath)
}

func lookupGroup(root, group string) (int, error) {
	if gid, ok := parseID(group); ok {
		return gid, nil
	}
	data, err := ReadFile(root, groupPath, accountsLimit)
	if err != nil {
		return 0, fmt.Errorf("look up group %q: %w", group, err)
	}
	for fields := range accountLines(data) {
		if len(fields) < 3 || fields[0] != group {
			continue
		}
		if gid, ok := parseID(fields[2]); ok {
			return gid, nil
		}
	}
	return 0, fmt.Errorf("look up group %q: no such group in %s", group, groupPath)
}

func accountLines(data []byte) func(func([]string) bool) {
	return func(yield func([]string) bool) {
		scanner := bufio.NewScanner(bytes.NewReader(data))
		scanner.Buffer(make([]byte, 0, 64<<10), accountsLimit)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			if !yield(strings.Split(line, ":")) {
				return
			}
		}
	}
}
