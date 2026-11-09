//go:build linux

package deploy

import (
	"io"
	"log/slog"
	"testing"

	"github.com/harshjv/stationly/go/internal/depot"
	"github.com/harshjv/stationly/go/internal/protocol"
)

func TestRegistryReportsInstallTimeAddressBeforeFirstGeneration(t *testing.T) {
	s := &Station{depot: depot.New(slog.New(slog.NewTextHandler(io.Discard, nil)), nil, t.TempDir()), opts: Options{Install: &InstallState{RegistryAddress: "10.200.3.2:5000"}}}
	state, failure := s.depot.State()
	if state != protocol.RegistryStateDown || failure != depot.AwaitingGeneration {
		t.Fatalf("state %v failure %v", state, failure)
	}
	front, dist := s.registryAddresses()
	if front != "10.200.3.2:5000" || dist != "10.200.3.3:5000" {
		t.Fatalf("front %v distribution %v", front, dist)
	}
}
