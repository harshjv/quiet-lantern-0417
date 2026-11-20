//go:build linux

package deploy

import (
	"fmt"
	"net/http"
	"net/netip"
	"slices"
	"strings"

	"github.com/harshjv/stationly/go/internal/netns"
	"github.com/harshjv/stationly/go/internal/protocol"
)

const tunnelTokenFix = "Give this server its Cloudflare Tunnel token as root on the host: sly platform tunnel-token --stdin. A restore onto a new host needs this once; the token never leaves the server, so no backup holds it."

func (s *Station) checkTunnel() protocol.DoctorCheck {
	c := newCheck("tunnel")
	configured := s.tunnelConfigured()
	if !configured && (s.plan == nil || !s.plan.Gateway.Run) {
		c.note("no Gateway on this server")
		return c.build()
	}
	t := &s.gw.tunnel
	c.detail["configured"], c.detail["ready"], c.detail["connections"] = configured, t.ready, t.connections
	if configured {
		c.step("token", doctorStep{status: protocol.DoctorStatusOk, finding: "tunnel token configured"})
	} else {
		c.step("token", doctorStep{status: protocol.DoctorStatusFail, code: "tunnel_token_missing", finding: "no tunnel token on this server", fix: tunnelTokenFix})
	}
	if st, ok := s.cloudflaredStep(configured); ok {
		c.step("cloudflared", st)
	}
	zone := s.domainsZone()
	if s.plan != nil {
		for _, rp := range s.plan.Gateway.Routes {
			if rp.System == "" {
				continue
			}
			p, probed := t.probes[rp.ID]
			c.step(rp.Hostname, tunnelProbeStep(rp.Hostname, routeZone(zone, rp.Hostname), true, p, probed))
		}
	}
	if t.wildcard != nil {
		c.step("wildcard", tunnelProbeStep("*."+zone, zone, false, *t.wildcard, true))
	}
	c.step("host", s.hostWebStep(c))
	c.note(fmt.Sprintf("%d step(s) pass", len(c.steps)))
	return c.build()
}

func (s *Station) cloudflaredStep(configured bool) (doctorStep, bool) {
	t := &s.gw.tunnel
	switch {
	case t.failure != "":
		return doctorStep{status: protocol.DoctorStatusFail, code: "tunnel_cloudflared_failed", finding: t.failure, fix: "Check stationd's cloudflared log lines; stationd retries at its next reconcile (30 s)."}, true
	case !configured:
		return doctorStep{}, false
	case s.plan == nil || !s.cloudflaredWanted():
		return doctorStep{status: protocol.DoctorStatusWarn, code: "tunnel_waiting_gateway", finding: "cloudflared waits for a running Gateway and its pinned image", fix: "Check component_health: cloudflared starts once the Gateway runs."}, true
	case !t.ready || t.connections == 0:
		return doctorStep{status: protocol.DoctorStatusFail, code: "tunnel_not_connected", finding: "cloudflared has no connection to Cloudflare", fix: "The token belongs to a revoked or deleted tunnel, or this host cannot reach Cloudflare: copy the token from the tunnel's page in Cloudflare and run sly platform tunnel-token --stdin."}, true
	}
	return doctorStep{status: protocol.DoctorStatusOk, finding: fmt.Sprintf("connected with %d connections", t.connections)}, true
}

func routeZone(zone, host string) string {
	if zone != "" {
		return zone
	}
	_, rest, _ := strings.Cut(host, ".")
	return rest
}

