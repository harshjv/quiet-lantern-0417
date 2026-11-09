//go:build linux

package deploy

import (
	"context"
	"errors"
	"net/netip"
	"strings"
	"time"

	"github.com/harshjv/stationly/go/internal/dispatch"
	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/logstore"
	"github.com/harshjv/stationly/go/internal/netns"
	"github.com/harshjv/stationly/go/internal/protocol"
	mdns "github.com/miekg/dns"
	"github.com/moby/moby/api/types/container"
	"golang.org/x/sys/unix"
)

const (
	probesPerStation = 4
	dnsLogDefault    = 50
	dnsLogMax        = 200
)

const (
	checkNotFound = "NOT_FOUND"
	checkInvalid  = "INVALID_CHECK"
	checkFailed   = "READ_FAILED"
	checkRuleset  = "RULESET_MISMATCH"
)

func healthName(h health) string {
	switch h.state {
	case protocol.HealthStatePassing:
		return "passing"
	case protocol.HealthStateFailing, protocol.HealthStateFailed:
		return "failing"
	}
	if h.rule == nil {
		return "none"
	}
	return "starting"
}

func checkError(kind protocol.NetworkCheckKind, code string) protocol.NetworkCheckResult {
	return protocol.NetworkCheckResult{Kind: kind, Error: ptr(code)}
}

func (s *Station) inspectNetwork(ctx context.Context, m dispatch.Message) {
	var b protocol.NetworkInspectBody
	if !s.networkBody(m, &b) {
		return
	}
	if len(b.Checks) > 16 {
		s.replyError(m, protocolError(protocol.ErrorCodeProtocolLimit, "Send at most 16 checks per network.inspect.", "network.inspect carried %d checks", len(b.Checks)))
		return
	}
	ref := m.ID
	go func() {
		st := s.net.state.Load()
		results := make([]protocol.NetworkCheckResult, 0, len(b.Checks))
		for _, c := range b.Checks {
			results = append(results, s.runCheck(ctx, st, c))
		}
		s.send(protocol.MessageNetworkInspectResult, &ref, protocol.NetworkInspectResultBody{Results: results})
	}()
}

func verdictOf(v netns.Verdict) *protocol.NetworkVerdict {
	return &protocol.NetworkVerdict{Verdict: protocol.NetworkVerdictValue(v.Verdict), Path: protocol.NetworkPathId(v.Path), Rule: v.Rule}
}

func protoNumber(p *protocol.NetworkProtocol) uint8 {
	if p != nil && *p == protocol.NetworkProtocolUdp {
		return unix.IPPROTO_UDP
	}
	return unix.IPPROTO_TCP
}

func (t netTarget) verdict(st *netState, p netns.Packet) (netns.Verdict, error) {
	ns, err := netns.OpenChecked(t.pid, t.inode)
	if err != nil {
		return netns.Verdict{}, err
	}
	defer ns.Close()
	if t.sandbox {
		return ns.SandboxVerdict(t.baseline, st.pool, p, false)
	}
	return ns.Verdict(netns.Baseline{Resolver: t.resolver, Self: t.self, Subnet: t.subnet}, st.pool, p)
}

