package main

import (
	"bytes"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/sigstore/sigstore-go/pkg/bundle"
	"github.com/sigstore/sigstore-go/pkg/root"
	"github.com/sigstore/sigstore-go/pkg/verify"
)

type verifyOutput struct {
	OK       bool               `json:"ok"`
	Reason   string             `json:"reason"`
	Manifest string             `json:"manifest,omitempty"`
	Timings  map[string]float64 `json:"timings_ms"`
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

func expectedIdentity(name string) (verify.CertificateIdentity, error) {
	if name != "release" {
		return verify.CertificateIdentity{}, fmt.Errorf("unknown expected identity %q (only release)", name)
	}
	san, err := verify.NewSANMatcher("", releaseSANExpr)
	if err != nil {
		return verify.CertificateIdentity{}, err
	}
	issuer, err := verify.NewIssuerMatcher(githubIssuer, "")
	if err != nil {
		return verify.CertificateIdentity{}, err
	}
	return verify.NewCertificateIdentity(san, issuer, releaseExtensionsPolicy())
}

func newVerifier(dir string) (*verify.Verifier, error) {
	trusted, err := root.NewTrustedRootFromPath(filepath.Join(dir, trustedRootFile))
	if err != nil {
		return nil, err
	}
	return verify.NewVerifier(trusted, verify.WithTransparencyLog(1), verify.WithSignedCertificateTimestamps(1), verify.WithObserverTimestamps(1))
}

func finish(out verifyOutput, start time.Time) error {
	out.Timings["total"] = ms(time.Since(start))
	if err := printJSON(out); err != nil {
		return err
	}
	if !out.OK {
		return &exitError{code: 1}
	}
	return nil
}

func cmdVerifyImage(args []string) error {
	fs := flag.NewFlagSet("verify-image", flag.ExitOnError)
	dir := fs.String("dir", "", "state directory")
	repo := fs.String("repo", "", "signatures repository")
	digest := fs.String("digest", "", "image digest sha256:...")
	insecure := fs.Bool("insecure", false, "plain HTTP registry")
	identity := fs.String("identity", "release", "expected identity profile")
	fs.Parse(args)
	if *dir == "" || *repo == "" || *digest == "" {
		return errors.New("--dir, --repo and --digest are required")
	}
	start := time.Now()
	out := verifyOutput{Timings: map[string]float64{}}
	_, raw, err := parseDigest(*digest)
	if err != nil {
		return err
	}
	id, err := expectedIdentity(*identity)
	if err != nil {
		return err
	}
	t := time.Now()
	v, err := newVerifier(*dir)
	if err != nil {
		return err
	}
	out.Timings["load_trusted_root"] = ms(time.Since(t))
	t = time.Now()
	bundles, err := fetchBundles(*repo, *insecure, *digest)
	out.Timings["referrers_and_fetch"] = ms(time.Since(t))
	if err != nil {
		out.Reason = err.Error()
		return finish(out, start)
	}
	if len(bundles) == 0 {
		out.Reason = "no referrers with artifactType " + bundleMediaType + " for " + *digest
		return finish(out, start)
	}
	t = time.Now()
	var reasons []string
	for _, fb := range bundles {
		reason := verifyImageBundle(v, fb.json, raw, id)
		if reason == "" {
			out.OK = true
			out.Manifest = fb.manifest
			out.Reason = "verified"
			break
		}
		reasons = append(reasons, fb.manifest+": "+reason)
	}
	out.Timings["verify"] = ms(time.Since(t))
	if !out.OK {
		out.Reason = fmt.Sprint(reasons)
		if len(reasons) == 1 {
			out.Reason = reasons[0]
		}
	}
	return finish(out, start)
}

func verifyImageBundle(v *verify.Verifier, bundleJSON, digest []byte, id verify.CertificateIdentity) string {
	var b bundle.Bundle
	if err := b.UnmarshalJSON(bundleJSON); err != nil {
		return "parse bundle: " + err.Error()
	}
	res, err := v.Verify(&b, verify.NewPolicy(verify.WithArtifactDigest("sha256", digest), verify.WithCertificateIdentity(id)))
	if err != nil {
		return err.Error()
	}
	if res.Statement == nil || res.Statement.GetPredicateType() != cosignPredicateType {
		return "statement predicate type is not " + cosignPredicateType
	}
	return ""
}

func cmdVerifyBlob(args []string) error {
	fs := flag.NewFlagSet("verify-blob", flag.ExitOnError)
	dir := fs.String("dir", "", "state directory")
	in := fs.String("in", "", "file")
	bundlePath := fs.String("bundle", "", "bundle path")
	identity := fs.String("identity", "release", "expected identity profile")
	fs.Parse(args)
	if *dir == "" || *in == "" || *bundlePath == "" {
		return errors.New("--dir, --in and --bundle are required")
	}
	start := time.Now()
	out := verifyOutput{Timings: map[string]float64{}}
	id, err := expectedIdentity(*identity)
	if err != nil {
		return err
	}
	v, err := newVerifier(*dir)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(*in)
	if err != nil {
		return err
	}
	bj, err := os.ReadFile(*bundlePath)
	if err != nil {
		return err
	}
	t := time.Now()
	var b bundle.Bundle
	if err := b.UnmarshalJSON(bj); err != nil {
		out.Reason = "parse bundle: " + err.Error()
		return finish(out, start)
	}
	if _, err := v.Verify(&b, verify.NewPolicy(verify.WithArtifact(bytes.NewReader(data)), verify.WithCertificateIdentity(id))); err != nil {
		out.Reason = err.Error()
	} else {
		out.OK = true
		out.Reason = "verified"
	}
	out.Timings["verify"] = ms(time.Since(t))
	return finish(out, start)
}
