package docker

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/moby/moby/client"
)

func TestFollowLogsSendsSinceWithFullNanoseconds(t *testing.T) {
	var since string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		since = r.URL.Query().Get("since")
	}))
	t.Cleanup(server.Close)
	api, err := client.New(client.WithHost("tcp://"+server.Listener.Addr().String()), client.WithAPIVersion("1.52"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = api.Close() })
	c := &Client{api: api}

	logs, err := c.FollowLogs(context.Background(), "ctr", time.Unix(1700000000, 5), false)
	if err != nil {
		t.Fatal(err)
	}
	_ = logs.Close()

	if since != "1700000000.000000005" {
		t.Fatalf("since %q, want 1700000000.000000005", since)
	}
}
