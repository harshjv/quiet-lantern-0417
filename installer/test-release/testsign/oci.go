package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/google/go-containerregistry/pkg/name"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/static"
	"github.com/google/go-containerregistry/pkg/v1/types"
)

const (
	emptyConfigMediaType = "application/vnd.oci.empty.v1+json"
	plausibleIndexSize   = 1609
)

var publicRegistries = []string{"ghcr.io", "docker.io", "index.docker.io", "registry-1.docker.io", "quay.io", "gcr.io", "registry.k8s.io", "public.ecr.aws", "mcr.microsoft.com"}

type rawManifest struct {
	body      []byte
	mediaType types.MediaType
}

func (m rawManifest) RawManifest() ([]byte, error)        { return m.body, nil }
func (m rawManifest) MediaType() (types.MediaType, error) { return m.mediaType, nil }

type ociDescriptor struct {
	MediaType    string            `json:"mediaType"`
	ArtifactType string            `json:"artifactType,omitempty"`
	Digest       string            `json:"digest"`
	Size         int64             `json:"size"`
	Annotations  map[string]string `json:"annotations,omitempty"`
}

type ociManifest struct {
	SchemaVersion int               `json:"schemaVersion"`
	MediaType     string            `json:"mediaType"`
	ArtifactType  string            `json:"artifactType"`
	Config        ociDescriptor     `json:"config"`
	Layers        []ociDescriptor   `json:"layers"`
	Subject       *ociDescriptor    `json:"subject,omitempty"`
	Annotations   map[string]string `json:"annotations,omitempty"`
}

type pushResult struct {
	subject      ociDescriptor
	manifest     string
	referrersAPI string
	listed       bool
}

func repository(repo string, insecure bool) (name.Repository, error) {
	var opts []name.Option
	if insecure {
		opts = append(opts, name.Insecure)
	}
	r, err := name.NewRepository(repo, opts...)
	if err != nil {
		return r, err
	}
	return r, nil
}

func refusePublic(r name.Repository) error {
	host := r.RegistryStr()
	for _, p := range publicRegistries {
		if host == p || strings.HasSuffix(host, "."+p) || strings.HasSuffix(host, ".pkg.dev") {
			return fmt.Errorf("refusing to push to public registry %s", host)
		}
	}
	return nil
}

func blobDescriptor(mediaType string, data []byte) ociDescriptor {
	sum := sha256.Sum256(data)
	return ociDescriptor{MediaType: mediaType, Digest: fmt.Sprintf("sha256:%x", sum), Size: int64(len(data))}
}

func subjectDescriptor(subject, subjectRef string) (ociDescriptor, error) {
	d := ociDescriptor{MediaType: string(types.OCIImageIndex), Digest: subject, Size: plausibleIndexSize}
	if subjectRef == "" {
		return d, nil
	}
	ref, err := name.ParseReference(subjectRef)
	if err != nil {
		return d, err
	}
	head, err := remote.Head(ref)
	if err != nil {
		return d, fmt.Errorf("HEAD %s: %w", subjectRef, err)
	}
	if head.Digest.String() == subject {
		d.MediaType = string(head.MediaType)
		d.Size = head.Size
	}
	return d, nil
}

