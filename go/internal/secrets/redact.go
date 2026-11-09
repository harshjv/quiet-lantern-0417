package secrets

import (
	"encoding/base64"
	"net/url"
	"regexp"
	"sort"
	"strings"
)

const minRedactLength = 8

var (
	digitsOnly    = regexp.MustCompile(`^[0-9]+$`)
	tokenPatterns = regexp.MustCompile(`sly_[A-Za-z0-9_-]{8,}|sly-rk-[A-Za-z2-7]{8,}`)
)

type Known struct {
	Key   string
	Value string
}

type Redactor struct {
	replacer *strings.Replacer
	patterns int
}

func Redactable(value string) bool {
	return len(value) >= minRedactLength && !digitsOnly.MatchString(value)
}

func forms(value string) []string {
	b := []byte(value)
	out := []string{value}
	for _, enc := range []*base64.Encoding{base64.RawStdEncoding, base64.RawURLEncoding} {
		out = append(out, enc.EncodeToString(b))
	}
	out = append(out, url.QueryEscape(value), url.PathEscape(value))
	return out
}

func NewRedactor(known []Known) *Redactor {
	type pair struct{ from, to string }
	seen := map[string]bool{}
	var pairs []pair
	for _, k := range known {
		if !Redactable(k.Value) {
			continue
		}
		candidates := forms(k.Value)
		for _, line := range strings.Split(k.Value, "\n") {
			if line = strings.TrimRight(line, "\r"); line != k.Value && Redactable(line) {
				candidates = append(candidates, line)
			}
		}
		for _, f := range candidates {
			if f == "" || seen[f] {
				continue
			}
			seen[f] = true
			pairs = append(pairs, pair{f, "[redacted:" + k.Key + "]"})
		}
	}
	sort.SliceStable(pairs, func(i, j int) bool { return len(pairs[i].from) > len(pairs[j].from) })
	args := make([]string, 0, 2*len(pairs))
	for _, p := range pairs {
		args = append(args, p.from, p.to)
	}
	return &Redactor{replacer: strings.NewReplacer(args...), patterns: len(pairs)}
}

func (r *Redactor) Patterns() int {
	if r == nil {
		return 0
	}
	return r.patterns
}

func (r *Redactor) Redact(s string) string {
	if r != nil && r.patterns > 0 {
		s = r.replacer.Replace(s)
	}
	return tokenPatterns.ReplaceAllString(s, "[redacted]")
}

func (r *Redactor) Lines(lines []string) []string {
	return strings.Split(r.Redact(strings.Join(lines, "\n")), "\n")
}
