package verify

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/harshjv/stationly/go/internal/protocol"
)

func testTrustJSON(t *testing.T, edit func(map[string]any)) []byte {
	t.Helper()
	doc := map[string]any{
		"name": "ci release",
		"identity": map[string]any{
			"san_regex": `^https://github\.com/example/fork/\.github/workflows/release\.yml@refs/tags/v[0-9.]+$`,
			"issuer":    "https://token.actions.githubusercontent.com",
		},
		"signatures_repository": "registry.example.test/signatures",
		"tuf_mirror":            "https://tuf.example.test",
		"releases_repository":   "registry.example.test/stationly/release",
		"tuf_root":              json.RawMessage(`{"signed":{}}`),
	}
	if edit != nil {
		edit(doc)
	}
	b, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestReleaseTrustNamesTheProductionIdentity(t *testing.T) {
	tr := ReleaseTrust()
	if !tr.Production {
		t.Error("release trust must be marked production")
	}
	if tr.ReleasesRepository != protocol.ReleaseRepository || tr.TUFMirror != protocol.TUFMirror || tr.SignaturesRepository != protocol.SignaturesRepository {
		t.Errorf("release locations: %+v", tr)
	}
	if tr.Identity.Issuer != "https://token.actions.githubusercontent.com" {
		t.Errorf("issuer %q", tr.Identity.Issuer)
	}
	if tr.Identity.Extensions.SourceRepositoryURI != "https://github.com/harshjv/quiet-lantern-0417" || tr.Identity.Extensions.RunnerEnvironment != "github-hosted" {
		t.Errorf("extensions %+v", tr.Identity.Extensions)
	}
	if len(tr.TUFRoot) == 0 || len(tr.TrustedRoot) == 0 {
		t.Error("embedded roots missing")
	}
}

func TestReleaseSANRegexAcceptsOnlyReleaseTags(t *testing.T) {
	tr := ReleaseTrust()
	good := []string{
		"https://github.com/harshjv/quiet-lantern-0417/.github/workflows/release.yml@refs/tags/v1.2.3",
		"https://github.com/harshjv/quiet-lantern-0417/.github/workflows/release.yml@refs/tags/v0.1.0-rc.1",
	}
	bad := []string{
		"https://github.com/harshjv/quiet-lantern-0417/.github/workflows/release.yml@refs/heads/main",
		"https://github.com/harshjv/quiet-lantern-0417/.github/workflows/ci.yml@refs/tags/v1.2.3",
		"https://github.com/someone/stationly/.github/workflows/release.yml@refs/tags/v1.2.3",
		"https://github.com/harshjv/quiet-lantern-0417/.github/workflows/release.yml@refs/tags/v1.2",
		"https://github.com/harshjv/quiet-lantern-0417/.github/workflows/release.yml@refs/tags/v1.2.3/extra",
	}
	if _, err := tr.certificateIdentity(); err != nil {
		t.Fatal(err)
	}
	re := mustRegexp(t, tr.Identity.SANRegex)
	for _, s := range good {
		if !re.MatchString(s) {
			t.Errorf("rejects %s", s)
		}
	}
	for _, s := range bad {
		if re.MatchString(s) {
			t.Errorf("accepts %s", s)
		}
	}
}

func TestLoadTrustWithoutPathIsTheReleaseTrust(t *testing.T) {
	tr, err := LoadTrust("")
	if err != nil {
		t.Fatal(err)
	}
	if !tr.Production {
		t.Error("empty path must give the release trust")
	}
}

func TestLoadTrustReadsAFileAndResolvesRelativeRoots(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "tuf.json"), []byte(`{"signed":{"v":1}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "root.json"), []byte(`{"root":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	body := testTrustJSON(t, func(d map[string]any) {
		delete(d, "tuf_root")
		d["tuf_root_path"] = "tuf.json"
		d["trusted_root_path"] = "root.json"
	})
	path := filepath.Join(dir, "trust.json")
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	tr, err := LoadTrust(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(tr.TUFRoot) != `{"signed":{"v":1}}` || string(tr.TrustedRoot) != `{"root":true}` {
		t.Errorf("roots: %s %s", tr.TUFRoot, tr.TrustedRoot)
	}
	if tr.Production {
		t.Error("a trust file is never production")
	}
}

func TestLoadTrustReportsAMissingFile(t *testing.T) {
	if _, err := LoadTrust(filepath.Join(t.TempDir(), "absent.json")); err == nil {
		t.Fatal("expected an error")
	}
}

func TestTestTrustKeepsItsOwnReleaseLocations(t *testing.T) {
	tr, err := ParseTestTrust(testTrustJSON(t, nil), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if tr.ReleasesRepository != "registry.example.test/stationly/release" || tr.TUFMirror != "https://tuf.example.test" || tr.SignaturesRepository != "registry.example.test/signatures" {
		t.Errorf("locations: %+v", tr)
	}
	if tr.Production {
		t.Error("test trust must not be production")
	}
	if !bytes.Equal(tr.TrustedRoot, embeddedTrustedRoot) {
		t.Error("trusted root defaults to the embedded one")
	}
}

func TestTestTrustRejectsEveryProductionLocation(t *testing.T) {
	cases := map[string]string{
		"releases_repository":   protocol.ReleaseRepository,
		"tuf_mirror":            protocol.TUFMirror,
		"signatures_repository": protocol.SignaturesRepository,
	}
	for field, value := range cases {
		t.Run(field, func(t *testing.T) {
			_, err := ParseTestTrust(testTrustJSON(t, func(d map[string]any) { d[field] = value }), t.TempDir())
			if err == nil || !strings.Contains(err.Error(), "production release locations") {
				t.Fatalf("got %v", err)
			}
		})
	}
}

func TestTestTrustInheritsNothingFromProduction(t *testing.T) {
	for _, field := range []string{"name", "signatures_repository", "tuf_mirror", "releases_repository", "tuf_root"} {
		t.Run(field, func(t *testing.T) {
			_, err := ParseTestTrust(testTrustJSON(t, func(d map[string]any) { delete(d, field) }), t.TempDir())
			if err == nil || !strings.Contains(err.Error(), "inherits nothing") {
				t.Fatalf("got %v", err)
			}
		})
	}
}

func TestTestTrustRequiresTheIdentity(t *testing.T) {
	for _, field := range []string{"san_regex", "issuer"} {
		t.Run(field, func(t *testing.T) {
			_, err := ParseTestTrust(testTrustJSON(t, func(d map[string]any) {
				delete(d["identity"].(map[string]any), field)
			}), t.TempDir())
			if err == nil || !strings.Contains(err.Error(), "identity."+field) {
				t.Fatalf("got %v", err)
			}
		})
	}
}

func TestTestTrustListsEveryMissingFieldSorted(t *testing.T) {
	_, err := ParseTestTrust([]byte(`{}`), t.TempDir())
	if err == nil {
		t.Fatal("expected an error")
	}
	want := "identity.issuer, identity.san_regex, name, releases_repository, signatures_repository, tuf_mirror, tuf_root"
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("got %v", err)
	}
}

func TestTestTrustRejectsAnInvalidSANRegex(t *testing.T) {
	_, err := ParseTestTrust(testTrustJSON(t, func(d map[string]any) { d["identity"].(map[string]any)["san_regex"] = "(" }), t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "identity.san_regex") {
		t.Fatalf("got %v", err)
	}
}

func TestTestTrustRejectsMalformedJSON(t *testing.T) {
	if _, err := ParseTestTrust([]byte(`{`), t.TempDir()); err == nil {
		t.Fatal("expected an error")
	}
}

func TestTestTrustReadsInlineRootsOverPaths(t *testing.T) {
	tr, err := ParseTestTrust(testTrustJSON(t, func(d map[string]any) {
		d["trusted_root"] = json.RawMessage(`{"inline":true}`)
		d["trusted_root_path"] = "ignored.json"
	}), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if string(tr.TrustedRoot) != `{"inline":true}` {
		t.Errorf("trusted root %s", tr.TrustedRoot)
	}
}

func TestProductionTrustIsNeverMarshalled(t *testing.T) {
	if _, err := ReleaseTrust().MarshalTestTrust(); err == nil {
		t.Fatal("the production identity must not be written to a trust file")
	}
}

func TestTestTrustRoundTripsThroughItsFile(t *testing.T) {
	want, err := ParseTestTrust(testTrustJSON(t, func(d map[string]any) {
		d["sources"] = map[string]string{"coupler_image": "registry.example.test/pause"}
		d["insecure_registries"] = []string{"registry.example.test"}
	}), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	b, err := want.MarshalTestTrust()
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseTestTrust(b, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != want.Name || got.Identity.SANRegex != want.Identity.SANRegex || got.ReleasesRepository != want.ReleasesRepository ||
		compact(t, got.TUFRoot) != compact(t, want.TUFRoot) || got.Sources["coupler_image"] != "registry.example.test/pause" ||
		len(got.InsecureRegistries) != 1 {
		t.Fatalf("round trip lost data in trust %q", got.Name)
	}
}

func TestMarshalledTrustOmitsTheEmbeddedTrustedRoot(t *testing.T) {
	tr, err := ParseTestTrust(testTrustJSON(t, nil), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	b, err := tr.MarshalTestTrust()
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatal(err)
	}
	if _, ok := doc["trusted_root"]; ok {
		t.Error("the embedded trusted root must not be copied into the file")
	}
	if _, ok := doc["tuf_root"]; !ok {
		t.Error("tuf_root must be written")
	}
}

func TestSourceFallsBackWhenNoOverrideIsSet(t *testing.T) {
	tr := Trust{Sources: map[string]string{"coupler_image": "override", "empty": ""}}
	cases := map[string]string{"coupler_image": "override", "empty": "fallback", "absent": "fallback"}
	for component, want := range cases {
		if got := tr.Source(component, "fallback"); got != want {
			t.Errorf("%s: %s", component, got)
		}
	}
}

func TestInsecureAppliesOnlyToListedHosts(t *testing.T) {
	tr := Trust{InsecureRegistries: []string{"localhost:5000"}}
	if !tr.Insecure("localhost:5000") || tr.Insecure("ghcr.io") {
		t.Error("insecure host match is wrong")
	}
}

func TestSignaturesHostIsTheRepositoryHost(t *testing.T) {
	if got := (Trust{SignaturesRepository: protocol.SignaturesRepository}).signaturesHost(); got != "ghcr.io" {
		t.Errorf("host %q", got)
	}
}

func mustRegexp(t *testing.T, expr string) *regexp.Regexp {
	t.Helper()
	re, err := regexp.Compile(expr)
	if err != nil {
		t.Fatal(err)
	}
	return re
}

func compact(t *testing.T, raw []byte) string {
	t.Helper()
	var out bytes.Buffer
	if err := json.Compact(&out, raw); err != nil {
		t.Fatal(err)
	}
	return out.String()
}
