package depot

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"strings"
	"time"
)

const ManifestAccept = "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json"

const maxManifestBytes = 4 << 20

type Client struct {
	signer *Signer
	base   string
	http   *http.Client
}

func NewClient(signer *Signer, front netip.AddrPort) *Client {
	return &Client{signer: signer, base: "http://" + front.String(), http: &http.Client{Timeout: 60 * time.Second}}
}

type Manifest struct {
	MediaType string
	Digest    string
	Body      []byte
}

func (c *Client) do(ctx context.Context, method, repo, path string, access Access) (*http.Response, error) {
	tok, err := c.signer.Mint("stationd", []Access{access}, PullTokenTTL)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+"/v2/"+repo+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Accept", ManifestAccept)
	return c.http.Do(req)
}

func (c *Client) Manifest(ctx context.Context, repo, ref string) (Manifest, error) {
	resp, err := c.do(ctx, http.MethodGet, repo, "/manifests/"+ref, Repository(repo, ActionPull))
	if err != nil {
		return Manifest{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Manifest{}, fmt.Errorf("GET %s manifest %s: %s", repo, ref, resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxManifestBytes))
	if err != nil {
		return Manifest{}, err
	}
	return Manifest{MediaType: strings.TrimSpace(strings.Split(resp.Header.Get("Content-Type"), ";")[0]), Digest: resp.Header.Get("Docker-Content-Digest"), Body: body}, nil
}

func (c *Client) Blob(ctx context.Context, repo, digest string, limit int64) ([]byte, error) {
	resp, err := c.do(ctx, http.MethodGet, repo, "/blobs/"+digest, Repository(repo, ActionPull))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s blob %s: %s", repo, digest, resp.Status)
	}
	return io.ReadAll(io.LimitReader(resp.Body, limit))
}

func (c *Client) Head(ctx context.Context, repo, ref string) (string, int, error) {
	resp, err := c.do(ctx, http.MethodHead, repo, "/manifests/"+ref, Repository(repo, ActionPull))
	if err != nil {
		return "", 0, err
	}
	resp.Body.Close()
	return resp.Header.Get("Docker-Content-Digest"), resp.StatusCode, nil
}

type DeleteStatus string

const (
	Deleted DeleteStatus = "deleted"
	Absent  DeleteStatus = "absent"
	Failed  DeleteStatus = "failed"
)

func (c *Client) Delete(ctx context.Context, repo, digest string) (DeleteStatus, error) {
	_, code, err := c.Head(ctx, repo, digest)
	if err != nil {
		return Failed, err
	}
	switch code {
	case http.StatusNotFound:
		return Absent, nil
	case http.StatusOK:
	default:
		return Failed, fmt.Errorf("HEAD %s@%s answered %d", repo, digest, code)
	}
	resp, err := c.do(ctx, http.MethodDelete, repo, "/manifests/"+digest, Repository(repo, ActionDelete))
	if err != nil {
		return Failed, err
	}
	resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusAccepted, http.StatusOK:
		return Deleted, nil
	case http.StatusNotFound:
		return Absent, nil
	}
	return Failed, fmt.Errorf("DELETE %s@%s answered %s", repo, digest, resp.Status)
}
