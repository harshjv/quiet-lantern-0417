package main

import (
	"bytes"
	"crypto"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	sigtuf "github.com/sigstore/sigstore-go/pkg/tuf"
	"github.com/sigstore/sigstore/pkg/signature"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

const (
	tufTarget  = "trusted_root.json"
	tufRootTTL = 365 * 24 * time.Hour
)

type fileFetcher struct {
	base string
	root string
}

func (f fileFetcher) DownloadFile(urlPath string, maxLength int64, _ time.Duration) ([]byte, error) {
	rel, ok := strings.CutPrefix(urlPath, f.base)
	if !ok {
		return nil, fmt.Errorf("fetcher: %s is outside %s", urlPath, f.base)
	}
	b, err := os.ReadFile(filepath.Join(f.root, filepath.FromSlash(strings.TrimPrefix(rel, "/"))))
	if errors.Is(err, os.ErrNotExist) {
		return nil, &metadata.ErrDownloadHTTP{StatusCode: 404, URL: urlPath}
	}
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > maxLength {
		return nil, &metadata.ErrDownloadLengthMismatch{Msg: urlPath + " exceeds max length"}
	}
	return b, nil
}

func loadOrCreateTUFKey(dir string) (ed25519.PrivateKey, error) {
	path := filepath.Join(keysDir(dir), tufKeyFile)
	if _, err := os.Stat(path); err == nil {
		return readEd25519Key(path)
	}
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(keysDir(dir), 0o700); err != nil {
		return nil, err
	}
	return key, writePrivateKey(path, key)
}

func cmdTUF(args []string) error {
	fs := flag.NewFlagSet("tuf", flag.ExitOnError)
	dir := fs.String("dir", "", "state directory")
	expiresDays := fs.Int("expires-days", 7, "expiry of targets, snapshot and timestamp")
	fs.Parse(args)
	if *dir == "" {
		return errors.New("--dir is required")
	}
	absDir, err := filepath.Abs(*dir)
	if err != nil {
		return err
	}
	*dir = absDir
	tr, err := os.ReadFile(filepath.Join(*dir, trustedRootFile))
	if err != nil {
		return fmt.Errorf("run init first: %w", err)
	}
	key, err := loadOrCreateTUFKey(*dir)
	if err != nil {
		return err
	}
	signer, err := signature.LoadSigner(key, crypto.Hash(0))
	if err != nil {
		return err
	}
	repo := filepath.Join(*dir, "tuf")
	if err := os.MkdirAll(filepath.Join(repo, "targets"), 0o755); err != nil {
		return err
	}
	now := time.Now().UTC().Truncate(time.Second)
	expires := now.Add(time.Duration(*expiresDays) * 24 * time.Hour)

	rootMD, err := ensureRoot(repo, key, signer, now, expires)
	if err != nil {
		return err
	}
	version := nextVersion(repo)

	targets := metadata.Targets(expires)
	targets.Signed.Version = version
	tf, err := metadata.TargetFile().FromBytes(tufTarget, tr, "sha256")
	if err != nil {
		return err
	}
	targets.Signed.Targets[tufTarget] = tf
	if _, err := targets.Sign(signer); err != nil {
		return err
	}
	sum := sha256.Sum256(tr)
	targetPath := filepath.Join(repo, "targets", fmt.Sprintf("%x.%s", sum, tufTarget))
	if err := os.WriteFile(targetPath, tr, 0o644); err != nil {
		return err
	}
	if err := targets.ToFile(filepath.Join(repo, fmt.Sprintf("%d.targets.json", version)), true); err != nil {
		return err
	}
	snapshot := metadata.Snapshot(expires)
	snapshot.Signed.Version = version
	snapshot.Signed.Meta["targets.json"] = metadata.MetaFile(version)
	if _, err := snapshot.Sign(signer); err != nil {
		return err
	}
	if err := snapshot.ToFile(filepath.Join(repo, fmt.Sprintf("%d.snapshot.json", version)), true); err != nil {
		return err
	}
	timestamp := metadata.Timestamp(expires)
	timestamp.Signed.Version = version
	timestamp.Signed.Meta["snapshot.json"] = metadata.MetaFile(version)
	if _, err := timestamp.Sign(signer); err != nil {
		return err
	}
	if err := timestamp.ToFile(filepath.Join(repo, "timestamp.json"), true); err != nil {
		return err
	}

	rootBytes, err := os.ReadFile(filepath.Join(repo, "root.json"))
	if err != nil {
		return err
	}
	cache := filepath.Join(*dir, "tuf-cache")
	base := "file://" + repo
	t := time.Now()
	client, err := sigtuf.New(&sigtuf.Options{
		Root:              rootBytes,
		RepositoryBaseURL: base,
		CachePath:         cache,
		Fetcher:           fileFetcher{base: base, root: repo},
	})
	if err != nil {
		return fmt.Errorf("sigstore-go tuf client: %w", err)
	}
	got, err := client.GetTarget(tufTarget)
	if err != nil {
		return fmt.Errorf("sigstore-go GetTarget: %w", err)
	}
	if !bytes.Equal(got, tr) {
		return errors.New("sigstore-go GetTarget returned bytes that differ from trusted_root.json")
	}
	return printJSON(map[string]any{
		"ok":                 true,
		"repo":               repo,
		"root_version":       rootMD.Signed.Version,
		"targets_version":    version,
		"snapshot_version":   version,
		"timestamp_version":  version,
		"expires":            expires.Format(time.RFC3339),
		"target":             targetPath,
		"client_cache":       cache,
		"client_fetch_bytes": len(got),
		"client_ms":          ms(time.Since(t)),
	})
}

func nextVersion(repo string) int64 {
	latest := int64(0)
	ts, err := metadata.Timestamp().FromFile(filepath.Join(repo, "timestamp.json"))
	if err != nil {
		return 1
	}
	latest = max(latest, ts.Signed.Version)
	sm := ts.Signed.Meta["snapshot.json"]
	if sm == nil {
		return latest + 1
	}
	latest = max(latest, sm.Version)
	snap, err := metadata.Snapshot().FromFile(filepath.Join(repo, fmt.Sprintf("%d.snapshot.json", sm.Version)))
	if err == nil && snap.Signed.Meta["targets.json"] != nil {
		latest = max(latest, snap.Signed.Meta["targets.json"].Version)
	}
	return latest + 1
}

func ensureRoot(repo string, key ed25519.PrivateKey, signer signature.Signer, now, expires time.Time) (*metadata.Metadata[metadata.RootType], error) {
	pub, err := metadata.KeyFromPublicKey(key.Public())
	if err != nil {
		return nil, err
	}
	keyID, err := pub.ID()
	if err != nil {
		return nil, err
	}
	rootPath := filepath.Join(repo, "root.json")
	existing, err := metadata.Root().FromFile(rootPath)
	if err == nil {
		if _, ok := existing.Signed.Keys[keyID]; !ok {
			return nil, fmt.Errorf("%s is signed by a different TUF key; remove %s to start over", rootPath, repo)
		}
		if existing.Signed.Expires.After(expires) {
			return existing, nil
		}
		existing.Signed.Version++
		existing.Signed.Expires = now.Add(tufRootTTL)
		existing.ClearSignatures()
		return writeRoot(repo, existing, signer)
	}
	rootMD := metadata.Root(now.Add(tufRootTTL))
	for _, role := range []string{metadata.ROOT, metadata.TARGETS, metadata.SNAPSHOT, metadata.TIMESTAMP} {
		if err := rootMD.Signed.AddKey(pub, role); err != nil {
			return nil, err
		}
	}
	return writeRoot(repo, rootMD, signer)
}

func writeRoot(repo string, rootMD *metadata.Metadata[metadata.RootType], signer signature.Signer) (*metadata.Metadata[metadata.RootType], error) {
	if _, err := rootMD.Sign(signer); err != nil {
		return nil, err
	}
	if err := rootMD.ToFile(filepath.Join(repo, fmt.Sprintf("%d.root.json", rootMD.Signed.Version)), true); err != nil {
		return nil, err
	}
	if err := rootMD.ToFile(filepath.Join(repo, "root.json"), true); err != nil {
		return nil, err
	}
	return rootMD, nil
}
