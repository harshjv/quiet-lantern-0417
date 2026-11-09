//go:build linux

package deploy

import (
	"bytes"
	"context"
	"fmt"
	"runtime"
	"slices"
	"time"

	"github.com/harshjv/stationly/go/internal/release"
	"github.com/harshjv/stationly/go/internal/sandbox/runsc"
	"github.com/harshjv/stationly/go/internal/verify"
)

const maxRunscArchive = 256 << 20

func runscFile() string {
	return "runsc-linux-" + runtime.GOARCH + ".tar.zst"
}

func (s *Station) needsRunsc(want componentPin) bool {
	if !s.sbx.kernelOK || !s.sandboxStorageReady() {
		return false
	}
	versions, _ := runsc.Installed(runsc.LibDir)
	return !slices.Contains(versions, want.Version)
}

func (s *Station) runscRelease() string {
	if s.plan != nil {
		if pin, ok := s.plan.Generation.Components["stationd"]; ok {
			return pin.Version
		}
	}
	return stationdVersion()
}

func (s *Station) runscProcedure(ctx context.Context, name string, p *procState, step func(string, map[string]any)) error {
	if !s.sbx.kernelOK || s.verifier == nil {
		step("skipped", map[string]any{"reason": "this station runs no sandboxes"})
		return nil
	}
	if !s.sandboxStorageReady() {
		step("skipped", map[string]any{"reason": "no sandbox filesystem on this station"})
		return nil
	}
	src, err := OpenRelease(ctx, s.verifier.Trust(), s.runscRelease())
	if err != nil {
		return err
	}
	step("download", map[string]any{"release": src.Location(), "file": runscFile()})
	_, err = InstallRunsc(ctx, s.verifier, src, p.To.Version, p.To.Digest)
	if err != nil {
		return err
	}
	step("installed", map[string]any{"version": p.To.Version})
	return nil
}

type RunscCheck struct {
	Version  string `json:"version"`
	Identity string `json:"identity"`
	TookMs   int64  `json:"took_ms"`
	Reused   bool   `json:"reused"`
}

func InstallRunsc(ctx context.Context, v *verify.Verifier, src release.Source, version, digest string) (RunscCheck, error) {
	start := time.Now()
	out := RunscCheck{Version: version}
	rt := runsc.At(runsc.LibDir, runsc.StateBase, version)
	versions, _ := runsc.Installed(runsc.LibDir)
	if slices.Contains(versions, version) {
		out.Reused = true
		problems, err := rt.Verify()
		if err == nil && len(problems) == 0 {
			out.TookMs = time.Since(start).Milliseconds()
			return out, nil
		}
		if err := runsc.Remove(runsc.LibDir, runsc.StateBase, version); err != nil {
			return out, fmt.Errorf("remove the modified runsc %s: %w", version, err)
		}
	}
	data, err := src.Read(ctx, runscFile(), maxRunscArchive)
	if err != nil {
		return out, err
	}
	bundle, err := src.Read(ctx, runscFile()+bundleSuffix, release.MaxBundle)
	if err != nil {
		return out, fmt.Errorf("runsc %s has no signature bundle: %w", version, err)
	}
	if got := digestHex(data); got != digest {
		return out, fmt.Errorf("runsc archive %s in %s is %s; the pin is %s", runscFile(), src.Location(), got, digest)
	}
	san, err := v.Blob(data, bundle)
	if err != nil {
		return out, fmt.Errorf("runsc %s: no valid signature from the release signing identity: %w", version, err)
	}
	out.Identity = san
	if err := runsc.Install(runsc.LibDir, version, bytes.NewReader(data)); err != nil {
		return out, fmt.Errorf("unpack runsc %s: %w", version, err)
	}
	pctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	if err := rt.Probe(pctx); err != nil {
		runsc.Remove(runsc.LibDir, runsc.StateBase, version)
		return out, fmt.Errorf("probe runsc %s on systrap: %w", version, err)
	}
	out.TookMs = time.Since(start).Milliseconds()
	return out, nil
}
