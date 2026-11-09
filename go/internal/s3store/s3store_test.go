package s3store

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/harshjv/stationly/go/internal/s3store/fakes3"
)

func clientFor(t *testing.T, f *fakes3.Server, secret string) *Client {
	t.Helper()
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	c, err := New(Target{Endpoint: srv.URL, Bucket: "backups", Prefix: "volumes/prod"}, Credentials{AccessKeyID: f.Access, SecretAccessKey: secret})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func randomBytes(t *testing.T, n int) []byte {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return b
}

func TestPutSmallObjectIsOneRequestAndRoundTrips(t *testing.T) {
	f := fakes3.New("AKIATEST")
	c := clientFor(t, f, "secretsecret")
	data := randomBytes(t, 1<<20)
	n, err := c.Put(context.Background(), "a.tar.zst", bytes.NewReader(data))
	if err != nil || n != int64(len(data)) {
		t.Fatalf("put: %d %v", n, err)
	}
	if f.Stats().Completed != 0 {
		t.Fatalf("a small object used a multipart upload")
	}
	if stored, _ := f.Object("backups/volumes/prod/a.tar.zst"); !bytes.Equal(stored, data) {
		t.Fatal("stored bytes differ")
	}
	size, err := c.Head(context.Background(), "a.tar.zst")
	if err != nil || size != int64(len(data)) {
		t.Fatalf("head: %d %v", size, err)
	}
	rc, length, err := c.Get(context.Background(), "a.tar.zst")
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(rc)
	rc.Close()
	if length != int64(len(data)) || sha256.Sum256(got) != sha256.Sum256(data) {
		t.Fatal("downloaded bytes differ")
	}
}

func TestPutStreamsLargeObjectInParts(t *testing.T) {
	f := fakes3.New("AKIATEST")
	c := clientFor(t, f, "secretsecret")
	data := randomBytes(t, 2*PartSize+12345)
	pr, pw := io.Pipe()
	go func() {
		for off := 0; off < len(data); off += 1 << 20 {
			pw.Write(data[off:min(off+1<<20, len(data))])
		}
		pw.Close()
	}()
	n, err := c.Put(context.Background(), "big.tar.zst", pr)
	if err != nil || n != int64(len(data)) {
		t.Fatalf("put: %d %v", n, err)
	}
	if st := f.Stats(); st.Completed != 1 || st.Aborted != 0 {
		t.Fatalf("completed %d aborted %d", st.Completed, st.Aborted)
	}
	if stored, _ := f.Object("backups/volumes/prod/big.tar.zst"); sha256.Sum256(stored) != sha256.Sum256(data) {
		t.Fatal("assembled object differs")
	}
}

func TestPutAtExactPartBoundary(t *testing.T) {
	f := fakes3.New("AKIATEST")
	c := clientFor(t, f, "secretsecret")
	data := randomBytes(t, PartSize)
	n, err := c.Put(context.Background(), "edge", bytes.NewReader(data))
	if stored, _ := f.Object("backups/volumes/prod/edge"); err != nil || n != int64(len(data)) || !bytes.Equal(stored, data) {
		t.Fatalf("put at the boundary: %d %v", n, err)
	}
}

type failingReader struct {
	sent int
}

func (r *failingReader) Read(p []byte) (int, error) {
	if r.sent >= PartSize+1024 {
		return 0, fmt.Errorf("the volume went away")
	}
	n := min(len(p), PartSize+1024-r.sent)
	r.sent += n
	return n, nil
}

func TestPutAbortsTheMultipartUploadWhenTheSourceFails(t *testing.T) {
	f := fakes3.New("AKIATEST")
	c := clientFor(t, f, "secretsecret")
	_, err := c.Put(context.Background(), "broken", &failingReader{})
	if err == nil || !strings.Contains(err.Error(), "the volume went away") {
		t.Fatalf("expected the source error, got %v", err)
	}
	if st := f.Stats(); st.Aborted != 1 || st.Open != 0 || st.Objects != 0 {
		t.Fatalf("aborted %d, open uploads %d, objects %d", st.Aborted, st.Open, st.Objects)
	}
}

func TestDeleteAndNotFound(t *testing.T) {
	f := fakes3.New("AKIATEST")
	c := clientFor(t, f, "secretsecret")
	if err := c.PutBytes(context.Background(), "m.json", []byte("{}")); err != nil {
		t.Fatal(err)
	}
	if err := c.Delete(context.Background(), "m.json"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Head(context.Background(), "m.json"); !IsNotFound(err) {
		t.Fatalf("head after delete: %v", err)
	}
	if _, _, err := c.Get(context.Background(), "m.json"); !IsNotFound(err) {
		t.Fatalf("get after delete: %v", err)
	}
}

func TestRequestsAreSignedWithTheDeliveredKey(t *testing.T) {
	f := fakes3.New("AKIATEST")
	srv := httptest.NewServer(f)
	defer srv.Close()
	c, err := New(Target{Endpoint: srv.URL, Bucket: "backups"}, Credentials{AccessKeyID: "AKIAOTHER", SecretAccessKey: "secretsecret"})
	if err != nil {
		t.Fatal(err)
	}
	if err := c.PutBytes(context.Background(), "x", []byte("x")); err == nil {
		t.Fatal("a request signed with another key succeeded")
	}
	if f.Stats().Refused != 1 {
		t.Fatalf("server saw %d refused requests", f.Stats().Refused)
	}
}

func TestEndpointRule(t *testing.T) {
	cases := map[string]bool{
		"https://s3.eu-west-1.amazonaws.com":   true,
		"https://abc.r2.cloudflarestorage.com": true,
		"http://10.0.0.5:9000":                 true,
		"http://192.168.1.2:9000":              true,
		"http://127.0.0.1:9000":                true,
		"http://[::1]:9000":                    true,
		"http://8.8.8.8:9000":                  false,
		"http://minio.lan:9000":                false,
		"https://u:p@host":                     false,
		"ftp://10.0.0.5":                       false,
		"https://host/some/path":               false,
		"https://host?x=1":                     false,
		"":                                     false,
		"host:9000":                            false,
		"http://169.254.169.254":               false,
		"https://s3.example.com/":              true,
	}
	for endpoint, want := range cases {
		if got := ValidateEndpoint(endpoint) == nil; got != want {
			t.Errorf("%q: allowed %v, want %v", endpoint, got, want)
		}
	}
}

func TestTargetValidation(t *testing.T) {
	ok := Target{Endpoint: "https://s3.example.com", Bucket: "my-backups", Prefix: "prod/volumes"}
	if err := ok.Validate(); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*Target){
		"upper-case bucket": func(t *Target) { t.Bucket = "Backups" },
		"short bucket":      func(t *Target) { t.Bucket = "a" },
		"leading slash":     func(t *Target) { t.Prefix = "/prod" },
		"trailing slash":    func(t *Target) { t.Prefix = "prod/" },
		"dot dot":           func(t *Target) { t.Prefix = "prod/../x" },
		"space":             func(t *Target) { t.Prefix = "my volumes" },
	} {
		bad := ok
		mutate(&bad)
		if bad.Validate() == nil {
			t.Errorf("%s accepted", name)
		}
	}
	empty := ok
	empty.Prefix = ""
	if err := empty.Validate(); err != nil {
		t.Fatalf("empty prefix: %v", err)
	}
}

func TestRegionAndKeys(t *testing.T) {
	for host, want := range map[string]string{
		"s3.eu-west-1.amazonaws.com":   "eu-west-1",
		"s3-us-west-2.amazonaws.com":   "us-west-2",
		"s3.amazonaws.com":             "us-east-1",
		"abc.r2.cloudflarestorage.com": "auto",
		"minio.internal":               "us-east-1",
	} {
		if got := regionOf(host); got != want {
			t.Errorf("%s: %s, want %s", host, got, want)
		}
	}
	c := &Client{prefix: "a/b"}
	if c.Key("x") != "a/b/x" {
		t.Fatal(c.Key("x"))
	}
	if (&Client{}).Key("x") != "x" {
		t.Fatal("empty prefix")
	}
}
