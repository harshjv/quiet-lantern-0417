//go:build linux

package main

import (
	"context"
	"encoding/json"
	"errors"
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
	_ "time/tzdata"

	"github.com/caarlos0/env/v11"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"

	"github.com/harshjv/stationly/go/internal/deploy"
	"github.com/harshjv/stationly/go/internal/dispatch"
	"github.com/harshjv/stationly/go/internal/hostconfig"
	"github.com/harshjv/stationly/go/internal/identity"
	"github.com/harshjv/stationly/go/internal/ids"
	"github.com/harshjv/stationly/go/internal/outbox"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/rootsocket"
	"github.com/harshjv/stationly/go/internal/sandbox/gvisor"
	"github.com/harshjv/stationly/go/internal/upgrade"
	"github.com/harshjv/stationly/go/internal/verify"
)

type environment struct {
	Handover            string `env:"STATIONLY_HANDOVER,unset"`
	RecoveryKey         string `env:"STATIONLY_RECOVERY_KEY"`
	LitestreamAccessKey string `env:"LITESTREAM_ACCESS_KEY_ID"`
	LitestreamSecretKey string `env:"LITESTREAM_SECRET_ACCESS_KEY"`
}

type usageError struct{ error }

func main() {
	vars, err := env.ParseAs[environment]()
	if err != nil {
		fmt.Fprintln(os.Stderr, "stationd:", err)
		os.Exit(1)
	}
	os.Exit(execute(rootCmd(vars), os.Stderr))
}

func execute(root *cobra.Command, stderr io.Writer) int {
	cmd, err := root.ExecuteC()
	if err == nil {
		return 0
	}
	fmt.Fprintln(stderr, "stationd:", err)
	if errors.As(err, &usageError{}) {
		fmt.Fprint(stderr, cmd.UsageString())
		return 2
	}
	return 1
}

func rootCmd(vars environment) *cobra.Command {
	root := group("stationd", "The Stationly station daemon",
		enrollCmd(),
		runCmd(vars),
		installCmd(vars),
		verifyCmd(),
		statusCmd(),
		connectionCmd(),
		doctorCmd(),
		dispatchEnvCmd(),
		registryCmd(),
		secretsCmd(),
		logsCmd(),
	)
	root.SilenceErrors = true
	root.SilenceUsage = true
	root.SetFlagErrorFunc(func(_ *cobra.Command, err error) error { return usageError{err} })
	return root
}

func group(use, short string, children ...*cobra.Command) *cobra.Command {
	c := &cobra.Command{
		Use:   use,
		Short: short,
		Args:  usageArgs(cobra.NoArgs),
		RunE: func(c *cobra.Command, _ []string) error {
			return usageError{fmt.Errorf("%s needs a subcommand", c.CommandPath())}
		},
	}
	c.AddCommand(children...)
	return c
}

func usageArgs(check cobra.PositionalArgs) cobra.PositionalArgs {
	return func(c *cobra.Command, args []string) error {
		if err := check(c, args); err != nil {
			return usageError{err}
		}
		return nil
	}
}

func socketFlag(fs *pflag.FlagSet) *string {
	return fs.String("socket", protocol.RootSocketPath, "root socket path")
}

func stateDirFlag(fs *pflag.FlagSet) *string {
	return fs.String("state-dir", deploy.DefaultStateDir, "stationd state directory")
}

func runCmd(vars environment) *cobra.Command {
	c := &cobra.Command{Use: "run", Short: "Run the station daemon"}
	fs := c.Flags()
	stateDir := stateDirFlag(fs)
	socket := socketFlag(fs)
	debug := fs.Bool("debug", false, "log every Docker event")
	trustPath := fs.String("trust", "", "signing identity and Sigstore trust file (default: the Stationly release identity)")
	fetch := fs.String("sigstore-fetch", deploy.FetchDirect, "where signature bundles and TUF metadata come from: direct or dispatch")
	etcDir := fs.String("etc-dir", hostconfig.DefaultEtcDir, "directory holding host.toml and platform.lock.json")
	backupRoot := fs.String("backup-root", deploy.DefaultBackupRoot, "station backup root; path targets of volume_backup.target live under it")
	binDir := fs.String("bin-dir", deploy.DefaultBinDir, "directory holding stationd-<version> binaries")
	binLink := fs.String("link", deploy.DefaultLink, "symlink the systemd unit starts")
	handoverFlag := fs.Bool("handover", false, "started by the running stationd during a self-upgrade; adopt its sockets")
	c.RunE = func(*cobra.Command, []string) error {
		var runArgs []string
		fs.Visit(func(f *pflag.Flag) {
			if f.Name != "handover" {
				runArgs = append(runArgs, "--"+f.Name+"="+f.Value.String())
			}
		})
		inheritedSockets, err := upgrade.LoadInherited(vars.Handover)
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
		return deploy.Run(ctx, deploy.Options{StateDir: *stateDir, SocketPath: *socket, Log: log, Identity: id, Link: link, Outbox: ob, Verifier: v, SigstoreFetch: *fetch, EtcDir: *etcDir, Host: host, Install: inst, BackupRoot: *backupRoot, Handover: inheritedSockets, RunArgs: runArgs, BinDir: *binDir, BinaryLink: *binLink, Sandbox: gvisor.New()})
	}
	return c
}

func enrollCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "enroll <token>",
		Short: "Enroll this host with Dispatch using an enrollment token",
		Args:  usageArgs(cobra.ExactArgs(1)),
	}
	url := c.Flags().String("dispatch-url", "", "Dispatch API URL (dispatch.url)")
	stateDir := stateDirFlag(c.Flags())
	_ = c.MarkFlagRequired("dispatch-url")
	c.RunE = func(_ *cobra.Command, args []string) error {
		if identity.Exists(*stateDir) {
			return fmt.Errorf("this station is already enrolled (%s exists)", identity.Dir(*stateDir))
		}
		ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		defer stop()
		out, err := enrollAndSave(ctx, *url, args[0], *stateDir, nil)
		if err != nil {
			return err
		}
		printJSON(out)
		return nil
	}
	return c
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
		return fmt.Errorf("this station is not enrolled and has no bootstrap token (%w); run the installer, or stationd enroll <token> --dispatch-url <url>", err)
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

func dispatchEnvCmd() *cobra.Command {
	c := &cobra.Command{Use: "dispatch-env", Short: "Print the Dispatch container environment, one KEY=value per line"}
	stateDir := stateDirFlag(c.Flags())
	etcDir := c.Flags().String("etc-dir", hostconfig.DefaultEtcDir, "directory holding host.toml")
	c.RunE = func(*cobra.Command, []string) error {
		env, err := deploy.DispatchEnv(*stateDir, *etcDir)
		if err != nil {
			return err
		}
		for _, kv := range env {
			fmt.Println(kv)
		}
		return nil
	}
	return c
}

func connectionCmd() *cobra.Command {
	c := &cobra.Command{Use: "connection", Short: "Show the connection to Dispatch"}
	socket := socketFlag(c.Flags())
	c.RunE = func(*cobra.Command, []string) error {
		return call(*socket, protocol.RootSocketOpStatus, protocol.RootSocketNoParams{})
	}
	return c
}

func statusCmd() *cobra.Command {
	c := &cobra.Command{Use: "status", Short: "Show the observed state of this station"}
	stateDir := stateDirFlag(c.Flags())
	asJSON := c.Flags().Bool("json", false, "print the observed-state document")
	c.RunE = func(*cobra.Command, []string) error {
		return deploy.PrintStatus(os.Stdout, *stateDir, *asJSON)
	}
	return c
}

