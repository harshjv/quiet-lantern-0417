//go:build linux

package deploy

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/moby/moby/api/types/container"

	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/fsx"
	"github.com/harshjv/stationly/go/internal/gateway"
	"github.com/harshjv/stationly/go/internal/netns"
	"github.com/harshjv/stationly/go/internal/protocol"
)

const (
	tunnelTokenFile    = "tunnel-token"
	probeIDFile        = "probe-id"
	tunnelInterval     = 15 * time.Second
	tunnelReadyTimeout = 3 * time.Second
	tunnelProbeTimeout = 10 * time.Second
)

type routeProbe struct {
	status  int
	failure protocol.RouteProbeFailure
}

type tunnelRuntime struct {
	probeID     string
	pulling     bool
	pulled      *error
	failure     string
	ready       bool
	connections int
	probes      map[string]routeProbe
	at          time.Time
	busy        bool
}

func (s *Station) tunnelTokenPath() string {
	return filepath.Join(s.gatewayDir(), tunnelTokenFile)
}

func (s *Station) tunnelToken() (string, bool) {
	b, err := os.ReadFile(s.tunnelTokenPath())
	if err != nil {
		return "", false
	}
	token := strings.TrimSpace(string(b))
	return token, token != ""
}

func (s *Station) tunnelConfigured() bool {
	_, ok := s.tunnelToken()
	return ok
}

func checkTunnelToken(raw string) (string, *protocol.ErrorBody) {
	token := strings.TrimSpace(raw)
	invalid := func(reason string) *protocol.ErrorBody {
		return protocolError(protocol.ErrorCodeValidationFailed, "Copy the token from the tunnel's page in the Cloudflare dashboard (Networks, Tunnels, the tunnel, its install command) and send it again.", "the tunnel token %s", reason)
	}
	if token == "" {
		return "", invalid("is empty")
	}
	if strings.ContainsAny(token, " \t\r\n") {
		return "", invalid("contains whitespace")
	}
	var decoded []byte
	var err error
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if decoded, err = enc.DecodeString(token); err == nil {
			break
		}
	}
	if err != nil {
		return "", invalid("is not base64")
	}
	var fields struct {
		Account string `json:"a"`
		Tunnel  string `json:"t"`
		Secret  string `json:"s"`
	}
	if json.Unmarshal(decoded, &fields) != nil || fields.Account == "" || fields.Tunnel == "" || fields.Secret == "" {
		return "", invalid("does not carry an account, a tunnel id and a secret")
	}
	return token, nil
}

func (s *Station) storeTunnelToken(token string) error {
	if err := os.MkdirAll(s.gatewayDir(), 0o755); err != nil {
		return err
	}
	return fsx.WriteFile(s.tunnelTokenPath(), []byte(token+"\n"), 0o600)
}

