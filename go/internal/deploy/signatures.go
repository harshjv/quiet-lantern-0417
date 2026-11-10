//go:build linux

package deploy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/harshjv/stationly/go/internal/dispatch"
	"github.com/harshjv/stationly/go/internal/fsx"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/verify"
	"github.com/theupdateframework/go-tuf/v2/metadata"
	"github.com/theupdateframework/go-tuf/v2/metadata/fetcher"
)

const (
	FetchDirect       = "direct"
	FetchDispatch     = "dispatch"
	sigstoreBlobLimit = 16 << 20
)

var ImageComponents = map[string]bool{
	"dispatch": true, "gateway": true, "cloudflared": true, "buildkit": true, "depot": true, "litestream": true,
	"guard_image": true, "coupler_image": true, "railpack_frontend": true, "syft_scanner": true, "sandbox_toolchain": true,
}

type signatureBook struct {
	mu      sync.Mutex
	results map[string]verify.Result
}

func (b *signatureBook) set(name string, r verify.Result) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.results == nil {
		b.results = map[string]verify.Result{}
	}
	b.results[name] = r
}

func (b *signatureBook) get(name string) (verify.Result, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	r, ok := b.results[name]
	return r, ok
}

type dispatchSource struct {
	s      *Station
	mirror string
}

func (d dispatchSource) Name() verify.BundleSource { return verify.SourceDispatch }

func (d dispatchSource) upstream(ctx context.Context, up protocol.BlobUpstream) ([]byte, error) {
	reply, err := d.s.link.Request(ctx, protocol.MessageBlobGrant, protocol.BlobGrantRequestBody{Upstream: &up})
	if err != nil {
		return nil, err
	}
	if reply.Type != protocol.MessageBlobGranted {
		var e protocol.ErrorBody
		json.Unmarshal(reply.Body, &e)
		return nil, fmt.Errorf("blob.grant answered %s %s: %s", reply.Type, e.Code, e.Explanation)
	}
	var g protocol.BlobGrant
	if err := json.Unmarshal(reply.Body, &g); err != nil {
		return nil, err
	}
	return d.s.fetchGrantedBlob(ctx, g)
}

