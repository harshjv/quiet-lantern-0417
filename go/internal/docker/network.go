package docker

import (
	"context"
	"fmt"
	"maps"
	"net/netip"

	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"
)

func bridgeNetwork(name, bridge string, icc bool, ipam network.IPAMConfig, labels, options map[string]string) NetworkSpec {
	ipv4, ipv6 := true, false
	opts := map[string]string{
		"com.docker.network.bridge.name":       bridge,
		"com.docker.network.bridge.enable_icc": fmt.Sprint(icc),
	}
	maps.Copy(opts, options)
	spec := NetworkSpec{
		Name: name,
		Options: client.NetworkCreateOptions{
			Driver:     "bridge",
			EnableIPv4: &ipv4,
			EnableIPv6: &ipv6,
			IPAM:       &network.IPAM{Driver: "default", Config: []network.IPAMConfig{ipam}},
			Options:    opts,
			Labels:     labels,
		},
	}
	spec.Hash = hashOf(spec.Options)
	spec.Options.Labels[LabelHash] = spec.Hash
	return spec
}

func parseIPAM(subnet, gateway string) (network.IPAMConfig, error) {
	s, err := netip.ParsePrefix(subnet)
	if err != nil {
		return network.IPAMConfig{}, fmt.Errorf("subnet: %w", err)
	}
	g, err := netip.ParseAddr(gateway)
	if err != nil {
		return network.IPAMConfig{}, fmt.Errorf("gateway: %w", err)
	}
	return network.IPAMConfig{Subnet: s, Gateway: g}, nil
}

func (c *Client) EnsureFixedNetwork(ctx context.Context, spec NetworkSpec) (string, bool, error) {
	return c.ensureNetwork(ctx, spec, false, nil)
}

func (c *Client) EnsureNetwork(ctx context.Context, spec NetworkSpec, beforeRemove func()) (string, bool, error) {
	return c.ensureNetwork(ctx, spec, true, beforeRemove)
}

func (c *Client) ensureNetwork(ctx context.Context, spec NetworkSpec, recreate bool, beforeRemove func()) (string, bool, error) {
	id, labels, ok, err := c.networkByName(ctx, spec.Name)
	if err != nil {
		return "", false, fmt.Errorf("inspect network %s: %w", spec.Name, err)
	}
	if ok {
		switch {
		case labels[LabelHash] == spec.Hash:
			return id, false, nil
		case !recreate:
			return "", false, fmt.Errorf("network %s exists with other settings; its subnet is fixed at install, remove the network to recreate it", spec.Name)
		case labels[LabelStation] != spec.Options.Labels[LabelStation]:
			return "", false, fmt.Errorf("network %s exists and belongs to another station", spec.Name)
		}
		if beforeRemove != nil {
			beforeRemove()
		}
		if err := c.RemoveNetwork(ctx, id); err != nil {
			return "", false, fmt.Errorf("remove network %s: %w", spec.Name, err)
		}
	}
	res, err := c.api.NetworkCreate(ctx, spec.Name, spec.Options)
	if err != nil {
		return "", false, fmt.Errorf("create network %s: %w", spec.Name, err)
	}
	return res.ID, true, nil
}
