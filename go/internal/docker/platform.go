package docker

import (
	"archive/tar"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/volume"
	"github.com/moby/moby/client"
)

func RegistryTokenAuth(token string) (string, error) {
	b, err := json.Marshal(map[string]string{"registrytoken": token})
	if err != nil {
		return "", err
	}
	return base64.URLEncoding.EncodeToString(b), nil
}

func (c *Client) ContainerByName(ctx context.Context, name string) (container.Summary, bool, error) {
	res, err := c.api.ContainerList(ctx, client.ContainerListOptions{All: true, Filters: client.Filters{}.Add("name", "^/"+name+"$")})
	if err != nil {
		return container.Summary{}, false, err
	}
	for _, s := range res.Items {
		for _, n := range s.Names {
			if strings.TrimPrefix(n, "/") == name {
				return s, true, nil
			}
		}
	}
	return container.Summary{}, false, nil
}

func (c *Client) ContainersWithRole(ctx context.Context, role string) ([]container.Summary, error) {
	res, err := c.api.ContainerList(ctx, client.ContainerListOptions{All: true, Filters: ownedFilter().Add("label", LabelRole+"="+role)})
	return res.Items, err
}

func (c *Client) NetworkByName(ctx context.Context, name string) (string, map[string]string, bool, error) {
	res, err := c.api.NetworkList(ctx, client.NetworkListOptions{Filters: client.Filters{}.Add("name", name)})
	if err != nil {
		return "", nil, false, err
	}
	for _, n := range res.Items {
		if n.Name == name {
			return n.ID, n.Labels, true, nil
		}
	}
	return "", nil, false, nil
}

func (c *Client) EnsureVolume(ctx context.Context, name string, labels map[string]string) (volume.Volume, bool, error) {
	res, err := c.api.VolumeInspect(ctx, name, client.VolumeInspectOptions{})
	if err == nil {
		return res.Volume, false, nil
	}
	if !cerrdefs.IsNotFound(err) {
		return volume.Volume{}, false, err
	}
	created, err := c.api.VolumeCreate(ctx, client.VolumeCreateOptions{Name: name, Driver: "local", Labels: labels})
	return created.Volume, true, err
}

func (c *Client) VolumesWithLabel(ctx context.Context, label string) ([]volume.Volume, error) {
	res, err := c.api.VolumeList(ctx, client.VolumeListOptions{Filters: client.Filters{}.Add("label", label)})
	return res.Items, err
}

func (c *Client) RemoveVolume(ctx context.Context, name string) error {
	_, err := c.api.VolumeRemove(ctx, name, client.VolumeRemoveOptions{Force: true})
	return ignoreNotFound(err)
}

func (c *Client) Stop(ctx context.Context, id string, timeoutS int) error {
	_, err := c.api.ContainerStop(ctx, id, client.ContainerStopOptions{Timeout: &timeoutS})
	return ignoreNotFound(err)
}

func (c *Client) Wait(ctx context.Context, id string) (int64, error) {
	res := c.api.ContainerWait(ctx, id, client.ContainerWaitOptions{Condition: container.WaitConditionNotRunning})
	select {
	case r := <-res.Result:
		if r.Error != nil && r.Error.Message != "" {
			return r.StatusCode, fmt.Errorf("%s", r.Error.Message)
		}
		return r.StatusCode, nil
	case err := <-res.Error:
		return -1, err
	}
}

func (c *Client) Logs(ctx context.Context, id string) (string, error) {
	rc, err := c.api.ContainerLogs(ctx, id, client.ContainerLogsOptions{ShowStdout: true, ShowStderr: true})
	if err != nil {
		return "", err
	}
	defer rc.Close()
	var out strings.Builder
	header := make([]byte, 8)
	for {
		if _, err := io.ReadFull(rc, header); err != nil {
			break
		}
		size := int64(header[4])<<24 | int64(header[5])<<16 | int64(header[6])<<8 | int64(header[7])
		if _, err := io.CopyN(&out, rc, size); err != nil {
			break
		}
	}
	return out.String(), nil
}

func (c *Client) ImageFile(ctx context.Context, image, path string) ([]byte, error) {
	if err := c.EnsureImage(ctx, image); err != nil {
		return nil, err
	}
	res, err := c.api.ContainerCreate(ctx, client.ContainerCreateOptions{Config: &container.Config{Image: image, Entrypoint: []string{"/nonexistent"}, Labels: map[string]string{LabelRole: "image-read"}}, HostConfig: &container.HostConfig{NetworkMode: "none"}})
	if err != nil {
		return nil, err
	}
	defer c.Remove(context.WithoutCancel(ctx), res.ID)
	cp, err := c.api.CopyFromContainer(ctx, res.ID, client.CopyFromContainerOptions{SourcePath: path})
	if err != nil {
		return nil, err
	}
	defer cp.Content.Close()
	tr := tar.NewReader(cp.Content)
	for {
		h, err := tr.Next()
		if err != nil {
			return nil, fmt.Errorf("%s not found in %s: %w", path, image, err)
		}
		if h.Typeflag == tar.TypeReg {
			return io.ReadAll(io.LimitReader(tr, 1<<20))
		}
	}
}

func (c *Client) RemoveImage(ctx context.Context, ref string) error {
	_, err := c.api.ImageRemove(ctx, ref, client.ImageRemoveOptions{Force: true})
	return ignoreNotFound(err)
}
