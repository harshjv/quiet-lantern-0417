package release

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/google/go-containerregistry/pkg/name"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/remote/transport"
	"github.com/google/go-containerregistry/pkg/v1/types"
	"github.com/harshjv/stationly/go/internal/protocol"
)

const (
	TitleAnnotation = "org.opencontainers.image.title"
	ManifestFile    = "release-manifest.json"
	BundleSuffix    = ".sigstore.json"
	MaxManifest     = 4 << 20
	MaxBundle       = 1 << 20
	maxArtifact     = 1 << 20
)

var (
	ErrNotFound = errors.New("not found")
	versionRe   = regexp.MustCompile(`^v?([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?)$`)
)

type Source interface {
	Read(ctx context.Context, file string, limit int64) ([]byte, error)
	Location() string
}

func Version(s string) (string, bool) {
	m := versionRe.FindStringSubmatch(s)
	if m == nil {
		return "", false
	}
	return m[1], true
}

func Tag(version string) string { return "v" + version }

type Dir string

func (d Dir) Location() string { return string(d) }

func (d Dir) Read(_ context.Context, file string, limit int64) ([]byte, error) {
	f, err := os.Open(filepath.Join(string(d), file))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("%s: %w", filepath.Join(string(d), file), ErrNotFound)
		}
		return nil, err
	}
	defer f.Close()
	return readCapped(f, file, limit)
}

type Remote struct {
	repo     name.Repository
	version  string
	digest   string
	files    map[string]v1.Descriptor
	location string
}

func Open(ctx context.Context, repository string, insecure bool, version string) (*Remote, error) {
	var nopts []name.Option
	if insecure {
		nopts = append(nopts, name.Insecure)
	}
	repo, err := name.NewRepository(repository, nopts...)
	if err != nil {
		return nil, fmt.Errorf("release repository %q: %w", repository, err)
	}
	r := &Remote{
		repo:    repo,
		version: version,
		files:   map[string]v1.Descriptor{},
	}
	tag := repo.Tag(Tag(version))
	desc, err := remote.Get(tag, remote.WithContext(ctx))
	if err != nil {
		var te *transport.Error
		if errors.As(err, &te) && (te.StatusCode == http.StatusNotFound || hasCode(te, transport.ManifestUnknownErrorCode, transport.NameUnknownErrorCode)) {
			return nil, fmt.Errorf("release %s: %s has no tag %s: %w", version, repo, Tag(version), ErrNotFound)
		}
		return nil, fmt.Errorf("release %s: GET %s: %w", version, tag, err)
	}
	if desc.MediaType != types.OCIManifestSchema1 {
		return nil, fmt.Errorf("release %s: %s is a %s, not an OCI artifact manifest", version, tag, desc.MediaType)
	}
	if len(desc.Manifest) > maxArtifact {
		return nil, fmt.Errorf("release %s: the artifact manifest is above %d bytes", version, maxArtifact)
	}
	m, err := v1.ParseManifest(bytes.NewReader(desc.Manifest))
	if err != nil {
		return nil, fmt.Errorf("release %s: artifact manifest: %w", version, err)
	}
	if m.ArtifactType != protocol.MediaTypeReleaseArtifact && string(m.Config.MediaType) != protocol.MediaTypeReleaseArtifact {
		return nil, fmt.Errorf("release %s: %s has artifact type %q, not %s", version, tag, m.ArtifactType, protocol.MediaTypeReleaseArtifact)
	}
	for _, l := range m.Layers {
		title := l.Annotations[TitleAnnotation]
		if title == "" || strings.ContainsAny(title, "/\\") {
			continue
		}
		if _, dup := r.files[title]; dup {
			return nil, fmt.Errorf("release %s: the artifact lists %s twice", version, title)
		}
		r.files[title] = l
	}
	r.digest = desc.Digest.String()
	r.location = tag.String() + "@" + r.digest
	return r, nil
}

func hasCode(te *transport.Error, codes ...transport.ErrorCode) bool {
	for _, d := range te.Errors {
		for _, c := range codes {
			if d.Code == c {
				return true
			}
		}
	}
	return false
}

func (r *Remote) Location() string { return r.location }

func (r *Remote) Digest() string { return r.digest }

func (r *Remote) Files() []string {
	out := make([]string, 0, len(r.files))
	for f := range r.files {
		out = append(out, f)
	}
	return out
}

func (r *Remote) Read(ctx context.Context, file string, limit int64) ([]byte, error) {
	d, ok := r.files[file]
	if !ok {
		return nil, fmt.Errorf("release %s (%s) has no file %s: %w", r.version, r.location, file, ErrNotFound)
	}
	if d.Size > limit {
		return nil, fmt.Errorf("%s in release %s is %d bytes, above %d", file, r.version, d.Size, limit)
	}
	layer, err := remote.Layer(r.repo.Digest(d.Digest.String()), remote.WithContext(ctx))
	if err != nil {
		return nil, err
	}
	rc, err := layer.Compressed()
	if err != nil {
		return nil, fmt.Errorf("GET %s blob %s: %w", file, d.Digest, err)
	}
	defer rc.Close()
	b, err := readCapped(rc, file, limit)
	if err != nil {
		return nil, fmt.Errorf("GET %s blob %s: %w", file, d.Digest, err)
	}
	if got := DigestOf(b); got != d.Digest.String() {
		return nil, fmt.Errorf("%s in release %s is %s, but the artifact lists %s", file, r.version, got, d.Digest)
	}
	return b, nil
}

func readCapped(rd io.Reader, file string, limit int64) ([]byte, error) {
	b, err := io.ReadAll(io.LimitReader(rd, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("%s is above %d bytes", file, limit)
	}
	return b, nil
}

func DigestOf(b []byte) string {
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}
