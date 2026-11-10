//go:build linux

package deploy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/fsx"
	"github.com/harshjv/stationly/go/internal/hostconfig"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/release"
	"github.com/harshjv/stationly/go/internal/verify"
)

var ComponentSources = map[string]string{
	"dispatch":          protocol.DispatchRepository,
	"gateway":           protocol.GatewaySource,
	"buildkit":          protocol.BuildkitSource,
	"depot":             protocol.DepotSource,
	"coupler_image":     protocol.CouplerImageSource,
	"railpack_frontend": protocol.RailpackFrontendSource,
	"syft_scanner":      protocol.SyftScannerSource,
	"litestream":        protocol.LitestreamSource,
	"sandbox_toolchain": protocol.SandboxToolchainRepository,
}

var RequiredComponents = []string{"stationd", "dispatch", "gateway", "buildkit", "depot", "coupler_image", "railpack_frontend", "syft_scanner", "litestream"}

const (
	DefaultSlyPath = "/usr/local/bin/sly"
	TestTrustFile  = "test-trust.json"
	manifestFile   = release.ManifestFile
	bundleSuffix   = release.BundleSuffix
)

type InstallOptions struct {
	Release       string
	StateDir      string
	EtcDir        string
	DaemonJSON    string
	SysctlFile    string
	DispatchURL   string
	AllowUnsigned bool
	Pull          bool
	Host          bool
	Unit          bool
	BinDir        string
	BinaryLink    string
	UnitPath      string
	SlyPath       string
	RunArgs       []string
	Litestream    *hostconfig.Litestream
	RecoveryKey   string
	SandboxDevice string
	SandboxWipe   bool
	SandboxSize   uint64
	SandboxUnits  string
}

type InstallStep struct {
	Step       string `json:"step"`
	Component  string `json:"component,omitempty"`
	Digest     string `json:"digest,omitempty"`
	Result     string `json:"result"`
	Detail     string `json:"detail,omitempty"`
	DurationMs int64  `json:"duration_ms"`
}

type InstallReport struct {
	Release        string              `json:"release"`
	ManifestDigest string              `json:"manifest_digest"`
	Identity       string              `json:"identity"`
	TrustedRoot    verify.RootState    `json:"trusted_root"`
	Test           bool                `json:"test"`
	Steps          []InstallStep       `json:"steps"`
	Host           *InstallState       `json:"host,omitempty"`
	HandoffDir     string              `json:"handoff_dir"`
	DurationMs     int64               `json:"duration_ms"`
	Failure        *protocol.ErrorBody `json:"failure,omitempty"`
}

func openInstallRelease(ctx context.Context, t verify.Trust, ref string) (release.Source, string, error) {
	if fi, err := os.Stat(ref); err == nil && fi.IsDir() {
		return release.Dir(ref), "", nil
	}
	version, ok := release.Version(ref)
	if !ok {
		return nil, "", fmt.Errorf("--release %q is neither a release version (0.1.0 or v0.1.0) nor a directory", ref)
	}
	src, err := OpenRelease(ctx, t, version)
	return src, version, err
}

func ParseReleaseManifest(raw []byte) (*protocol.ReleaseManifest, error) {
	var m protocol.ReleaseManifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("release-manifest.json: %w", err)
	}
	if m.Schema != 1 {
		return nil, fmt.Errorf("release-manifest.json schema %v is not 1", m.Schema)
	}
	return &m, nil
}

func platformKey() string { return "linux/" + runtime.GOARCH }

func pinOf(c protocol.ReleaseComponent) string {
	if c.Digest != nil {
		return *c.Digest
	}
	if c.Platforms == nil {
		return ""
	}
	if !hasPlatform(c) {
		return ""
	}
	if runtime.GOARCH == "arm64" {
		return *c.Platforms.LinuxArm64
	}
	return *c.Platforms.LinuxAmd64
}

