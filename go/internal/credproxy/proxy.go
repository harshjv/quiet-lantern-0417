package credproxy

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/harshjv/stationly/go/internal/protocol"
)

const (
	helloTimeout  = 10 * time.Second
	headerTimeout = 10 * time.Second
	dialTimeout   = 10 * time.Second
	idleTimeout   = 90 * time.Second
)

var PlaceholderShape = regexp.MustCompile(`^[A-Za-z0-9_-]*` + protocol.CredentialPlaceholderPattern + `$`)

type Credential struct {
	Value string
	Hosts []string
}

type Config struct {
	Hosts       []string
	CA          *CA
	Lookup      func(placeholder string) (Credential, bool)
	Dial        func(ctx context.Context, to netip.AddrPort) (net.Conn, error)
	Resolve     func(ctx context.Context, host string) ([]netip.Addr, error)
	OriginalDst func(net.Conn) (netip.AddrPort, error)
	RootCAs     *x509.CertPool
	Count       func(placeholder string, misdirected bool)
	Log         *slog.Logger
}

type Proxy struct {
	cfg       Config
	hosts     map[string]bool
	tlsConfig *tls.Config
	srv       *http.Server
	terminate *connQueue
	transport *http.Transport

	mu     sync.Mutex
	ln     net.Listener
	open   map[net.Conn]bool
	closed bool
}

func New(cfg Config) *Proxy {
	p := &Proxy{cfg: cfg, hosts: map[string]bool{}, terminate: newConnQueue(), open: map[net.Conn]bool{}}
	for _, h := range cfg.Hosts {
		p.hosts[strings.ToLower(h)] = true
	}
	p.tlsConfig = &tls.Config{
		MinVersion: tls.VersionTLS12,
		NextProtos: []string{"h2", "http/1.1"},
		GetCertificate: func(h *tls.ClientHelloInfo) (*tls.Certificate, error) {
			name := strings.ToLower(h.ServerName)
			if !p.hosts[name] {
				return nil, fmt.Errorf("%q is not a credential host", h.ServerName)
			}
			return cfg.CA.Leaf(name, time.Now())
		},
	}
	p.transport = &http.Transport{
		DialContext:         p.dialHost,
		TLSClientConfig:     &tls.Config{RootCAs: cfg.RootCAs, MinVersion: tls.VersionTLS12},
		ForceAttemptHTTP2:   true,
		TLSHandshakeTimeout: dialTimeout,
		IdleConnTimeout:     idleTimeout,
		MaxIdleConnsPerHost: 16,
	}
	rp := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.Out.URL.Scheme = "https"
			r.Out.URL.Host = strings.ToLower(r.In.TLS.ServerName)
			r.Out.Host = r.In.Host
		},
		Transport:     p.transport,
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			p.log().Warn("credentials proxy upstream failed", "host", r.TLS.ServerName, "error", err)
			w.WriteHeader(http.StatusBadGateway)
		},
		ErrorLog: slog.NewLogLogger(p.log().Handler(), slog.LevelWarn),
	}
	p.srv = &http.Server{
		Handler:           p.handler(rp),
		ReadHeaderTimeout: headerTimeout,
		IdleTimeout:       idleTimeout,
		ErrorLog:          slog.NewLogLogger(p.log().Handler(), slog.LevelDebug),
	}
	return p
}

func (p *Proxy) log() *slog.Logger {
	if p.cfg.Log == nil {
		return slog.Default()
	}
	return p.cfg.Log
}

func (p *Proxy) Serve(ln net.Listener) error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return net.ErrClosed
	}
	p.ln = ln
	p.mu.Unlock()
	go func() { _ = p.srv.Serve(p.terminate) }()
	for {
		c, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		go p.handle(c)
	}
}

func (p *Proxy) Close() error {
	p.mu.Lock()
	p.closed = true
	ln := p.ln
	open := make([]net.Conn, 0, len(p.open))
	for c := range p.open {
		open = append(open, c)
	}
	p.mu.Unlock()
	var errs []error
	if ln != nil {
		errs = append(errs, ln.Close())
	}
	errs = append(errs, p.srv.Close())
	for _, c := range open {
		c.Close()
	}
	p.transport.CloseIdleConnections()
	return errors.Join(errs...)
}

func (p *Proxy) track(c net.Conn, on bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if on {
		p.open[c] = true
	} else {
		delete(p.open, c)
	}
}

