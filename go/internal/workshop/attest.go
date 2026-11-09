package workshop

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/harshjv/stationly/go/internal/depot"
	"github.com/harshjv/stationly/go/internal/protocol"
)

const (
	refTypeAnnotation   = "vnd.docker.reference.type"
	refDigestAnnotation = "vnd.docker.reference.digest"
	predicateAnnotation = "in-toto.io/predicate-type"
	inTotoMediaType     = "application/vnd.in-toto+json"
	maxStatementBytes   = 32 << 20
)

type descriptor struct {
	MediaType   string            `json:"mediaType"`
	Digest      string            `json:"digest"`
	Size        int64             `json:"size"`
	Annotations map[string]string `json:"annotations,omitempty"`
	Platform    *struct {
		OS           string `json:"os"`
		Architecture string `json:"architecture"`
		Variant      string `json:"variant,omitempty"`
	} `json:"platform,omitempty"`
}

type ociManifest struct {
	MediaType string       `json:"mediaType"`
	Manifests []descriptor `json:"manifests"`
	Layers    []descriptor `json:"layers"`
}

type statement struct {
	PredicateType string          `json:"predicateType"`
	Predicate     json.RawMessage `json:"predicate"`
}

type Extracted struct {
	PlatformDigest   string
	Children         map[string]string
	Attestations     []protocol.BuildAttestation
	BaseImages       []protocol.BaseImage
	GeneratorVersion *string
}

func extract(ctx context.Context, c *depot.Client, stateDir, buildID, repo, indexDigest, arch string, drop []string) (Extracted, error) {
	var out Extracted
	idx, err := c.Manifest(ctx, repo, indexDigest)
	if err != nil {
		return out, err
	}
	var index ociManifest
	if err := json.Unmarshal(idx.Body, &index); err != nil {
		return out, fmt.Errorf("index %s: %w", indexDigest, err)
	}
	platform := "linux/" + arch
	for _, m := range index.Manifests {
		if m.Platform != nil && m.Platform.OS == "linux" && m.Platform.Architecture == arch && m.Annotations[refTypeAnnotation] == "" {
			out.PlatformDigest = m.Digest
		}
	}
	if out.PlatformDigest == "" {
		return out, fmt.Errorf("index %s has no %s manifest", indexDigest, platform)
	}
	out.Children = map[string]string{}
	for _, m := range index.Manifests {
		if m.Annotations[refTypeAnnotation] == "attestation-manifest" {
			out.Children[m.Digest] = "attestation"
		} else {
			out.Children[m.Digest] = "image"
		}
	}
	dir := filepath.Join(stateDir, "attestations", buildID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return out, err
	}
	for _, m := range index.Manifests {
		if m.Annotations[refTypeAnnotation] != "attestation-manifest" || m.Annotations[refDigestAnnotation] != out.PlatformDigest {
			continue
		}
		am, err := c.Manifest(ctx, repo, m.Digest)
		if err != nil {
			return out, err
		}
		var att ociManifest
		if err := json.Unmarshal(am.Body, &att); err != nil {
			return out, fmt.Errorf("attestation manifest %s: %w", m.Digest, err)
		}
		seen := map[protocol.AttestationKind]int{}
		for _, layer := range att.Layers {
			if layer.MediaType != inTotoMediaType {
				continue
			}
			body, err := c.Blob(ctx, repo, layer.Digest, maxStatementBytes)
			if err != nil {
				return out, err
			}
			var st statement
			if err := json.Unmarshal(body, &st); err != nil {
				return out, fmt.Errorf("in-toto statement %s: %w", layer.Digest, err)
			}
			kind := protocol.AttestationKindSbom
			if strings.Contains(st.PredicateType, "slsa.dev/provenance") {
				kind = protocol.AttestationKindProvenance
			} else if !strings.Contains(strings.ToLower(st.PredicateType), "spdx") {
				continue
			}
			name := string(kind)
			if n := seen[kind]; n > 0 {
				name = fmt.Sprintf("%s-%d", kind, n)
			}
			seen[kind]++
			ref := filepath.Join("attestations", buildID, name+".json")
			if err := os.WriteFile(filepath.Join(stateDir, ref), st.Predicate, 0o600); err != nil {
				return out, err
			}
			digest := m.Digest
			a := protocol.BuildAttestation{Kind: kind, Platform: platform, Digest: &digest, PredicateRef: ref, BaseImages: []protocol.BaseImage{}}
			switch kind {
			case protocol.AttestationKindProvenance:
				a.BaseImages = baseImages(st.Predicate, drop)
				out.BaseImages = append(out.BaseImages, a.BaseImages...)
			case protocol.AttestationKindSbom:
				if v := syftVersion(st.Predicate); v != nil && out.GeneratorVersion == nil {
					out.GeneratorVersion = v
				}
			}
			out.Attestations = append(out.Attestations, a)
		}
	}
	if out.BaseImages == nil {
		out.BaseImages = []protocol.BaseImage{}
	}
	return out, nil
}

func baseImages(predicate []byte, drop []string) []protocol.BaseImage {
	var p struct {
		BuildDefinition struct {
			ResolvedDependencies []struct {
				URI    string            `json:"uri"`
				Digest map[string]string `json:"digest"`
			} `json:"resolvedDependencies"`
		} `json:"buildDefinition"`
	}
	out := []protocol.BaseImage{}
	if json.Unmarshal(predicate, &p) != nil {
		return out
	}
	seen := map[string]bool{}
	for _, d := range p.BuildDefinition.ResolvedDependencies {
		if !strings.HasPrefix(d.URI, "pkg:docker/") || d.Digest["sha256"] == "" {
			continue
		}
		ref := strings.TrimPrefix(d.URI, "pkg:docker/")
		if i := strings.Index(ref, "?"); i >= 0 {
			ref = ref[:i]
		}
		name := ref
		if i := strings.LastIndex(name, "@"); i >= 0 {
			name = name[:i]
			ref = name + ":" + ref[i+1:]
		}
		if dropped(name, drop) {
			continue
		}
		key := ref + "@" + d.Digest["sha256"]
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, protocol.BaseImage{Ref: ref, Digest: "sha256:" + d.Digest["sha256"]})
	}
	return out
}

func dropped(name string, drop []string) bool {
	for _, d := range drop {
		if name == d || strings.HasSuffix(name, "/"+d) {
			return true
		}
	}
	return false
}

var syftTool = regexp.MustCompile(`^Tool:\s*syft-v?(\S+)$`)

func syftVersion(predicate []byte) *string {
	var p struct {
		CreationInfo struct {
			Creators []string `json:"creators"`
		} `json:"creationInfo"`
	}
	if json.Unmarshal(predicate, &p) != nil {
		return nil
	}
	for _, c := range p.CreationInfo.Creators {
		if m := syftTool.FindStringSubmatch(strings.TrimSpace(c)); m != nil {
			return &m[1]
		}
	}
	return nil
}
