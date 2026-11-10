//go:build linux

package deploy

import (
	"strings"
	"testing"

	"github.com/harshjv/stationly/go/internal/protocol"
)

func TestRouteRefusesAMessageWhoseCapabilityWasNotNegotiated(t *testing.T) {
	cases := []struct {
		typ        string
		capability protocol.Capability
	}{
		{protocol.MessageGeneration, protocol.CapabilityGenerationV1},
		{protocol.MessageGenerationAvailable, protocol.CapabilityGenerationV1},
		{protocol.MessageSecretsDeliver, protocol.CapabilitySecretsV1},
		{protocol.MessageLogsFollow, protocol.CapabilityLogsFollow},
		{protocol.MessageMetricsSample, protocol.CapabilityMetricsV1},
		{protocol.MessageMetricsSubscribe, protocol.CapabilityMetricsV1},
		{protocol.MessageNetworkSample, protocol.CapabilityNetworkV1},
		{protocol.MessageNetworkSubscribe, protocol.CapabilityNetworkV1},
		{protocol.MessageNetworkInspect, protocol.CapabilityNetworkV1},
		{protocol.MessageNetworkProbe, protocol.CapabilityNetworkV1},
		{protocol.MessageDnsLog, protocol.CapabilityNetworkV1},
		{protocol.MessageExecResize, protocol.CapabilityExecTty},
		{protocol.MessageForwardOpen, protocol.CapabilityForwardTcp},
		{protocol.MessageRegistryDelete, protocol.CapabilityRegistryV1},
		{protocol.MessageRegistryGc, protocol.CapabilityRegistryV1},
		{protocol.MessagePlatformVerify, protocol.CapabilityPlatformV1},
		{protocol.MessageDoctorRun, protocol.CapabilityDoctorV1},
		{protocol.MessageVolumeBackup, protocol.CapabilityVolumesV1},
		{protocol.MessageVolumeRestore, protocol.CapabilityVolumesV1},
		{protocol.MessageVolumeBackupDelete, protocol.CapabilityVolumesV1},
		{protocol.MessageSandboxStorageGrow, protocol.CapabilitySandboxV1},
	}
	for _, c := range cases {
		without := func(have protocol.Capability) bool { return have != c.capability }
		h, failure := route(c.typ, without)
		if h != nil || failure == nil || failure.Code != string(protocol.ErrorCodeProtocolCapabilityMissing) || !strings.Contains(failure.Explanation, string(c.capability)) {
			t.Errorf("%s without %s: handler %v, failure %+v; want PROTOCOL_CAPABILITY_MISSING naming the capability", c.typ, c.capability, h != nil, failure)
		}
		if h, failure := route(c.typ, func(protocol.Capability) bool { return true }); h == nil || failure != nil {
			t.Errorf("%s with every capability: failure %+v, want its handler", c.typ, failure)
		}
	}
}

func TestRouteServesUngatedMessagesAndRefusesUnknownOnes(t *testing.T) {
	none := func(protocol.Capability) bool { return false }
	for _, typ := range []string{protocol.MessageBuildStart, protocol.MessageBuildCancel, protocol.MessageRunStart, protocol.MessageRunCancel, protocol.MessageLogsQuery, protocol.MessageError, protocol.MessageWelcome} {
		if h, failure := route(typ, none); h == nil || failure != nil {
			t.Errorf("%s with no capabilities: failure %+v, want its handler", typ, failure)
		}
	}
	if _, failure := route("no.such.type", none); failure == nil || failure.Code != string(protocol.ErrorCodeProtocolUnknownType) {
		t.Errorf("unknown type: failure %+v, want PROTOCOL_UNKNOWN_TYPE", failure)
	}
	for typ := range handlers {
		if _, known := protocol.MessageBodies[typ]; !known {
			t.Errorf("handler for %s, which is not in the catalog", typ)
		}
	}
}