func (p *Proxy) handle(c net.Conn) {
	dst, err := p.cfg.OriginalDst(c)
	if err != nil {
		p.log().Warn("credentials proxy could not read the original destination", "error", err)
		c.Close()
		return
	}
	sni, replay, err := peekHello(c, helloTimeout)
	if err != nil {
		c.Close()
		return
	}
	if p.hosts[strings.ToLower(sni)] {
		p.terminate.push(tls.Server(replay, p.tlsConfig))
		return
	}
	p.passthrough(replay, dst)
}

func (p *Proxy) passthrough(c net.Conn, dst netip.AddrPort) {
	p.track(c, true)
	defer p.track(c, false)
	defer c.Close()
	ctx, cancel := context.WithTimeout(context.Background(), dialTimeout)
	up, err := p.cfg.Dial(ctx, dst)
	cancel()
	if err != nil {
		p.log().Info("credentials proxy passthrough dial failed", "to", dst, "error", err)
		return
	}
	p.track(up, true)
	defer p.track(up, false)
	defer up.Close()
	done := make(chan struct{}, 2)
	pipe := func(to, from net.Conn) {
		_, _ = io.Copy(to, from)
		if cw, ok := to.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
		}
		done <- struct{}{}
	}
	go pipe(up, c)
	go pipe(c, up)
	<-done
	<-done
}

func (p *Proxy) dialHost(ctx context.Context, _, addr string) (net.Conn, error) {
	host, portText, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	if !p.hosts[strings.ToLower(host)] {
		return nil, fmt.Errorf("%s is not a credential host", host)
	}
	port, err := strconv.ParseUint(portText, 10, 16)
	if err != nil {
		return nil, err
	}
	addrs, err := p.cfg.Resolve(ctx, host)
	if err != nil {
		return nil, err
	}
	var errs []error
	for _, a := range addrs {
		c, err := p.cfg.Dial(ctx, netip.AddrPortFrom(a, uint16(port)))
		if err == nil {
			return c, nil
		}
		errs = append(errs, err)
	}
	if len(errs) == 0 {
		return nil, fmt.Errorf("%s resolved to no address", host)
	}
	return nil, errors.Join(errs...)
}

func (p *Proxy) handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sni := strings.ToLower(r.TLS.ServerName)
		host := strings.ToLower(r.Host)
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		if !p.substitute(r.Header, sni, host) {
			unavailable(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

var credentialHeaders = []string{"X-Api-Key", "Authorization"}

func (p *Proxy) substitute(h http.Header, sni, host string) bool {
	type swap struct {
		name, scheme, token string
		cred                Credential
	}
	var swaps []swap
	for _, name := range credentialHeaders {
		v := h.Get(name)
		scheme, token := "", strings.TrimSpace(v)
		if name == "Authorization" {
			s, t, ok := strings.Cut(v, " ")
			if !ok || !strings.EqualFold(s, "bearer") {
				continue
			}
			scheme, token = s+" ", strings.TrimSpace(t)
		}
		if !PlaceholderShape.MatchString(token) {
			continue
		}
		cred, ok := p.cfg.Lookup(token)
		if !ok {
			return false
		}
		swaps = append(swaps, swap{name, scheme, token, cred})
	}
	for _, sw := range swaps {
		bound := sni == host && slices.Contains(sw.cred.Hosts, sni)
		if bound {
			h.Set(sw.name, sw.scheme+sw.cred.Value)
		}
		if p.cfg.Count != nil {
			p.cfg.Count(sw.token, !bound)
		}
	}
	return true
}

func unavailable(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Retry-After", "2")
	w.WriteHeader(http.StatusServiceUnavailable)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{
		"code":        string(protocol.ErrorCodeCredentialsUnavailable),
		"explanation": "Stationly's credentials proxy holds no value for this placeholder: its run ended, or stationd restarted and Dispatch has not delivered the credentials again yet.",
		"fix":         "Retry in a few seconds; a placeholder of a run that ended never works again.",
		"request_id":  r.Header.Get("X-Request-Id"),
	}})
}

type connQueue struct {
	ch   chan net.Conn
	done chan struct{}
	once sync.Once
}

func newConnQueue() *connQueue {
	return &connQueue{ch: make(chan net.Conn), done: make(chan struct{})}
}

func (q *connQueue) push(c net.Conn) {
	select {
	case q.ch <- c:
	case <-q.done:
		c.Close()
	}
}

func (q *connQueue) Accept() (net.Conn, error) {
	select {
	case c := <-q.ch:
		return c, nil
	case <-q.done:
		return nil, net.ErrClosed
	}
}

func (q *connQueue) Close() error {
	q.once.Do(func() { close(q.done) })
	return nil
}

func (q *connQueue) Addr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4(169, 254, 1, 1), Port: protocol.NetworkCredentialsProxyPort}
}
