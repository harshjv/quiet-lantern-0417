//go:build linux

package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/harshjv/stationly/go/internal/deploy"
	"github.com/harshjv/stationly/go/internal/dispatch"
	"github.com/harshjv/stationly/go/internal/hostconfig"
	"github.com/harshjv/stationly/go/internal/identity"
	"github.com/harshjv/stationly/go/internal/ids"
	"github.com/harshjv/stationly/go/internal/outbox"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/rootsocket"
	"github.com/harshjv/stationly/go/internal/upgrade"
	"github.com/harshjv/stationly/go/internal/verify"
)

const usage = `usage:
  stationd enroll <token> --dispatch-url <url> [--state-dir <dir>]
  stationd install --release <version|dir> [--state-dir <dir>] [--trust <test trust file>] [--allow-unsigned] [--no-pull] [--no-unit] [--sly-path <path>] [--litestream-bucket <bucket> [--litestream-endpoint <url>]] [--sandbox-size <bytes|GiB> | --sandbox-device <path> [--sandbox-device-wipe]] [--run-arg <arg>]...
  stationd run [--state-dir <dir>] [--socket <path>] [--debug] [--trust <file>] [--sigstore-fetch direct|dispatch] [--etc-dir <dir>] [--bin-dir <dir>] [--link <path>]
  stationd verify image --component <name> --version <v> --digest <sha256:...> [--state-dir <dir>] [--trust <file>]
  stationd verify refresh [--state-dir <dir>] [--trust <file>]
  stationd status [--state-dir <dir>] [--json]
  stationd connection [--socket <path>]
  stationd dispatch-env [--state-dir <dir>] [--etc-dir <dir>]
  stationd doctor [--socket <path>] [--json]
  stationd registry token --scope <scope> [--scope <scope>] [--ttl <seconds>] [--socket <path>]
  stationd registry retain --project <id> [--socket <path>]
  stationd registry delete --repository <name> --digest <digest> [--socket <path>]
  stationd registry gc [--socket <path>]
  stationd secrets status [--socket <path>]
  stationd logs --deployment <id> [--tail <n>] [--socket <path>]
`

type multi []string

