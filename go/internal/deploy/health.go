//go:build linux

package deploy

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"os"
	"strconv"
	"syscall"
	"time"

	"github.com/harshjv/stationly/go/internal/protocol"
)

type healthRule struct {
	kind     string
	path     string
	host     string
	port     int
	interval time.Duration
	timeout  time.Duration
	startup  time.Duration
	passes   int
	failures int
	alive    time.Duration
}

func ruleFor(h *protocol.ContainerSpecHealth, ports []protocol.ContainerPort) *healthRule {
	if h == nil {
		return nil
	}
	orDefault := func(v *int, d int) int {
		if v == nil {
			return d
		}
		return *v
	}
	seconds := func(v *int, d int) time.Duration {
		return time.Duration(orDefault(v, d)) * time.Second
	}
	timed := func(kind string, port int, startup int) *healthRule {
		return &healthRule{
			kind:     kind,
			port:     orDefault(h.Port, port),
			interval: seconds(h.IntervalS, 5),
			timeout:  seconds(h.TimeoutS, 3),
			startup:  seconds(h.StartupTimeoutS, startup),
			passes:   max(orDefault(h.Passes, 2), 1),
			failures: max(orDefault(h.Failures, 3), 1),
		}
	}
	switch h.Type {
	case "http":
		port := 0
		for _, p := range ports {
			if p.Protocol == protocol.PortProtocolHttp {
				port = p.Port
				break
			}
		}
		r := timed("http", port, 120)
		r.path = "/"
		if h.Path != nil && *h.Path != "" {
			r.path = *h.Path
		}
		if h.Host != nil {
			r.host = *h.Host
		}
		return r
	case "tcp":
		port := 0
		if len(ports) > 0 {
			port = ports[0].Port
		}
		return timed("tcp", port, 60)
	case "alive":
		return &healthRule{kind: "alive", alive: seconds(h.Seconds, 10), interval: time.Second}
	}
	return nil
}

func (r *healthRule) describe() string {
	switch r.kind {
	case "http":
		return "the http check GET " + r.path + " on port " + strconv.Itoa(r.port)
	case "tcp":
		return "the tcp check on port " + strconv.Itoa(r.port)
	}
	return "the " + r.kind + " check"
}

type health struct {
	rule       *healthRule
	since      time.Time
	state      protocol.HealthState
	passStreak int
	failStreak int
	everPassed bool
	lastCheck  time.Time
	nextCheck  time.Time
	inflight   bool
	failure    *protocol.ErrorBody
	attempts   int
	lastResult string
}

func newHealth(rule *healthRule, since time.Time) health {
	return health{rule: rule, since: since, state: protocol.HealthStateNone, nextCheck: since}
}

func (h *health) consecutive() int {
	return max(h.passStreak, h.failStreak)
}

func (h *health) record(pass bool, result string, at time.Time) {
	h.lastCheck = at
	h.attempts++
	h.lastResult = result
	if pass {
		h.passStreak++
		h.failStreak = 0
	} else {
		h.failStreak++
		h.passStreak = 0
	}
	h.evaluate(at)
}

func (h *health) evaluate(now time.Time) {
	r := h.rule
	if r == nil {
		return
	}
	switch {
	case r.kind == "alive":
		if h.passStreak > 0 {
			h.state = protocol.HealthStatePassing
			h.everPassed = true
		}
	case h.passStreak >= r.passes:
		h.state = protocol.HealthStatePassing
		h.everPassed = true
		h.failure = nil
	case h.everPassed && h.failStreak >= r.failures:
		h.state = protocol.HealthStateFailed
	case h.everPassed && h.failStreak > 0:
		h.state = protocol.HealthStateFailing
	case !h.everPassed && now.Sub(h.since) > r.startup:
		h.state = protocol.HealthStateFailed
		h.failure = &protocol.ErrorBody{
			Code:        string(protocol.ErrorCodeHealthTimeout),
			Explanation: fmt.Sprintf("%s did not pass within %s (last result %s after %d attempts)", r.describe(), r.startup, h.lastResult, h.attempts),
			Fix:         "Check that the service listens on the health port on all interfaces and answers the health path with 200 to 399.",
		}
	}
}

func (h *health) due(now time.Time) bool {
	return h.rule != nil && !h.inflight && !now.Before(h.nextCheck)
}

func probe(ctx context.Context, r *healthRule, addr netip.Addr) (bool, string) {
	target := netip.AddrPortFrom(addr, uint16(r.port)).String()
	switch r.kind {
	case "tcp":
		d := net.Dialer{Timeout: r.timeout}
		conn, err := d.DialContext(ctx, "tcp", target)
		if err != nil {
			return false, dialResult(err)
		}
		conn.Close()
		return true, "ok"
	case "http":
		client := http.Client{
			Timeout:       r.timeout,
			Transport:     &http.Transport{DisableKeepAlives: true, Proxy: nil},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		}
		req, err := r.request(ctx, target)
		if err != nil {
			return false, "invalid_request"
		}
		resp, err := client.Do(req)
		if err != nil {
			return false, dialResult(err)
		}
		resp.Body.Close()
		if resp.StatusCode >= 200 && resp.StatusCode <= 399 {
			return true, "status_" + strconv.Itoa(resp.StatusCode)
		}
		return false, "status_" + strconv.Itoa(resp.StatusCode)
	}
	return false, "unsupported"
}

func (r *healthRule) request(ctx context.Context, target string) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+target+r.path, nil)
	if err != nil {
		return nil, err
	}
	if r.host != "" {
		req.Host = r.host
	}
	return req, nil
}

func dialResult(err error) string {
	var ne net.Error
	switch {
	case errors.Is(err, syscall.ECONNREFUSED):
		return "connection_refused"
	case errors.Is(err, syscall.EHOSTUNREACH):
		return "host_unreachable"
	case errors.Is(err, syscall.ECONNRESET):
		return "connection_reset"
	case errors.Is(err, os.ErrDeadlineExceeded), errors.As(err, &ne) && ne.Timeout():
		return "no_response"
	}
	return "error"
}
