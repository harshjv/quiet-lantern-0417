//go:build linux

package deploy

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/harshjv/stationly/go/internal/hostconfig"
	"github.com/harshjv/stationly/go/internal/netns"
	"github.com/harshjv/stationly/go/internal/protocol"
)

const setupTimeout = 60 * time.Second

func setupLitestream(raw any) (*hostconfig.Litestream, *protocol.ErrorBody) {
	if raw == nil {
		return nil, nil
	}
	m, ok := raw.(map[string]any)
	str := func(k string) string { v, _ := m[k].(string); return strings.TrimSpace(v) }
	invalid := func(format string, args ...any) *protocol.ErrorBody {
		return protocolError(protocol.ErrorCodeValidationFailed, "Send litestream with bucket, endpoint (https, http on a private address, or empty), access_key and secret_key.", format, args...)
	}
	if !ok {
		return nil, invalid("litestream is not an object")
	}
	l := hostconfig.Litestream{Bucket: str("bucket"), Endpoint: str("endpoint"), AccessKey: str("access_key"), SecretKey: str("secret_key")}
	if err := l.Validate(); err != nil {
		return nil, invalid("%v", err)
	}
	return &l, nil
}

func (s *Station) opDetectPublicAddress(context.Context, json.RawMessage, func(string, string)) (any, *protocol.ErrorBody) {
	route, err := netns.DefaultRouteAddress()
	if err != nil {
		return map[string]any{"address": nil, "interface": nil, "public": false, "reason": err.Error()}, nil
	}
	return map[string]any{"address": route.Address.String(), "interface": route.Interface, "public": netns.PublicIPv4(route.Address)}, nil
}

func (s *Station) opRecoveryKey(context.Context, json.RawMessage, func(string, string)) (any, *protocol.ErrorBody) {
	if s.opts.Host == nil {
		return nil, protocolError(protocol.ErrorCodeHostAdminForbidden, "Run sly admin recovery-key on the station that hosts Dispatch (the one the installer set up).", "this station has no host.toml, so it does not hold a master key")
	}
	key, err := s.opts.Host.RecoveryKey()
	if err != nil {
		return nil, protocolError(protocol.ErrorCodeInternalError, "Repair dispatch.master_key in host.toml.", "%v", err)
	}
	s.emit(protocol.MessageAuditRecord, map[string]any{
		"action":  "admin.recovery_key_displayed",
		"target":  map[string]any{"entity": "instance", "id": s.opts.Identity.InstanceID},
		"actor":   map[string]any{"type": "station", "id": s.opts.Identity.StationID, "client": "root-socket"},
		"purpose": "recovery key displayed through the root socket",
	})
	return map[string]any{"recovery_key": key}, nil
}

func (s *Station) opSetup(ctx context.Context, params json.RawMessage, progress func(string, string)) (any, *protocol.ErrorBody) {
	var p map[string]any
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, invalidParams(err)
	}
	if s.opts.Host == nil {
		return nil, protocolError(protocol.ErrorCodeHostAdminForbidden, "Run sly setup on the station that hosts Dispatch (the one the installer set up).", "this station has no host.toml, so it does not run Dispatch")
	}
	if s.opts.Install != nil {
		p["ipam.pool"] = s.opts.Install.IpamPool
	}
	bucket, perr := setupLitestream(p["litestream"])
	if perr != nil {
		return nil, perr
	}
	delete(p, "litestream")
	dir := ReleaseDir(s.opts.StateDir)
	manifest, err1 := os.ReadFile(filepath.Join(dir, manifestFile))
	bundle, err2 := os.ReadFile(filepath.Join(dir, manifestFile+bundleSuffix))
	source, _ := os.ReadFile(filepath.Join(dir, "source"))
	if err1 == nil && err2 == nil {
		p["release"] = map[string]any{"manifest": string(manifest), "bundle": string(bundle), "source": strings.TrimSpace(string(source))}
		progress("release", "initial lockfile from the release stationd install verified ("+digestHex(manifest)[:19]+")")
	} else {
		progress("release", "no verified release in "+dir+"; setup writes no lockfile")
	}
	if !s.link.Connected() {
		return nil, protocolError(protocol.ErrorCodeStationOffline, "Start Dispatch and wait for stationd to connect (stationd connection).", "stationd is not connected to Dispatch")
	}
	progress("dispatch", "creating the admin")
	rctx, cancel := context.WithTimeout(ctx, setupTimeout)
	defer cancel()
	reply, err := s.link.Request(rctx, protocol.MessageHostAdmin, protocol.HostAdminBody{Op: "setup", Params: p})
	if err != nil {
		return nil, protocolError(protocol.ErrorCodeStationOffline, "Check that Dispatch is up and retry.", "host.admin setup: %v", err)
	}
	if reply.Type != protocol.MessageHostAdminResult {
		var e protocol.ErrorBody
		json.Unmarshal(reply.Body, &e)
		return nil, &e
	}
	var res protocol.HostAdminResultBody
	if err := json.Unmarshal(reply.Body, &res); err != nil {
		return nil, invalidParams(err)
	}
	out := res.Result
	if key, err := s.opts.Host.RecoveryKey(); err == nil {
		out["recovery_key"] = key
	}
	out["litestream"] = nil
	if bucket != nil {
		progress("litestream", "storing bucket "+bucket.Bucket+" in "+hostconfig.Path(s.opts.EtcDir))
		host := *s.opts.Host
		host.Litestream = *bucket
		if err := hostconfig.Save(s.opts.EtcDir, &host); err != nil {
			return nil, protocolError(protocol.ErrorCodeInternalError, "Write litestream.* into host.toml by hand; the admin already exists.", "store the Litestream bucket: %v", err)
		}
		s.opts.Host = &host
		var endpoint any
		if bucket.Endpoint != "" {
			endpoint = bucket.Endpoint
		}
		started := make(chan string, 1)
		s.post(ctx, func() {
			s.ensureLitestream(ctx)
			s.disp.lastStart = time.Time{}
			s.ensureDispatch(ctx)
			started <- s.litestreamFailure
		})
		active, note := false, "stored in host.toml; the sidecar did not report back in time, stationd retries at its next reconcile"
		select {
		case failure := <-started:
			active = failure == ""
			note = "replicating Dispatch to the bucket"
			if !active {
				note = "stored in host.toml, but the sidecar did not start: " + failure
			}
		case <-time.After(litestreamTaskTimeout):
		case <-ctx.Done():
		}
		if active {
			progress("dispatch", "recreated once so it knows it is replicated; waiting for it to answer")
			if took, err := dispatchHealthy(ctx, dispatchHealthWait); err != nil {
				note += "; Dispatch did not answer after its restart: " + err.Error()
			} else {
				note += fmt.Sprintf("; Dispatch answered %d ms after its restart", took.Milliseconds())
			}
		}
		out["litestream"] = map[string]any{"bucket": bucket.Bucket, "endpoint": endpoint, "active": active, "note": note}
	}
	s.log.Info("sly setup done", "admin_user_id", out["admin_user_id"])
	return out, nil
}
