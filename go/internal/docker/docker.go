package docker

import (
	"bytes"
	"context"
	"fmt"
	"net/netip"
	"strconv"
	"strings"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/pkg/stdcopy"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/events"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"
)

const (
	LabelStation     = "stationly.station"
	LabelRole        = "stationly.role"
	LabelService     = "stationly.service"
	LabelEnvironment = "stationly.environment"
	LabelDeployment  = "stationly.deployment"
	LabelHash        = "stationly.hash"
	LabelRun         = "stationly.run"
	LabelVolume      = "stationly.volume"
	LabelOwner       = "stationly.owner"
	LabelEnvDigest   = "stationly.env_digest"

	RoleNetwork = "network"
	RoleCoupler = "coupler"
	RoleService = "service"
	RoleRun     = "run"
	RoleVolume  = "volume"
)

type Client struct {
	api          *client.Client
	registryAuth func(ref string) (string, bool, error)
}

func (c *Client) SetRegistryAuth(f func(ref string) (string, bool, error)) {
	c.registryAuth = f
}

func Connect(ctx context.Context) (*Client, error) {
	api, err := client.New(client.FromEnv)
	if err != nil {
		return nil, err
	}
	if _, err := api.Ping(ctx, client.PingOptions{}); err != nil {
		api.Close()
		return nil, err
	}
	return &Client{api: api}, nil
}

func (c *Client) Close() error {
	return c.api.Close()
}

func (c *Client) Info(ctx context.Context) (client.SystemInfoResult, error) {
	return c.api.Info(ctx, client.InfoOptions{})
}

func ownedFilter() client.Filters {
	return client.Filters{}.Add("label", LabelStation)
}

func (c *Client) Containers(ctx context.Context) ([]container.Summary, error) {
	res, err := c.api.ContainerList(ctx, client.ContainerListOptions{All: true, Filters: ownedFilter()})
	return res.Items, err
}

func (c *Client) Networks(ctx context.Context) ([]network.Summary, error) {
	res, err := c.api.NetworkList(ctx, client.NetworkListOptions{Filters: ownedFilter()})
	return res.Items, err
}

func (c *Client) Inspect(ctx context.Context, id string) (container.InspectResponse, error) {
	res, err := c.api.ContainerInspect(ctx, id, client.ContainerInspectOptions{})
	return res.Container, err
}

func (c *Client) RemoveNetwork(ctx context.Context, id string) error {
	_, err := c.api.NetworkRemove(ctx, id, client.NetworkRemoveOptions{})
	return ignoreNotFound(err)
}

func (c *Client) EnsureImage(ctx context.Context, ref string) error {
	_, err := c.api.ImageInspect(ctx, ref)
	if err == nil {
		return nil
	}
	if !cerrdefs.IsNotFound(err) {
		return err
	}
	var opts client.ImagePullOptions
	if c.registryAuth != nil {
		auth, ok, err := c.registryAuth(ref)
		if err != nil {
			return fmt.Errorf("pull %s: %w", ref, err)
		}
		if ok {
			opts.RegistryAuth = auth
		}
	}
	pull, err := c.api.ImagePull(ctx, ref, opts)
	if err != nil {
		return fmt.Errorf("pull %s: %w", ref, err)
	}
	if err := pull.Wait(ctx); err != nil {
		return fmt.Errorf("pull %s: %w", ref, err)
	}
	return nil
}

func (c *Client) NetworkAddresses(ctx context.Context, id string) ([]netip.Addr, error) {
	res, err := c.api.NetworkInspect(ctx, id, client.NetworkInspectOptions{})
	if err != nil {
		return nil, err
	}
	var out []netip.Addr
	for _, ep := range res.Network.Containers {
		if ep.IPv4Address.IsValid() {
			out = append(out, ep.IPv4Address.Addr())
		}
	}
	return out, nil
}

func (c *Client) Connect(ctx context.Context, networkID, containerID string, ep *network.EndpointSettings) error {
	_, err := c.api.NetworkConnect(ctx, networkID, client.NetworkConnectOptions{Container: containerID, EndpointConfig: ep})
	return err
}

func (c *Client) Disconnect(ctx context.Context, networkID, containerID string) error {
	_, err := c.api.NetworkDisconnect(ctx, networkID, client.NetworkDisconnectOptions{Container: containerID, Force: true})
	return ignoreNotFound(err)
}

func (c *Client) CreateContainer(ctx context.Context, create client.ContainerCreateOptions) (string, error) {
	if err := c.EnsureImage(ctx, create.Config.Image); err != nil {
		return "", err
	}
	res, err := c.api.ContainerCreate(ctx, create)
	return res.ID, err
}

func (c *Client) Start(ctx context.Context, id string) error {
	_, err := c.api.ContainerStart(ctx, id, client.ContainerStartOptions{})
	return err
}

func (c *Client) Remove(ctx context.Context, id string) error {
	_, err := c.api.ContainerRemove(ctx, id, client.ContainerRemoveOptions{Force: true, RemoveVolumes: true})
	return ignoreNotFound(err)
}

func (c *Client) Events(ctx context.Context, since string) client.EventsResult {
	owned := c.api.Events(ctx, client.EventsListOptions{Since: since, Filters: ownedFilter().Add("type", "container")})
	endpoints := c.api.Events(ctx, client.EventsListOptions{Since: since, Filters: client.Filters{}.Add("type", "network").Add("event", "connect", "disconnect")})
	msgs := make(chan events.Message)
	errs := make(chan error, 2)
	forward := func(r client.EventsResult) {
		for {
			select {
			case m := <-r.Messages:
				select {
				case msgs <- m:
				case <-ctx.Done():
					return
				}
			case err := <-r.Err:
				errs <- err
				return
			case <-ctx.Done():
				return
			}
		}
	}
	go forward(owned)
	go forward(endpoints)
	return client.EventsResult{Messages: msgs, Err: errs}
}

func ignoreNotFound(err error) error {
	if err == nil || cerrdefs.IsNotFound(err) {
		return nil
	}
	return err
}

func (c *Client) Signal(ctx context.Context, id, signal string) error {
	_, err := c.api.ContainerKill(ctx, id, client.ContainerKillOptions{Signal: signal})
	return err
}

func (c *Client) LogTail(ctx context.Context, id string, tail int) ([]string, error) {
	rc, err := c.api.ContainerLogs(ctx, id, client.ContainerLogsOptions{ShowStdout: true, ShowStderr: true, Tail: strconv.Itoa(tail)})
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	var out bytes.Buffer
	if _, err := stdcopy.StdCopy(&out, &out, rc); err != nil {
		return nil, err
	}
	text := strings.TrimRight(out.String(), "\n")
	if text == "" {
		return nil, nil
	}
	return strings.Split(text, "\n"), nil
}

func (c *Client) RepoDigests(ctx context.Context, ref string) ([]string, error) {
	res, err := c.api.ImageInspect(ctx, ref)
	if err != nil {
		return nil, err
	}
	return res.RepoDigests, nil
}
