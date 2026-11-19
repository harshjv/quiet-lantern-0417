package gateway

import (
	"context"
	"io"
	"net/http"
	"net/netip"
	"os"
	"strings"
	"time"
)

func ConfigFiles(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range entries {
		if e.Type().IsRegular() && strings.HasSuffix(e.Name(), ".yml") {
			out = append(out, e.Name())
		}
	}
	return out, nil
}

func Ready(ctx context.Context, addr netip.Addr) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+netip.AddrPortFrom(addr, 80).String()+"/", nil)
	if err != nil {
		return 0, err
	}
	req.Host = ProbeHost
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true, Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp.StatusCode, nil
}
