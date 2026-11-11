package depot

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"

	"github.com/google/go-containerregistry/pkg/authn"
	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/registry"
	"github.com/google/go-containerregistry/pkg/v1/random"
	"github.com/google/go-containerregistry/pkg/v1/remote"
)

func TestClientReadsAndDeletesThroughTheBearerFront(t *testing.T) {
	inner := registry.New(registry.Logger(log.New(io.Discard, "", 0)))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			w.Header().Set("WWW-Authenticate", `Bearer realm="http://`+r.Host+`/token",service="depot"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		inner.ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)
	front := netip.MustParseAddrPort(server.Listener.Addr().String())

	img, err := random.Image(512, 1)
	if err != nil {
		t.Fatal(err)
	}
	tag, err := name.NewTag(front.String()+"/prj/app:latest", name.Insecure)
	if err != nil {
		t.Fatal(err)
	}
	if err := remote.Write(tag, img, remote.WithAuth(&authn.Bearer{Token: "push"})); err != nil {
		t.Fatal(err)
	}
	digest, _ := img.Digest()
	rawManifest, _ := img.RawManifest()
	layers, _ := img.Layers()
	layerDigest, _ := layers[0].Digest()
	rc, _ := layers[0].Compressed()
	layerBytes, _ := io.ReadAll(rc)
	_ = rc.Close()

	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	c := NewClient(newSigner(key), front)
	ctx := context.Background()

	manifest, err := c.Manifest(ctx, "prj/app", digest.String())
	if err != nil || !bytes.Equal(manifest, rawManifest) {
		t.Fatalf("Manifest = %d bytes, %v; want the pushed manifest", len(manifest), err)
	}
	blob, err := c.Blob(ctx, "prj/app", layerDigest.String(), 1<<20)
	if err != nil || !bytes.Equal(blob, layerBytes) {
		t.Fatalf("Blob = %d bytes, %v; want the pushed layer", len(blob), err)
	}
	if status, err := c.Delete(ctx, "prj/app", digest.String()); status != Deleted || err != nil {
		t.Fatalf("Delete = %s, %v; want deleted", status, err)
	}
	if status, err := c.Delete(ctx, "prj/app", digest.String()); status != Absent || err != nil {
		t.Fatalf("second Delete = %s, %v; want absent", status, err)
	}
}
