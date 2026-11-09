package dns

import (
	"fmt"
	"net/netip"
	"slices"
	"strings"
	"time"
)

const (
	MaxAllowDomains  = 256
	MaxAllowPorts    = 8
	DefaultAllowPort = 443
	wildcardDepth    = 3
	allowFloor       = 300
	allowCap         = 3600
	maxNameLength    = 253
	maxLabelLength   = 63
)

var privateRanges = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("224.0.0.0/4"),
	netip.MustParsePrefix("240.0.0.0/4"),
}

type AllowDomain struct {
	Domain   string
	Wildcard bool
	Ports    []uint16
}

type DomainError struct {
	Index  int
	Reason string
}

func (e *DomainError) Error() string {
	return fmt.Sprintf("domain %d: %s", e.Index, e.Reason)
}

func ParseDomains(in []AllowDomain) ([]AllowDomain, error) {
	if len(in) > MaxAllowDomains {
		return nil, &DomainError{Index: MaxAllowDomains, Reason: fmt.Sprintf("more than %d entries", MaxAllowDomains)}
	}
	out := make([]AllowDomain, 0, len(in))
	distinct := map[uint16]bool{}
	for i, d := range in {
		name := strings.TrimSuffix(strings.ToLower(d.Domain), ".")
		if reason := checkName(name); reason != "" {
			return nil, &DomainError{Index: i, Reason: reason}
		}
		ports := d.Ports
		if len(ports) == 0 {
			ports = []uint16{DefaultAllowPort}
		}
		var uniq []uint16
		for _, p := range ports {
			if p == 0 {
				return nil, &DomainError{Index: i, Reason: "port 0 is not a port"}
			}
			if !slices.Contains(uniq, p) {
				uniq = append(uniq, p)
			}
			distinct[p] = true
		}
		if len(distinct) > MaxAllowPorts {
			return nil, &DomainError{Index: i, Reason: fmt.Sprintf("more than %d distinct ports", MaxAllowPorts)}
		}
		slices.Sort(uniq)
		out = append(out, AllowDomain{Domain: name, Wildcard: d.Wildcard, Ports: uniq})
	}
	return out, nil
}

func checkName(name string) string {
	if name == "" {
		return "empty domain"
	}
	if len(name) > maxNameLength {
		return fmt.Sprintf("longer than %d characters", maxNameLength)
	}
	labels := strings.Split(name, ".")
	if len(labels) < 2 {
		return "needs at least two labels"
	}
	for _, l := range labels {
		if l == "" || len(l) > maxLabelLength {
			return fmt.Sprintf("label %q must be 1 to %d characters", l, maxLabelLength)
		}
		if l[0] == '-' || l[len(l)-1] == '-' {
			return fmt.Sprintf("label %q starts or ends with a hyphen", l)
		}
		for _, c := range l {
			if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '-' {
				return fmt.Sprintf("label %q has a character other than a-z, 0-9 and hyphen", l)
			}
		}
	}
	return ""
}

func Match(domains []AllowDomain, name string) (AllowDomain, bool) {
	name = strings.TrimSuffix(strings.ToLower(name), ".")
	for _, d := range domains {
		if d.Domain == name {
			return d, true
		}
	}
	for _, d := range domains {
		if !d.Wildcard {
			continue
		}
		prefix, ok := strings.CutSuffix(name, "."+d.Domain)
		if !ok || prefix == "" {
			continue
		}
		if strings.Count(prefix, ".")+1 <= wildcardDepth {
			return d, true
		}
	}
	return AllowDomain{}, false
}

func AllowTimeout(ttl uint32) time.Duration {
	return time.Duration(max(allowFloor, min(ttl, allowCap))) * time.Second
}

func rebind(a netip.Addr, blocked []netip.Prefix) bool {
	a = a.Unmap()
	if !a.IsValid() || !a.Is4() {
		return true
	}
	for _, p := range privateRanges {
		if p.Contains(a) {
			return true
		}
	}
	for _, p := range blocked {
		if p.Contains(a) {
			return true
		}
	}
	return false
}