func (s *Station) probeID() string {
	if s.gw.tunnel.probeID != "" {
		return s.gw.tunnel.probeID
	}
	path := filepath.Join(s.gatewayDir(), probeIDFile)
	if b, err := os.ReadFile(path); err == nil && len(strings.TrimSpace(string(b))) == 32 {
		s.gw.tunnel.probeID = strings.TrimSpace(string(b))
		return s.gw.tunnel.probeID
	}
	id := randomHex(16)
	if err := os.MkdirAll(s.gatewayDir(), 0o755); err == nil {
		err = fsx.WriteFile(path, []byte(id+"\n"), 0o600)
		if err != nil {
			s.log.Warn("persist the Gateway probe id", "file", path, "error", err)
		}
	}
	s.gw.tunnel.probeID = id
	return id
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (s *Station) cloudflaredWanted() bool {
	gp := s.plan.Gateway
	return gp.Run && gp.Tunnel.Image != "" && s.gw.state.Current != nil && s.tunnelConfigured()
}

func (s *Station) reconcileCloudflared(ctx context.Context) {
	s.gw.tunnel.failure = ""
	if !s.cloudflaredWanted() {
		s.removeCloudflared(ctx, "no tunnel token, no cloudflared pin or no running Gateway")
		s.gw.tunnel.ready, s.gw.tunnel.connections = false, 0
		return
	}
	gp := s.plan.Gateway
	stationID := s.plan.Generation.StationId
	coupler := docker.CloudflaredCoupler(stationID, s.plan.couplerImage, gp.Cloudflared, gp.GatewayVIP)
	cf := docker.Cloudflared(stationID, gp.Tunnel.Image, netip.AddrPortFrom(gp.Cloudflared, docker.CloudflaredMetricsPort))
	for _, spec := range []docker.ContainerSpec{coupler, cf} {
		if err := docker.CheckInvariants(spec, s.opts.StateDir); err != nil {
			s.tunnelFail("%v", err)
			return
		}
	}
	c, cOK, err := s.docker.ContainerByName(ctx, coupler.Name)
	if err != nil {
		s.tunnelFail("inspect %s: %v", coupler.Name, err)
		return
	}
	t, tOK, err := s.docker.ContainerByName(ctx, cf.Name)
	if err != nil {
		s.tunnelFail("inspect %s: %v", cf.Name, err)
		return
	}
	couplerOK := cOK && c.State == container.StateRunning && c.Labels[docker.LabelHash] == coupler.Hash
	if couplerOK && tOK && t.State == container.StateRunning && t.Labels[docker.LabelHash] == cf.Hash {
		if _, err := s.syncCloudflaredNamespace(ctx); err != nil {
			s.tunnelFail("%v", err)
		}
		return
	}
	if !s.cloudflaredPulled(ctx, gp.Tunnel.Image) {
		return
	}
	if tOK {
		s.removeNamed(ctx, cf.Name)
	}
	couplerID := c.ID
	if !couplerOK {
		if cOK {
			s.removeNamed(ctx, coupler.Name)
		}
		couplerID, err = s.docker.CreateContainer(ctx, coupler.Create)
		if err == nil {
			err = s.docker.Start(ctx, couplerID)
		}
		if err != nil {
			s.tunnelFail("start %s: %v", coupler.Name, err)
			return
		}
	}
	result, err := s.syncCloudflaredNamespace(ctx)
	if err != nil {
		s.tunnelFail("%v", err)
		return
	}
	token, ok := s.tunnelToken()
	if !ok {
		return
	}
	id, err := s.docker.CreateContainer(ctx, cf.WithEnv([]string{"TUNNEL_TOKEN=" + token}).JoinedTo(couplerID))
	if err == nil {
		err = s.docker.Start(ctx, id)
	}
	if err != nil {
		s.tunnelFail("start %s: %v", cf.Name, err)
		return
	}
	s.gw.tunnel.at = time.Time{}
	s.log.Info("cloudflared started", "coupler", shortID(couplerID), "cloudflared", shortID(id), "address", gp.Cloudflared, "gateway_host", docker.GatewayHostAlias+"="+gp.GatewayVIP.String(), "metrics_table", result, "image", gp.Tunnel.Image)
}

func (s *Station) tunnelFail(format string, args ...any) {
	s.gw.tunnel.failure = fmt.Sprintf(format, args...)
	s.log.Error("cloudflared", "error", s.gw.tunnel.failure)
}

func (s *Station) cloudflaredPulled(ctx context.Context, image string) bool {
	if s.gw.tunnel.pulled != nil {
		err := *s.gw.tunnel.pulled
		s.gw.tunnel.pulled = nil
		if err != nil {
			s.tunnelFail("pull %s: %v", image, err)
			return false
		}
		return true
	}
	if s.gw.tunnel.pulling {
		return false
	}
	s.gw.tunnel.pulling = true
	go func() {
		err := s.docker.EnsureImage(ctx, image)
		select {
		case s.inspections <- func() {
			s.gw.tunnel.pulling = false
			s.gw.tunnel.pulled = &err
			s.resync = true
		}:
		case <-ctx.Done():
		}
	}()
	return false
}

func (s *Station) syncCloudflaredNamespace(ctx context.Context) (netns.Result, error) {
	v := s.inspectID(ctx, docker.CloudflaredCouplerName, docker.IngressNetworkName)
	if v.state != string(container.StateRunning) || v.pid <= 0 {
		return netns.Unchanged, fmt.Errorf("%s is not running", docker.CloudflaredCouplerName)
	}
	ns, err := netns.Open(v.pid)
	if err != nil {
		return netns.Unchanged, err
	}
	defer ns.Close()
	result, err := ns.SyncCloudflared(netns.CloudflaredBaseline{MetricsPort: docker.CloudflaredMetricsPort, Prober: s.plan.Gateway.Bridge})
	if err != nil {
		return result, fmt.Errorf("write table inet %s into %s: %w", netns.TableName, docker.CloudflaredCouplerName, err)
	}
	if result != netns.Unchanged {
		s.log.Info("cloudflared namespace ruleset synced", "coupler", docker.CloudflaredCouplerName, "netns", ns.Inode, "result", result, "metrics_port", docker.CloudflaredMetricsPort, "metrics_from", s.plan.Gateway.Bridge)
	}
	return result, nil
}

func (s *Station) removeCloudflared(ctx context.Context, why string) {
	removed := false
	for _, name := range []string{docker.CloudflaredName, docker.CloudflaredCouplerName} {
		if _, ok, err := s.docker.ContainerByName(ctx, name); err == nil && ok {
			s.removeNamed(ctx, name)
			removed = true
		}
	}
	if removed {
		s.log.Info("cloudflared removed", "why", why)
	}
}

func (s *Station) restartCloudflared(ctx context.Context) bool {
	_, ok, err := s.docker.ContainerByName(ctx, docker.CloudflaredName)
	if err != nil || !ok {
		return false
	}
	s.removeNamed(ctx, docker.CloudflaredName)
	s.gw.tunnel.ready, s.gw.tunnel.connections = false, 0
	s.log.Info("cloudflared removed to pick up a new tunnel token")
	return true
}

func (s *Station) opTunnelSetToken(ctx context.Context, params json.RawMessage, progress func(string, string)) (any, *protocol.ErrorBody) {
	var p protocol.RootSocketTunnelTokenParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, invalidParams(err)
	}
	token, perr := checkTunnelToken(p.Token)
	if perr != nil {
		return nil, perr
	}
	if err := s.storeTunnelToken(token); err != nil {
		return nil, protocolError(protocol.ErrorCodeInternalError, "Check that stationd's state directory is writable and retry.", "store the tunnel token: %v", err)
	}
	progress("tunnel", "token stored in "+s.tunnelTokenPath()+" (0600)")
	done := make(chan bool, 1)
	s.post(ctx, func() {
		restarted := s.restartCloudflared(ctx)
		s.resync = true
		done <- restarted
	})
	select {
	case restarted := <-done:
		return protocol.RootSocketTunnelTokenResult{Restarted: restarted}, nil
	case <-ctx.Done():
		return nil, protocolError(protocol.ErrorCodeInternalError, "Retry; the token is stored.", "interrupted before cloudflared restarted")
	case <-time.After(30 * time.Second):
		return nil, protocolError(protocol.ErrorCodeInternalError, "Check the stationd log; the token is stored and cloudflared picks it up at its next start.", "cloudflared did not restart within 30 s")
	}
}

