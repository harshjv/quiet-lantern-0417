package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

type ghcrProxy struct {
	upstream *url.URL
	public   string
	blobBase string
	tokens   sync.Map
	logger   *log.Logger
}

func cmdRegistryProxy(args []string) error {
	fs := flag.NewFlagSet("registry-proxy", flag.ExitOnError)
	upstream := fs.String("upstream", "", "Distribution registry to front, http://HOST:PORT")
	addr := fs.String("addr", ":5051", "registry listen address")
	blobAddr := fs.String("blob-addr", ":5052", "blob host listen address")
	public := fs.String("public", "", "HOST:PORT clients use for the registry (token realm)")
	blobPublic := fs.String("blob-public", "", "HOST:PORT clients use for the blob host (redirect target)")
	fs.Parse(args)
	if *upstream == "" || *public == "" || *blobPublic == "" {
		return errors.New("--upstream, --public and --blob-public are required")
	}
	u, err := url.Parse(*upstream)
	if err != nil {
		return err
	}
	p := &ghcrProxy{upstream: u, public: *public, blobBase: "http://" + *blobPublic, logger: log.New(os.Stdout, "", log.LstdFlags|log.LUTC)}
	errs := make(chan error, 2)
	go func() {
		errs <- (&http.Server{Addr: *blobAddr, Handler: http.HandlerFunc(p.blob), ReadHeaderTimeout: 10 * time.Second}).ListenAndServe()
	}()
	go func() {
		errs <- (&http.Server{Addr: *addr, Handler: http.HandlerFunc(p.registry), ReadHeaderTimeout: 10 * time.Second}).ListenAndServe()
	}()
	p.logger.Printf("TEST registry proxy (GHCR behaviour: anonymous bearer token, blob redirect) on %s, blobs on %s, upstream %s", *addr, *blobAddr, *upstream)
	return <-errs
}

func (p *ghcrProxy) registry(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "read only", http.StatusMethodNotAllowed)
		return
	}
	if r.URL.Path == "/token" {
		scope := r.URL.Query().Get("scope")
		if !strings.HasPrefix(scope, "repository:") || !strings.HasSuffix(scope, ":pull") {
			http.Error(w, `{"errors":[{"code":"DENIED"}]}`, http.StatusForbidden)
			return
		}
		b := make([]byte, 16)
		rand.Read(b)
		token := hex.EncodeToString(b)
		p.tokens.Store(token, strings.TrimSuffix(strings.TrimPrefix(scope, "repository:"), ":pull"))
		p.logger.Printf("token %s for %s", token[:8], scope)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"token":%q}`, token)
		return
	}
	repo, rest, ok := splitV2(r.URL.Path)
	if !ok {
		if r.URL.Path == "/v2/" {
			p.challenge(w, "")
			return
		}
		http.NotFound(w, r)
		return
	}
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	granted, found := p.tokens.Load(token)
	if !found || granted.(string) != repo {
		p.logger.Printf("401 %s %s", r.Method, r.URL.Path)
		p.challenge(w, repo)
		return
	}
	if strings.HasPrefix(rest, "blobs/") {
		p.logger.Printf("307 %s %s", r.Method, r.URL.Path)
		http.Redirect(w, r, p.blobBase+"/"+repo+"/"+rest, http.StatusTemporaryRedirect)
		return
	}
	p.logger.Printf("proxy %s %s", r.Method, r.URL.Path)
	rp := httputil.NewSingleHostReverseProxy(p.upstream)
	r.Header.Del("Authorization")
	rp.ServeHTTP(w, r)
}

func (p *ghcrProxy) challenge(w http.ResponseWriter, repo string) {
	h := fmt.Sprintf(`Bearer realm="http://%s/token",service="%s"`, p.public, p.public)
	if repo != "" {
		h += fmt.Sprintf(`,scope="repository:%s:pull"`, repo)
	}
	w.Header().Set("WWW-Authenticate", h)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	io.WriteString(w, `{"errors":[{"code":"UNAUTHORIZED"}]}`)
}

func (p *ghcrProxy) blob(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "" {
		p.logger.Printf("400 blob request carried an Authorization header")
		http.Error(w, "the blob host takes no Authorization header", http.StatusBadRequest)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/")
	i := strings.Index(path, "/blobs/")
	if i < 0 {
		http.NotFound(w, r)
		return
	}
	resp, err := http.Get(p.upstream.String() + "/v2/" + path)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	p.logger.Printf("blob %d %s", resp.StatusCode, path)
	for _, k := range []string{"Content-Type", "Content-Length", "Docker-Content-Digest"} {
		if v := resp.Header.Get(k); v != "" {
			w.Header().Set(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

func splitV2(path string) (string, string, bool) {
	rest, ok := strings.CutPrefix(path, "/v2/")
	if !ok {
		return "", "", false
	}
	for _, kind := range []string{"/manifests/", "/blobs/", "/tags/", "/referrers/"} {
		if i := strings.Index(rest, kind); i > 0 {
			return rest[:i], rest[i+1:], true
		}
	}
	return "", "", false
}
