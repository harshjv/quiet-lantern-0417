//go:build linux

package workshop

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/harshjv/stationly/go/internal/protocol"
)

const (
	imageUID   = "1000"
	rangeSize  = 65537
	subIDCount = 65536
)

func BuildkitdTOML(ws protocol.DesiredWorkshop, registry string, insecure []string) []byte {
	var b strings.Builder
	fmt.Fprintf(&b, `[worker.oci]
  gc = true
  reservedSpace = "%dB"
  maxUsedSpace = "%dB"
  minFreeSpace = "%dB"
  max-parallelism = 4

[[worker.oci.gcpolicy]]
  keepDuration = "168h"
  filters = ["type==source.local", "type==exec.cachemount", "type==source.git.checkout"]

[[worker.oci.gcpolicy]]
  all = true
  maxUsedSpace = "%dB"

[registry."%s"]
  http = true
`, ws.Cache.ReservedBytes, ws.Cache.MaxUsedBytes, ws.Cache.MinFreeBytes, ws.Cache.MaxUsedBytes, registry)
	for _, host := range insecure {
		if host != registry {
			fmt.Fprintf(&b, "\n[registry.%q]\n  http = true\n", host)
		}
	}
	return []byte(b.String())
}

func remapPasswd(image []byte, base int) ([]byte, error) {
	return remap(image, base, func(f []string) bool { return len(f) >= 4 && f[0] == "user" && f[2] == imageUID }, 2, 3)
}

func remapGroup(image []byte, base int) ([]byte, error) {
	return remap(image, base, func(f []string) bool { return len(f) >= 3 && f[0] == "user" && f[2] == imageUID }, 2)
}

func remap(image []byte, base int, match func([]string) bool, columns ...int) ([]byte, error) {
	var out bytes.Buffer
	found := false
	sc := bufio.NewScanner(bytes.NewReader(image))
	for sc.Scan() {
		f := strings.Split(sc.Text(), ":")
		if match(f) {
			for _, c := range columns {
				f[c] = strconv.Itoa(base)
			}
			found = true
		}
		out.WriteString(strings.Join(f, ":") + "\n")
	}
	if !found {
		return nil, fmt.Errorf("the image has no user entry with id %s", imageUID)
	}
	return out.Bytes(), nil
}

func subordinate(base int) []byte {
	return fmt.Appendf(nil, "user:%d:%d\n", base+1, subIDCount)
}

type Overlap struct {
	Source string
	Entry  string
}

func HostOverlaps(base int) ([]Overlap, error) {
	var out []Overlap
	last := base + rangeSize - 1
	passwd, err := os.ReadFile("/etc/passwd")
	if err != nil {
		return nil, err
	}
	for _, line := range strings.Split(string(passwd), "\n") {
		f := strings.Split(line, ":")
		if len(f) < 3 {
			continue
		}
		if uid, err := strconv.Atoi(f[2]); err == nil && uid >= base && uid <= last {
			out = append(out, Overlap{Source: "/etc/passwd", Entry: f[0] + ":" + f[2]})
		}
	}
	for _, path := range []string{"/etc/subuid", "/etc/subgid"} {
		b, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(b), "\n") {
			f := strings.Split(line, ":")
			if len(f) != 3 {
				continue
			}
			start, err1 := strconv.Atoi(f[1])
			count, err2 := strconv.Atoi(f[2])
			if err1 == nil && err2 == nil && start <= last && start+count-1 >= base {
				out = append(out, Overlap{Source: path, Entry: line})
			}
		}
	}
	return out, nil
}
