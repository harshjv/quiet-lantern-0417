package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"fmt"
	"net/url"
	"path"
	"strings"
	"time"

	ct "github.com/google/certificate-transparency-go"
	cttls "github.com/google/certificate-transparency-go/tls"
	ctx509 "github.com/google/certificate-transparency-go/x509"
	"github.com/google/certificate-transparency-go/x509util"
	"github.com/sigstore/sigstore-go/pkg/fulcio/certificate"
	"github.com/sigstore/sigstore-go/pkg/sign"
)

const (
	githubIssuer   = "https://token.actions.githubusercontent.com"
	sourceRepoURI  = "https://github.com/stationly-test/stationly"
	releaseSANExpr = `^https://github\.com/stationly-test/stationly/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$`
)

type profile struct {
	san        string
	ref        string
	workflow   string
	extensions certificate.Extensions
}

func identityProfile(name, tag string) (profile, error) {
	var p profile
	switch name {
	case "release":
		p.workflow = ".github/workflows/release.yml"
		p.ref = "refs/tags/" + tag
	case "wrong":
		p.workflow = ".github/workflows/evil.yml"
		p.ref = "refs/heads/main"
	default:
		return p, fmt.Errorf("unknown identity profile %q (want release or wrong)", name)
	}
	p.san = sourceRepoURI + "/" + p.workflow + "@" + p.ref
	p.extensions = certificate.Extensions{
		Issuer:                              githubIssuer,
		BuildSignerURI:                      p.san,
		BuildSignerDigest:                   "0000000000000000000000000000000000000001",
		RunnerEnvironment:                   "github-hosted",
		SourceRepositoryURI:                 sourceRepoURI,
		SourceRepositoryDigest:              "0000000000000000000000000000000000000001",
		SourceRepositoryRef:                 p.ref,
		SourceRepositoryIdentifier:          "100001",
		SourceRepositoryOwnerURI:            "https://github.com/stationly-test",
		SourceRepositoryOwnerIdentifier:     "200002",
		BuildConfigURI:                      p.san,
		BuildConfigDigest:                   "0000000000000000000000000000000000000001",
		BuildTrigger:                        "push",
		RunInvocationURI:                    sourceRepoURI + "/actions/runs/1/attempts/1",
		SourceRepositoryVisibilityAtSigning: "public",
	}
	return p, nil
}

func releaseExtensionsPolicy() certificate.Extensions {
	return certificate.Extensions{
		SourceRepositoryURI:             sourceRepoURI,
		SourceRepositoryIdentifier:      "100001",
		SourceRepositoryOwnerIdentifier: "200002",
		RunnerEnvironment:               "github-hosted",
	}
}

func derUTF8(s string) []byte {
	b, err := asn1.MarshalWithParams(s, "utf8")
	if err != nil {
		panic(err)
	}
	return b
}

func fulcioExtensions(p profile) []pkix.Extension {
	e := p.extensions
	ext := func(id asn1.ObjectIdentifier, v []byte) pkix.Extension { return pkix.Extension{Id: id, Value: v} }
	out := []pkix.Extension{
		ext(certificate.OIDIssuer, []byte(e.Issuer)),
		ext(certificate.OIDGitHubWorkflowTrigger, []byte(e.BuildTrigger)),
		ext(certificate.OIDGitHubWorkflowSHA, []byte(e.SourceRepositoryDigest)),
		ext(certificate.OIDGitHubWorkflowName, []byte(strings.TrimSuffix(path.Base(p.workflow), ".yml"))),
		ext(certificate.OIDGitHubWorkflowRepository, []byte("stationly-test/stationly")),
		ext(certificate.OIDGitHubWorkflowRef, []byte(e.SourceRepositoryRef)),
		ext(certificate.OIDIssuerV2, derUTF8(e.Issuer)),
	}
	for _, kv := range []struct {
		id asn1.ObjectIdentifier
		v  string
	}{
		{certificate.OIDBuildSignerURI, e.BuildSignerURI},
		{certificate.OIDBuildSignerDigest, e.BuildSignerDigest},
		{certificate.OIDRunnerEnvironment, e.RunnerEnvironment},
		{certificate.OIDSourceRepositoryURI, e.SourceRepositoryURI},
		{certificate.OIDSourceRepositoryDigest, e.SourceRepositoryDigest},
		{certificate.OIDSourceRepositoryRef, e.SourceRepositoryRef},
		{certificate.OIDSourceRepositoryIdentifier, e.SourceRepositoryIdentifier},
		{certificate.OIDSourceRepositoryOwnerURI, e.SourceRepositoryOwnerURI},
		{certificate.OIDSourceRepositoryOwnerIdentifier, e.SourceRepositoryOwnerIdentifier},
		{certificate.OIDBuildConfigURI, e.BuildConfigURI},
		{certificate.OIDBuildConfigDigest, e.BuildConfigDigest},
		{certificate.OIDBuildTrigger, e.BuildTrigger},
		{certificate.OIDRunInvocationURI, e.RunInvocationURI},
		{certificate.OIDSourceRepositoryVisibilityAtSigning, e.SourceRepositoryVisibilityAtSigning},
	} {
		out = append(out, ext(kv.id, derUTF8(kv.v)))
	}
	return out
}

