package identity

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/url"
	"os"
	"path/filepath"

	"golang.org/x/crypto/curve25519"
)

const (
	dirName      = "identity"
	stationFile  = "station.json"
	keyFile      = "station.key"
	wireguardKey = "wireguard.key"
)

var b64 = base64.RawURLEncoding

type Station struct {
	StationID       string            `json:"station_id"`
	InstanceID      string            `json:"instance_id"`
	DispatchURL     string            `json:"dispatch_url"`
	RegistrySubnet  string            `json:"registry_subnet"`
	RegistryAddress string            `json:"registry_address"`
	Settings        map[string]string `json:"settings"`
}

type Identity struct {
	Station
	Key       ed25519.PrivateKey
	WireGuard []byte
}

type Keys struct {
	Key       ed25519.PrivateKey
	WireGuard []byte
}

func Dir(stateDir string) string {
	return filepath.Join(stateDir, dirName)
}

func (k Keys) IdentityPublic() string {
	return b64.EncodeToString(k.Key.Public().(ed25519.PublicKey))
}

func (k Keys) WireGuardPublic() (string, error) {
	pub, err := curve25519.X25519(k.WireGuard, curve25519.Basepoint)
	if err != nil {
		return "", err
	}
	return b64.EncodeToString(pub), nil
}

func NewKeys() (Keys, error) {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return Keys{}, err
	}
	wg := make([]byte, curve25519.ScalarSize)
	if _, err := rand.Read(wg); err != nil {
		return Keys{}, err
	}
	wg[0] &= 248
	wg[31] = (wg[31] & 127) | 64
	return Keys{Key: key, WireGuard: wg}, nil
}

func Exists(stateDir string) bool {
	_, err := os.Stat(filepath.Join(Dir(stateDir), stationFile))
	return err == nil
}

func Load(stateDir string) (*Identity, error) {
	dir := Dir(stateDir)
	b, err := os.ReadFile(filepath.Join(dir, stationFile))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("this station is not enrolled: %s is missing; run stationd enroll <token> --dispatch-url <url>", filepath.Join(dir, stationFile))
	}
	if err != nil {
		return nil, err
	}
	var st Station
	if err := json.Unmarshal(b, &st); err != nil {
		return nil, fmt.Errorf("%s: %w", stationFile, err)
	}
	seed, err := readKey(filepath.Join(dir, keyFile), ed25519.SeedSize)
	if err != nil {
		return nil, err
	}
	wg, err := readKey(filepath.Join(dir, wireguardKey), curve25519.ScalarSize)
	if err != nil {
		return nil, err
	}
	if err := CheckURL(st.DispatchURL); err != nil {
		return nil, err
	}
	return &Identity{Station: st, Key: ed25519.NewKeyFromSeed(seed), WireGuard: wg}, nil
}

func readKey(path string, size int) ([]byte, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	raw, err := b64.DecodeString(string(trim(b)))
	if err != nil || len(raw) != size {
		return nil, fmt.Errorf("%s does not hold a %d-byte base64url key", path, size)
	}
	return raw, nil
}

func trim(b []byte) []byte {
	for len(b) > 0 && (b[len(b)-1] == '\n' || b[len(b)-1] == '\r') {
		b = b[:len(b)-1]
	}
	return b
}

func Save(stateDir string, st Station, keys Keys) error {
	dir := Dir(stateDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := writeFile(filepath.Join(dir, keyFile), []byte(b64.EncodeToString(keys.Key.Seed())+"\n")); err != nil {
		return err
	}
	if err := writeFile(filepath.Join(dir, wireguardKey), []byte(b64.EncodeToString(keys.WireGuard)+"\n")); err != nil {
		return err
	}
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	return writeFile(filepath.Join(dir, stationFile), append(b, '\n'))
}

func writeFile(path string, b []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

func CheckURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("dispatch url %q: %w", raw, err)
	}
	switch u.Scheme {
	case "https":
		return nil
	case "http":
		host := u.Hostname()
		if host == "localhost" {
			return nil
		}
		if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
			return nil
		}
		return fmt.Errorf("dispatch url %s uses http to a non-loopback address; TLS is required for every non-loopback URL", raw)
	}
	return fmt.Errorf("dispatch url %s must use https, or http to a loopback address", raw)
}

func SocketURL(raw, path string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	}
	u.Path = path
	u.RawQuery = ""
	return u.String(), nil
}