func (s *Station) runCheck(ctx context.Context, st *netState, c protocol.NetworkCheck) protocol.NetworkCheckResult {
	var t netTarget
	if c.Kind != protocol.NetworkCheckKindHostSwitch {
		key := c.ServiceId
		if key == nil {
			key = c.SandboxId
		}
		if key == nil {
			return checkError(c.Kind, checkInvalid)
		}
		var ok bool
		if t, ok = st.targets[*key]; !ok {
			return checkError(c.Kind, checkNotFound)
		}
	}
	switch c.Kind {
	case protocol.NetworkCheckKindVerdict:
		if c.Address == nil || c.Port == nil {
			return checkError(c.Kind, checkInvalid)
		}
		addr, err := netip.ParseAddr(*c.Address)
		if err != nil || !addr.Is4() {
			return checkError(c.Kind, checkInvalid)
		}
		v, err := t.verdict(st, netns.Packet{Addr: addr, Port: uint16(*c.Port), Proto: protoNumber(c.Protocol)})
		if errors.Is(err, netns.ErrRulesetMismatch) {
			return checkError(c.Kind, checkRuleset)
		}
		if err != nil {
			s.log.Warn("network.inspect verdict", "service", t.serviceID, "error", err)
			return checkError(c.Kind, checkFailed)
		}
		pv := verdictOf(v)
		return protocol.NetworkCheckResult{Kind: c.Kind, Verdict: &pv.Verdict, Path: &pv.Path, Rule: &pv.Rule}
	case protocol.NetworkCheckKindSwitch:
		if c.VirtualIp == nil {
			return checkError(c.Kind, checkInvalid)
		}
		vip, err := netip.ParseAddr(*c.VirtualIp)
		if err != nil {
			return checkError(c.Kind, checkInvalid)
		}
		ns, err := netns.OpenChecked(t.pid, t.inode)
		if err != nil {
			return checkError(c.Kind, checkFailed)
		}
		defer ns.Close()
		real, rejected, err := ns.SwitchEntry(vip)
		if err != nil {
			s.log.Warn("network.inspect switch", "service", t.serviceID, "error", err)
			return checkError(c.Kind, checkFailed)
		}
		r := protocol.NetworkCheckResult{Kind: c.Kind, Address: protocol.NetworkCheckResultAddress(nil)}
		if real.IsValid() {
			r.Address = protocol.NetworkCheckResultAddress(ptr(real.String()))
			return r
		}
		r.Rejected = ptr(rejected)
		return r
	case protocol.NetworkCheckKindHostSwitch:
		return s.hostSwitchCheck(ctx, st, c)
	case protocol.NetworkCheckKindListening:
		port := 0
		if c.Port != nil {
			port = *c.Port
		}
		proto := "tcp"
		if c.Protocol != nil {
			proto = string(*c.Protocol)
		}
		var socks []netns.Socket
		var err error
		if t.sandbox {
			socks, err = s.sandboxListening(ctx, t, uint16(port), proto)
		} else {
			socks, err = netns.Listening(t.pid, uint16(port), proto)
		}
		if err != nil {
			s.log.Warn("network.inspect listening", "target", t.serviceID, "error", err)
			return checkError(c.Kind, checkFailed)
		}
		return protocol.NetworkCheckResult{Kind: c.Kind, Sockets: listeningOf(socks)}
	case protocol.NetworkCheckKindContainer:
		r := protocol.NetworkCheckResult{Kind: c.Kind, State: ptr(t.state), Health: ptr(t.health)}
		if t.deploymentID != "" {
			r.DeploymentId = protocol.NetworkCheckResultDeploymentId(ptr(t.deploymentID))
		}
		if t.sandbox {
			r.Address = protocol.NetworkCheckResultAddress(ptr(t.ring.String()))
		} else if t.self.IsValid() {
			r.Address = protocol.NetworkCheckResultAddress(ptr(t.self.String()))
		}
		return r
	}
	return checkError(c.Kind, checkInvalid)
}

func listeningOf(socks []netns.Socket) []protocol.ListeningSocket {
	out := make([]protocol.ListeningSocket, 0, len(socks))
	for _, k := range socks {
		out = append(out, protocol.ListeningSocket{Address: k.Address.String(), Port: int(k.Port), Protocol: protocol.NetworkProtocol(k.Proto)})
	}
	return out
}

