package depot

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

const (
	Issuer         = "stationd"
	Service        = "depot"
	grantAudience  = "depot-grant"
	PullTokenTTL   = 60 * time.Second
	notBeforeSkew  = 5 * time.Second
	ActionPull     = "pull"
	ActionPush     = "push"
	ActionDelete   = "delete"
	typeRepository = "repository"
)

type Access struct {
	Type    string   `json:"type"`
	Name    string   `json:"name"`
	Actions []string `json:"actions"`
}

func Repository(name string, actions ...string) Access {
	return Access{Type: typeRepository, Name: name, Actions: actions}
}

func (a Access) Scope() string {
	return a.Type + ":" + a.Name + ":" + strings.Join(a.Actions, ",")
}

type claims struct {
	jwt.Claims
	Access []Access `json:"access"`
}

type Signer struct {
	key   ed25519.PrivateKey
	keyID string
}

func LoadSigner(path string) (*Signer, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return createSigner(path)
	}
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(b)
	if block == nil {
		return nil, fmt.Errorf("%s holds no PEM block", path)
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	key, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("%s is not an Ed25519 key", path)
	}
	return newSigner(key), nil
}

func createSigner(path string) (*Signer, error) {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		return nil, err
	}
	return newSigner(key), nil
}

func newSigner(key ed25519.PrivateKey) *Signer {
	pub := key.Public().(ed25519.PublicKey)
	thumb := sha256.Sum256(fmt.Appendf(nil, `{"crv":"Ed25519","kty":"OKP","x":"%s"}`, base64.RawURLEncoding.EncodeToString(pub)))
	return &Signer{key: key, keyID: base64.RawURLEncoding.EncodeToString(thumb[:])}
}

func (s *Signer) KeyID() string {
	return s.keyID
}

func (s *Signer) JWKS() ([]byte, error) {
	set := jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: s.key.Public(), KeyID: s.keyID, Algorithm: string(jose.EdDSA), Use: "sig"}}}
	return json.MarshalIndent(set, "", "  ")
}

func (s *Signer) Mint(subject string, access []Access, ttl time.Duration) (string, error) {
	return s.mint(Service, subject, access, ttl)
}

func (s *Signer) MintGrant(access []Access, ttl time.Duration) (string, error) {
	return s.mint(grantAudience, "grant", access, ttl)
}

func (s *Signer) mint(audience, subject string, access []Access, ttl time.Duration) (string, error) {
	opts := (&jose.SignerOptions{}).WithType("JWT").WithHeader("kid", s.keyID)
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.EdDSA, Key: s.key}, opts)
	if err != nil {
		return "", err
	}
	id := make([]byte, 12)
	if _, err := rand.Read(id); err != nil {
		return "", err
	}
	now := time.Now()
	c := claims{
		Claims: jwt.Claims{
			Issuer:    Issuer,
			Subject:   subject,
			Audience:  jwt.Audience{audience},
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now.Add(-notBeforeSkew)),
			Expiry:    jwt.NewNumericDate(now.Add(ttl)),
			ID:        base64.RawURLEncoding.EncodeToString(id),
		},
		Access: access,
	}
	if c.Access == nil {
		c.Access = []Access{}
	}
	return jwt.Signed(signer).Claims(c).Serialize()
}

func (s *Signer) VerifyGrant(raw string) ([]Access, error) {
	tok, err := jwt.ParseSigned(raw, []jose.SignatureAlgorithm{jose.EdDSA})
	if err != nil {
		return nil, err
	}
	var c claims
	if err := tok.Claims(s.key.Public(), &c); err != nil {
		return nil, err
	}
	if err := c.Claims.ValidateWithLeeway(jwt.Expected{Issuer: Issuer, AnyAudience: jwt.Audience{grantAudience}, Time: time.Now()}, 0); err != nil {
		return nil, err
	}
	return c.Access, nil
}

func ParseScope(scope string) (Access, error) {
	first := strings.Index(scope, ":")
	last := strings.LastIndex(scope, ":")
	if first < 0 || first == last {
		return Access{}, fmt.Errorf("scope %q is not type:name:actions", scope)
	}
	return Access{Type: scope[:first], Name: scope[first+1 : last], Actions: strings.Split(scope[last+1:], ",")}, nil
}

func ParseScopes(values []string) []Access {
	var out []Access
	for _, v := range values {
		for _, part := range strings.Fields(v) {
			if a, err := ParseScope(part); err == nil {
				out = append(out, a)
			}
		}
	}
	return out
}

func Covered(granted []Access, want Access) Access {
	out := Access{Type: want.Type, Name: want.Name}
	for _, act := range want.Actions {
		for _, g := range granted {
			if g.Type == want.Type && g.Name == want.Name && slices.Contains(g.Actions, act) {
				out.Actions = append(out.Actions, act)
				break
			}
		}
	}
	return out
}

func ProjectPrefix(projectID string) string {
	return strings.ToLower(projectID) + "/"
}

func RepositoryFor(projectID, name string) string {
	return ProjectPrefix(projectID) + strings.ToLower(name)
}

func UnderProject(projectID, repository string) bool {
	prefix := ProjectPrefix(projectID)
	return strings.HasPrefix(repository, prefix) && !strings.ContainsAny(repository, "*?") && len(repository) > len(prefix)
}
