package docker

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"slices"
	"strings"
	"testing"

	"github.com/moby/moby/client"
)

type fakeDaemon struct {
	labels map[string]string
	calls  []string
}

func (d *fakeDaemon) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path[strings.Index(r.URL.Path[1:], "/")+1:]
	d.calls = append(d.calls, r.Method+" "+path)
	switch {
	case r.Method == http.MethodGet && path == "/networks":
		_ = json.NewEncoder(w).Encode([]map[string]any{{"Name": SystemNetworkName, "Id": "net-1", "Labels": d.labels}})
	case r.Method == http.MethodDelete:
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodPost && path == "/networks/create":
		_ = json.NewEncoder(w).Encode(map[string]string{"Id": "net-2"})
	default:
		http.NotFound(w, r)
	}
}

func fakeClient(t *testing.T, labels map[string]string) (*Client, *fakeDaemon) {
	t.Helper()
	daemon := &fakeDaemon{labels: labels}
	server := httptest.NewServer(daemon)
	t.Cleanup(server.Close)
	api, err := client.New(client.WithHost("tcp://"+server.Listener.Addr().String()), client.WithAPIVersion("1.52"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = api.Close() })
	return &Client{api: api}, daemon
}

func systemSpec() NetworkSpec {
	return SystemNetwork("stn_1", netip.MustParsePrefix("10.210.0.0/24"), netip.MustParsePrefix("10.210.0.0/25"), netip.MustParseAddr("10.210.0.1"))
}

func TestEnsureNetworkRefusesToRemoveAnotherStationsNetwork(t *testing.T) {
	c, daemon := fakeClient(t, map[string]string{LabelStation: "stn_2", LabelHash: "other"})
	removing := false
	_, created, err := c.EnsureNetwork(context.Background(), systemSpec(), func() { removing = true })
	if err == nil || !strings.Contains(err.Error(), "belongs to another station") {
		t.Fatalf("err %v, want the other-station refusal", err)
	}
	if created || removing || !slices.Equal(daemon.calls, []string{"GET /networks"}) {
		t.Fatalf("created %v, beforeRemove called %v, daemon calls %v", created, removing, daemon.calls)
	}
}

func TestEnsureNetworkRecreatesItsOwnNetworkWithOtherSettings(t *testing.T) {
	c, daemon := fakeClient(t, map[string]string{LabelStation: "stn_1", LabelHash: "other"})
	removing := false
	id, created, err := c.EnsureNetwork(context.Background(), systemSpec(), func() { removing = true })
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"GET /networks", "DELETE /networks/net-1", "POST /networks/create"}
	if id != "net-2" || !created || !removing || !slices.Equal(daemon.calls, want) {
		t.Fatalf("id %s created %v beforeRemove called %v daemon calls %v", id, created, removing, daemon.calls)
	}
}
