package verify

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/remote/transport"
	"github.com/harshjv/stationly/go/internal/fsx"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/sigstore/sigstore-go/pkg/bundle"
	"github.com/sigstore/sigstore-go/pkg/root"
	"github.com/sigstore/sigstore-go/pkg/tuf"
	"github.com/sigstore/sigstore-go/pkg/verify"
	"github.com/theupdateframework/go-tuf/v2/metadata/fetcher"
)

type Signature string

const (
	Verified        Signature = "verified"
	Refused         Signature = "refused"
	UnsignedAllowed Signature = "unsigned_allowed"
)

type BundleSource string

const (
	SourceCache    BundleSource = "cache"
	SourceDirect   BundleSource = "direct"
	SourceDispatch BundleSource = "dispatch"
)

type Source interface {
	Name() BundleSource
	Bundles(ctx context.Context, digest string) ([][]byte, error)
	TUF() fetcher.Fetcher
}

type Result struct {
	Component   string        `json:"component"`
	Version     string        `json:"version"`
	Digest      string        `json:"digest"`
	Signature   Signature     `json:"signature"`
	Identity    string        `json:"identity,omitempty"`
	Source      BundleSource  `json:"bundle_source,omitempty"`
	BundlesSeen int           `json:"bundles_seen"`
	Duration    time.Duration `json:"-"`
	DurationMs  int64         `json:"duration_ms"`
	Reason      string        `json:"reason,omitempty"`
	TrustedRoot string        `json:"trusted_root"`
}

type Record struct {
	Component   string    `json:"component"`
	Version     string    `json:"version"`
	Digest      string    `json:"digest"`
	Identity    string    `json:"identity"`
	TrustedRoot string    `json:"trusted_root"`
	Trust       string    `json:"trust"`
	VerifiedAt  time.Time `json:"verified_at"`
	Bundle      string    `json:"bundle"`
}

type RootState struct {
	Digest       string    `json:"digest"`
	Origin       string    `json:"origin"`
	RefreshedAt  time.Time `json:"refreshed_at,omitzero"`
	RefreshError string    `json:"refresh_error,omitempty"`
	AttemptedAt  time.Time `json:"attempted_at,omitzero"`
}

type Verifier struct {
	log      *slog.Logger
	trust    Trust
	dir      string
	cacheDir string

	mu    sync.Mutex
	root  *root.TrustedRoot
	state RootState
}

func digestOf(b []byte) string {
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func SigstoreDir(stateDir string) string {
	return filepath.Join(filepath.Dir(filepath.Clean(stateDir)), "sigstore")
}

func New(log *slog.Logger, trust Trust, stateDir string) (*Verifier, error) {
	v := &Verifier{log: log, trust: trust, dir: filepath.Join(stateDir, "verify"), cacheDir: SigstoreDir(stateDir)}
	for _, d := range []string{filepath.Join(v.dir, "images"), v.cacheDir} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return nil, err
		}
	}
	if b, err := os.ReadFile(v.statePath()); err == nil {
		json.Unmarshal(b, &v.state)
	}
	raw, origin := trust.TrustedRoot, "embedded"
	if b, err := os.ReadFile(v.rootPath()); err == nil {
		raw, origin = b, "tuf"
	}
	tr, err := root.NewTrustedRootFromJSON(raw)
	if err != nil {
		return nil, fmt.Errorf("trusted root (%s): %w", origin, err)
	}
	v.root = tr
	v.state.Digest, v.state.Origin = digestOf(raw), origin
	return v, nil
}

func (v *Verifier) Trust() Trust { return v.trust }

func (v *Verifier) rootPath() string  { return filepath.Join(v.cacheDir, "trusted_root.json") }
func (v *Verifier) statePath() string { return filepath.Join(v.cacheDir, "state.json") }

func (v *Verifier) RootState() RootState {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.state
}

func (v *Verifier) saveState() {
	b, _ := json.MarshalIndent(v.state, "", "  ")
	fsx.WriteFile(v.statePath(), b, 0o600)
}

