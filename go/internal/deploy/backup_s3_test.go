//go:build linux

package deploy

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/s3store"
	"github.com/harshjv/stationly/go/internal/s3store/fakes3"
)

func seedVolume(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	random := make([]byte, 3<<20)
	if _, err := rand.Read(random); err != nil {
		t.Fatal(err)
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(root, "base", "nested"), 0o750))
	must(os.WriteFile(filepath.Join(root, "marker"), []byte("backup-content\n"), 0o640))
	must(os.WriteFile(filepath.Join(root, "base", "nested", "random.bin"), random, 0o600))
	must(os.Symlink("base/nested/random.bin", filepath.Join(root, "link")))
	must(os.WriteFile(filepath.Join(root, "empty"), nil, 0o644))
	return root
}

func uploaded(t *testing.T, root string) (*fakes3.Server, *s3store.Client, string, int64) {
	t.Helper()
	fake := fakes3.New("AKIAUPLOAD")
	srv := httptest.NewServer(fake)
	t.Cleanup(srv.Close)
	store, err := s3store.New(s3store.Target{Endpoint: srv.URL, Bucket: "backups", Prefix: "prod"}, s3store.Credentials{AccessKeyID: "AKIAUPLOAD", SecretAccessKey: "secret-secret-secret"})
	if err != nil {
		t.Fatal(err)
	}
	pr, pw := io.Pipe()
	type result struct {
		sum      string
		archived int64
		err      error
	}
	done := make(chan result, 1)
	go func() {
		_, archived, sum, err := archive(context.Background(), root, pw)
		pw.CloseWithError(err)
		done <- result{sum, archived, err}
	}()
	sent, err := store.Put(context.Background(), "vol-1.tar.zst", pr)
	if err != nil {
		t.Fatal(err)
	}
	r := <-done
	if r.err != nil || sent != r.archived {
		t.Fatalf("archive %v, sent %d of %d", r.err, sent, r.archived)
	}
	return fake, store, r.sum, r.archived
}

func TestArchiveStreamedToS3ExtractsToTheSameTree(t *testing.T) {
	src := seedVolume(t)
	want, err := TreeSHA256(src)
	if err != nil {
		t.Fatal(err)
	}
	_, store, sum, archived := uploaded(t, src)
	if size, err := store.Head(context.Background(), "vol-1.tar.zst"); err != nil || size != archived {
		t.Fatalf("stored %d of %d: %v", size, archived, err)
	}
	rc, _, err := store.Get(context.Background(), "vol-1.tar.zst")
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	dst := t.TempDir()
	down := newTeeHash(rc)
	_, files, err := extractArchive(dst, down, down, sum)
	if err != nil {
		t.Fatal(err)
	}
	if files != 3 {
		t.Fatalf("extracted %d files", files)
	}
	got, err := TreeSHA256(dst)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("restored tree %s differs from the source %s", got, want)
	}
}

func TestExtractRejectsACorruptedDownload(t *testing.T) {
	src := seedVolume(t)
	fake, store, sum, _ := uploaded(t, src)
	key := "backups/prod/vol-1.tar.zst"
	stored, _ := fake.Object(key)
	tampered := bytes.Clone(stored)
	tampered = append(tampered, 0, 0, 0, 0)
	fake.Set(key, tampered)
	rc, _, err := store.Get(context.Background(), "vol-1.tar.zst")
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	down := newTeeHash(rc)
	_, _, err = extractArchive(t.TempDir(), down, down, sum)
	if err == nil || !strings.Contains(err.Error(), "sha256") {
		t.Fatalf("a changed archive was accepted: %v", err)
	}
}

func deliveryOf(access, secret string) protocol.SecretsDeliverBody {
	value := func(v string) string { return base64.RawURLEncoding.EncodeToString([]byte(v)) }
	return protocol.SecretsDeliverBody{Values: []protocol.SecretValue{
		{Key: backupAccessKeyID, Injection: protocol.InjectionEnv, Value: value(access)},
		{Key: backupSecretAccessKey, Injection: protocol.InjectionEnv, Value: value(secret)},
	}}
}

