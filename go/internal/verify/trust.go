package verify

import (
	"bytes"
	"crypto/x509"
	_ "embed"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/sigstore/sigstore-go/pkg/fulcio/certificate"
	"github.com/sigstore/sigstore-go/pkg/verify"

	"github.com/harshjv/stationly/go/internal/protocol"
)

//go:embed embedded/trusted_root.json
var embeddedTrustedRoot []byte

//go:embed embedded/tuf_root.json
var embeddedTUFRoot []byte

const (
	LetsEncryptProduction = "https://acme-v02.api.letsencrypt.org/directory"
	LetsEncryptStaging    = "https://acme-staging-v02.api.letsencrypt.org/directory"
	SignPredicateType     = "https://sigstore.dev/cosign/sign/v1"
	maxBundleBytes        = 1 << 20
	maxBundlesPerDigest   = 16
)

type Identity struct {
	SANRegex   string                 `json:"san_regex"`
	Issuer     string                 `json:"issuer"`
	Extensions certificate.Extensions `json:"extensions"`
}

type Trust struct {
	Name                 string            `json:"name"`
	Identity             Identity          `json:"identity"`
	SignaturesRepository string            `json:"signatures_repository"`
	InsecureRegistries   []string          `json:"insecure_registries"`
	TUFMirror            string            `json:"tuf_mirror"`
	ReleasesRepository   string            `json:"releases_repository"`
	Sources              map[string]string `json:"sources,omitempty"`
	ACMECAServer         string            `json:"acme_ca_server,omitempty"`
	ACMECACertificates   string            `json:"acme_ca_certificates,omitempty"`
	Production           bool              `json:"-"`
	TUFRoot              []byte            `json:"-"`
	TrustedRoot          []byte            `json:"-"`
}

type trustFile struct {
	Trust
	TUFRootInline     json.RawMessage `json:"tuf_root,omitempty"`
	TrustedRootInline json.RawMessage `json:"trusted_root,omitempty"`
	TUFRootPath       string          `json:"tuf_root_path,omitempty"`
	TrustedRootPath   string          `json:"trusted_root_path,omitempty"`
}

func ReleaseTrust() Trust {
	return Trust{
		Name: "stationly release",
		Identity: Identity{
			SANRegex: "^" + regexp.QuoteMeta(protocol.SigningSourceRepository+"/"+protocol.SigningWorkflow) + `@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$`,
			Issuer:   protocol.SigningIssuer,
			Extensions: certificate.Extensions{
				SourceRepositoryURI:             protocol.SigningSourceRepository,
				SourceRepositoryIdentifier:      protocol.SigningSourceRepositoryId,
				SourceRepositoryOwnerIdentifier: protocol.SigningSourceRepositoryOwnerId,
				RunnerEnvironment:               protocol.SigningRunnerEnvironment,
			},
		},
		SignaturesRepository: protocol.SignaturesRepository,
		TUFMirror:            protocol.TUFMirror,
		ReleasesRepository:   protocol.ReleaseRepository,
		Production:           true,
		TUFRoot:              embeddedTUFRoot,
		TrustedRoot:          embeddedTrustedRoot,
	}
}

func LoadTrust(path string) (Trust, error) {
	if path == "" {
		return ReleaseTrust(), nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return Trust{}, err
	}
	return ParseTestTrust(b, filepath.Dir(path))
}