func (v *Verifier) Refresh(ctx context.Context, f fetcher.Fetcher) (RootState, error) {
	start := time.Now()
	opts := &tuf.Options{Root: v.trust.TUFRoot, CachePath: filepath.Join(v.cacheDir, "tuf"), RepositoryBaseURL: v.trust.TUFMirror, Fetcher: f, Context: ctx}
	raw, err := func() ([]byte, error) {
		c, err := tuf.New(opts)
		if err != nil {
			return nil, err
		}
		if err := c.Refresh(); err != nil {
			return nil, err
		}
		return c.GetTarget("trusted_root.json")
	}()
	v.mu.Lock()
	defer v.mu.Unlock()
	v.state.AttemptedAt = time.Now().UTC()
	if err == nil {
		var tr *root.TrustedRoot
		if tr, err = root.NewTrustedRootFromJSON(raw); err == nil {
			if err = fsx.WriteFile(v.rootPath(), raw, 0o600); err == nil {
				fsx.WriteFile(filepath.Join(v.cacheDir, "trusted_root."+strings.TrimPrefix(digestOf(raw), "sha256:")+".json"), raw, 0o600)
				v.root = tr
				v.state = RootState{Digest: digestOf(raw), Origin: "tuf", RefreshedAt: v.state.AttemptedAt, AttemptedAt: v.state.AttemptedAt}
			}
		}
	}
	if err != nil {
		v.state.RefreshError = err.Error()
		v.log.Warn("TUF refresh of the Sigstore trusted root failed; verifying with the last saved copy", "mirror", v.trust.TUFMirror, "error", err, "trusted_root", v.state.Digest)
	} else {
		v.log.Info("TUF refresh of the Sigstore trusted root", "mirror", v.trust.TUFMirror, "trusted_root", v.state.Digest, "took_ms", time.Since(start).Milliseconds())
	}
	v.saveState()
	return v.state, err
}

func (v *Verifier) verifier() (*verify.Verifier, string, error) {
	v.mu.Lock()
	tr, d := v.root, v.state.Digest
	v.mu.Unlock()
	sv, err := verify.NewVerifier(tr, verify.WithTransparencyLog(1), verify.WithSignedCertificateTimestamps(1), verify.WithObserverTimestamps(1))
	return sv, d, err
}

func (v *Verifier) check(raw []byte, policy verify.PolicyBuilder, wantPredicate bool) (string, error) {
	sv, _, err := v.verifier()
	if err != nil {
		return "", err
	}
	var b bundle.Bundle
	if err := b.UnmarshalJSON(raw); err != nil {
		return "", fmt.Errorf("bundle: %w", err)
	}
	res, err := sv.Verify(&b, policy)
	if err != nil {
		return "", err
	}
	if wantPredicate && (res.Statement == nil || res.Statement.GetPredicateType() != SignPredicateType) {
		pt := ""
		if res.Statement != nil {
			pt = res.Statement.GetPredicateType()
		}
		return "", fmt.Errorf("statement predicate type %q is not %s", pt, SignPredicateType)
	}
	san := ""
	if res.Signature != nil && res.Signature.Certificate != nil {
		san = res.Signature.Certificate.SubjectAlternativeName
	}
	return san, nil
}

func (v *Verifier) imagePolicy(digest string) (verify.PolicyBuilder, error) {
	hexPart, ok := strings.CutPrefix(digest, "sha256:")
	raw, err := hex.DecodeString(hexPart)
	if !ok || err != nil || len(raw) != sha256.Size {
		return verify.PolicyBuilder{}, fmt.Errorf("digest %q is not sha256:<64 hex>", digest)
	}
	id, err := v.trust.certificateIdentity()
	if err != nil {
		return verify.PolicyBuilder{}, err
	}
	return verify.NewPolicy(verify.WithArtifactDigest("sha256", raw), verify.WithCertificateIdentity(id)), nil
}

func (v *Verifier) recordPath(digest string) string {
	return filepath.Join(v.dir, "images", strings.TrimPrefix(digest, "sha256:")+".json")
}

func (v *Verifier) Lookup(digest string) (*Record, bool) {
	b, err := os.ReadFile(v.recordPath(digest))
	if err != nil {
		return nil, false
	}
	var r Record
	if json.Unmarshal(b, &r) != nil || r.Digest != digest {
		return nil, false
	}
	return &r, r.TrustedRoot == v.RootState().Digest && r.Trust == v.trust.Name
}