func (s *Station) hostSwitchCheck(ctx context.Context, st *netState, c protocol.NetworkCheck) protocol.NetworkCheckResult {
	r := protocol.NetworkCheckResult{Kind: c.Kind, Address: protocol.NetworkCheckResultAddress(nil), Port: protocol.NetworkCheckResultPort(nil), GatewayTarget: ptr(false)}
	switch {
	case c.VirtualIp != nil:
		vip, err := netip.ParseAddr(*c.VirtualIp)
		if err != nil {
			return checkError(c.Kind, checkInvalid)
		}
		real, err := netns.HostSwitch(vip)
		if err != nil {
			return checkError(c.Kind, checkFailed)
		}
		if real.IsValid() {
			r.Address = protocol.NetworkCheckResultAddress(ptr(real.String()))
		}
		if c.Port != nil {
			r.Port = protocol.NetworkCheckResultPort(ptr(*c.Port))
			if st.gateway != "" {
				v := s.inspectID(ctx, st.gateway, docker.IngressNetworkName)
				if v.state == string(container.StateRunning) && v.pid > 0 {
					if ns, err := netns.OpenChecked(v.pid, v.netns); err == nil {
						in, err := ns.GatewayTarget(netip.AddrPortFrom(vip, uint16(*c.Port)))
						ns.Close()
						if err == nil {
							r.GatewayTarget = ptr(in)
						}
					}
				}
			}
		}
		return r
	case c.HostPort != nil:
		ap, err := netns.HostPort(uint16(*c.HostPort))
		if err != nil {
			return checkError(c.Kind, checkFailed)
		}
		if ap.IsValid() {
			r.Address = protocol.NetworkCheckResultAddress(ptr(ap.Addr().String()))
			r.Port = protocol.NetworkCheckResultPort(ptr(int(ap.Port())))
		}
		return r
	}
	return checkError(c.Kind, checkInvalid)
}

func (h *netHub) claimProbe(id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.probing[id] || len(h.probing) >= probesPerStation {
		return false
	}
	h.probing[id] = true
	return true
}

func (h *netHub) releaseProbe(id string) {
	h.mu.Lock()
	delete(h.probing, id)
	h.mu.Unlock()
}

func millisSince(t time.Time) float64 {
	return float64(time.Since(t).Microseconds()) / 1000
}

func (s *Station) probeNetwork(ctx context.Context, m dispatch.Message) {
	var b protocol.NetworkProbeBody
	if !s.networkBody(m, &b) {
		return
	}
	key := b.ServiceId
	if key == nil {
		key = b.SandboxId
	}
	if key == nil {
		s.replyError(m, protocolError(protocol.ErrorCodeProtocolInvalidMessage, "Send service_id or sandbox_id with a probe.", "a probe needs a source"))
		return
	}
	st := s.net.state.Load()
	t, ok := st.targets[*key]
	if !ok {
		s.replyError(m, protocolError(protocol.ErrorCodeNotFound, "Start the service or sandbox, then probe again.", "%s has no running container on this station", *key))
		return
	}
	if b.Kind == protocol.ProbeKindTcp && b.Port == nil {
		s.replyError(m, protocolError(protocol.ErrorCodeProtocolInvalidMessage, "Send port with a tcp probe.", "a tcp probe needs a port"))
		return
	}
	if !s.net.claimProbe(*key) {
		s.replyError(m, protocolError(protocol.ErrorCodeProtocolLimit, "Wait for the running probe to finish.", "stationd runs one probe per source and %d per station at a time", probesPerStation))
		return
	}
	ref := m.ID
	go func() {
		defer s.net.releaseProbe(*key)
		timeout := time.Duration(min(max(b.TimeoutS, 1), 10)) * time.Second
		pctx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		res, err := s.runProbe(pctx, st, t, b)
		if err != nil {
			s.replyError(m, protocolError(protocol.ErrorCodeNamespaceSetupFailed, "Check the stationd log and retry.", "probe from %s: %v", *key, err))
			return
		}
		s.send(protocol.MessageNetworkProbeResult, &ref, res)
	}()
}

