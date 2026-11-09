package docker

import (
	"net/netip"
	"slices"
	"testing"

	"github.com/moby/moby/api/types/mount"
)

var litestreamFiles = LitestreamFiles{ConfigHost: "/var/lib/stationly/stationd/config/litestream.yml", ConfigTarget: "/etc/litestream.yml"}

func TestLitestreamSidecarSharesTheDispatchVolumeAndPassesTheInvariants(t *testing.T) {
	spec := Litestream("stn_1", "docker.io/litestream/litestream@sha256:abc", litestreamFiles, []string{"LITESTREAM_ACCESS_KEY_ID=AK"})
	if err := CheckInvariants(spec, "/var/lib/stationly/stationd"); err != nil {
		t.Fatal(err)
	}
	hc, cfg := spec.Create.HostConfig, spec.Create.Config
	if !slices.Equal(cfg.Cmd, []string{"replicate", "-config", "/etc/litestream.yml"}) || cfg.User != DispatchUser {
		t.Fatalf("cmd %v user %s", cfg.Cmd, cfg.User)
	}
	var volume, config bool
	for _, m := range hc.Mounts {
		switch {
		case m.Type == mount.TypeVolume && m.Source == DispatchVolume && m.Target == DispatchDataTarget && !m.ReadOnly:
			volume = true
		case m.Type == mount.TypeBind && m.Source == litestreamFiles.ConfigHost && m.ReadOnly:
			config = true
		}
	}
	if !volume || !config || !hc.ReadonlyRootfs || len(hc.PortBindings) != 0 {
		t.Fatalf("mounts %+v readonly %v ports %v", hc.Mounts, hc.ReadonlyRootfs, hc.PortBindings)
	}
	if string(hc.NetworkMode) != SystemNetworkName {
		t.Fatalf("network %s", hc.NetworkMode)
	}
}

func TestLitestreamHashFollowsTheImageAndTheCredentials(t *testing.T) {
	base := Litestream("stn_1", "img@sha256:a", litestreamFiles, []string{"K=1"})
	for name, other := range map[string]ContainerSpec{
		"image":       Litestream("stn_1", "img@sha256:b", litestreamFiles, []string{"K=1"}),
		"credentials": Litestream("stn_1", "img@sha256:a", litestreamFiles, []string{"K=2"}),
	} {
		if other.Hash == base.Hash {
			t.Fatalf("a changed %s keeps the hash", name)
		}
	}
	if again := Litestream("stn_1", "img@sha256:a", litestreamFiles, []string{"K=1"}); again.Hash != base.Hash {
		t.Fatal("the hash is not stable")
	}
}

func TestLitestreamTaskPutsFlagsBeforeTheOperand(t *testing.T) {
	spec := LitestreamTask("stn_1", "img@sha256:a", litestreamFiles, nil, "restore", []string{"-if-db-not-exists", "-if-replica-exists"}, DispatchDatabase)
	want := []string{"restore", "-if-db-not-exists", "-if-replica-exists", "-config", "/etc/litestream.yml", "/data/dispatch.sqlite"}
	if !slices.Equal(spec.Create.Config.Cmd, want) {
		t.Fatalf("cmd %v", spec.Create.Config.Cmd)
	}
	if err := CheckInvariants(spec, "/var/lib/stationly/stationd"); err != nil {
		t.Fatal(err)
	}
	if spec.Name != LitestreamTaskName || spec.Role != RoleLitestreamTask {
		t.Fatalf("%s %s", spec.Name, spec.Role)
	}
}

func TestDispatchHashIsUnchangedUntilItIsReplicated(t *testing.T) {
	addr := netip.MustParseAddr("10.200.0.2")
	plain := DispatchContainer("stn_1", "img@sha256:a", addr, []string{"A=1"}, false)
	replicated := DispatchContainer("stn_1", "img@sha256:a", addr, []string{"A=1"}, true)
	if plain.Create.Config.Labels[LabelReplicated] != "" {
		t.Fatal("a Dispatch without a bucket carries the replicated label, so every existing install would recreate it")
	}
	if replicated.Hash == plain.Hash || replicated.Create.Config.Labels[LabelReplicated] != "true" {
		t.Fatal("configuring a bucket must change Dispatch's hash so stationd restarts it once")
	}
}
