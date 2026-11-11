package imageuser

import (
	"bytes"
	"fmt"
	"strconv"
	"strings"

	"github.com/moby/sys/user"
)

const (
	maxGid        = 1<<32 - 2
	maxGroupLine  = 1 << 16
	groupFieldGid = 2
)

func Resolve(spec string, passwd, group []byte) (uid, gid int, groups []int, err error) {
	name, groupName, hasGroup := strings.Cut(spec, ":")
	if spec != "" && (name == "" || hasGroup && groupName == "") {
		return 0, 0, nil, fmt.Errorf("user %q is not one of user, uid, user:group or uid:gid", spec)
	}
	u, err := user.GetExecUser(spec, nil, bytes.NewReader(passwd), bytes.NewReader(validGroups(group)))
	if err != nil {
		return 0, 0, nil, err
	}
	return u.Uid, u.Gid, u.Sgids, nil
}

func validGroups(group []byte) []byte {
	var kept bytes.Buffer
	for _, line := range bytes.Split(group, []byte("\n")) {
		if validGroupLine(line) {
			kept.Write(line)
			kept.WriteByte('\n')
		}
	}
	return kept.Bytes()
}

func validGroupLine(line []byte) bool {
	trimmed := bytes.TrimSpace(line)
	if len(trimmed) == 0 || trimmed[0] == '#' {
		return false
	}
	if len(trimmed) > maxGroupLine {
		return false
	}
	fields := bytes.Split(trimmed, []byte(":"))
	if len(fields) <= groupFieldGid {
		return false
	}
	gid, err := strconv.ParseUint(string(fields[groupFieldGid]), 10, 32)
	return err == nil && gid <= maxGid
}