type fakeFulcio struct {
	authority *authority
	profile   profile
	issuedAt  time.Time
	leaf      *x509.Certificate
}

var _ sign.CertificateProvider = (*fakeFulcio)(nil)

func (f *fakeFulcio) GetCertificate(_ context.Context, keypair sign.Keypair, _ *sign.CertificateProviderOptions) ([]byte, error) {
	pub := keypair.GetPublicKey()
	pubDER, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return nil, err
	}
	san, err := url.Parse(f.profile.san)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC().Truncate(time.Second)
	ski := sha1.Sum(pubDER)
	tmpl := &x509.Certificate{
		SerialNumber: randomSerial(),
		NotBefore:    now,
		NotAfter:     now.Add(10 * time.Minute),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageCodeSigning},
		URIs:         []*url.URL{san},
		SubjectKeyId: ski[:],
	}
	base := fulcioExtensions(f.profile)
	poison := pkix.Extension{Id: asn1.ObjectIdentifier(ctx509.OIDExtensionCTPoison), Critical: true, Value: asn1.NullBytes}
	tmpl.ExtraExtensions = append(append([]pkix.Extension{}, base...), poison)
	preDER, err := x509.CreateCertificate(rand.Reader, tmpl, f.authority.intermediateCert, pub, f.authority.intermediateKey)
	if err != nil {
		return nil, fmt.Errorf("precertificate: %w", err)
	}
	sct, err := f.signSCT(preDER, now)
	if err != nil {
		return nil, err
	}
	sctList, err := x509util.MarshalSCTsIntoSCTList([]*ct.SignedCertificateTimestamp{sct})
	if err != nil {
		return nil, err
	}
	rawList, err := cttls.Marshal(*sctList)
	if err != nil {
		return nil, err
	}
	sctExtValue, err := asn1.Marshal(rawList)
	if err != nil {
		return nil, err
	}
	tmpl.ExtraExtensions = append(append([]pkix.Extension{}, base...), pkix.Extension{Id: asn1.ObjectIdentifier(ctx509.OIDExtensionCTSCT), Value: sctExtValue})
	der, err := x509.CreateCertificate(rand.Reader, tmpl, f.authority.intermediateCert, pub, f.authority.intermediateKey)
	if err != nil {
		return nil, err
	}
	f.leaf, err = x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	f.issuedAt = now
	return der, nil
}

func (f *fakeFulcio) signSCT(preDER []byte, at time.Time) (*ct.SignedCertificateTimestamp, error) {
	pre, err := ctx509.ParseCertificate(preDER)
	if err != nil {
		return nil, err
	}
	issuer, err := ctx509.ParseCertificate(f.authority.intermediateCert.Raw)
	if err != nil {
		return nil, err
	}
	leaf, err := ct.MerkleTreeLeafFromChain([]*ctx509.Certificate{pre, issuer}, ct.PrecertLogEntryType, uint64(at.UnixMilli()))
	if err != nil {
		return nil, err
	}
	id, err := logID(f.authority.ctlogKey.Public())
	if err != nil {
		return nil, err
	}
	sct := &ct.SignedCertificateTimestamp{
		SCTVersion: ct.V1,
		Timestamp:  uint64(at.UnixMilli()),
		Extensions: ct.CTExtensions{},
	}
	copy(sct.LogID.KeyID[:], id)
	input, err := ct.SerializeSCTSignatureInput(*sct, ct.LogEntry{Leaf: *leaf})
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(input)
	sig, err := ecdsa.SignASN1(rand.Reader, f.authority.ctlogKey, digest[:])
	if err != nil {
		return nil, err
	}
	sct.Signature = ct.DigitallySigned{
		Algorithm: cttls.SignatureAndHashAlgorithm{Hash: cttls.SHA256, Signature: cttls.ECDSA},
		Signature: sig,
	}
	return sct, nil
}
