//go:build linux

package deploy

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/harshjv/stationly/go/internal/dispatch"
	"github.com/harshjv/stationly/go/internal/fsx"
	"github.com/harshjv/stationly/go/internal/ids"
	"github.com/harshjv/stationly/go/internal/outbox"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/release"
	"github.com/harshjv/stationly/go/internal/upgrade"
	"github.com/harshjv/stationly/go/internal/verify"
)

const (
	DefaultBinDir   = "/usr/local/lib/stationly"
	DefaultLink     = "/usr/local/bin/stationd"
	DefaultUnitPath = "/etc/systemd/system/" + protocol.StationdUnit + ".service"
	handoverTimeout = 60 * time.Second
	maxBinary       = 256 << 20
)

func BinaryPath(binDir, version string) string {
	return filepath.Join(binDir, "stationd-"+version)
}

func StationdFile() string {
	return "stationd-linux-" + runtime.GOARCH
}

func OpenRelease(ctx context.Context, t verify.Trust, version string) (release.Source, error) {
	return release.Open(ctx, t.ReleasesRepository, t.ReleasesInsecure(), version)
}

type BinaryCheck struct {
	Path       string `json:"path"`
	Identity   string `json:"identity"`
	Downloaded bool   `json:"downloaded"`
	TookMs     int64  `json:"took_ms"`
}

func FetchStationd(ctx context.Context, v *verify.Verifier, binDir, version, digest string) (BinaryCheck, error) {
	return fetchStationd(ctx, v, binDir, version, digest, func() (release.Source, error) { return OpenRelease(ctx, v.Trust(), version) }, nil)
}

func fetchStationd(ctx context.Context, v *verify.Verifier, binDir, version, digest string, open func() (release.Source, error), have []byte) (BinaryCheck, error) {
	start := time.Now()
	out := BinaryCheck{Path: BinaryPath(binDir, version)}
	data, err := os.ReadFile(out.Path)
	bundle, berr := os.ReadFile(out.Path + bundleSuffix)
	location := out.Path
	if err != nil || berr != nil || digestHex(data) != digest {
		src, err := open()
		if err != nil {
			return out, err
		}
		location = src.Location()
		if have != nil && digestHex(have) == digest {
			data = have
		} else if data, err = src.Read(ctx, StationdFile(), maxBinary); err != nil {
			return out, err
		}
		if bundle, err = src.Read(ctx, StationdFile()+bundleSuffix, release.MaxBundle); err != nil {
			return out, err
		}
		out.Downloaded = true
	}
	if got := digestHex(data); got != digest {
		return out, fmt.Errorf("stationd %s for linux/%s from %s is %s; the release manifest pins %s", version, runtime.GOARCH, location, got, digest)
	}
	san, err := v.Blob(data, bundle)
	if err != nil {
		return out, fmt.Errorf("stationd %s: %s: %w", version, "no valid signature from the release signing identity", err)
	}
	out.Identity = san
	if out.Downloaded {
		if err := os.MkdirAll(binDir, 0o755); err != nil {
			return out, err
		}
		for path, body := range map[string][]byte{out.Path: data, out.Path + bundleSuffix: bundle} {
			mode := os.FileMode(0o644)
			if path == out.Path {
				mode = 0o755
			}
			if err := fsx.WriteFile(path, body, mode); err != nil {
				return out, err
			}
		}
	}
	out.TookMs = time.Since(start).Milliseconds()
	return out, nil
}

func Repoint(link, target string) error {
	tmp := link + ".next"
	os.Remove(tmp)
	if err := os.Symlink(target, tmp); err != nil {
		return err
	}
	return os.Rename(tmp, link)
}

func UnitFile(link string, args []string) string {
	exec := append([]string{link, "run"}, args...)
	return strings.Join([]string{
		"[Unit]",
		"Description=Stationly station daemon (stationd)",
		"Documentation=https://github.com/harshjv/stationly",
		"Wants=network-online.target docker.service var-lib-stationly-sandboxes.mount",
		"After=network-online.target docker.service var-lib-stationly-sandboxes.mount",
		"",
		"[Service]",
		"Type=notify",
		"NotifyAccess=main",
		"ExecStart=" + strings.Join(exec, " "),
		"Restart=on-failure",
		"RestartSec=2",
		"TimeoutStartSec=300",
		"TimeoutStopSec=60",
		"",
		"[Install]",
		"WantedBy=multi-user.target",
		"",
	}, "\n")
}

