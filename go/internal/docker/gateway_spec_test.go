package docker

import (
	"slices"
	"testing"
)

var gatewayFiles = GatewayFiles{
	Static:        "/var/lib/stationly/stationd/gateway/traefik-a.yml",
	StaticTarget:  "/etc/traefik/traefik.yml",
	Dynamic:       "/var/lib/stationly/stationd/gateway/dynamic",
	DynamicTarget: "/etc/traefik/dynamic",
	DataTarget:    "/data",
}

func TestGatewayKeepsItsGoHeapUnderTheContainerMemoryLimit(t *testing.T) {
	spec := Gateway("stn_1", "a", "docker.io/library/traefik@sha256:abc", gatewayFiles)
	if err := CheckInvariants(spec, "/var/lib/stationly/stationd"); err != nil {
		t.Fatal(err)
	}
	hc, cfg := spec.Create.HostConfig, spec.Create.Config
	if hc.Memory != 512<<20 || hc.MemorySwap != hc.Memory {
		t.Fatalf("memory %d swap %d", hc.Memory, hc.MemorySwap)
	}
	if !slices.Equal(cfg.Env, []string{"GOMEMLIMIT=402653184"}) {
		t.Fatalf("env %v", cfg.Env)
	}
}