func Install(ctx context.Context, v *verify.Verifier, opts InstallOptions) (InstallReport, error) {
	start := time.Now()
	rep := InstallReport{Steps: []InstallStep{}}
	step := func(name, component, digest, result, detail string, t time.Time) {
		rep.Steps = append(rep.Steps, InstallStep{Step: name, Component: component, Digest: digest, Result: result, Detail: detail, DurationMs: time.Since(t).Milliseconds()})
	}
	fail := func(code protocol.ErrorCode, fix, format string, args ...any) (InstallReport, error) {
		rep.Failure = &protocol.ErrorBody{Code: string(code), Explanation: fmt.Sprintf(format, args...), Fix: fix}
		rep.DurationMs = time.Since(start).Milliseconds()
		return rep, fmt.Errorf("%s: %s", code, rep.Failure.Explanation)
	}
	direct := verify.NewDirect(v.Trust())

	if opts.Host {
		hs, err := prepareHost(ctx, opts, v.Trust().InsecureRegistries, func(name, detail, result string, t time.Time) { step(name, "", "", result, detail, t) })
		if err != nil {
			return fail(protocol.ErrorCodeValidationFailed, "Fix the host prerequisite and run the installer again.", "%v", err)
		}
		rep.Host = &hs.state
	}
	sandboxes := false
	if opts.Host {
		t := time.Now()
		ready, result, detail, err := provisionSandboxes(ctx, opts)
		step("sandbox_storage", "", "", result, detail, t)
		if err != nil {
			return fail(protocol.ErrorCodeValidationFailed, "Fix the sandbox storage option or drop it; everything else installs without it.", "%v", err)
		}
		sandboxes = ready
	}

	t := time.Now()
	state, err := v.Refresh(ctx, direct.TUF())
	rep.TrustedRoot = state
	if err != nil {
		step("tuf_refresh", "", state.Digest, "stale", err.Error(), t)
	} else {
		step("tuf_refresh", "", state.Digest, "ok", v.Trust().TUFMirror, t)
	}

	t = time.Now()
	src, wantRelease, err := openInstallRelease(ctx, v.Trust(), opts.Release)
	if err != nil {
		if errors.Is(err, release.ErrNotFound) {
			return fail(protocol.ErrorCodeReleaseNotFound, "Check the release version; releases are the tags of "+v.Trust().ReleasesRepository+".", "%v", err)
		}
		return fail(protocol.ErrorCodeSourceUnreachable, "Check the station's egress to "+v.Trust().ReleasesRepository+".", "%v", err)
	}
	raw, err := src.Read(ctx, manifestFile, release.MaxManifest)
	if err != nil {
		return fail(protocol.ErrorCodeReleaseNotFound, "Check the release version.", "%v", err)
	}
	bundle, err := src.Read(ctx, manifestFile+bundleSuffix, release.MaxBundle)
	if err != nil {
		return fail(protocol.ErrorCodeUnsignedArtifact, "Publish the manifest's Sigstore bundle with it.", "%v", err)
	}
	step("fetch_manifest", "", digestHex(raw), "ok", src.Location(), t)
	rep.ManifestDigest = digestHex(raw)

	t = time.Now()
	san, err := v.Blob(raw, bundle)
	if err != nil {
		step("verify_manifest", "", rep.ManifestDigest, "refused", err.Error(), t)
		return fail(protocol.ErrorCodeUnsignedArtifact, "Install a release signed by the release signing identity.", "release-manifest.json: %v", err)
	}
	rep.Identity = san
	step("verify_manifest", "", rep.ManifestDigest, "verified", san, t)
	m, err := ParseReleaseManifest(raw)
	if err != nil {
		return fail(protocol.ErrorCodeValidationFailed, "Publish a schema 1 manifest.", "%v", err)
	}
	rep.Release = m.Release

	rep.Test = !v.Trust().Production
	if missing := missingComponents(m); len(missing) > 0 {
		return fail(protocol.ErrorCodeValidationFailed, "Install a release that pins every phase 1a component for "+platformKey()+".", "release %s does not pin %s", m.Release, strings.Join(missing, ", "))
	}
	if wantRelease != "" && m.Release != wantRelease {
		return fail(protocol.ErrorCodeValidationFailed, "Install a release whose tag matches the release its manifest names.", "tag %s of %s holds the manifest of release %s", release.Tag(wantRelease), v.Trust().ReleasesRepository, m.Release)
	}
	names := make([]string, 0, len(m.Components))
	for n := range m.Components {
		names = append(names, n)
	}
	sort.Strings(names)

	t = time.Now()
	sd := m.Components["stationd"]
	want, self := pinOf(sd), SelfDigest()
	var have []byte
	if self == want {
		if path, err := os.Executable(); err == nil {
			have, _ = os.ReadFile(path)
		}
	}
	binDir := opts.BinDir
	if !opts.Unit {
		if binDir, err = os.MkdirTemp(opts.StateDir, "stationd-check-"); err != nil {
			return fail(protocol.ErrorCodeInternalError, "Check the state directory.", "%v", err)
		}
		defer os.RemoveAll(binDir)
	}
	check, err := fetchStationd(ctx, v, binDir, sd.Version, want, func() (release.Source, error) { return src, nil }, have)
	if err != nil {
		step("stationd", "stationd", want, "refused", err.Error(), t)
		return fail(protocol.ErrorCodeUnsignedArtifact, "Install a release whose stationd binary for "+platformKey()+" matches its manifest and carries the release signature.", "%v", err)
	}
	origin := "this binary is the pinned one"
	if self != want {
		origin = "this binary is " + self + "; installed the release's pinned binary instead"
	}
	step("stationd", "stationd", want, "verified", fmt.Sprintf("%s %s for %s, %s, signed by %s", sd.Version, check.Path, platformKey(), origin, check.Identity), t)

	var dc *docker.Client
	if opts.Pull {
		if dc, err = docker.Connect(ctx); err != nil {
			return fail(protocol.ErrorCodeStationOffline, "Start Docker.", "connect to Docker: %v", err)
		}
		defer dc.Close()
	}
	if sandboxes {
		if c, ok := m.Components["runsc"]; ok {
			t = time.Now()
			check, err := InstallRunsc(ctx, v, src, c.Version, pinOf(c))
			if err != nil {
				step("runsc", "runsc", pinOf(c), "refused", err.Error(), t)
				return fail(protocol.ErrorCodeUnsignedArtifact, "Install a release whose runsc archive for "+platformKey()+" matches its manifest and carries the release signature.", "%v", err)
			}
			step("runsc", "runsc", pinOf(c), "verified", fmt.Sprintf("runsc %s unpacked, recorded and probed on systrap (signed by %s, reused %t)", c.Version, check.Identity, check.Reused), t)
		} else {
			step("runsc", "runsc", "", "skipped", "release "+m.Release+" pins no runsc; sandboxes start once a release pins it", time.Now())
		}
	}
	for _, name := range names {
		c := m.Components[name]
		if c.Kind != protocol.ReleaseComponentKindImage {
			continue
		}
		if name == "sandbox_toolchain" && !sandboxes {
			step("verify_image", name, pinOf(c), "skipped", "no sandbox filesystem on this host", time.Now())
			continue
		}
		digest := pinOf(c)
		if want, ok := ComponentSources[name]; ok && v.Trust().Source(name, want) != c.Source {
			return fail(protocol.ErrorCodeValidationFailed, "Publish the component from the source stationd pulls.", "components.%s.source is %s; stationd pulls %s", name, c.Source, want)
		}
		r := v.Image(ctx, direct, name, c.Version, digest)
		step("verify_image", name, digest, string(r.Signature), firstNonEmpty(r.Reason, r.Identity), time.Now().Add(-r.Duration))
		if r.Signature == verify.Refused && !opts.AllowUnsigned {
			return fail(protocol.ErrorCodeUnsignedArtifact, "Install a release whose images the release signing identity signed.", "%s %s: %s", name, digest, r.Reason)
		}
		if dc == nil || name == "sandbox_toolchain" {
			continue
		}
		t = time.Now()
		ref := c.Source + "@" + digest
		if err := dc.EnsureImage(ctx, ref); err != nil {
			step("pull", name, digest, "failed", err.Error(), t)
			return fail(protocol.ErrorCodeSourceUnreachable, "Check the station's egress to "+c.Source+".", "pull %s: %v", ref, err)
		}
		got, err := dc.RepoDigests(ctx, ref)
		if err != nil || !containsDigest(got, digest) {
			step("pull", name, digest, "digest_mismatch", fmt.Sprint(got, err), t)
			return fail(protocol.ErrorCodeUnsignedArtifact, "Pull by the index digest the lockfile pins.", "%s resolved to %v, not %s", ref, got, digest)
		}
		step("pull", name, digest, "ok", ref, t)
	}

	if opts.Unit {
		runArgs := opts.RunArgs
		if !v.Trust().Production {
			t = time.Now()
			path, err := writeTestTrust(opts.EtcDir, v.Trust())
			if err != nil {
				step("test_trust", "", "", "failed", err.Error(), t)
				return fail(protocol.ErrorCodeInternalError, "Check "+opts.EtcDir+".", "%v", err)
			}
			if !hasFlag(runArgs, "--trust") {
				runArgs = append(append([]string{}, runArgs...), "--trust", path)
			}
			step("test_trust", "", "", "written", fmt.Sprintf("%s (%s); TEST INSTALL: stationd trusts this identity instead of the Stationly release identity, and the Gateway uses %s", path, v.Trust().Name, v.Trust().DefaultACME()), t)
		}
		t = time.Now()
		detail, err := installUnit(opts, check.Path, runArgs)
		if err != nil {
			step("unit", "stationd", "", "failed", err.Error(), t)
			return fail(protocol.ErrorCodeInternalError, "Check "+opts.BinDir+" and "+opts.UnitPath+".", "%v", err)
		}
		step("unit", "stationd", want, "written", detail, t)
		if opts.SlyPath != "" {
			t = time.Now()
			if err := writeSlyWrapper(opts.SlyPath, socketArg(runArgs)); err != nil {
				step("sly", "", "", "failed", err.Error(), t)
				return fail(protocol.ErrorCodeInternalError, "Check "+opts.SlyPath+".", "%v", err)
			}
			step("sly", "", "", "written", opts.SlyPath+" runs sly from the verified Dispatch image against "+socketArg(runArgs), t)
		}
	}

	t = time.Now()
	dir := ReleaseDir(opts.StateDir)
	if err := os.MkdirAll(filepath.Join(dir, "releases"), 0o755); err != nil {
		return fail(protocol.ErrorCodeInternalError, "Check the state directory.", "%v", err)
	}
	for path, body := range map[string][]byte{
		filepath.Join(dir, manifestFile):              raw,
		filepath.Join(dir, manifestFile+bundleSuffix): bundle,
		filepath.Join(dir, "source"):                  []byte(src.Location() + "\n"),
		filepath.Join(dir, "releases", strings.TrimPrefix(rep.ManifestDigest, "sha256:")+".json"): raw,
	} {
		if err := os.WriteFile(path, body, 0o644); err != nil {
			return fail(protocol.ErrorCodeInternalError, "Check the state directory.", "%v", err)
		}
	}
	rep.HandoffDir = dir
	step("handoff", "", rep.ManifestDigest, "ok", dir, t)
	rep.DurationMs = time.Since(start).Milliseconds()
	return rep, nil
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func containsDigest(refs []string, digest string) bool {
	for _, r := range refs {
		if strings.HasSuffix(r, "@"+digest) {
			return true
		}
	}
	return false
}

func digestHex(b []byte) string {
	return "sha256:" + sha256Hex(b)
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func missingComponents(m *protocol.ReleaseManifest) []string {
	missing := []string{}
	for _, name := range RequiredComponents {
		c, ok := m.Components[name]
		switch {
		case !ok:
			missing = append(missing, name)
		case c.Kind == protocol.ReleaseComponentKindImage && (c.Digest == nil || *c.Digest == ""):
			missing = append(missing, name+" (index digest)")
		case pinOf(c) == "" || !hasPlatform(c):
			missing = append(missing, name+" ("+platformKey()+")")
		}
	}
	return missing
}

func hasPlatform(c protocol.ReleaseComponent) bool {
	if c.Platforms == nil {
		return false
	}
	p := c.Platforms.LinuxAmd64
	if runtime.GOARCH == "arm64" {
		p = c.Platforms.LinuxArm64
	}
	return p != nil && *p != ""
}

func hasFlag(args []string, flag string) bool {
	for _, a := range args {
		if a == flag || strings.HasPrefix(a, flag+"=") {
			return true
		}
	}
	return false
}

func socketArg(args []string) string {
	for i, a := range args {
		if a == "--socket" && i+1 < len(args) {
			return args[i+1]
		}
		if v, ok := strings.CutPrefix(a, "--socket="); ok {
			return v
		}
	}
	return protocol.RootSocketPath
}

func writeTestTrust(etcDir string, t verify.Trust) (string, error) {
	b, err := t.MarshalTestTrust()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(etcDir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(etcDir, TestTrustFile)
	return path, fsx.WriteFile(path, append(b, '\n'), 0o644)
}

func SlyWrapper(socket string) string {
	return strings.Join([]string{
		"#!/bin/sh",
		"set -eu",
		"image=$(docker inspect --format '{{.Config.Image}}' " + docker.DispatchName + " 2>/dev/null) || {",
		"  echo 'sly: the Dispatch container " + docker.DispatchName + " is not on this host; start stationd (systemctl start " + protocol.StationdUnit + ") and wait for Dispatch' >&2",
		"  exit 5",
		"}",
		"tty=",
		"if [ -t 0 ] && [ -t 1 ] && [ -t 2 ]; then tty=-t; fi",
		"exec docker run --rm -i $tty --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --user 0:0 \\",
		"  -e HOME=/tmp -e LITESTREAM_ACCESS_KEY_ID -e LITESTREAM_SECRET_ACCESS_KEY -v " + filepath.Dir(socket) + ":" + filepath.Dir(socket) + " \\",
		"  --entrypoint node \"$image\" /app/packages/cli/src/index.ts \"$@\"",
		"",
	}, "\n")
}

func writeSlyWrapper(path, socket string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return fsx.WriteFile(path, []byte(SlyWrapper(socket)), 0o755)
}

func installUnit(opts InstallOptions, binary string, runArgs []string) (string, error) {
	if err := os.MkdirAll(filepath.Dir(opts.BinaryLink), 0o755); err != nil {
		return "", err
	}
	if err := Repoint(opts.BinaryLink, binary); err != nil {
		return "", err
	}
	if err := os.WriteFile(opts.UnitPath, []byte(UnitFile(opts.BinaryLink, runArgs)), 0o644); err != nil {
		return "", err
	}
	out, err := exec.Command("systemctl", "daemon-reload").CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("systemctl daemon-reload: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return fmt.Sprintf("%s -> %s; %s (Type=notify, NotifyAccess=main)", opts.BinaryLink, binary, opts.UnitPath), nil
}
