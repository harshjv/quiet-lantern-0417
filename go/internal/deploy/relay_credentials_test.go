//go:build linux

package deploy

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/harshjv/stationly/go/internal/netns"
	"github.com/harshjv/stationly/go/internal/protocol"
)

var relayTestHost = netip.AddrPortFrom(netns.CouplerLink, protocol.NetworkDispatchPort).String()

func testPlaceholder(c string) string {
	return "sly_" + strings.Repeat(c, 26)
}

type relayUpstream struct {
	target *url.URL
	hits   atomic.Int32
}

func newRelayUpstream(t *testing.T) *relayUpstream {
	t.Helper()
	u := &relayUpstream{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u.hits.Add(1)
		_, _ = io.WriteString(w, r.Header.Get("Authorization"))
	}))
	t.Cleanup(srv.Close)
	target, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	u.target = target
	return u
}

func relayCall(h http.Handler, path, auth string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "http://"+relayTestHost+path, nil)
	req.Header.Set("X-Request-Id", "req_test")
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestTheRelaySwapsOnlyAHeldPlaceholderBoundToItsAddress(t *testing.T) {
	up := newRelayUpstream(t)
	now := time.Unix(1_000_000, 0)
	bound, unbound := testPlaceholder("A"), testPlaceholder("B")
	realToken := "sly_" + strings.Repeat("Q", 64)
	var c relayCredentials
	c.hold("sbx_a", "run_1", map[string]relayCredential{
		bound:   {key: "STATIONLY_TOKEN", value: "real-bound", hosts: []string{relayTestHost}, expires: now.Add(time.Hour)},
		unbound: {key: "STATIONLY_TOKEN", value: "real-unbound", hosts: []string{"api.anthropic.com"}},
	})
	h := relayHandler(up.target, func(p string) (relayCredential, bool) { return c.lookup("sbx_a", p, now) }, relayTestHost)
	cases := []struct {
		name, auth, seen string
	}{
		{"a bound placeholder", "Bearer " + bound, "Bearer real-bound"},
		{"a bound placeholder with a lowercase scheme", "bearer " + bound, "Bearer real-bound"},
		{"a placeholder bound to other hosts", "Bearer " + unbound, "Bearer " + unbound},
		{"a real token", "Bearer " + realToken, "Bearer " + realToken},
		{"a bound placeholder under another scheme", "Basic " + bound, "Basic " + bound},
		{"no credentials", "", ""},
	}
	for _, tc := range cases {
		rec := relayCall(h, "/v1/me", tc.auth)
		if rec.Code != http.StatusOK || rec.Body.String() != tc.seen {
			t.Errorf("%s: status %d, upstream saw %q; want 200 and %q", tc.name, rec.Code, rec.Body.String(), tc.seen)
		}
	}
	if got := up.hits.Load(); got != int32(len(cases)) {
		t.Errorf("upstream hits %d, want %d", got, len(cases))
	}
}

