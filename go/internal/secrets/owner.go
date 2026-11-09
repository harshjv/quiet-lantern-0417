package secrets

import (
	"bufio"
	"bytes"
	"fmt"
	"strconv"
	"strings"
)

type Owner struct {
	UID int `json:"uid"`
	GID int `json:"gid"`
}

func parseDB(content []byte) map[string][]string {
	out := map[string][]string{}
	sc := bufio.NewScanner(bytes.NewReader(content))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Split(line, ":")
		if len(fields) >= 3 {
			out[fields[0]] = fields
		}
	}
	return out
}

func ResolveOwner(user string, passwd, group []byte) (Owner, error) {
	if user == "" {
		return Owner{}, nil
	}
	name, groupName, hasGroup := strings.Cut(user, ":")
	users := parseDB(passwd)
	o := Owner{}
	if uid, err := strconv.Atoi(name); err == nil {
		o.UID = uid
		for _, f := range users {
			if f[2] == name && len(f) >= 4 {
				o.GID, _ = strconv.Atoi(f[3])
				break
			}
		}
	} else {
		f, ok := users[name]
		if !ok || len(f) < 4 {
			return Owner{}, fmt.Errorf("user %q is not in the image's /etc/passwd", name)
		}
		o.UID, _ = strconv.Atoi(f[2])
		o.GID, _ = strconv.Atoi(f[3])
	}
	if hasGroup {
		if gid, err := strconv.Atoi(groupName); err == nil {
			o.GID = gid
		} else {
			f, ok := parseDB(group)[groupName]
			if !ok {
				return Owner{}, fmt.Errorf("group %q is not in the image's /etc/group", groupName)
			}
			o.GID, _ = strconv.Atoi(f[2])
		}
	}
	return o, nil
}
