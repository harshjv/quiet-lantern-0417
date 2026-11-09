package gateway

import (
	"encoding/json"
	"regexp"
	"strings"
	"time"
)

const (
	acmeErrorNamespace     = "urn:ietf:params:acme:error:"
	ACMERateLimited        = acmeErrorNamespace + "rateLimited"
	ACMERejectedIdentifier = acmeErrorNamespace + "rejectedIdentifier"
	ACMECAA                = acmeErrorNamespace + "caa"
	maxACMEErrorText       = 1000
)

type ACMEFailure struct {
	Hostnames  []string  `json:"hostnames"`
	Type       string    `json:"type"`
	Detail     string    `json:"detail"`
	RetryAfter time.Time `json:"retry_after"`
	Text       string    `json:"text"`
}

type traefikLine struct {
	Level   string   `json:"level"`
	Message string   `json:"message"`
	Error   string   `json:"error"`
	Domains []string `json:"domains"`
}

var (
	renewDomain = regexp.MustCompile(`^Error renewing ACME certificate: \{(?:Main:)?([^ }]+)`)
	acmeType    = regexp.MustCompile(`urn:ietf:params:acme:error:[A-Za-z]+`)
	retryAfter  = regexp.MustCompile(`retry after (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) UTC`)
)

func ParseACMEFailure(text string) (ACMEFailure, bool) {
	var l traefikLine
	if !strings.HasPrefix(strings.TrimSpace(text), "{") || json.Unmarshal([]byte(text), &l) != nil || l.Level != "error" {
		return ACMEFailure{}, false
	}
	var hosts []string
	switch {
	case strings.HasPrefix(l.Message, "Unable to obtain ACME certificate for domain"):
		hosts = l.Domains
	case strings.HasPrefix(l.Message, "Error renewing ACME certificate: "):
		if m := renewDomain.FindStringSubmatch(l.Message); m != nil {
			hosts = []string{m[1]}
		}
	}
	if len(hosts) == 0 {
		return ACMEFailure{}, false
	}
	f := ACMEFailure{Hostnames: make([]string, 0, len(hosts)), Text: truncate(l.Error, maxACMEErrorText)}
	for _, h := range hosts {
		f.Hostnames = append(f.Hostnames, strings.ToLower(h))
	}
	if types := acmeType.FindAllString(l.Error, -1); len(types) > 0 {
		f.Type = types[len(types)-1]
		for _, t := range types {
			if t == ACMERateLimited {
				f.Type = t
			}
		}
		if i := strings.LastIndex(l.Error, f.Type+" :: "); i >= 0 {
			f.Detail = truncate(strings.TrimSpace(l.Error[i+len(f.Type)+4:]), maxACMEErrorText)
		}
	}
	if m := retryAfter.FindStringSubmatch(l.Error); m != nil {
		if t, err := time.Parse(time.DateTime, m[1]); err == nil {
			f.RetryAfter = t.UTC()
		}
	}
	return f, true
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
