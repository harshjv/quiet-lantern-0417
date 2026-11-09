package docker

import (
	"context"
	"fmt"
	"io"
	"maps"
	"net/netip"

	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"
)

const (
	LabelSandbox       = "stationly.sandbox"
	RoleSandboxCoupler = "sandbox_coupler"
	RoleSandboxExport  = "sandbox_export"
	RoleSandboxNetwork = "sandbox_network"
	SandboxBridge      = "stationly-sandbox"
	SandboxIface       = "or-sandbox"
)

func SandboxCouplerName(sandboxID string) string {
	return "or-sbx-coupler-" + sandboxID
}

func SandboxNetwork(stationID string, n protocol.DesiredStationSandboxNetwork) (NetworkSpec, error) {
	subnet, err := netip.ParsePrefix(n.Subnet)
	if err != nil {
		return NetworkSpec{}, fmt.Errorf("sandbox network subnet: %w", err)
	}
	gateway, err := netip.ParseAddr(n.Gateway)
	if err != nil {
		return NetworkSpec{}, fmt.Errorf("sandbox network gateway: %w", err)
	}
	ipv4, ipv6 := true, false
	spec := NetworkSpec{
		Name: n.BridgeName,
		Options: client.NetworkCreateOptions{
			Driver:     "bridge",
			EnableIPv4: &ipv4,
			EnableIPv6: &ipv6,
			IPAM: &network.IPAM{
				Driver: "default",
				Config: []network.IPAMConfig{{Subnet: subnet, Gateway: gateway}},
			},
			Options: map[string]string{
				"com.docker.network.bridge.name":       SandboxIface,
				"com.docker.network.bridge.enable_icc": "false",
			},
			Labels: map[string]string{
				LabelStation: stationID,
				LabelRole:    RoleSandboxNetwork,
			},
		},
	}
	spec.Hash = hashOf(spec.Options)
	spec.Options.Labels[LabelHash] = spec.Hash
	return spec, nil
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
	spec := ContainerSpec{
		Name: SandboxCouplerName(sandboxID),
		Role: RoleSandboxCoupler,
		Create: client.ContainerCreateOptions{
			Name:   SandboxCouplerName(sandboxID),
			Config: &container.Config{Image: image, Labels: labels},
			HostConfig: &container.HostConfig{
				NetworkMode:    container.NetworkMode(networkName),
				CapDrop:        []string{"ALL"},
				SecurityOpt:    []string{"no-new-privileges"},
				ReadonlyRootfs: true,
				Sysctls:        sysctls,
				RestartPolicy:  container.RestartPolicy{Name: container.RestartPolicyDisabled},
				LogConfig:      logConfig,
				Resources: container.Resources{
					Memory:     couplerMemoryBytes,
					MemorySwap: couplerMemoryBytes,
					NanoCPUs:   couplerNanoCPUs,
				},
			},
			NetworkingConfig: &network.NetworkingConfig{
				EndpointsConfig: map[string]*network.EndpointSettings{
					networkName: {GwPriority: CouplerGwPriority},
				},
			},
		},
	}
	return sealed(spec)
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
		c.api.ContainerRemove(context.Background(), res.ID, client.ContainerRemoveOptions{Force: true, RemoveVolumes: true})
	}
	rc, err := c.api.ContainerExport(ctx, res.ID, client.ContainerExportOptions{})
	if err != nil {
		cleanup()
		return nil, nil, fmt.Errorf("export %s: %w", ref, err)
	}
	return rc, cleanup, nil
}
