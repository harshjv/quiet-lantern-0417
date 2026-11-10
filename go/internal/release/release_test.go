package release_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/registry"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/static"
	"github.com/google/go-containerregistry/pkg/v1/types"
	"github.com/sigstore/sigstore-go/pkg/fulcio/certificate"

	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/release"
	"github.com/harshjv/stationly/go/internal/verify"
)

type rawManifest struct {
	body      []byte
	mediaType types.MediaType
}

func (m rawManifest) RawManifest() ([]byte, error)        { return m.body, nil }
func (m rawManifest) MediaType() (types.MediaType, error) { return m.mediaType, nil }

type descriptor struct {
	MediaType   string            `json:"mediaType"`
	Digest      string            `json:"digest"`
	Size        int64             `json:"size"`
	Annotations map[string]string `json:"annotations,omitempty"`
}

type testRegistry struct {
	server *httptest.Server
	host   string
	tamper map[string]bool
}

func newRegistry(t *testing.T) *testRegistry {
	t.Helper()
	r := &testRegistry{tamper: map[string]bool{}}
	inner := registry.New(registry.Logger(log.New(io.Discard, "", 0)))
	r.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method == http.MethodGet && strings.Contains(req.URL.Path, "/blobs/") && r.tamper[req.URL.Path[strings.LastIndex(req.URL.Path, "/")+1:]] {
			rec := httptest.NewRecorder()
			inner.ServeHTTP(rec, req)
			body := append(rec.Body.Bytes(), 'x')
			w.WriteHeader(rec.Code)
			w.Write(body)
			return
		}
		inner.ServeHTTP(w, req)
	}))
	t.Cleanup(r.server.Close)
	r.host = strings.TrimPrefix(r.server.URL, "http://")
	return r
}

func (r *testRegistry) repo(t *testing.T) name.Repository {
	t.Helper()
	repo, err := name.NewRepository(r.host+"/stationly/release", name.Insecure)
	if err != nil {
		t.Fatal(err)
	}
	return repo
}

func digestOf(b []byte) string {
	return fmt.Sprintf("sha256:%x", sha256.Sum256(b))
}

func (r *testRegistry) publish(t *testing.T, version, artifactType string, files map[string][]byte) string {
	t.Helper()
	repo := r.repo(t)
	config := []byte("{}")
	if err := remote.WriteLayer(repo, static.NewLayer(config, "application/vnd.oci.empty.v1+json")); err != nil {
		t.Fatal(err)
	}
	layers := []descriptor{}
	for title, body := range files {
		if err := remote.WriteLayer(repo, static.NewLayer(body, "application/octet-stream")); err != nil {
			t.Fatal(err)
		}
		layers = append(layers, descriptor{MediaType: "application/octet-stream", Digest: digestOf(body), Size: int64(len(body)), Annotations: map[string]string{release.TitleAnnotation: title}})
	}
	m := map[string]any{
		"schemaVersion": 2,
		"mediaType":     string(types.OCIManifestSchema1),
		"artifactType":  artifactType,
		"config":        descriptor{MediaType: "application/vnd.oci.empty.v1+json", Digest: digestOf(config), Size: int64(len(config))},
		"layers":        layers,
	}
	body, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	if err := remote.Put(repo.Tag(release.Tag(version)), rawManifest{body: body, mediaType: types.OCIManifestSchema1}); err != nil {
		t.Fatal(err)
	}
	return digestOf(body)
}

func fixture(t *testing.T, file string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", file))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func fixtureFiles(t *testing.T) map[string][]byte {
	files := map[string][]byte{}
	for _, f := range []string{"release-manifest.json", "release-manifest.json.sigstore.json", "stationd-linux-amd64", "stationd-linux-amd64.sigstore.json"} {
		files[f] = fixture(t, f)
	}
	return files
}

