package docker

import (
	"context"
	"io"
	"time"

	"github.com/moby/moby/client"
)

func (c *Client) FollowLogs(ctx context.Context, id string, since time.Time, follow bool) (io.ReadCloser, error) {
	opts := client.ContainerLogsOptions{ShowStdout: true, ShowStderr: true, Timestamps: true, Follow: follow}
	if !since.IsZero() {
		opts.Since = since.Format(time.RFC3339Nano)
	}
	return c.api.ContainerLogs(ctx, id, opts)
}

func (c *Client) Attach(ctx context.Context, id string) (client.HijackedResponse, error) {
	res, err := c.api.ContainerAttach(ctx, id, client.ContainerAttachOptions{Stream: true, Stdin: true, Stdout: true, Stderr: true})
	return res.HijackedResponse, err
}

func (c *Client) Resize(ctx context.Context, id string, rows, cols int) error {
	_, err := c.api.ContainerResize(ctx, id, client.ContainerResizeOptions{Height: uint(rows), Width: uint(cols)})
	return err
}

func (c *Client) Stats(ctx context.Context, id string) (io.ReadCloser, error) {
	res, err := c.api.ContainerStats(ctx, id, client.ContainerStatsOptions{Stream: true})
	return res.Body, err
}

func (s ContainerSpec) Interactive(tty bool, rows, cols int) ContainerSpec {
	cfg := *s.Create.Config
	cfg.AttachStdin, cfg.AttachStdout, cfg.AttachStderr = true, true, true
	cfg.OpenStdin, cfg.StdinOnce, cfg.Tty = true, true, tty
	s.Create.Config = &cfg
	if tty && rows > 0 && cols > 0 {
		hc := *s.Create.HostConfig
		hc.ConsoleSize = [2]uint{uint(rows), uint(cols)}
		s.Create.HostConfig = &hc
	}
	return s
}