func ParseTestTrust(b []byte, dir string) (Trust, error) {
	var f trustFile
	if err := json.Unmarshal(b, &f); err != nil {
		return Trust{}, fmt.Errorf("trust file: %w", err)
	}
	t := f.Trust
	t.Production = false
	var err error
	switch {
	case len(f.TUFRootInline) > 0:
		t.TUFRoot = f.TUFRootInline
	case f.TUFRootPath != "":
		if t.TUFRoot, err = os.ReadFile(resolvePath(dir, f.TUFRootPath)); err != nil {
			return Trust{}, err
		}
	}
	switch {
	case len(f.TrustedRootInline) > 0:
		t.TrustedRoot = f.TrustedRootInline
	case f.TrustedRootPath != "":
		if t.TrustedRoot, err = os.ReadFile(resolvePath(dir, f.TrustedRootPath)); err != nil {
			return Trust{}, err
		}
	default:
		t.TrustedRoot = embeddedTrustedRoot
	}
	missing := []string{}
	for field, value := range map[string]string{
		"name": t.Name, "identity.san_regex": t.Identity.SANRegex, "identity.issuer": t.Identity.Issuer,
		"signatures_repository": t.SignaturesRepository, "tuf_mirror": t.TUFMirror, "releases_repository": t.ReleasesRepository,
	} {
		if value == "" {
			missing = append(missing, field)
		}
	}
	if len(t.TUFRoot) == 0 {
		missing = append(missing, "tuf_root")
	}
	if len(missing) > 0 {
		slices.Sort(missing)
		return Trust{}, fmt.Errorf("trust file is missing %s; a test trust inherits nothing from the production release identity", strings.Join(missing, ", "))
	}
	if t.ReleasesRepository == protocol.ReleaseRepository || t.TUFMirror == protocol.TUFMirror || t.SignaturesRepository == protocol.SignaturesRepository {
		return Trust{}, fmt.Errorf("trust file %q points at the production release locations; a test trust names its own release host", t.Name)
	}
	if t.ACMECAServer == "" {
		t.ACMECAServer = LetsEncryptStaging
	}
	if t.ACMECAServer == LetsEncryptProduction || !strings.HasPrefix(t.ACMECAServer, "https://") {
		return Trust{}, fmt.Errorf("trust file acme_ca_server %q must be an https ACME directory other than Let's Encrypt production", t.ACMECAServer)
	}
	if t.ACMECACertificates != "" {
		if _, err := parseRoots([]byte(t.ACMECACertificates)); err != nil {
			return Trust{}, fmt.Errorf("trust file acme_ca_certificates: %w", err)
		}
	}
	if _, err := regexp.Compile(t.Identity.SANRegex); err != nil {
		return Trust{}, fmt.Errorf("identity.san_regex: %w", err)
	}
	return t, nil
}

func (t Trust) MarshalTestTrust() ([]byte, error) {
	if t.Production {
		return nil, fmt.Errorf("the production release identity is embedded in stationd and is never written to a trust file")
	}
	f := trustFile{Trust: t, TUFRootInline: t.TUFRoot}
	if !bytes.Equal(t.TrustedRoot, embeddedTrustedRoot) {
		f.TrustedRootInline = t.TrustedRoot
	}
	return json.MarshalIndent(f, "", "  ")
}

func (t Trust) DefaultACME() string {
	if t.Production {
		return ""
	}
	return t.ACMECAServer
}

func (t Trust) ACMERoots() []byte {
	if t.Production || t.ACMECACertificates == "" {
		return nil
	}
	return []byte(t.ACMECACertificates)
}

func parseRoots(b []byte) (int, error) {
	n := 0
	for {
		var block *pem.Block
		block, b = pem.Decode(b)
		if block == nil {
			break
		}
		if block.Type != "CERTIFICATE" {
			return n, fmt.Errorf("PEM block %d is %s, not CERTIFICATE", n+1, block.Type)
		}
		if _, err := x509.ParseCertificate(block.Bytes); err != nil {
			return n, fmt.Errorf("certificate %d: %w", n+1, err)
		}
		n++
	}
	if n == 0 {
		return 0, fmt.Errorf("no PEM certificate found")
	}
	return n, nil
}

func resolvePath(dir, p string) string {
	if filepath.IsAbs(p) {
		return p
	}
	return filepath.Join(dir, p)
}

func (t Trust) certificateIdentity() (verify.CertificateIdentity, error) {
	san, err := verify.NewSANMatcher("", t.Identity.SANRegex)
	if err != nil {
		return verify.CertificateIdentity{}, err
	}
	issuer, err := verify.NewIssuerMatcher(t.Identity.Issuer, "")
	if err != nil {
		return verify.CertificateIdentity{}, err
	}
	return verify.NewCertificateIdentity(san, issuer, t.Identity.Extensions)
}

func (t Trust) Source(component, fallback string) string {
	if s, ok := t.Sources[component]; ok && s != "" {
		return s
	}
	return fallback
}

func (t Trust) Insecure(host string) bool {
	return slices.Contains(t.InsecureRegistries, host)
}

func (t Trust) signaturesHost() string {
	return repositoryHost(t.SignaturesRepository)
}

func (t Trust) ReleasesInsecure() bool {
	return t.Insecure(repositoryHost(t.ReleasesRepository))
}

func repositoryHost(repo string) string {
	host, _, _ := strings.Cut(repo, "/")
	return host
}
