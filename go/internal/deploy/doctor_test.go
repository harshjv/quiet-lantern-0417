//go:build linux

package deploy

import (
	"errors"
	"strings"
	"testing"

	"github.com/harshjv/stationly/go/internal/netns"
	"github.com/harshjv/stationly/go/internal/protocol"
)

func TestMarkAcceptRowStatuses(t *testing.T) {
	cases := []struct {
		name   string
		state  netns.MarkAcceptState
		err    error
		status protocol.DoctorStatus
		code   string
	}{
		{"present", netns.MarkAcceptPresent, nil, protocol.DoctorStatusOk, ""},
		{"rule absent", netns.MarkAcceptAbsent, nil, protocol.DoctorStatusFail, "mark_accept_missing"},
		{"chain missing", netns.MarkAcceptChainMissing, nil, protocol.DoctorStatusFail, "docker_user_chain_missing"},
		{"iptables unreadable", netns.MarkAcceptChainMissing, errors.New("exec: iptables not found"), protocol.DoctorStatusFail, "mark_accept_unchecked"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			check := newCheck("mark_accept")
			raiseMarkAccept(check, c.state, c.err)
			got := check.build()
			code := ""
			if got.Code != nil {
				code = *got.Code
			}
			if got.Status != c.status || code != c.code {
				t.Fatalf("%s %s: %s", got.Status, code, got.Finding)
			}
			if c.status != protocol.DoctorStatusOk && (got.Fix == nil || *got.Fix == "") {
				t.Fatal("a failing row carries a fix")
			}
		})
	}
}

func TestMarkAcceptFixNamesTheExactRuleToInsert(t *testing.T) {
	check := newCheck("mark_accept")
	raiseMarkAccept(check, netns.MarkAcceptAbsent, nil)
	got := check.build()
	want := "iptables -I DOCKER-USER 1 " + strings.Join(netns.MarkAcceptRule(), " ")
	if got.Fix == nil || !strings.Contains(*got.Fix, want) {
		t.Fatalf("fix %v lacks %q", got.Fix, want)
	}
}
