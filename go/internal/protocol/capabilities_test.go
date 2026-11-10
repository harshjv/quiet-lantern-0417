package protocol

import "testing"

func TestMessageCapabilitiesMatchTheVersionSkewTable(t *testing.T) {
	spec := map[Capability][]string{
		CapabilityGenerationV1: {MessageGeneration, MessageGenerationAvailable, MessageGenerationAck},
		CapabilitySecretsV1:    {MessageSecretsDeliver, MessageSecretsRequest, MessageSecretsAck},
		CapabilityLogsFollow:   {MessageLogsFollow},
		CapabilityMetricsV1:    {MessageMetricsSubscribe, MessageMetricsSample, MessageMetricsSampleResult},
		CapabilityExecTty:      {MessageExecResize, MessageExecResized},
		CapabilityForwardTcp:   {MessageForwardOpen},
		CapabilityRegistryV1:   {MessageRegistryDelete, MessageRegistryDeleteResult, MessageRegistryGc, MessageRegistryGcAccepted},
		CapabilityPlatformV1:   {MessagePlatformVerify, MessagePlatformVerifyResult},
		CapabilityDoctorV1:     {MessageDoctorRun, MessageDoctorReport},
		CapabilityVolumesV1: {
			MessageVolumeBackup, MessageVolumeBackupAccepted, MessageVolumeBackupResult,
			MessageVolumeRestore, MessageVolumeRestoreAccepted, MessageVolumeRestoreResult,
			MessageVolumeBackupDelete, MessageVolumeBackupDeleteResult,
		},
		CapabilityNetworkV1: {
			MessageNetworkSubscribe, MessageNetworkSample, MessageNetworkSampleResult,
			MessageNetworkInspect, MessageNetworkInspectResult, MessageNetworkProbe, MessageNetworkProbeResult,
			MessageDnsLog, MessageDnsLogResult,
		},
		CapabilitySandboxV1: {MessageSandboxStatus, MessageSandboxSnapshotStatus, MessageSandboxStorageGrow, MessageSandboxStorageGrown},
		CapabilityGuardV1:   {MessageGuardAck, MessageFlowRollup},
		CapabilityScanV1:    {MessageScanStart, MessageScanAccepted, MessageScanResult},
	}
	want := map[string]Capability{}
	for capability, types := range spec {
		for _, typ := range types {
			want[typ] = capability
		}
	}
	for typ := range MessageBodies {
		if got := MessageCapabilities[typ]; got != want[typ] {
			t.Errorf("%s needs capability %q, the spec says %q", typ, got, want[typ])
		}
	}
	for typ := range MessageCapabilities {
		if _, ok := MessageBodies[typ]; !ok {
			t.Errorf("%s has a capability but is not in the catalog", typ)
		}
	}
}