type tunnelReady struct {
	Status          int `json:"status"`
	ReadyConnection int `json:"readyConnections"`
}

func (s *Station) checkTunnel(ctx context.Context, now time.Time) {
	t := &s.gw.tunnel
	if t.busy || now.Sub(t.at) < tunnelInterval {
		return
	}
	t.at = now
	gp := s.plan.Gateway
	var routes []RoutePlan
	for _, rp := range gp.Routes {
		if !rp.Direct && s.gw.routes[rp.ID].result != protocol.ObjectResultBlocked {
			routes = append(routes, rp)
		}
	}
	running := s.cloudflaredWanted()
	if !running && len(routes) == 0 {
		t.ready, t.connections, t.probes = false, 0, nil
		return
	}
	metrics := netip.AddrPortFrom(gp.Cloudflared, docker.CloudflaredMetricsPort)
	id := s.probeID()
	t.busy = true
	go func() {
		ready, connections := false, 0
		if running {
			ready, connections = readTunnel(ctx, metrics)
		}
		probes := map[string]routeProbe{}
		for _, rp := range routes {
			probes[rp.ID] = probeTunnelRoute(ctx, rp.Hostname, id)
		}
		select {
		case s.inspections <- func() {
			t.busy = false
			if t.ready != ready || t.connections != connections {
				s.log.Info("cloudflared readiness", "ready", ready, "connections", connections)
			}
			t.ready, t.connections = ready, connections
			for rid, p := range probes {
				if before, seen := t.probes[rid]; !seen || before != p {
					s.log.Info("tunnel route probed", "route", rid, "status", p.status, "failure", p.failure)
				}
			}
			t.probes = probes
		}:
		case <-ctx.Done():
		}
	}()
}

