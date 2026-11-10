//go:build linux

package workshop

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"strings"

	"github.com/harshjv/stationly/go/internal/docker"
)

const (
	profilePath  = "/etc/apparmor.d/" + docker.WorkshopAppArmorProfile
	abi4Path     = "/etc/apparmor.d/abi/4.0"
	enabledPath  = "/sys/module/apparmor/parameters/enabled"
	profilesPath = "/sys/kernel/security/apparmor/profiles"
)

const profileABI4 = `abi <abi/4.0>,
include <tunables/global>
profile stationly-workshop flags=(unconfined) {
  userns,
}
`

const profileABI3 = `abi <abi/3.0>,
profile stationly-workshop flags=(unconfined) {
}
`

func AppArmorEnabled() bool {
	b, err := os.ReadFile(enabledPath)
	return err == nil && strings.TrimSpace(string(b)) == "Y"
}

func ParserInstalled() bool {
	_, err := exec.LookPath("apparmor_parser")
	return err == nil
}

func ProfileBody() (string, string) {
	if _, err := os.Stat(abi4Path); err == nil {
		return profileABI4, "abi/4.0"
	}
	return profileABI3, "abi/3.0"
}

func ProfileLoaded() bool {
	b, err := os.ReadFile(profilesPath)
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, docker.WorkshopAppArmorProfile+" ") {
			return true
		}
	}
	return false
}

func EnsureProfile() (bool, string, error) {
	if !AppArmorEnabled() {
		return false, "", nil
	}
	body, abi := ProfileBody()
	if !ParserInstalled() {
		return true, abi, errors.New("AppArmor is enabled in the kernel but apparmor_parser is not installed; run apt-get install apparmor")
	}
	have, err := os.ReadFile(profilePath)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return true, abi, err
	}
	if string(have) == body && ProfileLoaded() {
		return true, abi, nil
	}
	if err := os.WriteFile(profilePath, []byte(body), 0o644); err != nil {
		return true, abi, err
	}
	var out bytes.Buffer
	cmd := exec.Command("apparmor_parser", "-r", profilePath)
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Run(); err != nil {
		return true, abi, fmt.Errorf("apparmor_parser -r %s: %w: %s", profilePath, err, strings.TrimSpace(out.String()))
	}
	if !ProfileLoaded() {
		return true, abi, fmt.Errorf("apparmor_parser loaded %s but %s does not list it", profilePath, profilesPath)
	}
	return true, abi, nil
}
