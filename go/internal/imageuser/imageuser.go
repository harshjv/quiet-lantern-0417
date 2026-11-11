package imageuser

import (
	"bytes"
	"fmt"
	"strings"

	"github.com/moby/sys/user"
)

func Resolve(spec string, passwd, group []byte) (uid, gid int, err error) {
	name, groupName, hasGroup := strings.Cut(spec, ":")
	if spec != "" && (name == "" || hasGroup && groupName == "") {
		return 0, 0, fmt.Errorf("user %q is not one of user, uid, user:group or uid:gid", spec)
	}
	u, err := user.GetExecUser(spec, nil, bytes.NewReader(passwd), bytes.NewReader(group))
	if err != nil {
		return 0, 0, err
	}
	return u.Uid, u.Gid, nil
}