func (m *multi) String() string     { return strings.Join(*m, " ") }
func (m *multi) Set(v string) error { *m = append(*m, v); return nil }

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "enroll":
		err = enroll(os.Args[2:])
	case "run":
		err = run(os.Args[2:])
	case "install":
		err = install(os.Args[2:])
	case "verify":
		err = verifyCmd(os.Args[2:])
	case "status":
		err = status(os.Args[2:])
	case "connection":
		err = connection(os.Args[2:])
	case "doctor":
		err = doctor(os.Args[2:])
	case "dispatch-env":
		err = dispatchEnv(os.Args[2:])
	case "registry":
		err = registry(os.Args[2:])
	case "secrets":
		err = secretsCmd(os.Args[2:])
	case "logs":
		err = logs(os.Args[2:])
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "stationd:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	stateDir := fs.String("state-dir", deploy.DefaultStateDir, "stationd state directory")
	socket := fs.String("socket", rootsocket.DefaultPath, "root socket path")
	debug := fs.Bool("debug", false, "log every Docker event")
	trustPath := fs.String("trust", "", "signing identity and Sigstore trust file (default: the Stationly release identity)")
	fetch := fs.String("sigstore-fetch", deploy.FetchDirect, "where signature bundles and TUF metadata come from: direct or dispatch")
	etcDir := fs.String("etc-dir", hostconfig.DefaultEtcDir, "directory holding host.toml and platform.lock.json")
	backupRoot := fs.String("backup-root", deploy.DefaultBackupRoot, "station backup root; path targets of volume_backup.target live under it")
	binDir := fs.String("bin-dir", deploy.DefaultBinDir, "directory holding stationd-<version> binaries")
	binLink := fs.String("link", deploy.DefaultLink, "symlink the systemd unit starts")
	handoverFlag := fs.Bool("handover", false, "started by the running stationd during a self-upgrade; adopt its sockets")
	fs.Parse(args)
	runArgs := make([]string, 0, len(args))
	for _, a := range args {
		if a != "--handover" && a != "-handover" {
			runArgs = append(runArgs, a)
		}
	}
	inheritedSockets, err := upgrade.LoadInherited()
	if err != nil {
		return err
	}
	if *handoverFlag != inheritedSockets {
		return fmt.Errorf("--handover needs the sockets of a running stationd (%s) and only comes from one", upgrade.HandoverEnv)
	}
	if *fetch != deploy.FetchDirect && *fetch != deploy.FetchDispatch {
		return fmt.Errorf("--sigstore-fetch is direct or dispatch")
	}
	level := slog.LevelInfo
	if *debug {
		level = slog.LevelDebug
	}
	if err := os.MkdirAll(*stateDir, 0o700); err != nil {
		return err
	}
	log := slog.New(slog.NewTextHandler(io.MultiWriter(os.Stderr, deploy.SelfLog(*stateDir)), &slog.HandlerOptions{Level: level}))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	v, err := newVerifier(log, *trustPath, *stateDir)
	if err != nil {
		return err
	}
	if !identity.Exists(*stateDir) {
		host, _ := hostconfig.Load(*etcDir)
		inst, _ := deploy.LoadInstallState(*stateDir)
		cleanup, err := deploy.Bootstrap(ctx, deploy.BootstrapOptions{StateDir: *stateDir, EtcDir: *etcDir, Log: log, Verifier: v, Install: inst, Host: host})
		if err != nil {
			return fmt.Errorf("first boot: %w", err)
		}
		if sent, nerr := upgrade.Notify("READY=1"); sent || nerr != nil {
			log.Info("systemd notified before enrollment", "state", "READY=1", "error", nerr)
		}
		err = bootstrapEnroll(ctx, log, *stateDir, *etcDir)
		cleanup()
		if err != nil {
			return err
		}
	}
	id, err := identity.Load(*stateDir)
	if err != nil {
		return err
	}
	ob, err := outbox.Open(filepath.Join(*stateDir, "outbox"), ids.New)
	if err != nil {
		return fmt.Errorf("open the outbox: %w", err)
	}
	link, err := dispatch.New(log, id, ob, deploy.Version())
	if err != nil {
		return err
	}
	host, err := hostconfig.Load(*etcDir)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	inst, err := deploy.LoadInstallState(*stateDir)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return deploy.Run(ctx, deploy.Options{StateDir: *stateDir, SocketPath: *socket, Log: log, Identity: id, Link: link, Outbox: ob, Verifier: v, SigstoreFetch: *fetch, EtcDir: *etcDir, Host: host, Install: inst, BackupRoot: *backupRoot, Handover: inheritedSockets, RunArgs: runArgs, BinDir: *binDir, BinaryLink: *binLink})
}

