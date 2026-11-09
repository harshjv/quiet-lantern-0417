package main

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"time"

	protocommon "github.com/sigstore/protobuf-specs/gen/pb-go/common/v1"
	prototrustroot "github.com/sigstore/protobuf-specs/gen/pb-go/trustroot/v1"
	"github.com/sigstore/sigstore-go/pkg/root"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/timestamppb"
)

const (
	rootKeyFile         = "root-ca.key.pem"
	rootCertFile        = "root-ca.crt.pem"
	intermediateKeyFile = "fulcio-intermediate.key.pem"
	intermediateCrtFile = "fulcio-intermediate.crt.pem"
	rekorKeyFile        = "rekor.key.pem"
	ctlogKeyFile        = "ctlog.key.pem"
	tufKeyFile          = "tuf-ed25519.key.pem"
	trustedRootFile     = "trusted_root.json"
	trustedRootMedia    = "application/vnd.dev.sigstore.trustedroot+json;version=0.1"
	rekorBaseURL        = "https://rekor.fake.test"
	rekorHostname       = "rekor.fake.test"
	fulcioURL           = "https://fulcio.fake.test"
	ctlogURL            = "https://ctfe.fake.test/test"
)

type authority struct {
	dir              string
	rootCert         *x509.Certificate
	intermediateCert *x509.Certificate
	intermediateKey  *ecdsa.PrivateKey
	rekorKey         *ecdsa.PrivateKey
	ctlogKey         *ecdsa.PrivateKey
}

func keysDir(dir string) string { return filepath.Join(dir, "keys") }

func cmdInit(args []string) error {
	fs := flag.NewFlagSet("init", flag.ExitOnError)
	dir := fs.String("dir", "", "state directory")
	force := fs.Bool("force", false, "overwrite existing keys")
	fs.Parse(args)
	if *dir == "" {
		return errors.New("--dir is required")
	}
	kd := keysDir(*dir)
	if _, err := os.Stat(filepath.Join(kd, rootKeyFile)); err == nil && !*force {
		return fmt.Errorf("keys already exist in %s; pass --force to regenerate", kd)
	}
	if *force {
		for _, name := range []string{rootKeyFile, rootCertFile, intermediateKeyFile, intermediateCrtFile, rekorKeyFile, ctlogKeyFile} {
			os.Remove(filepath.Join(kd, name))
		}
		os.RemoveAll(filepath.Join(*dir, "rekor"))
	}
	if err := os.MkdirAll(kd, 0o700); err != nil {
		return err
	}
	now := time.Now().UTC().Truncate(time.Second)
	rootKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	rootTmpl := &x509.Certificate{
		SerialNumber:          randomSerial(),
		Subject:               pkix.Name{CommonName: "testsign root (TEST ONLY)", Organization: []string{"stationly-test"}},
		NotBefore:             now.Add(-24 * time.Hour),
		NotAfter:              now.Add(10 * 365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            1,
	}
	rootDER, err := x509.CreateCertificate(rand.Reader, rootTmpl, rootTmpl, rootKey.Public(), rootKey)
	if err != nil {
		return err
	}
	rootCert, _ := x509.ParseCertificate(rootDER)
	interKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	interTmpl := &x509.Certificate{
		SerialNumber:          randomSerial(),
		Subject:               pkix.Name{CommonName: "testsign intermediate (TEST ONLY)", Organization: []string{"stationly-test"}},
		NotBefore:             now.Add(-24 * time.Hour),
		NotAfter:              now.Add(5 * 365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageCodeSigning},
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLenZero:        true,
	}
	interDER, err := x509.CreateCertificate(rand.Reader, interTmpl, rootCert, interKey.Public(), rootKey)
	if err != nil {
		return err
	}
	rekorKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	ctlogKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	if err := writePrivateKey(filepath.Join(kd, rootKeyFile), rootKey); err != nil {
		return err
	}
	if err := writeCert(filepath.Join(kd, rootCertFile), rootDER); err != nil {
		return err
	}
	if err := writePrivateKey(filepath.Join(kd, intermediateKeyFile), interKey); err != nil {
		return err
	}
	if err := writeCert(filepath.Join(kd, intermediateCrtFile), interDER); err != nil {
		return err
	}
	if err := writePrivateKey(filepath.Join(kd, rekorKeyFile), rekorKey); err != nil {
		return err
	}
	if err := writePrivateKey(filepath.Join(kd, ctlogKeyFile), ctlogKey); err != nil {
		return err
	}
	a, err := loadAuthority(*dir)
	if err != nil {
		return err
	}
	tr, err := a.trustedRootJSON(now.Add(-time.Hour))
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(*dir, trustedRootFile), tr, 0o644); err != nil {
		return err
	}
	loaded, err := root.NewTrustedRootFromJSON(tr)
	if err != nil {
		return fmt.Errorf("trusted root does not load: %w", err)
	}
	rekorID, _ := logID(a.rekorKey.Public())
	ctID, _ := logID(a.ctlogKey.Public())
	return printJSON(map[string]any{
		"ok":                      true,
		"trusted_root":            filepath.Join(*dir, trustedRootFile),
		"rekor_log_id":            fmt.Sprintf("%x", rekorID),
		"ctlog_log_id":            fmt.Sprintf("%x", ctID),
		"certificate_authorities": len(loaded.FulcioCertificateAuthorities()),
		"rekor_logs":              len(loaded.RekorLogs()),
		"ct_logs":                 len(loaded.CTLogs()),
		"timestamp_authorities":   len(loaded.TimestampingAuthorities()),
	})
}