func testVerifier(t *testing.T) *verify.Verifier {
	t.Helper()
	trust := verify.Trust{
		Name: "release package test identity",
		Identity: verify.Identity{
			SANRegex: `^https://github\.com/stationly-test/stationly/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$`,
			Issuer:   "https://token.actions.githubusercontent.com",
			Extensions: certificate.Extensions{
				SourceRepositoryURI:             "https://github.com/stationly-test/stationly",
				SourceRepositoryIdentifier:      "100001",
				SourceRepositoryOwnerIdentifier: "200002",
				RunnerEnvironment:               "github-hosted",
			},
		},
		TrustedRoot: fixture(t, "trusted_root.json"),
	}
	v, err := verify.New(slog.New(slog.NewTextHandler(io.Discard, nil)), trust, filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func open(t *testing.T, r *testRegistry, version string) *release.Remote {
	t.Helper()
	src, err := release.Open(context.Background(), r.host+"/stationly/release", true, version)
	if err != nil {
		t.Fatal(err)
	}
	return src
}

func TestOpenReadsTheArtifactTaggedWithTheVersion(t *testing.T) {
	r := newRegistry(t)
	files := fixtureFiles(t)
	digest := r.publish(t, "0.1.0-test.1", protocol.MediaTypeReleaseArtifact, files)
	src := open(t, r, "0.1.0-test.1")
	if src.Digest() != digest {
		t.Errorf("digest %s, want %s", src.Digest(), digest)
	}
	if want := r.host + "/stationly/release:v0.1.0-test.1@" + digest; src.Location() != want {
		t.Errorf("location %s, want %s", src.Location(), want)
	}
	for f, want := range files {
		got, err := src.Read(context.Background(), f, 1<<20)
		if err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		if !bytes.Equal(got, want) {
			t.Errorf("%s differs", f)
		}
	}
}

func TestOpenAnUnknownVersionIsNotFound(t *testing.T) {
	r := newRegistry(t)
	_, err := release.Open(context.Background(), r.host+"/stationly/release", true, "9.9.9")
	if !errors.Is(err, release.ErrNotFound) {
		t.Fatalf("err %v, want ErrNotFound", err)
	}
}

func TestReadAFileTheArtifactLacksIsNotFound(t *testing.T) {
	r := newRegistry(t)
	r.publish(t, "0.1.0", protocol.MediaTypeReleaseArtifact, map[string][]byte{"release-manifest.json": []byte("{}")})
	_, err := open(t, r, "0.1.0").Read(context.Background(), "stationd-linux-amd64", 1<<20)
	if !errors.Is(err, release.ErrNotFound) {
		t.Fatalf("err %v, want ErrNotFound", err)
	}
}

func TestOpenRefusesAnotherArtifactType(t *testing.T) {
	r := newRegistry(t)
	r.publish(t, "0.1.0", "application/vnd.example.other", map[string][]byte{"release-manifest.json": []byte("{}")})
	_, err := release.Open(context.Background(), r.host+"/stationly/release", true, "0.1.0")
	if err == nil || !strings.Contains(err.Error(), "artifact type") {
		t.Fatalf("err %v, want an artifact type refusal", err)
	}
}

func TestOpenRefusesAnImageIndexUnderTheTag(t *testing.T) {
	r := newRegistry(t)
	body := []byte(`{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[]}`)
	if err := remote.Put(r.repo(t).Tag("v0.1.0"), rawManifest{body: body, mediaType: types.OCIImageIndex}); err != nil {
		t.Fatal(err)
	}
	_, err := release.Open(context.Background(), r.host+"/stationly/release", true, "0.1.0")
	if err == nil || !strings.Contains(err.Error(), "not an OCI artifact manifest") {
		t.Fatalf("err %v, want a refusal of the index", err)
	}
}

func TestReadRefusesABlobThatDoesNotMatchItsDigest(t *testing.T) {
	r := newRegistry(t)
	body := []byte("stationd")
	r.publish(t, "0.1.0", protocol.MediaTypeReleaseArtifact, map[string][]byte{"stationd-linux-amd64": body})
	r.tamper[digestOf(body)] = true
	got, err := open(t, r, "0.1.0").Read(context.Background(), "stationd-linux-amd64", 1<<20)
	if err == nil {
		t.Fatalf("read %q from a tampered blob without an error", got)
	}
}

func TestReadRefusesAFileAboveTheLimitBeforeFetchingIt(t *testing.T) {
	r := newRegistry(t)
	r.publish(t, "0.1.0", protocol.MediaTypeReleaseArtifact, map[string][]byte{"stationd-linux-amd64": bytes.Repeat([]byte("a"), 64)})
	_, err := open(t, r, "0.1.0").Read(context.Background(), "stationd-linux-amd64", 32)
	if err == nil || !strings.Contains(err.Error(), "above 32") {
		t.Fatalf("err %v, want a size refusal", err)
	}
}

func TestTheFetchedManifestAndBinaryVerifyAgainstTheIdentity(t *testing.T) {
	r := newRegistry(t)
	r.publish(t, "0.1.0-test.1", protocol.MediaTypeReleaseArtifact, fixtureFiles(t))
	src := open(t, r, "0.1.0-test.1")
	v := testVerifier(t)
	for _, f := range []string{"release-manifest.json", "stationd-linux-amd64"} {
		data, err := src.Read(context.Background(), f, release.MaxManifest)
		if err != nil {
			t.Fatal(err)
		}
		bundle, err := src.Read(context.Background(), f+release.BundleSuffix, release.MaxBundle)
		if err != nil {
			t.Fatal(err)
		}
		san, err := v.Blob(data, bundle)
		if err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		if !strings.HasSuffix(san, "/.github/workflows/release.yml@refs/tags/v0.1.0-test.1") {
			t.Errorf("%s signed by %s", f, san)
		}
	}
}

func TestAManifestSignedByAnotherIdentityIsRefused(t *testing.T) {
	r := newRegistry(t)
	files := fixtureFiles(t)
	files["release-manifest.json.sigstore.json"] = fixture(t, "release-manifest.json.wrong.sigstore.json")
	r.publish(t, "0.1.0-test.1", protocol.MediaTypeReleaseArtifact, files)
	src := open(t, r, "0.1.0-test.1")
	data, _ := src.Read(context.Background(), "release-manifest.json", release.MaxManifest)
	bundle, _ := src.Read(context.Background(), "release-manifest.json.sigstore.json", release.MaxBundle)
	if san, err := testVerifier(t).Blob(data, bundle); err == nil {
		t.Fatalf("verified a manifest signed by %s", san)
	}
}

func TestAManifestChangedAfterSigningIsRefused(t *testing.T) {
	r := newRegistry(t)
	files := fixtureFiles(t)
	files["release-manifest.json"] = bytes.Replace(files["release-manifest.json"], []byte(`"edge"`), []byte(`"stable"`), 1)
	r.publish(t, "0.1.0-test.1", protocol.MediaTypeReleaseArtifact, files)
	src := open(t, r, "0.1.0-test.1")
	data, _ := src.Read(context.Background(), "release-manifest.json", release.MaxManifest)
	bundle, _ := src.Read(context.Background(), "release-manifest.json.sigstore.json", release.MaxBundle)
	if _, err := testVerifier(t).Blob(data, bundle); err == nil {
		t.Fatal("verified a manifest changed after it was signed")
	}
}

func TestDirReadsReleaseFilesFromADirectory(t *testing.T) {
	d := release.Dir("testdata")
	b, err := d.Read(context.Background(), "release-manifest.json", release.MaxManifest)
	if err != nil || !bytes.Equal(b, fixture(t, "release-manifest.json")) {
		t.Fatalf("read %q, %v", b, err)
	}
	if _, err := d.Read(context.Background(), "runsc-linux-amd64.tar.zst", 1<<20); !errors.Is(err, release.ErrNotFound) {
		t.Fatalf("err %v, want ErrNotFound", err)
	}
	if _, err := d.Read(context.Background(), "stationd-linux-amd64", 4); err == nil {
		t.Fatal("read a file above the limit")
	}
}

func TestVersionAcceptsAReleaseVersionWithOrWithoutTheTagPrefix(t *testing.T) {
	for in, want := range map[string]string{"0.1.0": "0.1.0", "v0.1.0": "0.1.0", "v0.1.0-test.2": "0.1.0-test.2"} {
		if got, ok := release.Version(in); !ok || got != want {
			t.Errorf("Version(%q) = %q, %v", in, got, ok)
		}
	}
	for _, in := range []string{"", "latest", "0.1", "http://example.test/releases/v0.1.0", "v0.1.0/../x"} {
		if _, ok := release.Version(in); ok {
			t.Errorf("Version(%q) accepted", in)
		}
	}
}