func pushBundle(repo string, insecure bool, subject, subjectRef string, bundleJSON []byte) (*pushResult, error) {
	r, err := repository(repo, insecure)
	if err != nil {
		return nil, err
	}
	if err := refusePublic(r); err != nil {
		return nil, err
	}
	subj, err := subjectDescriptor(subject, subjectRef)
	if err != nil {
		return nil, err
	}
	config := []byte("{}")
	if err := remote.WriteLayer(r, static.NewLayer(config, emptyConfigMediaType)); err != nil {
		return nil, fmt.Errorf("push config blob: %w", err)
	}
	if err := remote.WriteLayer(r, static.NewLayer(bundleJSON, bundleMediaType)); err != nil {
		return nil, fmt.Errorf("push bundle blob: %w", err)
	}
	m := ociManifest{
		SchemaVersion: 2,
		MediaType:     string(types.OCIManifestSchema1),
		ArtifactType:  bundleMediaType,
		Config:        blobDescriptor(emptyConfigMediaType, config),
		Layers:        []ociDescriptor{blobDescriptor(bundleMediaType, bundleJSON)},
		Subject:       &subj,
		Annotations: map[string]string{
			"dev.sigstore.bundle.content":       "dsse-envelope",
			"dev.sigstore.bundle.predicateType": cosignPredicateType,
			"org.opencontainers.image.created":  time.Now().UTC().Format(time.RFC3339),
		},
	}
	body, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(body)
	manifestDigest := fmt.Sprintf("sha256:%x", sum)
	if err := remote.Put(r.Digest(manifestDigest), rawManifest{body: body, mediaType: types.OCIManifestSchema1}); err != nil {
		return nil, fmt.Errorf("push manifest: %w", err)
	}
	res := &pushResult{subject: subj, manifest: r.String() + "@" + manifestDigest, referrersAPI: probeReferrersAPI(r, subject)}
	idx, err := remote.Referrers(r.Digest(subject))
	if err != nil {
		return nil, fmt.Errorf("list referrers after push: %w", err)
	}
	im, err := idx.IndexManifest()
	if err != nil {
		return nil, err
	}
	for _, d := range im.Manifests {
		if d.Digest.String() == manifestDigest && d.ArtifactType == bundleMediaType {
			res.listed = true
		}
	}
	if !res.listed {
		return res, fmt.Errorf("pushed %s but referrers of %s do not list it", manifestDigest, subject)
	}
	return res, nil
}

func probeReferrersAPI(r name.Repository, subject string) string {
	u := fmt.Sprintf("%s://%s/v2/%s/referrers/%s", r.Scheme(), r.RegistryStr(), r.RepositoryStr(), subject)
	req, _ := http.NewRequest(http.MethodGet, u, nil)
	req.Header.Set("Accept", string(types.OCIImageIndex))
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return "unknown: " + err.Error()
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK && resp.Header.Get("Content-Type") == string(types.OCIImageIndex) {
		return "supported"
	}
	return fmt.Sprintf("unsupported (HTTP %d), using sha256-<hex> tag fallback", resp.StatusCode)
}

type fetchedBundle struct {
	manifest string
	json     []byte
}

func fetchBundles(repo string, insecure bool, digest string) ([]fetchedBundle, error) {
	r, err := repository(repo, insecure)
	if err != nil {
		return nil, err
	}
	idx, err := remote.Referrers(r.Digest(digest))
	if err != nil {
		return nil, fmt.Errorf("list referrers: %w", err)
	}
	im, err := idx.IndexManifest()
	if err != nil {
		return nil, err
	}
	var out []fetchedBundle
	for _, d := range im.Manifests {
		if d.ArtifactType != bundleMediaType {
			continue
		}
		b, err := fetchBundleLayer(r, d)
		if err != nil {
			return nil, err
		}
		out = append(out, fetchedBundle{manifest: d.Digest.String(), json: b})
	}
	return out, nil
}

func fetchBundleLayer(r name.Repository, d v1.Descriptor) ([]byte, error) {
	img, err := remote.Image(r.Digest(d.Digest.String()))
	if err != nil {
		return nil, fmt.Errorf("fetch bundle manifest %s: %w", d.Digest, err)
	}
	layers, err := img.Layers()
	if err != nil {
		return nil, err
	}
	if len(layers) != 1 {
		return nil, fmt.Errorf("bundle manifest %s has %d layers, want 1", d.Digest, len(layers))
	}
	mt, err := layers[0].MediaType()
	if err != nil {
		return nil, err
	}
	if string(mt) != bundleMediaType {
		return nil, fmt.Errorf("bundle manifest %s layer media type %s", d.Digest, mt)
	}
	rc, err := layers[0].Compressed()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	return io.ReadAll(io.LimitReader(rc, 4<<20))
}