func TestDestinationFollowsTheEndpointRuleAndTakesCredentialsOnce(t *testing.T) {
	s := &Station{opts: Options{BackupRoot: t.TempDir()}, backupSecrets: map[string]backupCredential{}}
	str := func(v string) *string { return &v }
	target := func(endpoint string) protocol.BackupTarget {
		return protocol.BackupTarget{Type: protocol.BackupTargetTypeS3, Endpoint: str(endpoint), Bucket: str("backups"), Prefix: str("prod")}
	}
	creds, err := decodeBackupCredentials(deliveryOf("AKIAEXAMPLE", "wJalrXUtnFEMI/K7MDENG"))
	if err != nil {
		t.Fatal(err)
	}
	s.storeBackupCredentials("snp_A", creds, time.Now())
	if _, failure := s.destinationFor("snp_A", target("http://8.8.8.8:9000")); failure == nil || failure.Code != string(protocol.ErrorCodeValidationFailed) {
		t.Fatalf("a public http endpoint was accepted: %+v", failure)
	}
	if _, ok := s.backupSecrets["snp_A"]; !ok {
		t.Fatal("a refused target consumed the credentials")
	}
	dest, failure := s.destinationFor("snp_A", target("http://10.0.0.5:9000"))
	if failure != nil || dest.store == nil || dest.where != "s3://backups/prod" {
		t.Fatalf("private http endpoint refused: %+v", failure)
	}
	if _, failure := s.destinationFor("snp_A", target("http://10.0.0.5:9000")); failure == nil || failure.Code != string(protocol.ErrorCodeSecretsUnavailable) {
		t.Fatalf("credentials were usable twice: %+v", failure)
	}
}

func TestErrorsNeverCarryTheDeliveredCredentials(t *testing.T) {
	s := &Station{opts: Options{BackupRoot: t.TempDir()}, backupSecrets: map[string]backupCredential{}}
	str := func(v string) *string { return &v }
	s.storeBackupCredentials("snp_A", s3store.Credentials{AccessKeyID: "AKIAEXAMPLEKEY", SecretAccessKey: "wJalrXUtnFEMI/K7MDENG"}, time.Now())
	dest, failure := s.destinationFor("snp_A", protocol.BackupTarget{Type: protocol.BackupTargetTypeS3, Endpoint: str("https://s3.example.com"), Bucket: str("backups"), Prefix: str("")})
	if failure != nil {
		t.Fatal(failure)
	}
	scrubbed := dest.scrub(io.ErrUnexpectedEOF)
	if scrubbed != io.ErrUnexpectedEOF && scrubbed.Error() != io.ErrUnexpectedEOF.Error() {
		t.Fatal("an error without secrets was changed")
	}
	leaky := dest.scrub(&leak{"InvalidAccessKeyId AKIAEXAMPLEKEY signature wJalrXUtnFEMI/K7MDENG and wJalrXUtnFEMI%2FK7MDENG"})
	for _, secret := range []string{"AKIAEXAMPLEKEY", "wJalrXUtnFEMI/K7MDENG", "wJalrXUtnFEMI%2FK7MDENG"} {
		if strings.Contains(leaky.Error(), secret) {
			t.Fatalf("%q survived in %q", secret, leaky)
		}
	}
}

type leak struct{ text string }

func (l *leak) Error() string { return l.text }

func TestStaleCredentialsExpire(t *testing.T) {
	s := &Station{backupSecrets: map[string]backupCredential{}}
	old := time.Now().Add(-2 * backupSecretsTTL)
	s.storeBackupCredentials("snp_OLD", s3store.Credentials{AccessKeyID: "a", SecretAccessKey: "b"}, old)
	s.storeBackupCredentials("snp_NEW", s3store.Credentials{AccessKeyID: "a", SecretAccessKey: "b"}, time.Now())
	if _, ok := s.backupSecrets["snp_OLD"]; ok {
		t.Fatal("stale credentials were kept")
	}
	if _, ok := s.backupSecrets["snp_NEW"]; !ok {
		t.Fatal("fresh credentials were dropped")
	}
}
