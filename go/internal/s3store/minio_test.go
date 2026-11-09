package s3store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"math/rand/v2"
	"os"
	"runtime"
	"strconv"
	"testing"
	"time"
)

type stream struct {
	rng       *rand.ChaCha8
	remaining int64
}

func (s *stream) Read(p []byte) (int, error) {
	if s.remaining == 0 {
		return 0, io.EOF
	}
	n := int64(len(p))
	if n > s.remaining {
		n = s.remaining
	}
	s.rng.Read(p[:n])
	s.remaining -= n
	return int(n), nil
}

func TestAgainstARealBucket(t *testing.T) {
	endpoint := os.Getenv("SLY_TEST_S3_ENDPOINT")
	if endpoint == "" {
		t.Skip("set SLY_TEST_S3_ENDPOINT, SLY_TEST_S3_BUCKET, SLY_TEST_S3_ACCESS_KEY and SLY_TEST_S3_SECRET_KEY to run against MinIO")
	}
	mib, _ := strconv.Atoi(os.Getenv("SLY_TEST_S3_MIB"))
	if mib == 0 {
		mib = 512
	}
	c, err := New(Target{Endpoint: endpoint, Bucket: os.Getenv("SLY_TEST_S3_BUCKET"), Prefix: "s3store-test"}, Credentials{AccessKeyID: os.Getenv("SLY_TEST_S3_ACCESS_KEY"), SecretAccessKey: os.Getenv("SLY_TEST_S3_SECRET_KEY")})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	size := int64(mib) << 20
	var seed [32]byte
	up := sha256.New()
	t0 := time.Now()
	n, err := c.Put(ctx, "big.bin", io.TeeReader(&stream{rng: rand.NewChaCha8(seed), remaining: size}, up))
	if err != nil || n != size {
		t.Fatalf("put: %d %v", n, err)
	}
	uploadTook := time.Since(t0)
	defer c.Delete(ctx, "big.bin")
	stored, err := c.Head(ctx, "big.bin")
	if err != nil || stored != size {
		t.Fatalf("head: %d %v", stored, err)
	}
	t1 := time.Now()
	rc, length, err := c.Get(ctx, "big.bin")
	if err != nil || length != size {
		t.Fatalf("get: %d %v", length, err)
	}
	down := sha256.New()
	if _, err := io.Copy(down, rc); err != nil {
		t.Fatal(err)
	}
	rc.Close()
	downloadTook := time.Since(t1)
	if hex.EncodeToString(up.Sum(nil)) != hex.EncodeToString(down.Sum(nil)) {
		t.Fatal("downloaded bytes differ from the uploaded bytes")
	}
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	t.Logf("%d MiB: upload %s (%.0f MiB/s), download %s (%.0f MiB/s), process memory obtained from the OS %d MiB", mib, uploadTook.Round(time.Millisecond), float64(mib)/uploadTook.Seconds(), downloadTook.Round(time.Millisecond), float64(mib)/downloadTook.Seconds(), m.Sys>>20)
	if m.Sys > 400<<20 {
		t.Fatalf("a %d MiB object grew the process to %d MiB; the stream is being buffered", mib, m.Sys>>20)
	}
}