func (d dispatchSource) Bundles(ctx context.Context, digest string) ([][]byte, error) {
	dg := digest
	raw, err := d.upstream(ctx, protocol.BlobUpstream{SignatureDigest: &dg})
	if err != nil {
		return nil, err
	}
	var doc struct {
		Bundles []json.RawMessage `json:"bundles"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("sigstore blob: %w", err)
	}
	out := make([][]byte, 0, len(doc.Bundles))
	for _, b := range doc.Bundles {
		out = append(out, b)
	}
	return out, nil
}

func (d dispatchSource) TUF() fetcher.Fetcher { return tufViaDispatch(d) }

type tufViaDispatch dispatchSource

func (t tufViaDispatch) DownloadFile(url string, maxLength int64, _ time.Duration) ([]byte, error) {
	path, ok := strings.CutPrefix(url, strings.TrimRight(t.mirror, "/")+"/")
	if !ok {
		return nil, fmt.Errorf("TUF URL %s is outside the mirror %s", url, t.mirror)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	b, err := dispatchSource(t).upstream(ctx, protocol.BlobUpstream{TufPath: &path})
	if err != nil {
		if strings.Contains(err.Error(), "NOT_FOUND") {
			return nil, &metadata.ErrDownloadHTTP{StatusCode: 404, URL: url}
		}
		return nil, err
	}
	if maxLength > 0 && int64(len(b)) > maxLength {
		return nil, &metadata.ErrDownloadLengthMismatch{Msg: fmt.Sprintf("%s is %d bytes, above %d", url, len(b), maxLength)}
	}
	return b, nil
}

func (s *Station) bundleSource() verify.Source {
	if s.opts.SigstoreFetch == FetchDispatch {
		return dispatchSource{s: s, mirror: s.verifier.Trust().TUFMirror}
	}
	return verify.NewDirect(s.verifier.Trust())
}

func unsignedFailure(r verify.Result) *protocol.ErrorBody {
	return &protocol.ErrorBody{
		Code:        string(protocol.ErrorCodeUnsignedArtifact),
		Explanation: fmt.Sprintf("%s %s (%s) has no valid signature from %s: %s", r.Component, r.Version, r.Digest, "the release signing identity", r.Reason),
		Fix:         "Pin a digest the release signing identity signed, or set platform.allow_unsigned from a human session.",
		Details:     protocol.ErrorBodyDetails{"component": r.Component, "digest": r.Digest, "bundles_seen": r.BundlesSeen},
	}
}

func (s *Station) verifyComponents(ctx context.Context, g *protocol.Generation) *protocol.ErrorBody {
	if s.verifier == nil {
		return nil
	}
	names := make([]string, 0, len(g.Components))
	for name := range g.Components {
		names = append(names, name)
	}
	sort.Strings(names)
	var src verify.Source
	for _, name := range names {
		pin := g.Components[name]
		if !ImageComponents[name] || pin.Digest == nil {
			continue
		}
		if prev, ok := s.sigs.get(name); ok && prev.Digest == *pin.Digest && prev.Signature != verify.Refused {
			if _, current := s.verifier.Lookup(*pin.Digest); current || prev.Signature == verify.UnsignedAllowed {
				continue
			}
		}
		if src == nil {
			src = s.bundleSource()
		}
		vctx, cancel := context.WithTimeout(ctx, 60*time.Second)
		r := s.verifier.Image(vctx, src, name, pin.Version, *pin.Digest)
		cancel()
		if r.Signature == verify.Refused && g.Station.Settings.PlatformAllowUnsigned {
			r.Signature = verify.UnsignedAllowed
			s.emit(protocol.MessageAuditRecord, map[string]any{"action": "platform.unsigned_run", "target": map[string]any{"entity": "component", "id": name}, "actor": map[string]any{"type": "station", "id": s.opts.Identity.StationID}, "purpose": "platform.allow_unsigned is true: " + r.Reason})
		}
		s.sigs.set(name, r)
		s.log.Info("platform artifact signature", "component", name, "version", r.Version, "digest", r.Digest, "signature", r.Signature, "source", r.Source, "bundles", r.BundlesSeen, "identity", r.Identity, "took_ms", r.DurationMs, "reason", r.Reason)
		if r.Signature == verify.Refused {
			s.reportComponents(g)
			return unsignedFailure(r)
		}
	}
	return nil
}

func (s *Station) platformVerify(ctx context.Context, m dispatch.Message, body protocol.PlatformVerifyBody) {
	if s.verifier == nil {
		s.replyError(m, protocolError(protocol.ErrorCodeUnsignedArtifact, "Start stationd with a signature verifier.", "this stationd has no verifier"))
		return
	}
	ref := m.ID
	src := s.bundleSource()
	go func() {
		rctx, cancel := context.WithTimeout(ctx, 90*time.Second)
		defer cancel()
		s.verifier.Refresh(rctx, src.TUF())
		out := protocol.PlatformVerifyResultBody{Items: []protocol.PlatformVerifyResult{}}
		root := s.verifier.RootState().Digest
		out.TrustedRoot = &root
		if body.Release != nil {
			out.Release = s.verifyRelease(body.Release)
		}
		for _, it := range body.Items {
			if it.Component == protocol.ComponentNameStationd {
				out.Items = append(out.Items, s.verifyStationd(rctx, it))
				continue
			}
			r := s.verifier.Image(rctx, src, string(it.Component), it.Version, it.Digest)
			item := protocol.PlatformVerifyResult{Component: it.Component, Version: it.Version, Digest: it.Digest, Signature: protocol.SignatureState(r.Signature), BundlesSeen: r.BundlesSeen, DurationMs: int(r.DurationMs)}
			if r.Identity != "" {
				item.Identity = &r.Identity
			}
			if r.Source != "" {
				bs := protocol.BundleSource(r.Source)
				item.BundleSource = &bs
			}
			if r.Signature == verify.Refused {
				f := unsignedFailure(r)
				item.Failure = &protocol.PlatformVerifyResultFailure{Code: f.Code, Explanation: f.Explanation, Fix: f.Fix, Details: f.Details}
			}
			s.log.Info("platform.verify", "component", it.Component, "digest", it.Digest, "signature", r.Signature, "source", r.Source, "took_ms", r.DurationMs, "reason", r.Reason)
			out.Items = append(out.Items, item)
		}
		s.send(protocol.MessagePlatformVerifyResult, &ref, out)
	}()
}

func (s *Station) verifyRelease(rel *protocol.PlatformVerifyRelease) *protocol.PlatformVerifyReleaseResult {
	raw := []byte(rel.Manifest)
	out := &protocol.PlatformVerifyReleaseResult{ManifestDigest: digestHex(raw), Signature: protocol.SignatureStateVerified}
	san, err := s.verifier.Blob(raw, []byte(rel.Bundle))
	if err == nil {
		_, err = ParseReleaseManifest(raw)
	}
	if err != nil {
		out.Signature = protocol.SignatureStateRefused
		out.Failure = &protocol.PlatformVerifyReleaseResultFailure{Code: string(protocol.ErrorCodeUnsignedArtifact), Explanation: "release-manifest.json " + out.ManifestDigest + ": " + err.Error(), Fix: "Upgrade to a release signed by the release signing identity."}
		s.log.Warn("platform.verify release manifest refused", "digest", out.ManifestDigest, "error", err)
		return out
	}
	out.Identity = &san
	dir := filepath.Join(ReleaseDir(s.opts.StateDir), "releases")
	if err := os.MkdirAll(dir, 0o755); err == nil {
		writeAtomic(filepath.Join(dir, strings.TrimPrefix(out.ManifestDigest, "sha256:")+".json"), raw)
	}
	s.log.Info("platform.verify release manifest", "digest", out.ManifestDigest, "identity", san)
	return out
}

func (s *Station) verifyStationd(ctx context.Context, it protocol.PlatformVerifyItem) protocol.PlatformVerifyResult {
	start := time.Now()
	item := protocol.PlatformVerifyResult{Component: it.Component, Version: it.Version, Digest: it.Digest, Signature: protocol.SignatureStateVerified, BundlesSeen: 1}
	check, err := FetchStationd(ctx, s.verifier, s.opts.BinDir, it.Version, it.Digest)
	item.DurationMs = int(time.Since(start).Milliseconds())
	if err != nil {
		item.Signature = protocol.SignatureStateRefused
		item.Failure = &protocol.PlatformVerifyResultFailure{Code: string(protocol.ErrorCodeUnsignedArtifact), Explanation: err.Error(), Fix: "Upgrade to a release whose stationd binary matches its manifest checksum and carries the release signature."}
	} else {
		item.Identity = &check.Identity
		bs := protocol.BundleSourceDirect
		item.BundleSource = &bs
	}
	s.log.Info("platform.verify", "component", "stationd", "version", it.Version, "digest", it.Digest, "signature", item.Signature, "downloaded", check.Downloaded, "path", check.Path, "took_ms", item.DurationMs, "error", err)
	return item
}

var (
	selfDigestOnce sync.Once
	selfDigest     string
)

func SelfDigest() string {
	selfDigestOnce.Do(func() {
		path, err := os.Executable()
		if err != nil {
			return
		}
		f, err := os.Open(path)
		if err != nil {
			return
		}
		defer f.Close()
		h := sha256.New()
		if _, err := io.Copy(h, f); err == nil {
			selfDigest = "sha256:" + hex.EncodeToString(h.Sum(nil))
		}
	})
	return selfDigest
}

type reportedComponent struct {
	Version   string `json:"version"`
	Digest    string `json:"digest"`
	Status    string `json:"status"`
	Signature string `json:"signature"`
	Lockfile  string `json:"lockfile"`
}

func (s *Station) componentRows(g *protocol.Generation) map[string]map[string]any {
	rows := map[string]map[string]any{}
	now := time.Now().UTC().Format(timestampLayout)
	for name, pin := range g.Components {
		if name == "dispatch" && !s.hostsDispatch() {
			continue
		}
		want, pinned := pinOfGeneration(pin)
		row := map[string]any{"version": pin.Version, "digest": pin.Digest, "lockfile_version": pin.Version, "status": protocol.ComponentStatusOk, "signature": protocol.SignatureStateNotApplicable, "failure": nil, "container_id": nil, "since": now}
		if have, since, known := s.runningPin(name); known {
			row["version"], row["digest"] = have.Version, nilIfEmpty(have.Digest)
			if since != "" {
				row["since"] = since
			}
			if pinned && have != want {
				row["status"] = protocol.ComponentStatusDrift
			}
		} else if pinned && procedureKinds[name] != "" {
			row["status"] = protocol.ComponentStatusDrift
		}
		if status, failure := s.procedureStatus(name, want); status != "" {
			row["status"], row["failure"] = status, failure
		}
		if id := s.componentContainerID(name); id != "" {
			row["container_id"] = id
		}
		if ImageComponents[name] {
			row["signature"] = protocol.SignatureStatePending
			if r, ok := s.sigs.get(name); ok && pin.Digest != nil && r.Digest == *pin.Digest {
				row["signature"] = protocol.SignatureState(r.Signature)
				if r.Signature == verify.Refused {
					row["status"] = protocol.ComponentStatusFailed
					row["failure"] = unsignedFailure(r)
				}
			}
		}
		if name == "stationd" {
			row["signature"] = protocol.SignatureStateNotApplicable
		}
		rows[name] = row
	}
	if _, ok := rows["stationd"]; !ok {
		self := SelfDigest()
		rows["stationd"] = map[string]any{"version": stationdVersion(), "digest": nilIfEmpty(self), "lockfile_version": stationdVersion(), "status": protocol.ComponentStatusOk, "signature": protocol.SignatureStateNotApplicable, "failure": nil, "container_id": nil, "since": s.started}
	}
	rows["docker_engine"] = map[string]any{"version": s.info.ServerVersion, "digest": nil, "lockfile_version": s.info.ServerVersion, "status": protocol.ComponentStatusOk, "signature": protocol.SignatureStateNotApplicable, "failure": nil, "container_id": nil, "since": now}
	return rows
}

func (s *Station) componentContainerID(name string) string {
	switch name {
	case "gateway":
		return s.gw.containerID
	case "dispatch":
		return s.disp.containerID
	}
	return ""
}

func (s *Station) reportedPath() string {
	return filepath.Join(s.opts.StateDir, "components-reported.json")
}

func (s *Station) reportComponents(g *protocol.Generation) {
	var last map[string]reportedComponent
	if b, err := os.ReadFile(s.reportedPath()); err == nil {
		json.Unmarshal(b, &last)
	}
	next := map[string]reportedComponent{}
	changed := false
	rows := s.componentRows(g)
	names := make([]string, 0, len(rows))
	for n := range rows {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, name := range names {
		row := rows[name]
		rc := reportedComponent{Version: fmt.Sprint(row["version"]), Digest: textOf(row["digest"]), Status: fmt.Sprint(row["status"]), Signature: fmt.Sprint(row["signature"]), Lockfile: fmt.Sprint(row["lockfile_version"])}
		next[name] = rc
		if prev, ok := last[name]; ok && prev == rc {
			continue
		}
		changed = true
		row["name"] = name
		row["station_id"] = s.opts.Identity.StationID
		s.emit(protocol.MessageComponentStatus, row)
	}
	if !changed && len(next) == len(last) {
		return
	}
	b, _ := json.MarshalIndent(next, "", "  ")
	writeAtomic(s.reportedPath(), b)
}

func ReleaseDir(stateDir string) string {
	return filepath.Join(filepath.Dir(filepath.Clean(stateDir)), "release")
}

func (s *Station) lockMirror(g *protocol.Generation) ([]byte, bool) {
	raw, ok := g.Station.Settings.PlatformLockfile, g.Station.Settings.PlatformLockfile != nil
	if !ok {
		return nil, false
	}
	lb, err := json.Marshal(raw)
	if err != nil {
		return nil, false
	}
	var lock protocol.Lockfile
	if err := json.Unmarshal(lb, &lock); err != nil {
		return nil, false
	}
	var manifest *protocol.ReleaseManifest
	if mb, err := os.ReadFile(filepath.Join(ReleaseDir(s.opts.StateDir), "releases", strings.TrimPrefix(lock.ManifestDigest, "sha256:")+".json")); err == nil {
		var rm protocol.ReleaseManifest
		if json.Unmarshal(mb, &rm) == nil {
			manifest = &rm
		}
	}
	effective := protocol.PlatformMirrorEffective{}
	for name, pin := range g.Components {
		effective[name] = protocol.EffectivePin{Version: pin.Version, Digest: (*string)(pin.Digest), Source: sourceOf(name, manifest)}
	}
	doc := map[string]any{"lockfile": lock, "release_manifest": manifest, "effective": effective, "written_at": time.Now().UTC().Format(timestampLayout)}
	b, err := json.MarshalIndent(doc, "", "  ")
	return b, err == nil
}

func (s *Station) writeLockMirror(g *protocol.Generation) {
	if g.Station.Settings.PlatformLockfile == nil {
		return
	}
	b, ok := s.lockMirror(g)
	if !ok {
		s.log.Warn("platform.lockfile does not match schema 2; not mirrored")
		return
	}
	path := filepath.Join(s.opts.EtcDir, "platform.lock.json")
	if old, err := os.ReadFile(path); err == nil && sameMirror(old, b) {
		return
	}
	if err := os.MkdirAll(s.opts.EtcDir, 0o755); err != nil {
		s.log.Warn("mirror the lockfile", "error", err)
		return
	}
	if err := fsx.WriteFile(path, append(b, '\n'), 0o444); err != nil {
		s.log.Warn("mirror the lockfile", "path", path, "error", err)
		return
	}
	s.log.Info("lockfile mirrored", "path", path, "components", len(g.Components))
}

func sameMirror(a, b []byte) bool {
	strip := func(raw []byte) string {
		var m map[string]any
		if json.Unmarshal(raw, &m) != nil {
			return ""
		}
		delete(m, "written_at")
		out, _ := json.Marshal(m)
		return string(out)
	}
	return strip(a) == strip(b)
}

func sourceOf(name string, m *protocol.ReleaseManifest) *string {
	if m == nil {
		return nil
	}
	if c, ok := m.Components[name]; ok {
		v := c.Source
		return &v
	}
	return nil
}

func textOf(v any) string {
	switch d := v.(type) {
	case *string:
		if d != nil {
			return *d
		}
		return ""
	case protocol.ComponentPinDigest:
		if d != nil {
			return *d
		}
		return ""
	case string:
		return d
	}
	return fmt.Sprint(v)
}
