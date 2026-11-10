package docker

import (
	"context"
	"fmt"
	"io"
	"maps"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"

	"github.com/harshjv/stationly/go/internal/protocol"
)

const (
	LabelSandbox       = "stationly.sandbox"
	RoleSandboxCoupler = "sandbox_coupler"
	RoleSandboxExport  = "sandbox_export"
	RoleSandboxNetwork = "sandbox_network"
	SandboxBridge      = protocol.SandboxNetworkName
	SandboxIface       = SandboxBridge
)

func SandboxCouplerName(sandboxID string) string {
	return protocol.ResourcePrefix + "sbx-coupler-" + sandboxID
}

func SandboxNetwork(stationID string, n protocol.DesiredStationSandboxNetwork) (NetworkSpec, error) {
	ipam, err := parseIPAM(n.Subnet, n.Gateway)
	if err != nil {
		return NetworkSpec{}, fmt.Errorf("sandbox network %w", err)
	}
	return bridgeNetwork(n.BridgeName, SandboxIface, false, ipam, platformLabels(stationID, RoleSandboxNetwork, ""), nil), nil
}

func SandboxCoupler(stationID, envID, sandboxID, image, networkName string) ContainerSpec {
	labels := map[string]string{
		LabelStation:     stationID,
		LabelRole:        RoleSandboxCoupler,
		LabelEnvironment: envID,
		LabelSandbox:     sandboxID,
	}
	sysctls := map[string]string{"net.ipv4.ip_forward": "1"}
	maps.Copy(sysctls, ConntrackSysctls)
	return sealed(couplerSpec(SandboxCouplerName(sandboxID), RoleSandboxCoupler, image, networkName, labels, sysctls))
}

type ImageConfig struct {
	Entrypoint []string
	Cmd        []string
	Env        []string
	WorkingDir string
	User       string
}

func (c *Client) ImageConfig(ctx context.Context, ref string) (ImageConfig, error) {
	res, err := c.api.ImageInspect(ctx, ref)
	if err != nil {
		return ImageConfig{}, err
	}
	if res.Config == nil {
		return ImageConfig{}, nil
	}
	cfg := res.Config
	return ImageConfig{Entrypoint: cfg.Entrypoint, Cmd: cfg.Cmd, Env: cfg.Env, WorkingDir: cfg.WorkingDir, User: cfg.User}, nil
}

func (c *Client) ExportImage(ctx context.Context, stationID, sandboxKey, ref string) (io.ReadCloser, func(), error) {
	create := client.ContainerCreateOptions{
		Config: &container.Config{
			Image:      ref,
			Entrypoint: []string{"/nonexistent"},
			Labels:     map[string]string{LabelStation: stationID, LabelRole: RoleSandboxExport, LabelSandbox: sandboxKey},
		},
		HostConfig: &container.HostConfig{NetworkMode: "none", LogConfig: logConfig},
	}
	res, err := c.api.ContainerCreate(ctx, create)
	if err != nil {
		return nil, nil, fmt.Errorf("create a stopped container from %s: %w", ref, err)
	}
	cleanup := func() {
		_, _ = c.api.ContainerRemove(context.Background(), res.ID, client.ContainerRemoveOptions{Force: true, RemoveVolumes: true})
	}
	rc, err := c.api.ContainerExport(ctx, res.ID, client.ContainerExportOptions{})
	if err != nil {
		cleanup()
		return nil, nil, fmt.Errorf("export %s: %w", ref, err)
	}
	return rc, cleanup, nil
}
