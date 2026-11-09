package protocol

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

func loadFixture(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/generation.json")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func decode(t *testing.T, b []byte) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestGenerationRoundTripsWithoutLosingOrInventingFields(t *testing.T) {
	raw := loadFixture(t)
	var g Generation
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	out, err := json.Marshal(&g)
	if err != nil {
		t.Fatal(err)
	}
	if want, got := decode(t, raw), decode(t, out); !reflect.DeepEqual(want, got) {
		t.Fatalf("round trip changed the document:\nwant %v\ngot  %v", want, got)
	}
}

func TestGenerationDecodesTheFieldsStationdActsOn(t *testing.T) {
	var g Generation
	if err := json.Unmarshal(loadFixture(t), &g); err != nil {
		t.Fatal(err)
	}
	if g.Schema != 1 || g.Number != 1 || len(g.Environments) != 2 || len(g.Services) != 3 {
		t.Fatalf("envelope: schema %d number %d envs %d services %d", g.Schema, g.Number, len(g.Environments), len(g.Services))
	}
	if g.Station.Settings.IpamPool != "10.200.0.0/16" || g.Station.ConcurrencyCap != 2 {
		t.Fatalf("station: %+v", g.Station.Settings)
	}
	svc := g.Services["svc_01JCWH0AM1AAAAAAAAAAAAAAAA"]
	if svc.Kind != ServiceKindWeb || svc.DesiredState != DesiredStateRunning || svc.Current == nil || svc.Current.Spec.Limits.MemoryBytes != 67108864 {
		t.Fatalf("service: %+v", svc)
	}
	if svc.Current.Spec.Health == nil || svc.Current.Spec.Health.Type != "tcp" {
		t.Fatalf("health: %+v", svc.Current.Spec.Health)
	}
	if env := svc.Current.Spec.Env[0]; env.Key != "PORT" || env.Value == nil || *env.Value != "80" || !env.Platform {
		t.Fatalf("env: %+v", env)
	}
}

func TestGenerationRejectsEveryMissingRequiredTopLevelField(t *testing.T) {
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(loadFixture(t), &doc); err != nil {
		t.Fatal(err)
	}
	for field := range doc {
		if field == "resolution" || field == "previous" {
			continue
		}
		t.Run(field, func(t *testing.T) {
			cut := map[string]json.RawMessage{}
			for k, v := range doc {
				if k != field {
					cut[k] = v
				}
			}
			b, _ := json.Marshal(cut)
			var g Generation
			err := json.Unmarshal(b, &g)
			if err == nil || !strings.Contains(err.Error(), field) {
				t.Fatalf("want an error naming %q, got %v", field, err)
			}
		})
	}
}

func TestGenerationRejectsAnUnknownServiceKind(t *testing.T) {
	raw := strings.Replace(string(loadFixture(t)), `"kind": "web"`, `"kind": "spaceship"`, 1)
	var g Generation
	if err := json.Unmarshal([]byte(raw), &g); err == nil {
		t.Fatal("an invalid enum value was accepted")
	}
}

func TestGenerationRejectsAWrongFieldType(t *testing.T) {
	raw := strings.Replace(string(loadFixture(t)), `"number": 1,`, `"number": "one",`, 1)
	var g Generation
	if err := json.Unmarshal([]byte(raw), &g); err == nil {
		t.Fatal("a string was accepted for an integer")
	}
}

func TestEnvelopeRoundTripsAndKeepsTheBodyVerbatim(t *testing.T) {
	in := `{"id":"msg_01JCAAAAAAAAAAAAAAAAAAAAA1","type":"heartbeat","generation":4,"sent_at":"2026-11-06T10:00:00Z","ref":null,"body":{"a":1}}`
	var e Envelope
	if err := json.Unmarshal([]byte(in), &e); err != nil {
		t.Fatal(err)
	}
	if e.Type != MessageHeartbeat || e.Generation != 4 || string(e.Body) != `{"a":1}` || e.Ref != nil {
		t.Fatalf("got %+v", e)
	}
	out, err := json.Marshal(&e)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(decode(t, []byte(in)), decode(t, out)) {
		t.Fatalf("got %s", out)
	}
}