func (a *authority) trustedRootJSON(start time.Time) ([]byte, error) {
	rekorDER, err := x509.MarshalPKIXPublicKey(a.rekorKey.Public())
	if err != nil {
		return nil, err
	}
	ctDER, err := x509.MarshalPKIXPublicKey(a.ctlogKey.Public())
	if err != nil {
		return nil, err
	}
	rekorID := sha256.Sum256(rekorDER)
	ctID := sha256.Sum256(ctDER)
	validFor := &protocommon.TimeRange{Start: timestamppb.New(start)}
	tr := &prototrustroot.TrustedRoot{
		MediaType: trustedRootMedia,
		Tlogs: []*prototrustroot.TransparencyLogInstance{{
			BaseUrl:       rekorBaseURL,
			HashAlgorithm: protocommon.HashAlgorithm_SHA2_256,
			PublicKey: &protocommon.PublicKey{
				RawBytes:   rekorDER,
				KeyDetails: protocommon.PublicKeyDetails_PKIX_ECDSA_P256_SHA_256,
				ValidFor:   validFor,
			},
			LogId: &protocommon.LogId{KeyId: rekorID[:]},
		}},
		CertificateAuthorities: []*prototrustroot.CertificateAuthority{{
			Subject: &protocommon.DistinguishedName{Organization: "stationly-test", CommonName: "testsign (TEST ONLY)"},
			Uri:     fulcioURL,
			CertChain: &protocommon.X509CertificateChain{Certificates: []*protocommon.X509Certificate{
				{RawBytes: a.intermediateCert.Raw},
				{RawBytes: a.rootCert.Raw},
			}},
			ValidFor: validFor,
		}},
		Ctlogs: []*prototrustroot.TransparencyLogInstance{{
			BaseUrl:       ctlogURL,
			HashAlgorithm: protocommon.HashAlgorithm_SHA2_256,
			PublicKey: &protocommon.PublicKey{
				RawBytes:   ctDER,
				KeyDetails: protocommon.PublicKeyDetails_PKIX_ECDSA_P256_SHA_256,
				ValidFor:   validFor,
			},
			LogId: &protocommon.LogId{KeyId: ctID[:]},
		}},
	}
	b, err := protojson.MarshalOptions{Multiline: true, Indent: "  "}.Marshal(tr)
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

func loadAuthority(dir string) (*authority, error) {
	kd := keysDir(dir)
	a := &authority{dir: dir}
	var err error
	if a.rootCert, err = readCert(filepath.Join(kd, rootCertFile)); err != nil {
		return nil, err
	}
	if a.intermediateCert, err = readCert(filepath.Join(kd, intermediateCrtFile)); err != nil {
		return nil, err
	}
	if a.intermediateKey, err = readECKey(filepath.Join(kd, intermediateKeyFile)); err != nil {
		return nil, err
	}
	if a.rekorKey, err = readECKey(filepath.Join(kd, rekorKeyFile)); err != nil {
		return nil, err
	}
	if a.ctlogKey, err = readECKey(filepath.Join(kd, ctlogKeyFile)); err != nil {
		return nil, err
	}
	return a, nil
}

func logID(pub crypto.PublicKey) ([]byte, error) {
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(der)
	return sum[:], nil
}

func randomSerial() *big.Int {
	n, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 159))
	if err != nil {
		panic(err)
	}
	return n
}

func writePrivateKey(path string, key crypto.PrivateKey) error {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return err
	}
	return os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600)
}

func writeCert(path string, der []byte) error {
	return os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644)
}

func readPEM(path, typ string) ([]byte, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(b)
	if block == nil || block.Type != typ {
		return nil, fmt.Errorf("%s: expected PEM %s", path, typ)
	}
	return block.Bytes, nil
}

func readCert(path string) (*x509.Certificate, error) {
	der, err := readPEM(path, "CERTIFICATE")
	if err != nil {
		return nil, err
	}
	return x509.ParseCertificate(der)
}

func readPrivateKey(path string) (crypto.PrivateKey, error) {
	der, err := readPEM(path, "PRIVATE KEY")
	if err != nil {
		return nil, err
	}
	return x509.ParsePKCS8PrivateKey(der)
}

func readECKey(path string) (*ecdsa.PrivateKey, error) {
	k, err := readPrivateKey(path)
	if err != nil {
		return nil, err
	}
	ec, ok := k.(*ecdsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("%s: not an ECDSA key", path)
	}
	return ec, nil
}

func readEd25519Key(path string) (ed25519.PrivateKey, error) {
	k, err := readPrivateKey(path)
	if err != nil {
		return nil, err
	}
	ed, ok := k.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("%s: not an ed25519 key", path)
	}
	return ed, nil
}