func readTunnel(ctx context.Context, metrics netip.AddrPort) (bool, int) {
	ctx, cancel := context.WithTimeout(ctx, tunnelReadyTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+metrics.String()+"/ready", nil)
	if err != nil {
		return false, 0
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false, 0
	}
	defer resp.Body.Close()
	var body tunnelReady
	_ = json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&body)
	return resp.StatusCode == http.StatusOK && body.ReadyConnection > 0, body.ReadyConnection
}

var probeClient = &http.Client{
	Timeout:       tunnelProbeTimeout,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

func probeTunnelRoute(ctx context.Context, hostname, probeID string) routeProbe {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://"+hostname+gateway.TunnelProbePath+"/"+randomHex(8), nil)
	if err != nil {
		return routeProbe{failure: protocol.RouteProbeFailureUnreachable}
	}
	resp, err := probeClient.Do(req)
	if err != nil {
		return routeProbe{failure: protocol.RouteProbeFailureUnreachable}
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	p := routeProbe{status: resp.StatusCode}
	if resp.Header.Get(gateway.TunnelProbeHeader) != probeID {
		p.failure = protocol.RouteProbeFailureWrongGateway
	}
	return p
}

func (s *Station) observedTunnelProbe(id string) *protocol.ObservedRouteProbe {
	p, ok := s.gw.tunnel.probes[id]
	if !ok {
		return nil
	}
	out := &protocol.ObservedRouteProbe{Ok: p.failure == ""}
	if p.status != 0 {
		out.StatusCode = ptr(p.status)
	}
	if p.failure != "" {
		out.Failure = ptr(p.failure)
	}
	return out
}

func (s *Station) observedTunnel() *protocol.ObservedTunnel {
	if !s.plan.Gateway.Run && !s.tunnelConfigured() {
		return nil
	}
	return &protocol.ObservedTunnel{Configured: s.tunnelConfigured(), Ready: s.gw.tunnel.ready, Connections: s.gw.tunnel.connections}
}

func takeTunnelToken(p map[string]any) (string, bool, *protocol.ErrorBody) {
	raw, present := p["tunnel_token"]
	delete(p, "tunnel_token")
	if !present || raw == nil {
		return "", false, nil
	}
	str, ok := raw.(string)
	if !ok {
		return "", false, protocolError(protocol.ErrorCodeValidationFailed, "Send tunnel_token as a string.", "tunnel_token is not a string")
	}
	token, perr := checkTunnelToken(str)
	if perr != nil {
		return "", false, perr
	}
	return token, true, nil
}