func (s *Station) startSelfUpgrade(ctx context.Context, p *procState) {
	to := p.To
	go func() {
		start := time.Now()
		check, err := FetchStationd(ctx, s.verifier, s.opts.BinDir, to.Version, to.Digest)
		select {
		case s.inspections <- func() {
			p.Detail["binary"] = check
			if err != nil {
				s.finishProcedure("stationd", p, to, err, time.Since(start))
				return
			}
			s.handover(ctx, p, check.Path, start)
		}:
		case <-ctx.Done():
		}
	}()
}

func (s *Station) pauseLink() {
	s.linkCancel()
	<-s.linkDone
	s.capCancel()
	s.captures.waitAll(3 * time.Second)
	if err := s.outbox.Close(); err != nil {
		s.log.Warn("close the outbox for the handover", "error", err)
	}
}

func (s *Station) resumeLink(ctx context.Context) error {
	ob, err := outbox.Open(filepath.Join(s.opts.StateDir, "outbox"), ids.New)
	if err != nil {
		return err
	}
	link, err := dispatch.New(s.log, s.opts.Identity, ob, Version())
	if err != nil {
		ob.Close()
		return err
	}
	s.outbox, s.link = ob, link
	s.startLink(ctx)
	s.startCaptures(ctx)
	return nil
}

func (s *Station) handover(ctx context.Context, p *procState, path string, began time.Time) {
	to := p.To
	p.Step = "handover"
	s.handingOver = true
	s.reportComponents(s.plan.Generation)
	s.writeObserved()
	t := time.Now()
	s.pauseLink()
	paused := time.Since(t)
	args := append(append([]string{"run"}, s.opts.RunArgs...), "--handover")
	child, err := upgrade.Spawn(path, args)
	fail := func(cause error) {
		if rerr := s.resumeLink(ctx); rerr != nil {
			s.log.Error("reopen the outbox and the Dispatch link after a failed handover", "error", rerr)
		}
		s.handingOver = false
		s.finishProcedure("stationd", p, to, cause, time.Since(began))
	}
	if err != nil {
		fail(fmt.Errorf("start %s: %w", path, err))
		return
	}
	s.log.Info("handover: new stationd started; this process keeps serving DNS until it reports ready", "pid", child.Cmd.Process.Pid, "binary", path, "sockets", child.Keys, "pause_ms", paused.Milliseconds())
	timer := time.NewTimer(handoverTimeout)
	defer timer.Stop()
	var ready string
	select {
	case line, ok := <-child.Ready:
		if !ok {
			err := <-child.Exit
			fail(fmt.Errorf("the new stationd %s exited before reporting ready: %w", to.Version, err))
			return
		}
		ready = strings.TrimSpace(line)
	case err := <-child.Exit:
		fail(fmt.Errorf("the new stationd %s exited before reporting ready: %w", to.Version, err))
		return
	case <-timer.C:
		_ = child.Cmd.Process.Kill()
		<-child.Exit
		fail(fmt.Errorf("the new stationd %s did not report ready within %s; it was killed and this process kept running", to.Version, handoverTimeout))
		return
	}
	readyAt := time.Since(t)
	if err := Repoint(s.opts.BinaryLink, path); err != nil {
		s.log.Error("repoint the stationd symlink", "link", s.opts.BinaryLink, "target", path, "error", err)
	}
	sent, err := upgrade.HandOver(child.Cmd.Process.Pid)
	s.log.Info("handover: MAINPID and READY sent; stopping DNS and exiting", "pid", child.Cmd.Process.Pid, "ready", ready, "ready_ms", readyAt.Milliseconds(), "notified", sent, "error", err, "link", s.opts.BinaryLink, "target", path)
	s.resolver.Close()
	s.depot.Close()
	if s.sock != nil {
		s.sock.Close()
	}
	s.handedOver = true
}