func (v *Verifier) Image(ctx context.Context, src Source, component, version, digest string) Result {
	start := time.Now()
	res := Result{Component: component, Version: version, Digest: digest, Signature: Refused, TrustedRoot: v.RootState().Digest}
	done := func() Result {
		res.Duration = time.Since(start)
		res.DurationMs = res.Duration.Milliseconds()
		return res
	}
	policy, err := v.imagePolicy(digest)
	if err != nil {
		res.Reason = err.Error()
		return done()
	}
	rec, current := v.Lookup(digest)
	if rec != nil && current {
		res.Signature, res.Identity, res.Source = Verified, rec.Identity, SourceCache
		return done()
	}
	var candidates [][]byte
	if rec != nil {
		candidates = [][]byte{[]byte(rec.Bundle)}
		res.Source = SourceCache
	}
	if src != nil {
		fetched, err := src.Bundles(ctx, digest)
		if err != nil && len(candidates) == 0 {
			res.Source = src.Name()
			res.Reason = "fetch signature bundles: " + err.Error()
			return done()
		}
		if err == nil {
			candidates = append(candidates, fetched...)
			if rec == nil {
				res.Source = src.Name()
			}
		}
	}
	res.BundlesSeen = len(candidates)
	if len(candidates) == 0 {
		res.Reason = fmt.Sprintf("no Sigstore bundle for %s in %s", digest, v.trust.SignaturesRepository)
		return done()
	}
	var reasons []string
	for _, raw := range candidates {
		san, err := v.check(raw, policy, true)
		if err != nil {
			reasons = append(reasons, err.Error())
			continue
		}
		res.Signature, res.Identity, res.Reason = Verified, san, ""
		r := Record{Component: component, Version: version, Digest: digest, Identity: san, TrustedRoot: res.TrustedRoot, Trust: v.trust.Name, VerifiedAt: time.Now().UTC(), Bundle: string(raw)}
		b, _ := json.MarshalIndent(r, "", "  ")
		if err := fsx.WriteFile(v.recordPath(digest), b, 0o600); err != nil {
			v.log.Error("record verified digest", "digest", digest, "error", err)
		}
		return done()
	}
	res.Reason = fmt.Sprintf("%d bundle(s), none verified against %s: %s", len(candidates), v.trust.Name, strings.Join(reasons, "; "))
	return done()
}

func (v *Verifier) Blob(data, raw []byte) (string, error) {
	id, err := v.trust.certificateIdentity()
	if err != nil {
		return "", err
	}
	return v.check(raw, verify.NewPolicy(verify.WithArtifact(bytes.NewReader(data)), verify.WithCertificateIdentity(id)), false)
}

type Direct struct {
	trust  Trust
	client *http.Client
}

func NewDirect(trust Trust) *Direct {
	return &Direct{trust: trust, client: &http.Client{Timeout: 60 * time.Second}}
}

func (d *Direct) Name() BundleSource { return SourceDirect }

func (d *Direct) TUF() fetcher.Fetcher {
	f := fetcher.NewDefaultFetcher()
	f.SetHTTPClient(d.client)
	return f
}

func (d *Direct) Bundles(ctx context.Context, digest string) ([][]byte, error) {
	return ListBundles(ctx, d.trust, digest)
}

func ListBundles(ctx context.Context, trust Trust, digest string) ([][]byte, error) {
	var opts []name.Option
	if trust.Insecure(trust.signaturesHost()) {
		opts = append(opts, name.Insecure)
	}
	repo, err := name.NewRepository(trust.SignaturesRepository, opts...)
	if err != nil {
		return nil, err
	}
	ropts := []remote.Option{remote.WithContext(ctx)}
	idx, err := remote.Referrers(repo.Digest(digest), append(ropts, remote.WithFilter("artifactType", protocol.MediaTypeSigstoreBundle))...)
	if err != nil {
		var te *transport.Error
		if errors.As(err, &te) && te.StatusCode == http.StatusNotFound {
			return nil, nil
		}
		return nil, err
	}
	im, err := idx.IndexManifest()
	if err != nil {
		return nil, err
	}
	var out [][]byte
	for i, m := range im.Manifests {
		if i >= maxBundlesPerDigest {
			break
		}
		if m.ArtifactType != protocol.MediaTypeSigstoreBundle {
			continue
		}
		img, err := remote.Image(repo.Digest(m.Digest.String()), ropts...)
		if err != nil {
			return out, err
		}
		layers, err := img.Layers()
		if err != nil || len(layers) != 1 {
			continue
		}
		rc, err := layers[0].Compressed()
		if err != nil {
			return out, err
		}
		b, err := io.ReadAll(io.LimitReader(rc, maxBundleBytes+1))
		rc.Close()
		if err != nil {
			return out, err
		}
		if len(b) > maxBundleBytes {
			continue
		}
		out = append(out, b)
	}
	return out, nil
}