func enroll(args []string) error {
	if len(args) < 1 || strings.HasPrefix(args[0], "-") {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	token := args[0]
	fs := flag.NewFlagSet("enroll", flag.ExitOnError)
	url := fs.String("dispatch-url", "", "Dispatch API URL (dispatch.url)")
	stateDir := fs.String("state-dir", deploy.DefaultStateDir, "stationd state directory")
	fs.Parse(args[1:])
	if *url == "" {
		return fmt.Errorf("--dispatch-url is required")
	}
	if identity.Exists(*stateDir) {
		return fmt.Errorf("this station is already enrolled (%s exists)", identity.Dir(*stateDir))
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	out, err := enrollAndSave(ctx, *url, token, *stateDir, nil)
	if err != nil {
		return err
	}
	printJSON(out)
	return nil
}

func enrollAndSave(ctx context.Context, url, token, stateDir string, install *protocol.EnrollInstall) (map[string]any, error) {
	keys, err := identity.NewKeys()
	if err != nil {
		return nil, err
	}
	info, err := deploy.EnrollInfo(ctx)
	if err != nil {
		return nil, err
	}
	info.Install = install
	start := time.Now()
	out, err := dispatch.Enroll(ctx, url, token, keys, info)
	if err != nil {
		return nil, err
	}
	st := identity.Station{
		StationID:       out.StationId,
		InstanceID:      out.InstanceId,
		DispatchURL:     url,
		RegistrySubnet:  out.RegistrySubnet,
		RegistryAddress: out.RegistryAddress,
		Settings:        map[string]string{"ipam.pool": out.Settings.IpamPool, "ipam.virtual_prefix": out.Settings.IpamVirtualPrefix},
	}
	if err := identity.Save(stateDir, st, keys); err != nil {
		return nil, err
	}
	return map[string]any{"station_id": out.StationId, "instance_id": out.InstanceId, "registry_subnet": out.RegistrySubnet, "registry_address": out.RegistryAddress, "settings": out.Settings, "identity_key": keys.IdentityPublic(), "took_ms": time.Since(start).Milliseconds()}, nil
}

func bootstrapEnroll(ctx context.Context, log *slog.Logger, stateDir, etcDir string) error {
	raw, err := os.ReadFile(deploy.BootstrapTokenPath(stateDir))
	if err != nil {
		return fmt.Errorf("this station is not enrolled and has no bootstrap token (%v); run the installer, or stationd enroll <token> --dispatch-url <url>", err)
	}
	token := strings.TrimSpace(string(raw))
	host, err := hostconfig.Load(etcDir)
	if err != nil {
		return fmt.Errorf("read host.toml: %w", err)
	}
	inst, err := deploy.LoadInstallState(stateDir)
	if err != nil {
		return fmt.Errorf("read the install-time values: %w", err)
	}
	proposal := &protocol.EnrollInstall{IpamPool: inst.IpamPool, RegistrySubnet: inst.RegistrySubnet}
	if inst.StationID != "" {
		proposal.StationId = &inst.StationID
	}
	log.Info("bootstrap enrollment: waiting for Dispatch", "dispatch_url", host.Dispatch.URL, "ipam_pool", inst.IpamPool, "registry_subnet", inst.RegistrySubnet)
	wait, attempts, started := time.Second, 0, time.Now()
	for {
		attempts++
		out, err := enrollAndSave(ctx, host.Dispatch.URL, token, stateDir, proposal)
		if err == nil {
			if inst.StationID != "" && out["station_id"] != inst.StationID {
				log.Error("Dispatch assigned a station id other than the installer's; the system network and Dispatch carry the installer's", "dispatch", out["station_id"], "installer", inst.StationID)
			}
			if out["registry_subnet"] != inst.RegistrySubnet {
				log.Error("Dispatch recorded a registry subnet other than the installer's; daemon.json lists the installer's", "dispatch", out["registry_subnet"], "installer", inst.RegistrySubnet)
			}
			if err := os.Remove(deploy.BootstrapTokenPath(stateDir)); err != nil {
				log.Warn("remove the used bootstrap token", "error", err)
			}
			log.Info("bootstrap enrollment done", "station_id", out["station_id"], "registry_subnet", out["registry_subnet"], "registry_address", out["registry_address"], "attempts", attempts, "waited_ms", time.Since(started).Milliseconds())
			return nil
		}
		if refusal, ok := dispatch.Refused(err); ok {
			return fmt.Errorf("Dispatch refused the bootstrap token: %s: %s", refusal.Code, refusal.Explanation)
		}
		if attempts == 1 || attempts%10 == 0 {
			log.Info("Dispatch not reachable yet; retrying bootstrap enrollment", "attempt", attempts, "error", err, "retry_in", wait)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
		wait = min(wait*2, 15*time.Second)
	}
}

func dispatchEnv(args []string) error {
	fs := flag.NewFlagSet("dispatch-env", flag.ExitOnError)
	stateDir := fs.String("state-dir", deploy.DefaultStateDir, "stationd state directory")
	etcDir := fs.String("etc-dir", hostconfig.DefaultEtcDir, "directory holding host.toml")
	fs.Parse(args)
	env, err := deploy.DispatchEnv(*stateDir, *etcDir)
	if err != nil {
		return err
	}
	for _, kv := range env {
		fmt.Println(kv)
	}
	return nil
}

func connection(args []string) error {
	fs := flag.NewFlagSet("connection", flag.ExitOnError)
	socket := fs.String("socket", rootsocket.DefaultPath, "root socket path")
	fs.Parse(args)
	return call(*socket, "status", map[string]any{})
}

func status(args []string) error {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	stateDir := fs.String("state-dir", deploy.DefaultStateDir, "stationd state directory")
	asJSON := fs.Bool("json", false, "print the observed-state document")
	fs.Parse(args)
	return deploy.PrintStatus(os.Stdout, *stateDir, *asJSON)
}

func doctor(args []string) error {
	fs := flag.NewFlagSet("doctor", flag.ExitOnError)
	socket := fs.String("socket", rootsocket.DefaultPath, "root socket path")
	asJSON := fs.Bool("json", false, "print the report as JSON")
	fs.Parse(args)
	result, failure, err := rootsocket.Call(*socket, "doctor", map[string]any{}, func(rootsocket.ProgressBody) {})
	if err != nil {
		return err
	}
	if failure != nil {
		return fmt.Errorf("%s: %s", failure.Code, failure.Explanation)
	}
	var rep protocol.DoctorReportBody
	if err := json.Unmarshal(result, &rep); err != nil {
		return err
	}
	if *asJSON {
		printJSON(rep)
	}
	failing := false
	for _, c := range rep.Checks {
		if !*asJSON {
			code := ""
			if c.Code != nil {
				code = " [" + *c.Code + "]"
			}
			fmt.Printf("%-5s %-20s %s%s\n", strings.ToUpper(string(c.Status)), c.Name, c.Finding, code)
			if c.Fix != nil {
				fmt.Printf("      %-20s fix: %s\n", "", *c.Fix)
			}
		}
		failing = failing || c.Status == protocol.DoctorStatusFail
	}
	if failing {
		return fmt.Errorf("doctor found failing checks")
	}
	return nil
}

func call(socket, op string, params any) error {
	start := time.Now()
	result, failure, err := rootsocket.Call(socket, op, params, func(p rootsocket.ProgressBody) {
		fmt.Fprintf(os.Stderr, "%7.2fs  %-20s %s\n", time.Since(start).Seconds(), p.Step, p.Detail)
	})
	if err != nil {
		return err
	}
	if len(result) > 0 {
		var pretty any
		if json.Unmarshal(result, &pretty) == nil {
			b, _ := json.MarshalIndent(pretty, "", "  ")
			fmt.Println(string(b))
		}
	}
	if failure != nil {
		fmt.Fprintln(os.Stderr, failure.Explanation)
		fmt.Fprintln(os.Stderr, failure.Code)
		return fmt.Errorf("%s", failure.Code)
	}
	return nil
}

func registry(args []string) error {
	if len(args) < 1 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	fs := flag.NewFlagSet("registry "+args[0], flag.ExitOnError)
	socket := fs.String("socket", rootsocket.DefaultPath, "root socket path")
	switch args[0] {
	case "token":
		var scopes multi
		fs.Var(&scopes, "scope", "repository:<name>:<actions>")
		ttl := fs.Int("ttl", 60, "lifetime in seconds, at most 60")
		fs.Parse(args[1:])
		return call(*socket, "registry.token", map[string]any{"scopes": []string(scopes), "ttl_s": *ttl})
	case "retain":
		project := fs.String("project", "", "project id")
		fs.Parse(args[1:])
		return call(*socket, "registry.retain", map[string]string{"project_id": *project})
	case "delete":
		repo := fs.String("repository", "", "repository")
		digest := fs.String("digest", "", "manifest digest")
		fs.Parse(args[1:])
		return call(*socket, "registry.delete", protocol.RegistryDeleteBody{Items: []protocol.RegistryDeleteItem{{Repository: *repo, Digest: *digest, Reason: "manual"}}})
	case "gc":
		fs.Parse(args[1:])
		return call(*socket, "registry.gc", map[string]string{"reason": "schedule"})
	}
	fmt.Fprint(os.Stderr, usage)
	os.Exit(2)
	return nil
}

func secretsCmd(args []string) error {
	if len(args) < 1 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	fs := flag.NewFlagSet("secrets "+args[0], flag.ExitOnError)
	socket := fs.String("socket", rootsocket.DefaultPath, "root socket path")
	fs.Parse(args[1:])
	switch args[0] {
	case "status":
		return call(*socket, "secrets.status", map[string]any{})
	}
	fmt.Fprint(os.Stderr, usage)
	os.Exit(2)
	return nil
}

func logs(args []string) error {
	fs := flag.NewFlagSet("logs", flag.ExitOnError)
	socket := fs.String("socket", rootsocket.DefaultPath, "root socket path")
	deployment := fs.String("deployment", "", "deployment id")
	tail := fs.Int("tail", 200, "lines")
	fs.Parse(args)
	return call(*socket, "logs", map[string]any{"deployment_id": *deployment, "tail": *tail})
}

func newVerifier(log *slog.Logger, trustPath, stateDir string) (*verify.Verifier, error) {
	trust, err := verify.LoadTrust(trustPath)
	if err != nil {
		return nil, err
	}
	return verify.New(log, trust, stateDir)
}

func printJSON(v any) {
	b, _ := json.MarshalIndent(v, "", "  ")
	fmt.Println(string(b))
}

func install(args []string) error {
	fs := flag.NewFlagSet("install", flag.ExitOnError)
	release := fs.String("release", "", "release version (0.1.0), fetched by tag v<version> from the releases repository the signing identity names, or a directory holding release-manifest.json and its .sigstore.json bundle")
	stateDir := fs.String("state-dir", deploy.DefaultStateDir, "stationd state directory")
	trustPath := fs.String("trust", "", "signing identity and Sigstore trust file")
	allow := fs.Bool("allow-unsigned", false, "continue past artifacts without a valid signature")
	noPull := fs.Bool("no-pull", false, "verify only; do not pull images")
	etcDir := fs.String("etc-dir", hostconfig.DefaultEtcDir, "directory for host.toml and platform.lock.json")
	daemonJSON := fs.String("daemon-json", deploy.DefaultDaemonJSON, "Docker daemon configuration the installer writes")
	sysctlFile := fs.String("sysctl-file", deploy.DefaultSysctlFile, "sysctl drop-in the installer writes")
	dispatchURL := fs.String("dispatch-url", deploy.DefaultDispatchURL, "dispatch.url written into host.toml")
	noHost := fs.Bool("no-host", false, "skip the host steps (git check, ipam.pool, host.toml, bootstrap token, sysctl, daemon.json)")
	noUnit := fs.Bool("no-unit", false, "skip placing the binary, the symlink and the systemd unit")
	binDir := fs.String("bin-dir", deploy.DefaultBinDir, "directory for stationd-<version> binaries")
	binLink := fs.String("link", deploy.DefaultLink, "symlink the unit starts")
	unitPath := fs.String("unit-path", deploy.DefaultUnitPath, "systemd unit file")
	slyPath := fs.String("sly-path", deploy.DefaultSlyPath, "host sly wrapper that runs sly from the Dispatch image; empty skips it")
	bucket := fs.String("litestream-bucket", "", "restore Dispatch from this Litestream bucket before it starts; credentials come from LITESTREAM_ACCESS_KEY_ID and LITESTREAM_SECRET_ACCESS_KEY")
	bucketEndpoint := fs.String("litestream-endpoint", "", "S3-compatible endpoint of the bucket (default AWS S3)")
	sandboxDevice := fs.String("sandbox-device", "", "block device formatted as the sandbox filesystem (refused when it holds a filesystem or partition table, unless --sandbox-device-wipe)")
	sandboxWipe := fs.Bool("sandbox-device-wipe", false, "wipe --sandbox-device before formatting it")
	sandboxSize := fs.String("sandbox-size", "", "size of the sandbox loop file, in bytes or with a G or GiB suffix (default max(10 GiB, min(free/2, free-10 GiB)))")
	var runArgs multi
	fs.Var(&runArgs, "run-arg", "argument appended to stationd run in the unit's ExecStart (repeatable)")
	fs.Parse(args)
	if *release == "" {
		return fmt.Errorf("--release is required")
	}
	if *sandboxWipe && *sandboxDevice == "" {
		return fmt.Errorf("--sandbox-device-wipe needs --sandbox-device")
	}
	if *sandboxDevice != "" && *sandboxSize != "" {
		return fmt.Errorf("--sandbox-size applies to the loop file; a device is used whole")
	}
	sandboxBytes, err := parseSize(*sandboxSize)
	if err != nil {
		return fmt.Errorf("--sandbox-size: %w", err)
	}
	var replica *hostconfig.Litestream
	if *bucket != "" {
		replica = &hostconfig.Litestream{Bucket: *bucket, Endpoint: *bucketEndpoint, AccessKey: os.Getenv("LITESTREAM_ACCESS_KEY_ID"), SecretKey: os.Getenv("LITESTREAM_SECRET_ACCESS_KEY")}
		if err := replica.Validate(); err != nil {
			return err
		}
		if os.Getenv("STATIONLY_RECOVERY_KEY") == "" {
			return fmt.Errorf("a restore needs the lost host's recovery key in STATIONLY_RECOVERY_KEY: Dispatch refuses to start on a database whose data keys its master key does not unwrap, and restoring without the key is not built")
		}
	} else if *bucketEndpoint != "" {
		return fmt.Errorf("--litestream-endpoint needs --litestream-bucket")
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if err := os.MkdirAll(*stateDir, 0o700); err != nil {
		return err
	}
	v, err := newVerifier(log, *trustPath, *stateDir)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	rep, err := deploy.Install(ctx, v, deploy.InstallOptions{
		Release: *release, StateDir: *stateDir, EtcDir: *etcDir, DaemonJSON: *daemonJSON, SysctlFile: *sysctlFile, DispatchURL: *dispatchURL,
		AllowUnsigned: *allow, Pull: !*noPull, Host: !*noHost,
		Unit: !*noUnit, BinDir: *binDir, BinaryLink: *binLink, UnitPath: *unitPath, SlyPath: *slyPath, RunArgs: []string(runArgs),
		Litestream: replica, RecoveryKey: os.Getenv("STATIONLY_RECOVERY_KEY"),
		SandboxDevice: *sandboxDevice, SandboxWipe: *sandboxWipe, SandboxSize: sandboxBytes,
	})
	printJSON(rep)
	if rep.Test {
		fmt.Fprintln(os.Stderr, "TEST INSTALL: verified against "+v.Trust().Name+", not the Stationly release identity; never use it for production")
	}
	if err == nil {
		fmt.Fprintln(os.Stderr, "installed release "+rep.Release+"; start stationd, then run sly setup as root on this host")
	}
	return err
}

func verifyCmd(args []string) error {
	if len(args) < 1 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	fs := flag.NewFlagSet("verify "+args[0], flag.ExitOnError)
	stateDir := fs.String("state-dir", deploy.DefaultStateDir, "stationd state directory")
	trustPath := fs.String("trust", "", "signing identity and Sigstore trust file")
	component := fs.String("component", "", "component name")
	version := fs.String("version", "", "component version")
	digest := fs.String("digest", "", "index digest")
	fs.Parse(args[1:])
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	v, err := newVerifier(log, *trustPath, *stateDir)
	if err != nil {
		return err
	}
	ctx := context.Background()
	switch args[0] {
	case "refresh":
		state, err := v.Refresh(ctx, verify.NewDirect(v.Trust()).TUF())
		printJSON(state)
		return err
	case "image":
		r := v.Image(ctx, verify.NewDirect(v.Trust()), *component, *version, *digest)
		printJSON(r)
		if r.Signature != verify.Verified {
			return fmt.Errorf("UNSIGNED_ARTIFACT")
		}
		return nil
	}
	fmt.Fprint(os.Stderr, usage)
	os.Exit(2)
	return nil
}

func parseSize(v string) (uint64, error) {
	if v == "" {
		return 0, nil
	}
	n, unit := v, uint64(1)
	for _, suffix := range []string{"GiB", "G"} {
		if strings.HasSuffix(v, suffix) {
			n, unit = strings.TrimSuffix(v, suffix), 1<<30
			break
		}
	}
	b, err := strconv.ParseUint(n, 10, 64)
	if err != nil || b == 0 {
		return 0, fmt.Errorf("%q is not a positive number of bytes or GiB", v)
	}
	return b * unit, nil
}