func (s *Station) runProbe(ctx context.Context, st *netState, t netTarget, b protocol.NetworkProbeBody) (protocol.NetworkProbeResultBody, error) {
	res := protocol.NetworkProbeResultBody{Kind: b.Kind, To: b.To, At: logstore.FormatTime(time.Now())}
	if t.sandbox {
		res.SandboxId = ptr(t.serviceID)
	} else {
		res.ServiceId = ptr(t.serviceID)
	}
	if t.deploymentID != "" {
		res.DeploymentId = protocol.NetworkProbeResultBodyDeploymentId(ptr(t.deploymentID))
	}
	if b.Port != nil {
		res.Port = protocol.NetworkProbeResultBodyPort(ptr(*b.Port))
	}
	ns, err := netns.OpenChecked(t.pid, t.inode)
	if err != nil {
		return res, err
	}
	defer ns.Close()
	base := netns.Baseline{Resolver: t.resolver, Self: t.self, Subnet: t.subnet}
	attach := func(p netns.Packet) {
		verdict := func() (netns.Verdict, error) {
			if t.sandbox {
				return ns.SandboxVerdict(t.baseline, st.pool, p, false)
			}
			return ns.Verdict(base, st.pool, p)
		}
		if v, err := verdict(); err == nil {
			res.Verdict = verdictOf(v)
		} else {
			s.log.Warn("probe verdict check", "service", t.serviceID, "error", err)
		}
	}
	if t.sandbox {
		err := s.probeSandbox(ctx, ns, t, b, &res, attach)
		return res, err
	}
	literal, litErr := netip.ParseAddr(b.To)
	if b.Kind == protocol.ProbeKindDns || litErr != nil || !literal.Is4() {
		d, answers, err := s.probeDNS(ctx, ns, t.resolver, b.To)
		if err != nil {
			return res, err
		}
		res.Dns = d
		if b.Kind == protocol.ProbeKindDns {
			attach(netns.Packet{Addr: t.resolver, Port: 53, Proto: unix.IPPROTO_UDP})
			return res, nil
		}
		if len(answers) == 0 {
			res.Tcp = &protocol.ProbeTcp{Address: protocol.ProbeTcpAddress(nil), Result: protocol.ProbeTcpResultNoAnswer, Ms: 0}
			return res, nil
		}
		literal = answers[0]
	}
	dst := netip.AddrPortFrom(literal, uint16(*b.Port))
	attach(netns.Packet{Addr: literal, Port: dst.Port(), Proto: unix.IPPROTO_TCP})
	conn, err := ns.ProbeSocket(false)
	if err != nil {
		return res, err
	}
	start := time.Now()
	cerr := conn.Connect(ctx, dst)
	ms := millisSince(start)
	conn.Close()
	result, err := probeTCPResult(ctx, cerr, res.Verdict)
	if err != nil {
		return res, err
	}
	res.Tcp = &protocol.ProbeTcp{Address: protocol.ProbeTcpAddress(ptr(literal.String())), Result: result, Ms: ms}
	return res, nil
}

func probeTCPResult(ctx context.Context, cerr error, v *protocol.NetworkVerdict) (protocol.ProbeTcpResult, error) {
	switch {
	case cerr == nil:
		return protocol.ProbeTcpResultConnected, nil
	case errors.Is(cerr, unix.ECONNREFUSED):
		if v != nil && v.Path == protocol.NetworkPathIdNoSwitchTarget {
			return protocol.ProbeTcpResultRejected, nil
		}
		return protocol.ProbeTcpResultRefused, nil
	case errors.Is(cerr, unix.EHOSTUNREACH), errors.Is(cerr, unix.ENETUNREACH):
		return protocol.ProbeTcpResultNoRoute, nil
	case errors.Is(cerr, context.DeadlineExceeded), errors.Is(cerr, unix.ETIMEDOUT), errors.Is(cerr, unix.EPERM), ctx.Err() != nil:
		return protocol.ProbeTcpResultTimeout, nil
	}
	return "", cerr
}

