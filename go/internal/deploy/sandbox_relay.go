//go:build linux

package deploy

import (
	"context"
	"errors"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/harshjv/stationly/go/internal/netns"
)

const relayHeaderTimeout = 10 * time.Second

func relayed(path string) bool {
	return strings.HasPrefix(path, "/v1/") || path == "/mcp" || strings.HasPrefix(path, "/mcp/")
}

func relayHandler(target *url.URL) http.Handler {
	proxy := &httputil.ReverseProxy{Rewrite: func(r *httputil.ProxyRequest) { r.SetURL(target) }}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !relayed(r.URL.Path) {
			http.NotFound(w, r)
			return
		}
		proxy.ServeHTTP(w, r)
	})
}

func (s *Station) openRelay(st *sbxState) {
	if st.baseline.Relay == 0 || st.relay != nil {
		return
	}
	id := st.rec.ID
	target, err := url.Parse(s.opts.Identity.DispatchURL)
	if err != nil {
		s.log.Error("parse the dispatch url for the API relay", "sandbox", id, "error", err)
		return
	}
	ns, err := netns.OpenChecked(st.pid, st.inode)
	if err != nil {
		s.log.Error("open the Coupler namespace for the API relay", "sandbox", id, "error", err)
		return
	}
	ln, err := ns.ListenRelay(st.baseline.Relay)
	ns.Close()
	if err != nil {
		s.log.Error("listen for the API relay", "sandbox", id, "error", err)
		return
	}
	srv := &http.Server{Handler: relayHandler(target), ReadHeaderTimeout: relayHeaderTimeout}
	st.relay = srv
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			s.log.Warn("the API relay stopped", "sandbox", id, "error", err)
		}
	}()
}

func (st *sbxState) closeRelay() {
	if st.relay == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := st.relay.Shutdown(ctx); err != nil {
		st.relay.Close()
	}
	st.relay = nil
}
