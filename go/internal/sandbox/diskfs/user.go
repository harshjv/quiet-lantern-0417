//go:build linux

package diskfs

import (
	"errors"
	"fmt"
	"strings"

	"golang.org/x/sys/unix"

	"github.com/harshjv/stationly/go/internal/imageuser"
)

const (
	passwdPath    = "/etc/passwd"
	groupPath     = "/etc/group"
	accountsLimit = 4 << 20
)

func LookupUser(root, spec string) (uid, gid int, err error) {
	passwd, err := readAccounts(root, passwdPath)
	if err != nil {
		return 0, 0, err
	}
	var group []byte
	if strings.Contains(spec, ":") {
		if group, err = readAccounts(root, groupPath); err != nil {
			return 0, 0, err
		}
	}
	return imageuser.Resolve(spec, passwd, group)
}

func readAccounts(root, path string) ([]byte, error) {
	data, err := ReadFile(root, path, accountsLimit)
	if errors.Is(err, unix.ENOENT) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	return data, nil
}