func (s *Station) probeDNS(ctx context.Context, ns *netns.Namespace, resolver netip.Addr, name string) (*protocol.ProbeDns, []netip.Addr, error) {
	out := &protocol.ProbeDns{Answers: []string{}}
	conn, err := ns.ProbeSocket(true)
	if err != nil {
		return nil, nil, err
	}
	defer conn.Close()
	start := time.Now()
	if err := conn.Connect(ctx, netip.AddrPortFrom(resolver, 53)); err != nil {
		return nil, nil, err
	}
	if local := conn.Local(); local.IsValid() {
		defer s.resolver.RegisterProbe(local)()
	}
	q := new(mdns.Msg)
	q.SetQuestion(mdns.Fqdn(name), mdns.TypeA)
	packed, err := q.Pack()
	if err != nil {
		return nil, nil, err
	}
	if _, err := conn.Write(ctx, packed); err != nil {
		return nil, nil, err
	}
	buf := make([]byte, 4096)
	n, err := conn.Read(ctx, buf)
	out.Ms = millisSince(start)
	if err != nil {
		if ctx.Err() != nil {
			out.Rcode = "TIMEOUT"
			return out, nil, nil
		}
		return nil, nil, err
	}
	r := new(mdns.Msg)
	if err := r.Unpack(buf[:n]); err != nil {
		return nil, nil, err
	}
	out.Rcode = mdns.RcodeToString[r.Rcode]
	var answers []netip.Addr
	for _, rr := range r.Answer {
		if a, ok := rr.(*mdns.A); ok {
			if addr, ok := netip.AddrFromSlice(a.A.To4()); ok {
				answers = append(answers, addr)
				out.Answers = append(out.Answers, addr.String())
			}
		}
	}
	return out, answers, nil
}

func (s *Station) dnsLog(m dispatch.Message) {
	var b protocol.DnsLogBody
	if !s.networkBody(m, &b) {
		return
	}
	ref := m.ID
	st := s.net.state.Load()
	entries := []protocol.DnsLogEntry{}
	key := b.ServiceId
	if b.SandboxId != nil {
		key = b.SandboxId
	}
	if key == nil {
		s.send(protocol.MessageDnsLogResult, &ref, protocol.DnsLogResultBody{Entries: entries})
		return
	}
	t, ok := st.targets[*key]
	if !ok {
		s.send(protocol.MessageDnsLogResult, &ref, protocol.DnsLogResultBody{Entries: entries})
		return
	}
	tail := dnsLogDefault
	if b.Tail != nil {
		tail = min(max(*b.Tail, 1), dnsLogMax)
	}
	var dep protocol.DnsLogEntryDeploymentId
	if t.deploymentID != "" {
		dep = protocol.DnsLogEntryDeploymentId(ptr(t.deploymentID))
	}
	ring := t.self
	if t.ring.IsValid() {
		ring = t.ring
	}
	for _, q := range s.resolver.Queries(ring) {
		if len(entries) == tail {
			break
		}
		if b.Name != nil && !strings.Contains(strings.ToLower(q.Name), strings.ToLower(*b.Name)) {
			continue
		}
		if b.Rcode != nil && !strings.EqualFold(q.Rcode, *b.Rcode) {
			continue
		}
		answers := make([]string, 0, len(q.Answers))
		for _, a := range q.Answers {
			answers = append(answers, a.String())
		}
		e := protocol.DnsLogEntry{At: logstore.FormatTime(q.At), DeploymentId: dep, Name: q.Name, Type: q.Type, Rcode: q.Rcode, Answers: answers, Upstream: q.Upstream, Ms: q.MS, Probe: q.Probe}
		if q.Refused != "" {
			r := ptr(protocol.DnsRefusal(q.Refused))
			e.Refused = &r
		}
		entries = append(entries, e)
	}
	s.send(protocol.MessageDnsLogResult, &ref, protocol.DnsLogResultBody{Entries: entries})
}