func TestTheRelayRefusesAPlaceholderItHoldsNoValueForWithoutForwardingIt(t *testing.T) {
	up := newRelayUpstream(t)
	now := time.Unix(1_000_000, 0)
	expired, other, unknown := testPlaceholder("C"), testPlaceholder("D"), testPlaceholder("E")
	var c relayCredentials
	c.hold("sbx_a", "run_1", map[string]relayCredential{
		expired: {key: "STATIONLY_TOKEN", value: "real-expired", hosts: []string{relayTestHost}, expires: now.Add(-time.Second)},
	})
	c.hold("sbx_b", "", map[string]relayCredential{
		other: {key: "STATIONLY_TOKEN", value: "real-other", hosts: []string{relayTestHost}},
	})
	h := relayHandler(up.target, func(p string) (relayCredential, bool) { return c.lookup("sbx_a", p, now) }, relayTestHost)
	for _, tc := range []struct{ name, placeholder, path string }{
		{"an unknown placeholder", unknown, "/v1/me"},
		{"an expired placeholder", expired, "/v1/me"},
		{"another machine's placeholder", other, "/mcp"},
	} {
		rec := relayCall(h, tc.path, "Bearer "+tc.placeholder)
		if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "2" {
			t.Errorf("%s: status %d, Retry-After %q; want 503 and 2", tc.name, rec.Code, rec.Header().Get("Retry-After"))
			continue
		}
		var body struct {
			Error struct {
				Code        string `json:"code"`
				Explanation string `json:"explanation"`
				Fix         string `json:"fix"`
				RequestID   string `json:"request_id"`
			} `json:"error"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Errorf("%s: body is not JSON: %v", tc.name, err)
			continue
		}
		if body.Error.Code != string(protocol.ErrorCodeCredentialsUnavailable) || body.Error.Explanation == "" || body.Error.Fix == "" || body.Error.RequestID != "req_test" {
			t.Errorf("%s: error %+v, want CREDENTIALS_UNAVAILABLE with an explanation, a fix and the request id", tc.name, body.Error)
		}
		if strings.Contains(rec.Body.String(), "real-") || strings.Contains(rec.Body.String(), tc.placeholder) {
			t.Errorf("%s: the 503 body names a credential", tc.name)
		}
	}
	if got := up.hits.Load(); got != 0 {
		t.Errorf("upstream hits %d, want none", got)
	}
	if cred, ok := c.lookup("sbx_b", other, now); !ok || cred.value != "real-other" {
		t.Error("the other machine lost its own placeholder")
	}
}

func TestTheRelayServesOnlyTheAPIPaths(t *testing.T) {
	up := newRelayUpstream(t)
	h := relayHandler(up.target, func(string) (relayCredential, bool) { return relayCredential{}, false }, relayTestHost)
	for _, path := range []string{"/", "/v1", "/v2/me", "/mcpx", "/auth/api-key/create", "/healthz"} {
		if rec := relayCall(h, path, ""); rec.Code != http.StatusNotFound {
			t.Errorf("%s: status %d, want 404", path, rec.Code)
		}
	}
	if got := up.hits.Load(); got != 0 {
		t.Fatalf("upstream hits %d after unrelayed paths, want none", got)
	}
	for _, path := range []string{"/v1/me", "/mcp", "/mcp/tools"} {
		if rec := relayCall(h, path, ""); rec.Code != http.StatusOK {
			t.Errorf("%s: status %d, want 200", path, rec.Code)
		}
	}
}

func TestARelayCredentialStopsAtItsExpiryAndIsDropped(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	p := testPlaceholder("F")
	var c relayCredentials
	c.hold("sbx_a", "run_1", map[string]relayCredential{p: {value: "real", hosts: []string{relayTestHost}, expires: now.Add(time.Minute)}})
	if _, ok := c.lookup("sbx_a", p, now); !ok {
		t.Fatal("a live credential is not held")
	}
	if !c.holds("sbx_a", "run_1", now) {
		t.Fatal("holds says the run has no live credential")
	}
	later := now.Add(time.Minute)
	if _, ok := c.lookup("sbx_a", p, later); ok {
		t.Fatal("a credential is served at its expiry")
	}
	if c.holds("sbx_a", "run_1", later) {
		t.Fatal("holds counts an expired credential")
	}
	if _, ok := c.lookup("sbx_a", p, now); ok {
		t.Fatal("an expired credential was kept after its lookup")
	}
}

func TestRelayCredentialsDropWithTheirRunTheMachineStopAndTheMachineDelete(t *testing.T) {
	run1, run2, machine := testPlaceholder("G"), testPlaceholder("H"), testPlaceholder("I")
	now := time.Unix(1_000_000, 0)
	var c relayCredentials
	held := func(p string) bool {
		_, ok := c.lookup("sbx_a", p, now)
		return ok
	}
	c.hold("sbx_a", "run_1", map[string]relayCredential{run1: {value: "r1"}})
	c.hold("sbx_a", "run_2", map[string]relayCredential{run2: {value: "r2"}})
	c.hold("sbx_a", "", map[string]relayCredential{machine: {value: "m"}})
	c.dropRun("sbx_a", "run_1")
	if held(run1) || !held(run2) || !held(machine) {
		t.Fatalf("after run_1 exits: run_1 %v, run_2 %v, machine %v; want only run_1 gone", held(run1), held(run2), held(machine))
	}
	c.dropRuns("sbx_a")
	if held(run2) || !held(machine) {
		t.Fatalf("after the machine stops: run_2 %v, machine %v; want the run gone and the machine kept", held(run2), held(machine))
	}
	c.dropSandbox("sbx_a")
	if held(machine) {
		t.Fatal("the machine's value outlived the machine's delete")
	}
}

func TestADeliveryReplacesTheValuesItsTargetHeld(t *testing.T) {
	old, fresh, run := testPlaceholder("J"), testPlaceholder("K"), testPlaceholder("L")
	now := time.Unix(1_000_000, 0)
	var c relayCredentials
	c.hold("sbx_a", "", map[string]relayCredential{old: {value: "old"}})
	c.hold("sbx_a", "run_1", map[string]relayCredential{run: {value: "run"}})
	c.hold("sbx_a", "", map[string]relayCredential{fresh: {value: "fresh"}})
	if _, ok := c.lookup("sbx_a", old, now); ok {
		t.Error("a removed member's placeholder survived the machine's next delivery")
	}
	for _, p := range []string{fresh, run} {
		if _, ok := c.lookup("sbx_a", p, now); !ok {
			t.Errorf("%s dropped by a machine delivery", p)
		}
	}
}

func runCredentialsStation(t *testing.T) *Station {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, runDir), 0o700); err != nil {
		t.Fatal(err)
	}
	return &Station{log: slog.New(slog.NewTextHandler(io.Discard, nil)), opts: Options{StateDir: dir}, runs: map[string]*runRecord{}}
}

func secretValue(key, value, placeholder string, hosts []string, expires *string, relayOnly bool) protocol.SecretValue {
	v := protocol.SecretValue{Key: key, Value: base64.RawURLEncoding.EncodeToString([]byte(value))}
	if placeholder != "" {
		v.Placeholder, v.Hosts, v.ExpiresAt = &placeholder, hosts, expires
	}
	if relayOnly {
		v.RelayOnly = &relayOnly
	}
	return v
}

func TestTheStationDropsARunsCredentialsWhenTheRunEndsAndKeepsTheMachines(t *testing.T) {
	s := runCredentialsStation(t)
	runP, machineP := testPlaceholder("M"), testPlaceholder("N")
	until := time.Now().Add(time.Hour)
	rr := &runRecord{ID: "run_1", SandboxID: "sbx_a", Status: protocol.RunStatusRunning, Reported: protocol.RunStatusRunning}
	s.runs[rr.ID] = rr
	s.relayCreds.hold("sbx_a", "", map[string]relayCredential{machineP: {value: "machine"}})
	s.holdRunCredentials(rr, protocol.SecretsDeliverBody{EnvDigest: "sha256:run", Values: []protocol.SecretValue{
		secretValue("STATIONLY_TOKEN", "real-run", runP, []string{relayTestHost}, stamp(until), false),
		secretValue("PLAIN", "plain", "", nil, nil, false),
	}})
	if cred, ok := s.relayCreds.lookup("sbx_a", runP, time.Now()); !ok || cred.value != "real-run" || !cred.boundTo(relayTestHost) {
		t.Fatalf("the run's placeholder is not held for the relay: %v", ok)
	}
	if rr.CredentialsDigest != "sha256:run" || rr.CredentialsUntil == nil {
		t.Fatalf("the run record keeps digest %q until %v, want the delivery's", rr.CredentialsDigest, rr.CredentialsUntil)
	}
	s.releaseRunCredentials(rr)
	if _, ok := s.relayCreds.lookup("sbx_a", runP, time.Now()); ok {
		t.Error("the run's placeholder outlived the run")
	}
	if rr.CredentialsDigest != "" || rr.CredentialsUntil != nil {
		t.Error("the run record still asks for its credentials after the run ended")
	}
	if _, ok := s.relayCreds.lookup("sbx_a", machineP, time.Now()); !ok {
		t.Error("the run's exit dropped the machine's value")
	}
}

func TestStoppingAMachineDropsItsRunsCredentialsAndKeepsItsOwn(t *testing.T) {
	s := runCredentialsStation(t)
	runP, machineP := testPlaceholder("O"), testPlaceholder("P")
	rr := &runRecord{ID: "run_1", SandboxID: "sbx_a", Status: protocol.RunStatusRunning, Reported: protocol.RunStatusRunning}
	s.runs[rr.ID] = rr
	s.relayCreds.hold("sbx_a", "", map[string]relayCredential{machineP: {value: "machine"}})
	s.holdRunCredentials(rr, protocol.SecretsDeliverBody{EnvDigest: "sha256:run", Values: []protocol.SecretValue{
		secretValue("STATIONLY_TOKEN", "real-run", runP, []string{relayTestHost}, stamp(time.Now().Add(time.Hour)), false),
	}})
	orphanP := testPlaceholder("U")
	s.relayCreds.hold("sbx_a", "run_unrecorded", map[string]relayCredential{orphanP: {value: "orphan"}})
	s.releaseSandboxCredentials("sbx_a")
	if _, ok := s.relayCreds.lookup("sbx_a", runP, time.Now()); ok {
		t.Error("a run's placeholder outlived its machine's stop")
	}
	if _, ok := s.relayCreds.lookup("sbx_a", orphanP, time.Now()); ok {
		t.Error("the placeholder of a run without a record outlived its machine's stop")
	}
	if rr.CredentialsUntil != nil {
		t.Error("the run record still asks for its credentials after its machine stopped")
	}
	if _, ok := s.relayCreds.lookup("sbx_a", machineP, time.Now()); !ok {
		t.Error("the machine's stop dropped its own value")
	}
}

func TestARelayOnlyValueStaysOutOfTheEnvironmentButIsHeldAndRedacted(t *testing.T) {
	workspace, member := testPlaceholder("Q"), testPlaceholder("R")
	body := protocol.SecretsDeliverBody{Purpose: protocol.SecretPurposeSandbox, Values: []protocol.SecretValue{
		secretValue("STATIONLY_API_URL", "http://relay", "", nil, nil, false),
		secretValue("STATIONLY_TOKEN", "real-workspace", workspace, []string{relayTestHost}, nil, false),
		secretValue("STATIONLY_TOKEN_M2000", "real-member", member, []string{relayTestHost}, nil, true),
	}}
	env, known, err := decodeDelivered(body)
	if err != nil {
		t.Fatal(err)
	}
	wantEnv := []string{"STATIONLY_API_URL=http://relay", "STATIONLY_TOKEN=" + workspace}
	if !slices.Equal(env, wantEnv) {
		t.Errorf("env %q, want %q", env, wantEnv)
	}
	for _, e := range env {
		if strings.Contains(e, "real-") || strings.Contains(e, member) || strings.HasPrefix(e, "STATIONLY_TOKEN_M2000=") {
			t.Errorf("the environment carries %q", strings.SplitN(e, "=", 2)[0])
		}
	}
	redacted := map[string]string{}
	for _, k := range known {
		redacted[k.Key] = k.Value
	}
	if redacted["STATIONLY_TOKEN"] != "real-workspace" || redacted["STATIONLY_TOKEN_M2000"] != "real-member" {
		t.Error("the redaction set misses a held value")
	}
	held, _, err := placeholdersOf(body.Values)
	if err != nil {
		t.Fatal(err)
	}
	if held[member].value != "real-member" || held[member].key != "STATIONLY_TOKEN_M2000" || !held[member].boundTo(relayTestHost) {
		t.Error("the relay_only value is not held for the relay")
	}
	if len(held) != 2 {
		t.Errorf("held %d values, want the 2 placeholders", len(held))
	}
}

func TestCredentialUsesAreCountedPerMachineAndPlaceholderAndDrainOnce(t *testing.T) {
	a, b := testPlaceholder("S"), testPlaceholder("T")
	var c relayCredentials
	c.count("sbx_b", b, true)
	c.count("sbx_a", a, false)
	c.count("sbx_a", a, false)
	c.count("sbx_a", a, true)
	got := c.drainUses()
	want := []protocol.CredentialUse{
		{SandboxId: "sbx_a", Placeholder: a, Used: 2, Misdirected: 1},
		{SandboxId: "sbx_b", Placeholder: b, Used: 0, Misdirected: 1},
	}
	if !slices.Equal(got, want) {
		t.Errorf("drained %+v, want %+v", got, want)
	}
	if again := c.drainUses(); len(again) != 0 {
		t.Errorf("a second drain gave %+v, want nothing", again)
	}
}
