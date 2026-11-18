//go:build linux

package deploy

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/harshjv/stationly/go/internal/netns"
	"github.com/harshjv/stationly/go/internal/protocol"
)

const relayHeaderTimeout = 10 * time.Second

func relayed(path string) bool {
	return strings.HasPrefix(path, "/v1/") || path == "/mcp" || strings.HasPrefix(path, "/mcp/")
}

type credentialLookup func(placeholder string) (relayCredential, bool)

func bearerPlaceholder(header string) (string, bool) {
	scheme, token, ok := strings.Cut(header, " ")
	if !ok || !strings.EqualFold(scheme, "bearer") {
		return "", false
	}
	token = strings.TrimSpace(token)
	return token, placeholderShape.MatchString(token)
}

func credentialsUnavailable(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Retry-After", "2")
	w.WriteHeader(http.StatusServiceUnavailable)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{
		"code":        string(protocol.ErrorCodeCredentialsUnavailable),
		"explanation": "The API relay holds no token for this placeholder: its run ended, or stationd restarted and Dispatch has not delivered the run's credentials again yet.",
		"fix":         "Retry in a few seconds; a placeholder of a run that ended never works again.",
		"request_id":  r.Header.Get("X-Request-Id"),
	}})
}

func relayHandler(target *url.URL, lookup credentialLookup, host string) http.Handler {
	proxy := &httputil.ReverseProxy{Rewrite: func(r *httputil.ProxyRequest) { r.SetURL(target) }}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !relayed(r.URL.Path) {
			http.NotFound(w, r)
			return
		}
		if placeholder, ok := bearerPlaceholder(r.Header.Get("Authorization")); ok {
			cred, held := lookup(placeholder)
			if !held {
				credentialsUnavailable(w, r)
				return
			}
			if cred.boundTo(host) {
				r.Header.Set("Authorization", "Bearer "+cred.value)
			}
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
	ln, err := ns.ListenCoupler(st.baseline.Relay)
	ns.Close()
	if err != nil {
		s.log.Error("listen for the API relay", "sandbox", id, "error", err)
		return
	}
	lookup := func(placeholder string) (relayCredential, bool) {
		return s.relayCreds.lookup(id, placeholder, time.Now())
	}
	host := netip.AddrPortFrom(netns.CouplerLink, st.baseline.Relay).String()
	srv := &http.Server{Handler: relayHandler(target, lookup, host), ReadHeaderTimeout: relayHeaderTimeout}
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