func doctorCmd() *cobra.Command {
	c := &cobra.Command{Use: "doctor", Short: "Run the station's health checks"}
	socket := socketFlag(c.Flags())
	asJSON := c.Flags().Bool("json", false, "print the report as JSON")
	c.RunE = func(*cobra.Command, []string) error {
		result, failure, err := rootsocket.Call(*socket, protocol.RootSocketOpDoctor, protocol.RootSocketNoParams{}, func(protocol.RootSocketProgress) {})
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
	return c
}

func call(socket, op string, params any) error {
	start := time.Now()
	result, failure, err := rootsocket.Call(socket, op, params, func(p protocol.RootSocketProgress) {
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

func registryCmd() *cobra.Command {
	r := group("registry", "Depot operations through the root socket")
	socket := socketFlag(r.PersistentFlags())

	token := &cobra.Command{Use: "token", Short: "Mint a short-lived Depot token"}
	scopes := token.Flags().StringArray("scope", nil, "repository:<name>:<actions> (repeatable)")
	ttl := token.Flags().Int("ttl", 60, "lifetime in seconds, at most 60")
	token.RunE = func(*cobra.Command, []string) error {
		return call(*socket, protocol.RootSocketOpRegistryToken, protocol.RootSocketTokenParams{Scopes: *scopes, TtlS: ttl})
	}

	retain := &cobra.Command{Use: "retain", Short: "Prune a project's built images beyond its retention count"}
	project := retain.Flags().String("project", "", "project id")
	retain.RunE = func(*cobra.Command, []string) error {
		return call(*socket, protocol.RootSocketOpRegistryRetain, protocol.RootSocketRetainParams{ProjectId: *project})
	}

	del := &cobra.Command{Use: "delete", Short: "Delete one manifest from the Depot"}
	repo := del.Flags().String("repository", "", "repository")
	digest := del.Flags().String("digest", "", "manifest digest")
	del.RunE = func(*cobra.Command, []string) error {
		return call(*socket, protocol.RootSocketOpRegistryDelete, protocol.RegistryDeleteBody{Items: []protocol.RegistryDeleteItem{{Repository: *repo, Digest: *digest, Reason: "manual"}}})
	}

	gc := &cobra.Command{Use: "gc", Short: "Run Depot garbage collection", RunE: func(*cobra.Command, []string) error {
		return call(*socket, protocol.RootSocketOpRegistryGc, protocol.RegistryGcBody{Reason: protocol.RegistryGcReasonSchedule})
	}}

	r.AddCommand(token, retain, del, gc)
	return r
}

func secretsCmd() *cobra.Command {
	s := group("secrets", "Secrets operations through the root socket")
	socket := socketFlag(s.PersistentFlags())
	s.AddCommand(&cobra.Command{Use: "status", Short: "Show the secrets stationd holds, has requested and has mounted", RunE: func(*cobra.Command, []string) error {
		return call(*socket, protocol.RootSocketOpSecretsStatus, protocol.RootSocketNoParams{})
	}})
	return s
}

func logsCmd() *cobra.Command {
	c := &cobra.Command{Use: "logs", Short: "Print a deployment's logs"}
	socket := socketFlag(c.Flags())
	deployment := c.Flags().String("deployment", "", "deployment id")
	tail := c.Flags().Int("tail", 200, "lines")
	c.RunE = func(*cobra.Command, []string) error {
		return call(*socket, protocol.RootSocketOpLogs, protocol.RootSocketLogsParams{DeploymentId: *deployment, Tail: tail})
	}
	return c
}

func installCmd(vars environment) *cobra.Command {
	c := &cobra.Command{Use: "install", Short: "Verify a release and install it on this host"}
	fs := c.Flags()
	release := fs.String("release", "", "release version (0.1.0), fetched by tag v<version> from the releases repository the signing identity names, or a directory holding release-manifest.json and its .sigstore.json bundle")
	stateDir := stateDirFlag(fs)
	trustPath := fs.String("trust", "", "signing identity and Sigstore trust file")
	allow := fs.Bool("allow-unsigned", false, "continue past artifacts without a valid signature")
	noPull := fs.Bool("no-pull", false, "verify only; do not pull images")
	etcDir := fs.String("etc-dir", hostconfig.DefaultEtcDir, "directory for host.toml and platform.lock.json")
	daemonJSON := fs.String("daemon-json", deploy.DefaultDaemonJSON, "Docker daemon configuration the installer writes")
	sysctlFile := fs.String("sysctl-file", deploy.DefaultSysctlFile, "sysctl drop-in the installer writes")
	dispatchURL := fs.String("dispatch-url", fmt.Sprintf("http://%s:%d", protocol.NetworkDispatchHostAddress, protocol.NetworkDispatchPort), "dispatch.url written into host.toml")
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
	runArgs := fs.StringArray("run-arg", nil, "argument appended to stationd run in the unit's ExecStart (repeatable)")
	_ = c.MarkFlagRequired("release")
	c.MarkFlagsMutuallyExclusive("sandbox-device", "sandbox-size")
	c.RunE = func(*cobra.Command, []string) error {
		if *sandboxWipe && *sandboxDevice == "" {
			return fmt.Errorf("--sandbox-device-wipe needs --sandbox-device")
		}
		sandboxBytes, err := parseSize(*sandboxSize)
		if err != nil {
			return fmt.Errorf("--sandbox-size: %w", err)
		}
		var replica *hostconfig.Litestream
		if *bucket != "" {
			replica = &hostconfig.Litestream{Bucket: *bucket, Endpoint: *bucketEndpoint, AccessKey: vars.LitestreamAccessKey, SecretKey: vars.LitestreamSecretKey}
			if err := replica.Validate(); err != nil {
				return err
			}
			if vars.RecoveryKey == "" {
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
			Unit: !*noUnit, BinDir: *binDir, BinaryLink: *binLink, UnitPath: *unitPath, SlyPath: *slyPath, RunArgs: *runArgs,
			Litestream: replica, RecoveryKey: vars.RecoveryKey,
			SandboxDevice: *sandboxDevice, SandboxWipe: *sandboxWipe, SandboxSize: sandboxBytes, Sandbox: gvisor.New(),
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
	return c
}

func verifyCmd() *cobra.Command {
	g := group("verify", "Verify release artifacts against the signing identity")
	stateDir := stateDirFlag(g.PersistentFlags())
	trustPath := g.PersistentFlags().String("trust", "", "signing identity and Sigstore trust file")
	verifier := func() (*verify.Verifier, error) {
		return newVerifier(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})), *trustPath, *stateDir)
	}

	image := &cobra.Command{Use: "image", Short: "Verify an image's signature by component, version and index digest"}
	component := image.Flags().String("component", "", "component name")
	version := image.Flags().String("version", "", "component version")
	digest := image.Flags().String("digest", "", "index digest")
	image.RunE = func(*cobra.Command, []string) error {
		v, err := verifier()
		if err != nil {
			return err
		}
		r := v.Image(context.Background(), verify.NewDirect(v.Trust()), *component, *version, *digest)
		printJSON(r)
		if r.Signature != verify.Verified {
			return fmt.Errorf("UNSIGNED_ARTIFACT")
		}
		return nil
	}

	refresh := &cobra.Command{Use: "refresh", Short: "Refresh the Sigstore trusted root from the TUF mirror", RunE: func(*cobra.Command, []string) error {
		v, err := verifier()
		if err != nil {
			return err
		}
		state, err := v.Refresh(context.Background(), verify.NewDirect(v.Trust()).TUF())
		printJSON(state)
		return err
	}}

	g.AddCommand(image, refresh)
	return g
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
