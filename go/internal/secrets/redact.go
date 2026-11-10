package secrets

import (
	"encoding/base64"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/harshjv/stationly/go/internal/protocol"
)

var (
	excluded      = regexp.MustCompile(protocol.RedactExcludedPattern)
	tokenPatterns = regexp.MustCompile(protocol.RedactTokenPattern)
	base64Of      = map[protocol.Base64Encoding]*base64.Encoding{
		protocol.Base64EncodingBase64:    base64.RawStdEncoding,
		protocol.Base64EncodingBase64url: base64.RawURLEncoding,
	}
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
	return utf8.RuneCountInString(value) >= protocol.RedactMinLength && !excluded.MatchString(value)
}

func urlEncode(b []byte, enc protocol.URLEncoding) string {
	var out strings.Builder
	for _, c := range b {
		switch {
		case c == ' ':
			out.WriteString(enc.Space)
		case c < utf8.RuneSelf && strings.IndexByte(enc.Unescaped, c) >= 0:
			out.WriteByte(c)
		default:
			fmt.Fprintf(&out, "%%%02X", c)
		}
	}
	return out.String()
}

func encodedForms(value string) []string {
	b := []byte(value)
	out := []string{value}
	for _, enc := range protocol.RedactBase64Encodings {
		out = append(out, base64Of[enc].EncodeToString(b))
	}
	for _, enc := range protocol.RedactURLEncodings {
		out = append(out, urlEncode(b, enc))
	}
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
		candidates := encodedForms(k.Value)
		for _, line := range strings.Split(k.Value, "\n") {
			if line = strings.TrimSuffix(line, "\r"); line != k.Value && Redactable(line) {
				candidates = append(candidates, line)
			}
		}
		for _, f := range candidates {
			if f == "" || seen[f] {
				continue
			}
			seen[f] = true
			pairs = append(pairs, pair{f, protocol.RedactKeyedReplacementPrefix + k.Key + protocol.RedactKeyedReplacementSuffix})
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
	return tokenPatterns.ReplaceAllLiteralString(s, protocol.RedactTokenReplacement)
}

func (r *Redactor) Lines(lines []string) []string {
	return strings.Split(r.Redact(strings.Join(lines, "\n")), "\n")
}
