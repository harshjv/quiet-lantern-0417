package depot

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/netip"
	"time"

	"github.com/google/go-containerregistry/pkg/authn"
	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/remote/transport"
)

type Client struct {
	signer    *Signer
	front     string
	transport http.RoundTripper
}

func NewClient(signer *Signer, front netip.AddrPort) *Client {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.ResponseHeaderTimeout = 60 * time.Second
	return &Client{signer: signer, front: front.String(), transport: t}
}

func (c *Client) reference(repo, digest string) (name.Digest, error) {
	return name.NewDigest(c.front+"/"+repo+"@"+digest, name.Insecure)
}

func (c *Client) options(ctx context.Context, repo string, actions ...string) ([]remote.Option, error) {
	tok, err := c.signer.Mint("stationd", []Access{Repository(repo, actions...)}, PullTokenTTL)
	if err != nil {
		return nil, err
	}
	return []remote.Option{remote.WithContext(ctx), remote.WithTransport(c.transport), remote.WithAuth(&authn.Bearer{Token: tok})}, nil
}

func (c *Client) Manifest(ctx context.Context, repo, digest string) ([]byte, error) {
	ref, err := c.reference(repo, digest)
	if err != nil {
		return nil, err
	}
	opts, err := c.options(ctx, repo, ActionPull)
	if err != nil {
		return nil, err
	}
	desc, err := remote.Get(ref, opts...)
	if err != nil {
		return nil, err
	}
	return desc.Manifest, nil
}

func (c *Client) Blob(ctx context.Context, repo, digest string, limit int64) ([]byte, error) {
	ref, err := c.reference(repo, digest)
	if err != nil {
		return nil, err
	}
	opts, err := c.options(ctx, repo, ActionPull)
	if err != nil {
		return nil, err
	}
	layer, err := remote.Layer(ref, opts...)
	if err != nil {
		return nil, err
	}
	rc, err := layer.Compressed()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	return io.ReadAll(io.LimitReader(rc, limit))
}

type DeleteStatus string

const (
	Deleted DeleteStatus = "deleted"
	Absent  DeleteStatus = "absent"
	Failed  DeleteStatus = "failed"
)

func (c *Client) Delete(ctx context.Context, repo, digest string) (DeleteStatus, error) {
	ref, err := c.reference(repo, digest)
	if err != nil {
		return Failed, err
	}
	opts, err := c.options(ctx, repo, ActionPull, ActionDelete)
	if err != nil {
		return Failed, err
	}
	if _, err := remote.Head(ref, opts...); err != nil {
		return deleteStatus(err)
	}
	if err := remote.Delete(ref, opts...); err != nil {
		return deleteStatus(err)
	}
	return Deleted, nil
}

func deleteStatus(err error) (DeleteStatus, error) {
	var terr *transport.Error
	if errors.As(err, &terr) && terr.StatusCode == http.StatusNotFound {
		return Absent, nil
	}
	return Failed, err
}
