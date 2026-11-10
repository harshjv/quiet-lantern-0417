package docker

import (
	"archive/tar"
	"context"
	"errors"
	"io"
	"path"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"
)

const RoleProbe = "secrets-probe"

func (c *Client) ImageUser(ctx context.Context, ref string) (string, error) {
	res, err := c.api.ImageInspect(ctx, ref)
	if err != nil {
		return "", err
	}
	if res.Config == nil {
		return "", nil
	}
	return res.Config.User, nil
}

func (c *Client) ReadImageFiles(ctx context.Context, ref, stationID string, paths ...string) (map[string][]byte, error) {
	created, err := c.api.ContainerCreate(ctx, client.ContainerCreateOptions{
		Config:     &container.Config{Image: ref, Entrypoint: []string{"/stationly-never-started"}, Labels: map[string]string{LabelStation: stationID, LabelRole: RoleProbe}},
		HostConfig: &container.HostConfig{NetworkMode: "none"},
	})
	if err != nil {
		return nil, err
	}
	defer func() {
		_, _ = c.api.ContainerRemove(context.WithoutCancel(ctx), created.ID, client.ContainerRemoveOptions{Force: true})
	}()
	out := map[string][]byte{}
	for _, p := range paths {
		res, err := c.api.CopyFromContainer(ctx, created.ID, client.CopyFromContainerOptions{SourcePath: p})
		if cerrdefs.IsNotFound(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		tr := tar.NewReader(res.Content)
		for {
			h, err := tr.Next()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				res.Content.Close()
				return nil, err
			}
			if h.Typeflag == tar.TypeReg && h.Name == path.Base(p) {
				b, err := io.ReadAll(io.LimitReader(tr, 4<<20))
				if err != nil {
					res.Content.Close()
					return nil, err
				}
				out[p] = b
			}
		}
		res.Content.Close()
	}
	return out, nil
}
