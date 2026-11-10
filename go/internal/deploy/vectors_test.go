//go:build linux

package deploy

import (
	"bytes"
	"encoding/json"
	"net/netip"
	"os"
	"path/filepath"
	"testing"

	"github.com/harshjv/stationly/go/internal/cidr"
	"github.com/harshjv/stationly/go/internal/protocol"
)

const vectorsDir = "../../../packages/protocol/testdata"

func loadVectors(t *testing.T, name string, into any) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(vectorsDir, name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, into); err != nil {
		t.Fatal(err)
	}
}

func TestGenerationHashVectors(t *testing.T) {
	var v struct {
		Cases []struct {
			Name   string          `json:"name"`
			Object json.RawMessage `json:"object"`
			Hash   string          `json:"hash"`
		} `json:"cases"`
	}
	loadVectors(t, "generation-hash-vectors.json", &v)
	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			dec := json.NewDecoder(bytes.NewReader(c.Object))
			dec.UseNumber()
			var obj map[string]any
			if err := dec.Decode(&obj); err != nil {
				t.Fatal(err)
			}
			got, err := canonicalHash(obj)
			if err != nil {
				t.Fatal(err)
			}
			if got != c.Hash {
				t.Errorf("canonicalHash = %s, want %s", got, c.Hash)
			}
		})
	}
}

type subnetVector struct {
	Subnet  string `json:"subnet"`
	Gateway string `json:"gateway"`
}

func TestNetworkVectors(t *testing.T) {
	var v struct {
		Cases []struct {
			Name     string       `json:"name"`
			Pool     string       `json:"pool"`
			System   subnetVector `json:"system"`
			Ingress  subnetVector `json:"ingress"`
			Registry struct {
				Subnet  string `json:"subnet"`
				Address string `json:"address"`
			} `json:"registry"`
		} `json:"cases"`
	}
	loadVectors(t, "network-vectors.json", &v)
	gateway := func(subnet string) string {
		return cidr.Offset(netip.MustParsePrefix(subnet), protocol.NetworkGatewayHost).String()
	}
	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			st := NewInstallState(netip.MustParsePrefix(c.Pool))
			got := []string{st.SystemSubnet, gateway(st.SystemSubnet), st.IngressSubnet, gateway(st.IngressSubnet), st.RegistrySubnet, st.RegistryAddress}
			want := []string{c.System.Subnet, c.System.Gateway, c.Ingress.Subnet, c.Ingress.Gateway, c.Registry.Subnet, c.Registry.Address}
			for i := range want {
				if got[i] != want[i] {
					t.Errorf("pool %s: got %q, want %q", c.Pool, got, want)
					break
				}
			}
		})
	}
}
