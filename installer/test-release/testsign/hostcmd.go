package main

import (
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func cmdServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	dir := fs.String("dir", "", "directory to serve")
	addr := fs.String("addr", ":8080", "listen address")
	fs.Parse(args)
	if *dir == "" {
		return errors.New("--dir is required")
	}
	root, err := filepath.Abs(*dir)
	if err != nil {
		return err
	}
	if _, err := os.Stat(root); err != nil {
		return err
	}
	files := http.FileServer(http.Dir(root))
	logger := log.New(os.Stdout, "", log.LstdFlags|log.LUTC)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "read only", http.StatusMethodNotAllowed)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/") && r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		start := time.Now()
		files.ServeHTTP(rec, r)
		logger.Printf("%s %s %s %d %s", r.RemoteAddr, r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Millisecond))
	})
	logger.Printf("TEST release host serving %s on %s", root, *addr)
	srv := &http.Server{Addr: *addr, Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	return srv.ListenAndServe()
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}
