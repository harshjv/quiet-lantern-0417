//go:build linux

package deploy

import (
	"context"
	"fmt"
	"github.com/harshjv/stationly/go/internal/cidr"
	"log/slog"
	"net/netip"
	"os"
	"path/filepath"
	"time"

	"github.com/harshjv/stationly/go/internal/dns"
	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/hostconfig"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/verify"
	"github.com/moby/moby/api/types/container"
)

type BootstrapOptions struct {
	StateDir string
	EtcDir   string
	Log      *slog.Logger
	Verifier *verify.Verifier
	Install  *InstallState
	Host     *hostconfig.Config
}

func Bootstrap(ctx context.Context, o BootstrapOptions) (func(), error) {
	noop := func() {}
	raw, err := os.ReadFile(filepath.Join(ReleaseDir(o.StateDir), manifestFile))
	if err != nil {
		return noop, fmt.Errorf("read the installed release manifest: %w", err)
	}
	m, err := ParseReleaseManifest(raw)
	if err != nil {
		return noop, err
	}
	c, ok := m.Components["dispatch"]
	if !ok {
		o.Log.Info("the installed release has no dispatch component; Dispatch is expected outside stationd")
		return noop, nil
	}
	if o.Install == nil || o.Install.StationID == "" {
		return noop, fmt.Errorf("install.json has no station_id; rerun the installer")
	}
	subnet, err := netip.ParsePrefix(o.Install.SystemSubnet)
	if err != nil {
		return noop, fmt.Errorf("install.json system_subnet: %w", err)
	}
	hostAddr, err := netip.ParseAddrPort(o.Install.ResolverHostAddress)
	if err != nil {
		return noop, fmt.Errorf("install.json resolver_host_address: %w", err)
	}
	dc, err := docker.Connect(ctx)
	if err != nil {
		return noop, err
	}
	gateway := cidr.Offset(subnet, protocol.NetworkGatewayHost)
	spec := docker.SystemNetwork(o.Install.StationID, subnet, cidr.UpperHalf(subnet), gateway)
	_, labels, exists, err := dc.NetworkByName(ctx, spec.Name)
	switch {
	case err != nil:
		dc.Close()
		return noop, err
	case exists && labels[docker.LabelHash] != spec.Hash:
		dc.Close()
		return noop, fmt.Errorf("network %s exists with other settings", spec.Name)
	case !exists:
		id, err := dc.CreateNetwork(ctx, spec)
		if err != nil {
			dc.Close()
			return noop, err
		}
		o.Log.Info("created system network before enrollment", "name", spec.Name, "id", shortID(id), "subnet", subnet, "gateway", gateway, "station", o.Install.StationID)
	}
	upstream, err := dns.UpstreamFrom(resolvConf)
	if o.Host != nil && o.Host.Resolver.Upstream != "" {
		upstream, err = o.Host.Resolver.Upstream, nil
	}
	if err != nil {
		dc.Close()
		return noop, err
	}
	resolver := dns.New(o.Log, upstream)
	resolver.SetHost(hostAddr.Addr(), []netip.Prefix{subnet})
	if failed := resolver.Listen([]netip.Addr{hostAddr.Addr()}); len(failed) > 0 {
		o.Log.Error("resolver host listener before enrollment", "address", hostAddr, "error", failed[hostAddr.Addr()])
	}
	cleanup := func() {
		resolver.Close()
		dc.Close()
	}
	digest := pinOf(c)
	trust := o.Verifier.Trust()
	side := &dispatchSide{componentPin: componentPin{Version: c.Version, Digest: digest}, Image: trust.Source("dispatch", protocol.DispatchRepository) + "@" + digest, Since: *stamp(time.Now())}
	l := dispatchLaunch{stationID: o.Install.StationID, stateDir: o.StateDir, etcDir: o.EtcDir, subnet: subnet, trust: trust, log: o.Log}
	want, err := l.spec(side)
	if err != nil {
		cleanup()
		return noop, err
	}
	if running, ok, _ := dc.ContainerByName(ctx, docker.DispatchName); ok && running.State == container.StateRunning && running.Labels[docker.LabelHash] == want.Hash {
		o.Log.Info("Dispatch already running from the installed release", "id", shortID(running.ID), "version", side.Version)
	} else {
		id, err := startDispatch(ctx, dc, l, side)
		if err != nil {
			cleanup()
			return noop, err
		}
		o.Log.Info("Dispatch container started from the installed release before enrollment", "id", shortID(id), "version", side.Version, "image", side.Image, "address", dispatchAddress(subnet))
	}
	if err := saveDispatchState(o.StateDir, dispatchState{Current: side}); err != nil {
		cleanup()
		return noop, err
	}
	return cleanup, nil
}
