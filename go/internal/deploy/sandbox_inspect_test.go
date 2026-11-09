//go:build linux

package deploy

import (
	"net/netip"
	"testing"

	"github.com/harshjv/stationly/go/internal/protocol"
)

func TestSandboxProbeBlockedAnswersAsTheSandboxWouldSeeTheVerdict(t *testing.T) {
	addr := netip.MustParseAddr("93.184.216.34")
	cases := []struct {
		name    string
		verdict *protocol.NetworkVerdict
		want    protocol.ProbeTcpResult
	}{
		{"accept sends the handshake", &protocol.NetworkVerdict{Verdict: protocol.NetworkVerdictValueAccept, Path: protocol.NetworkPathIdPublicInternet}, ""},
		{"no verdict sends the handshake", nil, ""},
		{"drop times out", &protocol.NetworkVerdict{Verdict: protocol.NetworkVerdictValueDrop, Path: protocol.NetworkPathIdPrivateRange}, protocol.ProbeTcpResultTimeout},
		{"allowlist reject is refused", &protocol.NetworkVerdict{Verdict: protocol.NetworkVerdictValueReject, Path: protocol.NetworkPathIdDomainNotAllowed}, protocol.ProbeTcpResultRefused},
		{"switch reject is rejected", &protocol.NetworkVerdict{Verdict: protocol.NetworkVerdictValueReject, Path: protocol.NetworkPathIdNoSwitchTarget}, protocol.ProbeTcpResultRejected},
	}
	for _, c := range cases {
		got := sandboxProbeBlocked(c.verdict, addr)
		switch {
		case c.want == "" && got != nil:
			t.Errorf("%s: got %+v", c.name, got)
		case c.want != "" && (got == nil || got.Result != c.want):
			t.Errorf("%s: got %+v want %s", c.name, got, c.want)
		}
	}
}