func TestEnvelopeKeepsAReferenceToTheRequest(t *testing.T) {
	in := `{"id":"msg_01JCAAAAAAAAAAAAAAAAAAAAA2","type":"error","generation":0,"sent_at":"2026-11-06T10:00:00Z","ref":"msg_01JCAAAAAAAAAAAAAAAAAAAAA1","body":{}}`
	var e Envelope
	if err := json.Unmarshal([]byte(in), &e); err != nil {
		t.Fatal(err)
	}
	if e.Ref == nil || *e.Ref != "msg_01JCAAAAAAAAAAAAAAAAAAAAA1" {
		t.Fatalf("ref %v", e.Ref)
	}
}

func TestEnvelopeRejectsMissingFields(t *testing.T) {
	for _, field := range []string{"id", "type", "generation", "sent_at", "body"} {
		doc := map[string]any{"id": "msg_01JCAAAAAAAAAAAAAAAAAAAAA3", "type": "heartbeat", "generation": 1, "sent_at": "t", "body": map[string]any{}, "ref": nil}
		delete(doc, field)
		b, _ := json.Marshal(doc)
		var e Envelope
		if err := json.Unmarshal(b, &e); err == nil {
			t.Errorf("missing %s accepted", field)
		}
	}
}

func TestErrorBodyRoundTripsWithDetails(t *testing.T) {
	in := ErrorBody{Code: string(ErrorCodeGenerationInvalid), Explanation: "virtual_ip 100.64.0.2 is held twice", Fix: "Fix the generation.", Details: ErrorBodyDetails{"service_id": "svc_1", "count": float64(2)}}
	b, err := json.Marshal(&in)
	if err != nil {
		t.Fatal(err)
	}
	var out ErrorBody
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(in, out) {
		t.Fatalf("got %+v", out)
	}
}

func TestErrorBodyRequiresCodeAndExplanation(t *testing.T) {
	var e ErrorBody
	if err := json.Unmarshal([]byte(`{"fix":"x"}`), &e); err == nil {
		t.Fatal("an error body without a code was accepted")
	}
}

func TestEveryMessageTypeHasABodyConstructorAndNothingElseDoes(t *testing.T) {
	names := map[string]bool{}
	for _, n := range allMessageNames() {
		if names[n] {
			t.Errorf("message %q is declared twice", n)
		}
		names[n] = true
		ctor, ok := MessageBodies[n]
		if !ok {
			t.Errorf("message %q has no body constructor", n)
			continue
		}
		if v := ctor(); v == nil || reflect.ValueOf(v).Kind() != reflect.Pointer {
			t.Errorf("message %q constructs %T, want a pointer", n, v)
		}
	}
	for n := range MessageBodies {
		if !names[n] {
			t.Errorf("body constructor for undeclared message %q", n)
		}
	}
}

