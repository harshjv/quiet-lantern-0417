//go:build linux

package deploy

import (
	"encoding/json"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"

	"github.com/harshjv/stationly/go/internal/dispatch"
	"github.com/harshjv/stationly/go/internal/hostconfig"
	"github.com/harshjv/stationly/go/internal/identity"
	"github.com/harshjv/stationly/go/internal/ids"
	"github.com/harshjv/stationly/go/internal/outbox"
	"github.com/harshjv/stationly/go/internal/protocol"
)

func recoveryStation(t *testing.T, host *hostconfig.Config) (*Station, *outbox.Outbox) {
	t.Helper()
	ob, err := outbox.Open(filepath.Join(t.TempDir(), "outbox"), ids.New)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ob.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	id := &identity.Identity{Station: identity.Station{StationID: "stn_1", InstanceID: "ins_1", DispatchURL: "http://127.0.0.1:1"}}
	link, err := dispatch.New(log, id, ob, "test")
	if err != nil {
		t.Fatal(err)
	}
	return &Station{log: log, link: link, opts: Options{Host: host, Identity: id}}, ob
}

func TestRecoveryKeyReturnsTheKeyAndRecordsAnAuditEvent(t *testing.T) {
	key, err := hostconfig.NewMasterKey()
	if err != nil {
		t.Fatal(err)
	}
	host := &hostconfig.Config{Dispatch: hostconfig.Dispatch{MasterKey: key}}
	want, _ := host.RecoveryKey()
	s, ob := recoveryStation(t, host)
	got, perr := s.opRecoveryKey(nil, nil, nil)
	if perr != nil {
		t.Fatal(perr.Explanation)
	}
	if got.(protocol.RootSocketRecoveryKey).RecoveryKey != want {
		t.Fatalf("got %v, want %s", got, want)
	}
	records := ob.After(0, 10)
	if len(records) != 1 || records[0].Type != protocol.MessageAuditRecord {
		t.Fatalf("want one audit.record, got %+v", records)
	}
	var body protocol.AuditRecordBody
	if err := json.Unmarshal(records[0].Body, &body); err != nil {
		t.Fatal(err)
	}
	if body.Action != "admin.recovery_key_displayed" || body.Actor.Id == nil || *body.Actor.Id != "stn_1" {
		t.Fatalf("unexpected audit body %+v", body)
	}
	if strings.Contains(string(records[0].Body), want) {
		t.Fatal("the audit record must not carry the key")
	}
}

func TestRecoveryKeyRefusesAStationWithoutHostConfig(t *testing.T) {
	s, ob := recoveryStation(t, nil)
	_, perr := s.opRecoveryKey(nil, nil, nil)
	if perr == nil || perr.Code != string(protocol.ErrorCodeHostAdminForbidden) {
		t.Fatalf("want HOST_ADMIN_FORBIDDEN, got %+v", perr)
	}
	if len(ob.After(0, 10)) != 0 {
		t.Fatal("a refused call records nothing")
	}
}
