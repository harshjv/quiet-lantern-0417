package main

import (
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	protobundle "github.com/sigstore/protobuf-specs/gen/pb-go/bundle/v1"
	"github.com/sigstore/sigstore-go/pkg/root"
	"github.com/sigstore/sigstore-go/pkg/sign"
	"google.golang.org/protobuf/encoding/protojson"
)

const (
	bundleMediaType     = "application/vnd.dev.sigstore.bundle.v0.3+json"
	cosignPredicateType = "https://sigstore.dev/cosign/sign/v1"
	intotoPayloadType   = "application/vnd.in-toto+json"
)

type signed struct {
	bundle         *protobundle.Bundle
	json           []byte
	leafNotBefore  time.Time
	leafNotAfter   time.Time
	integratedTime time.Time
	logIndex       int64
}

func signContent(dir, identity, tag string, content sign.Content) (*signed, error) {
	a, err := loadAuthority(dir)
	if err != nil {
		return nil, err
	}
	p, err := identityProfile(identity, tag)
	if err != nil {
		return nil, err
	}
	trusted, err := root.NewTrustedRootFromPath(filepath.Join(dir, trustedRootFile))
	if err != nil {
		return nil, err
	}
	keypair, err := sign.NewEphemeralKeypair(nil)
	if err != nil {
		return nil, err
	}
	fulcio := &fakeFulcio{authority: a, profile: p}
	rekor := &fakeRekor{authority: a}
	b, err := sign.Bundle(content, keypair, sign.BundleOptions{
		CertificateProvider: fulcio,
		TransparencyLogs:    []sign.Transparency{sign.NewRekor(&sign.RekorOptions{Client: rekor})},
		TrustedRoot:         trusted,
	})
	if err != nil {
		return nil, err
	}
	j, err := protojson.Marshal(b)
	if err != nil {
		return nil, err
	}
	return &signed{
		bundle:         b,
		json:           j,
		leafNotBefore:  fulcio.leaf.NotBefore,
		leafNotAfter:   fulcio.leaf.NotAfter,
		integratedTime: rekor.integratedTime,
		logIndex:       rekor.logIndex,
	}, nil
}

func (s *signed) summary(out string) map[string]any {
	tle := s.bundle.GetVerificationMaterial().GetTlogEntries()[0]
	return map[string]any{
		"bundle":            out,
		"media_type":        s.bundle.GetMediaType(),
		"leaf_not_before":   s.leafNotBefore.UTC().Format(time.RFC3339),
		"leaf_not_after":    s.leafNotAfter.UTC().Format(time.RFC3339),
		"integrated_time":   s.integratedTime.UTC().Format(time.RFC3339),
		"log_index":         s.logIndex,
		"tlog_kind":         tle.GetKindVersion().GetKind() + "/" + tle.GetKindVersion().GetVersion(),
		"inclusion_promise": tle.GetInclusionPromise() != nil,
		"inclusion_proof":   tle.GetInclusionProof() != nil,
		"checkpoint":        tle.GetInclusionProof().GetCheckpoint().GetEnvelope() != "",
		"tree_size":         tle.GetInclusionProof().GetTreeSize(),
	}
}

func cmdSignBlob(args []string) error {
	fs := flag.NewFlagSet("sign-blob", flag.ExitOnError)
	dir := fs.String("dir", "", "state directory")
	identity := fs.String("identity", "release", "release|wrong")
	tag := fs.String("tag", "v0.1.0-test.1", "release tag in the signing certificate's workflow ref")
	in := fs.String("in", "", "file to sign")
	out := fs.String("out", "", "bundle output path")
	fs.Parse(args)
	if *dir == "" || *in == "" || *out == "" {
		return errors.New("--dir, --in and --out are required")
	}
	data, err := os.ReadFile(*in)
	if err != nil {
		return err
	}
	s, err := signContent(*dir, *identity, *tag, &sign.PlainData{Data: data})
	if err != nil {
		return err
	}
	if err := os.WriteFile(*out, s.json, 0o644); err != nil {
		return err
	}
	return printJSON(s.summary(*out))
}

func parseDigest(d string) (string, []byte, error) {
	hexPart, ok := strings.CutPrefix(d, "sha256:")
	if !ok {
		return "", nil, fmt.Errorf("digest %q must start with sha256:", d)
	}
	raw, err := hex.DecodeString(hexPart)
	if err != nil || len(raw) != 32 {
		return "", nil, fmt.Errorf("digest %q is not a sha256 hex digest", d)
	}
	return hexPart, raw, nil
}

func statementFor(hexDigest string) []byte {
	return []byte(`{"_type":"https://in-toto.io/Statement/v1","subject":[{"name":"","digest":{"sha256":"` + hexDigest + `"}}],"predicateType":"` + cosignPredicateType + `","predicate":{}}`)
}

func cmdSignImage(args []string) error {
	fs := flag.NewFlagSet("sign-image", flag.ExitOnError)
	dir := fs.String("dir", "", "state directory")
	identity := fs.String("identity", "release", "release|wrong")
	tag := fs.String("tag", "v0.1.0-test.1", "release tag in the signing certificate's workflow ref")
	digest := fs.String("digest", "", "image digest the statement is about (sha256:...)")
	repo := fs.String("repo", "", "signatures repository HOST:PORT/path")
	insecure := fs.Bool("insecure", false, "plain HTTP registry")
	attachTo := fs.String("attach-to", "", "subject digest to list the bundle under (defaults to --digest)")
	subjectRef := fs.String("subject-ref", "", "upstream image reference to HEAD for subject media type and size")
	out := fs.String("out", "", "optional bundle output path")
	fs.Parse(args)
	if *dir == "" || *digest == "" || *repo == "" {
		return errors.New("--dir, --digest and --repo are required")
	}
	hexDigest, _, err := parseDigest(*digest)
	if err != nil {
		return err
	}
	subject := *digest
	if *attachTo != "" {
		if _, _, err := parseDigest(*attachTo); err != nil {
			return err
		}
		subject = *attachTo
	}
	s, err := signContent(*dir, *identity, *tag, &sign.DSSEData{Data: statementFor(hexDigest), PayloadType: intotoPayloadType})
	if err != nil {
		return err
	}
	if *out != "" {
		if err := os.WriteFile(*out, s.json, 0o644); err != nil {
			return err
		}
	}
	pushed, err := pushBundle(*repo, *insecure, subject, *subjectRef, s.json)
	if err != nil {
		return err
	}
	summary := s.summary(*out)
	summary["statement_digest"] = *digest
	summary["subject"] = pushed.subject
	summary["manifest"] = pushed.manifest
	summary["referrers_api"] = pushed.referrersAPI
	summary["listed_by_referrers"] = pushed.listed
	return printJSON(summary)
}
