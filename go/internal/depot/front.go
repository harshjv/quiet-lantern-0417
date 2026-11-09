package depot

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"time"

	"github.com/harshjv/stationly/go/internal/upgrade"
)

type Front struct {
	log    *slog.Logger
	signer *Signer
	server *http.Server
}

func NewFront(log *slog.Logger, signer *Signer, upstream netip.AddrPort) *Front {
	target := &url.URL{Scheme: "http", Host: upstream.String()}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			r.Out.Host = r.In.Host
			r.SetXForwarded()
		},
		FlushInterval: -1,
	}
	f := &Front{log: log, signer: signer}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /token", f.getToken)
	mux.HandleFunc("POST /token", f.postToken)
	mux.Handle("/", proxy)
	f.server = &http.Server{Handler: mux, ReadHeaderTimeout: 30 * time.Second}
	return f
}

func (f *Front) Listen(addr netip.AddrPort) error {
	ln, err := upgrade.Listen("depot/front", "tcp4", addr.String())
	if err != nil {
		return err
	}
	go func() {
		if err := f.server.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			f.log.Error("Depot front stopped", "error", err)
		}
	}()
	f.log.Info("Depot front listening", "address", addr)
	return nil
}

func (f *Front) Close() {
	upgrade.Forget("depot/front")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	f.server.Shutdown(ctx)
}

func (f *Front) getToken(w http.ResponseWriter, r *http.Request) {
	_, password, basic := r.BasicAuth()
	f.answer(w, r, basic, password, r.URL.Query()["scope"])
}

func (f *Front) postToken(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, `{"errors":[{"code":"UNSUPPORTED","message":"unreadable form"}]}`, http.StatusBadRequest)
		return
	}
	password := r.PostForm.Get("password")
	f.answer(w, r, r.PostForm.Get("grant_type") == "password" && password != "", password, r.PostForm["scope"])
}

func (f *Front) answer(w http.ResponseWriter, r *http.Request, hasGrant bool, grant string, scopes []string) {
	var granted []Access
	if hasGrant {
		g, err := f.signer.VerifyGrant(grant)
		if err != nil {
			f.log.Warn("Depot token request with an invalid grant", "remote", r.RemoteAddr, "error", err)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"errors":[{"code":"UNAUTHORIZED","message":"invalid grant"}]}`))
			return
		}
		granted = g
	}
	var access []Access
	for _, want := range ParseScopes(scopes) {
		if got := Covered(granted, want); len(got.Actions) > 0 {
			access = append(access, got)
		}
	}
	tok, err := f.signer.Mint("front", access, PullTokenTTL)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	f.log.Info("Depot token issued", "remote", r.RemoteAddr, "method", r.Method, "requested", scopes, "granted", len(access), "user_agent", r.UserAgent())
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"token":        tok,
		"access_token": tok,
		"expires_in":   int(PullTokenTTL.Seconds()),
		"issued_at":    time.Now().UTC().Format(time.RFC3339),
	})
}