func allMessageNames() []string {
	return []string{
		MessageChallenge, MessageHello, MessageWelcome, MessageEnroll, MessageEnrolled, MessageHeartbeat, MessageError,
		MessageGeneration, MessageGenerationAvailable, MessageGenerationAck, MessageObservedReport, MessageObservedUpdate,
		MessageObservedRequest, MessageOutboxAck, MessageDeploymentStep, MessageDeploymentFinished, MessageRunCreated,
		MessageRunStatus, MessageRunExited, MessageBuildStatus, MessageBuildResult, MessageHealthResult, MessageContainerExited,
		MessageDiskPressure, MessageRegistryMaintenance, MessageComponentStatus, MessageLogGap, MessageAuditRecord,
		MessageGuardAck, MessageFlowRollup, MessageScanResult, MessageOutboxGap, MessageVolumeBackupResult,
		MessageVolumeRestoreResult, MessageSandboxStatus, MessageSandboxSnapshotStatus, MessageSandboxStorageGrow,
		MessageSandboxStorageGrown, MessageBuildStart, MessageBuildAccepted, MessageBuildCancel, MessageBuildCancelled,
		MessageRunStart, MessageRunAccepted, MessageRunCancel, MessageRunCancelled, MessageLogsQuery, MessageLogsPage,
		MessageLogsFollow, MessageMetricsSubscribe, MessageMetricsSample, MessageMetricsSampleResult, MessageNetworkSubscribe,
		MessageNetworkSample, MessageNetworkSampleResult, MessageNetworkInspect, MessageNetworkInspectResult,
		MessageNetworkProbe, MessageNetworkProbeResult, MessageDnsLog, MessageDnsLogResult, MessageExecResize,
		MessageExecResized, MessageForwardOpen, MessageSecretsDeliver, MessageSecretsAck, MessageSecretsRequest,
		MessageMasterKeyPrepare, MessageMasterKeyPrepared, MessageMasterKeyCommit, MessageMasterKeyCommitted,
		MessageMasterKeyAbort, MessageMasterKeyAborted, MessageHostAdmin, MessageHostAdminResult, MessageRegistryDelete,
		MessageRegistryDeleteResult, MessageRegistryGc, MessageRegistryGcAccepted, MessageScanStart, MessageScanAccepted,
		MessageDomainProbe, MessageDomainProbeResult, MessagePlatformVerify, MessagePlatformVerifyResult, MessageDoctorRun,
		MessageDoctorReport, MessageVolumeBackup, MessageVolumeBackupAccepted, MessageVolumeRestore,
		MessageVolumeRestoreAccepted, MessageVolumeBackupDelete, MessageVolumeBackupDeleteResult, MessageBlobGrant,
		MessageBlobGranted, MessageStreamOpened, MessageStreamData, MessageStreamCredit, MessageStreamEnd, MessageStreamCancel,
	}
}

func TestMessageNamesAreLowerCaseDotSeparated(t *testing.T) {
	for _, n := range allMessageNames() {
		if n != strings.ToLower(n) || strings.ContainsAny(n, " -") || strings.HasPrefix(n, ".") || strings.HasSuffix(n, ".") {
			t.Errorf("malformed message name %q", n)
		}
	}
}

func TestEmptyBodiesDecodeFromAnEmptyObject(t *testing.T) {
	for _, n := range []string{MessageObservedRequest, MessageMasterKeyCommit, MessageRegistryGcAccepted, MessageScanAccepted} {
		if err := json.Unmarshal([]byte(`{}`), MessageBodies[n]()); err != nil {
			t.Errorf("%s: %v", n, err)
		}
	}
}

func TestBodiesWithRequiredFieldsRejectAnEmptyObject(t *testing.T) {
	for _, n := range []string{MessageHello, MessageWelcome, MessageGeneration, MessageGenerationAck, MessageDeploymentStep, MessageStreamData} {
		if err := json.Unmarshal([]byte(`{}`), MessageBodies[n]()); err == nil {
			t.Errorf("%s accepted an empty body", n)
		}
	}
}

func TestProtocolConstantsMatchTheStationProtocolDocument(t *testing.T) {
	if Subprotocol != "stationly.station.v1" || ProtocolVersion != 1 || StationConnectPath != "/v1/stations/connect" {
		t.Fatalf("handshake constants: %s %d %s", Subprotocol, ProtocolVersion, StationConnectPath)
	}
	limits := map[string]int{
		"text frame":        LimitTextFrameBytes,
		"inline generation": LimitGenerationInlineBytes,
		"binary payload":    LimitBinaryPayloadBytes,
		"binary header":     LimitBinaryHeaderBytes,
		"read limit":        LimitReadLimitBytes,
		"streams":           LimitConcurrentStreams,
		"stream window":     LimitStreamWindowBytes,
		"stream item":       LimitStreamDataItemsBytes,
	}
	want := map[string]int{
		"text frame":        1 << 20,
		"inline generation": 4 << 20,
		"binary payload":    64 << 10,
		"binary header":     5,
		"read limit":        5 << 20,
		"streams":           64,
		"stream window":     256 << 10,
		"stream item":       256 << 10,
	}
	for k, v := range want {
		if limits[k] != v {
			t.Errorf("%s: %d, want %d", k, limits[k], v)
		}
	}
	if CloseRevoked != 4003 || CloseDuplicateConnection != 4009 || CloseMessageTooBig != 1009 {
		t.Errorf("close codes %d %d %d", CloseRevoked, CloseDuplicateConnection, CloseMessageTooBig)
	}
}
