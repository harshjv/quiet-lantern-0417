package netns

import (
	"net/netip"
	"testing"
)

func TestPublicIPv4(t *testing.T) {
	cases := map[string]bool{
		"8.8.8.8":         true,
		"93.184.216.34":   true,
		"10.0.0.5":        false,
		"172.16.0.1":      false,
		"192.168.1.10":    false,
		"100.64.0.1":      false,
		"127.0.0.1":       false,
		"169.254.1.1":     false,
		"0.0.0.0":         false,
		"198.51.100.10":   false,
		"203.0.113.9":     false,
		"192.0.2.1":       false,
		"198.18.0.1":      false,
		"224.0.0.1":       false,
		"255.255.255.255": false,
		"2001:db8::1":     false,
	}
	for in, want := range cases {
		if got := PublicIPv4(netip.MustParseAddr(in)); got != want {
			t.Errorf("PublicIPv4(%s) = %v, want %v", in, got, want)
		}
	}
}
