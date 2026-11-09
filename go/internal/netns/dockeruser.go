//go:build linux

package netns

import (
	"fmt"

	"github.com/coreos/go-iptables/iptables"
)

const DockerUserChain = "DOCKER-USER"

func MarkAcceptRule() []string {
	return []string{"-m", "mark", "--mark", fmt.Sprintf("%#x/%#x", AcceptMark, AcceptMark), "-m", "comment", "--comment", "stationly translated flows", "-j", "ACCEPT"}
}

func EnsureMarkAccept() (bool, error) {
	ipt, err := iptables.New()
	if err != nil {
		return false, err
	}
	ok, err := ipt.ChainExists("filter", DockerUserChain)
	if err != nil || !ok {
		return false, err
	}
	present, err := ipt.Exists("filter", DockerUserChain, MarkAcceptRule()...)
	if err != nil || present {
		return false, err
	}
	return true, ipt.Insert("filter", DockerUserChain, 1, MarkAcceptRule()...)
}

type MarkAcceptState int

const (
	MarkAcceptChainMissing MarkAcceptState = iota
	MarkAcceptAbsent
	MarkAcceptPresent
)

func MarkAcceptStatus() (MarkAcceptState, error) {
	ipt, err := iptables.New()
	if err != nil {
		return MarkAcceptChainMissing, err
	}
	ok, err := ipt.ChainExists("filter", DockerUserChain)
	if err != nil || !ok {
		return MarkAcceptChainMissing, err
	}
	present, err := ipt.Exists("filter", DockerUserChain, MarkAcceptRule()...)
	if err != nil {
		return MarkAcceptAbsent, err
	}
	if present {
		return MarkAcceptPresent, nil
	}
	return MarkAcceptAbsent, nil
}
