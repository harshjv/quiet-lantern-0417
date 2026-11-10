package hostconfig

import (
	"crypto/rand"
	"encoding/base32"
	"encoding/base64"
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/harshjv/stationly/go/internal/fsx"
	"github.com/pelletier/go-toml/v2"
)

const (
	DefaultEtcDir = "/etc/stationly"
	fileName      = "host.toml"
	recoveryLabel = "sly-rk-"
)

type Dispatch struct {
	URL       string `toml:"url"`
	MasterKey string `toml:"master_key"`
}

type Litestream struct {
	Bucket    string `toml:"bucket,omitempty"`
	Endpoint  string `toml:"endpoint,omitempty"`
	AccessKey string `toml:"access_key,omitempty"`
	SecretKey string `toml:"secret_key,omitempty"`
}

type Resolver struct {
	Upstream string `toml:"upstream,omitempty"`
}

type Stationd struct {
	Socket              string `toml:"socket,omitempty"`
	ResolverHostAddress string `toml:"resolver_host_address"`
}

type SandboxImage struct {
	Path      string `toml:"path"`
	SizeBytes uint64 `toml:"size_bytes"`
}

type Sandboxes struct {
	Device string        `toml:"device,omitempty"`
	Image  *SandboxImage `toml:"image,omitempty"`
}

type Config struct {
	Dispatch   Dispatch   `toml:"dispatch"`
	Litestream Litestream `toml:"litestream"`
	Resolver   Resolver   `toml:"resolver"`
	Stationd   Stationd   `toml:"stationd"`
	Sandboxes  *Sandboxes `toml:"sandboxes,omitempty"`
}

func Path(etcDir string) string { return filepath.Join(etcDir, fileName) }

func Load(etcDir string) (*Config, error) {
	b, err := os.ReadFile(Path(etcDir))
	if err != nil {
		return nil, err
	}
	var c Config
	if err := toml.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("%s: %w", Path(etcDir), err)
	}
	return &c, nil
}

func Exists(etcDir string) bool {
	_, err := os.Stat(Path(etcDir))
	return err == nil
}

func Save(etcDir string, c *Config) error {
	b, err := toml.Marshal(c)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(etcDir, 0o755); err != nil {
		return err
	}
	return fsx.WriteFile(Path(etcDir), b, 0o600)
}

func NewMasterKey() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func (c *Config) RecoveryKey() (string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(c.Dispatch.MasterKey)
	if err != nil || len(raw) != 32 {
		return "", errors.New("dispatch.master_key in host.toml is not 32 base64url bytes")
	}
	return recoveryLabel + strings.TrimRight(base32.StdEncoding.EncodeToString(raw), "="), nil
}

func MasterKeyFromRecovery(recovery string) (string, error) {
	text, ok := strings.CutPrefix(strings.TrimSpace(recovery), recoveryLabel)
	if !ok {
		return "", fmt.Errorf("a recovery key starts with %s", recoveryLabel)
	}
	raw, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ToUpper(text))
	if err != nil || len(raw) != 32 {
		return "", errors.New("the recovery key is not 32 base32 bytes")
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func (c *Config) BucketConfigured() bool { return c.Litestream.Bucket != "" }

var bucketPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)

func (l Litestream) Validate() error {
	switch {
	case !bucketPattern.MatchString(l.Bucket):
		return fmt.Errorf("litestream.bucket %q is not a bucket name", l.Bucket)
	case !endpointAllowed(l.Endpoint):
		return fmt.Errorf("litestream.endpoint %q is not an https URL, nor an http URL on a private or loopback address", l.Endpoint)
	case l.AccessKey == "" || l.SecretKey == "":
		return errors.New("litestream needs access_key and secret_key")
	}
	return nil
}

func endpointAllowed(endpoint string) bool {
	if endpoint == "" {
		return true
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || u.User != nil {
		return false
	}
	if u.Scheme == "https" {
		return true
	}
	addr, err := netip.ParseAddr(u.Hostname())
	return u.Scheme == "http" && err == nil && (addr.IsPrivate() || addr.IsLoopback())
}