func tunnelProbeStep(host, zone string, system bool, p routeProbe, probed bool) doctorStep {
	fail := func(code, finding, fix string) doctorStep {
		return doctorStep{status: protocol.DoctorStatusFail, code: code, finding: finding, fix: fix}
	}
	routeFix := "In Cloudflare, add the published route *." + zone + " -> http://" + protocol.GatewayHostAlias + " to this server's tunnel."
	switch {
	case !probed:
		return doctorStep{status: protocol.DoctorStatusWarn, code: "tunnel_probe_pending", finding: "not probed yet"}
	case len(p.foreign) > 0:
		return fail("tunnel_dns_shadowed", host+" resolves to "+strings.Join(p.foreign, ", ")+", outside Cloudflare's addresses: a DNS record in the zone shadows the tunnel route", "In Cloudflare DNS, delete the record for "+host+" (often an old * A or AAAA record); the tunnel's * CNAME then answers it.")
	case p.failure == "" && system:
		return doctorStep{status: protocol.DoctorStatusOk, finding: "Dispatch answers " + dispatchHealthPath + " through the tunnel"}
	case p.failure == "":
		return doctorStep{status: protocol.DoctorStatusOk, finding: host + " answers through the tunnel"}
	case p.failure == protocol.RouteProbeFailureUpstreamUnhealthy:
		answered := fmt.Sprintf("answered %d", p.status)
		if p.status == 0 {
			answered = "did not answer"
		}
		return fail("tunnel_dispatch_unhealthy", host+" reaches this Gateway but "+dispatchHealthPath+" "+answered, "Check the component_health row and Dispatch's log.")
	case p.failure == protocol.RouteProbeFailureWrongGateway && (p.status == http.StatusBadGateway || p.status == http.StatusServiceUnavailable || p.status == http.StatusGatewayTimeout):
		return fail("tunnel_service_wrong", fmt.Sprintf("Cloudflare answered %s with %d, not this server's Gateway: the route's service is wrong", host, p.status), "Set the published route's service to http://"+protocol.GatewayHostAlias+".")
	case p.failure == protocol.RouteProbeFailureWrongGateway && p.status == 530:
		return fail("tunnel_other_tunnel", "Cloudflare could not reach the tunnel that holds "+host+" (530): the route sits on another tunnel than the one whose token this server holds", "Add the route to this server's tunnel, or give this server that tunnel's token with sly platform tunnel-token --stdin.")
	case p.failure == protocol.RouteProbeFailureWrongGateway && p.status != 0:
		return fail("tunnel_route_missing", fmt.Sprintf("%s answered %d without this Gateway's probe header: no tunnel route covers it, or it reaches another tunnel or server", host, p.status), routeFix)
	}
	return fail("tunnel_route_missing", host+" did not answer through Cloudflare", routeFix)
}

func (s *Station) hostWebStep(c *checkBuilder) doctorStep {
	var problems []doctorStep
	listeners, err := netns.HostWebListeners()
	var open []string
	for _, l := range listeners {
		open = append(open, netip.AddrPortFrom(l.Address, l.Port).String())
	}
	c.detail["listeners"] = open
	if err != nil {
		problems = append(problems, doctorStep{status: protocol.DoctorStatusWarn, code: "tunnel_web_port_unchecked", finding: "read the host's sockets: " + err.Error()})
	}
	for _, addr := range open {
		problems = append(problems, doctorStep{status: protocol.DoctorStatusFail, code: "tunnel_web_port_open", finding: addr + " listens on the host", fix: "Stop the process that listens on port 80 or 443 (ss -ltnp); the server opens no web port, traffic arrives through cloudflared."})
	}
	if s.plan != nil {
		missing, err := netns.WebPortDrops()
		c.detail["missing_drops"] = missing
		if len(missing) > 0 {
			finding := fmt.Sprintf("table inet %s chain input does not drop TCP %v", netns.HostTableName, missing)
			if err != nil {
				finding += ": " + err.Error()
			}
			problems = append(problems, doctorStep{status: protocol.DoctorStatusFail, code: "tunnel_web_drop_missing", finding: finding, fix: "stationd re-creates table inet " + netns.HostTableName + " at its next full reconcile (30 s); if it stays missing, restart stationd and look for what deletes it (nft list ruleset)."})
		}
	}
	if len(problems) == 0 {
		return doctorStep{status: protocol.DoctorStatusOk, finding: "nothing listens on 80 or 443 outside loopback and the host drops both"}
	}
	worst := problems[0]
	var findings, fixes []string
	for _, p := range problems {
		if doctorRank[p.status] > doctorRank[worst.status] {
			worst = p
		}
		findings = append(findings, p.finding)
		if p.fix != "" && !slices.Contains(fixes, p.fix) {
			fixes = append(fixes, p.fix)
		}
	}
	worst.finding, worst.fix = strings.Join(findings, "; "), strings.Join(fixes, " ")
	return worst
}
