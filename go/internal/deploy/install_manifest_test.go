//go:build linux

package deploy

import (
	"runtime"
	"slices"
	"strings"
	"testing"
)

func manifestFor(t *testing.T, platforms string) []byte {
	t.Helper()
	d := `"sha256:` + strings.Repeat("a", 64) + `"`
	plat := `{` + strings.ReplaceAll(platforms, "D", d) + `}`
	var b strings.Builder
	b.WriteString(`{"schema":1,"release":"0.1.0","channel":"stable","published_at":"2026-11-08T00:00:00Z","changelog":"","components":{`)
	b.WriteString(`"stationd":{"kind":"binary","version":"0.1.0","source":"ghcr.io/harshjv/stationly/release","digest":null,"platforms":` + plat + `}`)
	for _, name := range RequiredComponents[1:] {
		b.WriteString(`,"` + name + `":{"kind":"image","version":"1","source":"x","digest":` + d + `,"platforms":` + plat + `}`)
	}
	b.WriteString(`}}`)
	return []byte(b.String())
}

func TestAReleaseForTheHostPlatformOnlyPinsEveryComponent(t *testing.T) {
	m, err := ParseReleaseManifest(manifestFor(t, `"linux/`+runtime.GOARCH+`":D`))
	if err != nil {
		t.Fatal(err)
	}
	if missing := missingComponents(m); len(missing) != 0 {
		t.Fatalf("missing %v", missing)
	}
	if pinOf(m.Components["stationd"]) == "" {
		t.Fatal("no stationd pin for the host platform")
	}
}

func TestAReleaseWithoutTheHostPlatformIsMissingEveryComponent(t *testing.T) {
	other := "arm64"
	if runtime.GOARCH == "arm64" {
		other = "amd64"
	}
	m, err := ParseReleaseManifest(manifestFor(t, `"linux/`+other+`":D`))
	if err != nil {
		t.Fatal(err)
	}
	missing := missingComponents(m)
	if len(missing) != len(RequiredComponents) || !slices.Contains(missing, "stationd (linux/"+runtime.GOARCH+")") {
		t.Fatalf("missing %v", missing)
	}
	if pinOf(m.Components["stationd"]) != "" {
		t.Fatal("pinned stationd for a platform the release does not publish")
	}
}

func TestAnImageWithoutItsIndexDigestIsMissing(t *testing.T) {
	raw := strings.Replace(string(manifestFor(t, `"linux/`+runtime.GOARCH+`":D`)), `"dispatch":{"kind":"image","version":"1","source":"x","digest":"sha256:`+strings.Repeat("a", 64)+`"`, `"dispatch":{"kind":"image","version":"1","source":"x","digest":null`, 1)
	m, err := ParseReleaseManifest([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if missing := missingComponents(m); !slices.Equal(missing, []string{"dispatch (index digest)"}) {
		t.Fatalf("missing %v", missing)
	}
}
