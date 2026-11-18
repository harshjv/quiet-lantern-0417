//go:build linux

package deploy

import (
	"encoding/base64"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"sync"
	"time"

	"github.com/harshjv/stationly/go/internal/protocol"
)

var placeholderShape = regexp.MustCompile(`^` + protocol.CredentialPlaceholderPattern + `$`)

type relayCredential struct {
	run     string
	key     string
	value   string
	hosts   []string
	expires time.Time
}

func (c relayCredential) live(now time.Time) bool {
	return c.expires.IsZero() || now.Before(c.expires)
}

type credentialUse struct {
	used, misdirected int
}

type relayCredentials struct {
	mu   sync.Mutex
	held map[string]map[string]relayCredential
	uses map[string]map[string]credentialUse
}

func (c *relayCredentials) count(sandbox, placeholder string, misdirected bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.uses == nil {
		c.uses = map[string]map[string]credentialUse{}
	}
	if c.uses[sandbox] == nil {
		c.uses[sandbox] = map[string]credentialUse{}
	}
	u := c.uses[sandbox][placeholder]
	if misdirected {
		u.misdirected++
	} else {
		u.used++
	}
	c.uses[sandbox][placeholder] = u
}

func (c *relayCredentials) drainUses() []protocol.CredentialUse {
	c.mu.Lock()
	uses := c.uses
	c.uses = nil
	c.mu.Unlock()
	var out []protocol.CredentialUse
	for _, sandbox := range slices.Sorted(maps.Keys(uses)) {
		for _, placeholder := range slices.Sorted(maps.Keys(uses[sandbox])) {
			u := uses[sandbox][placeholder]
			out = append(out, protocol.CredentialUse{SandboxId: sandbox, Placeholder: placeholder, Used: u.used, Misdirected: u.misdirected})
		}
	}
	return out
}

func (c *relayCredentials) hold(sandbox, run string, held map[string]relayCredential) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.dropLocked(sandbox, func(cred relayCredential) bool { return cred.run == run })
	if len(held) == 0 {
		return
	}
	if c.held == nil {
		c.held = map[string]map[string]relayCredential{}
	}
	if c.held[sandbox] == nil {
		c.held[sandbox] = map[string]relayCredential{}
	}
	for placeholder, cred := range held {
		cred.run = run
		c.held[sandbox][placeholder] = cred
	}
}

func (c *relayCredentials) dropRun(sandbox, run string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.dropLocked(sandbox, func(cred relayCredential) bool { return cred.run == run })
}

func (c *relayCredentials) dropRuns(sandbox string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.dropLocked(sandbox, func(cred relayCredential) bool { return cred.run != "" })
}

func (c *relayCredentials) dropSandbox(sandbox string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.held, sandbox)
}

func (c *relayCredentials) dropLocked(sandbox string, match func(relayCredential) bool) {
	for placeholder, cred := range c.held[sandbox] {
		if match(cred) {
			delete(c.held[sandbox], placeholder)
		}
	}
	if len(c.held[sandbox]) == 0 {
		delete(c.held, sandbox)
	}
}

func (c *relayCredentials) holds(sandbox, run string, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, cred := range c.held[sandbox] {
		if cred.run == run && cred.live(now) {
			return true
		}
	}
	return false
}

func (c *relayCredentials) lookup(sandbox, placeholder string, now time.Time) (relayCredential, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	cred, ok := c.held[sandbox][placeholder]
	if !ok {
		return relayCredential{}, false
	}
	if !cred.live(now) {
		c.dropLocked(sandbox, func(other relayCredential) bool { return !other.live(now) })
		return relayCredential{}, false
	}
	return cred, true
}

func (c relayCredential) boundTo(host string) bool {
	return slices.Contains(c.hosts, host)
}

func placeholdersOf(values []protocol.SecretValue) (map[string]relayCredential, time.Time, error) {
	held := map[string]relayCredential{}
	var until time.Time
	for _, v := range values {
		if v.Placeholder == nil {
			continue
		}
		value, err := base64.RawURLEncoding.DecodeString(v.Value)
		if err != nil {
			return nil, time.Time{}, fmt.Errorf("value of %s is not base64url: %w", v.Key, err)
		}
		expires := parseStamp(v.ExpiresAt)
		held[*v.Placeholder] = relayCredential{key: v.Key, value: string(value), hosts: v.Hosts, expires: expires}
		if expires.After(until) {
			until = expires
		}
	}
	return held, until, nil
}

func (s *Station) holdRunCredentials(rr *runRecord, body protocol.SecretsDeliverBody) {
	held, until, err := placeholdersOf(body.Values)
	if err != nil {
		s.log.Warn("run credentials refused", "run", rr.ID, "error", err)
		return
	}
	if len(held) == 0 {
		return
	}
	s.relayCreds.hold(rr.SandboxID, rr.ID, held)
	rr.CredentialsDigest, rr.CredentialsUntil = body.EnvDigest, stamp(until)
	s.log.Info("run credentials held for the API relay and the credentials proxy", "run", rr.ID, "sandbox", rr.SandboxID, "credentials", len(held), "until", deref(rr.CredentialsUntil))
}

func (s *Station) releaseRunCredentials(rr *runRecord) {
	s.relayCreds.dropRun(rr.SandboxID, rr.ID)
	if rr.CredentialsUntil == nil && rr.CredentialsDigest == "" {
		return
	}
	rr.CredentialsDigest, rr.CredentialsUntil = "", nil
	s.saveRun(rr)
}

func (s *Station) releaseSandboxCredentials(sandboxID string) {
	s.relayCreds.dropRuns(sandboxID)
	for _, rr := range s.runs {
		if rr.SandboxID == sandboxID {
			s.releaseRunCredentials(rr)
		}
	}
}

func (s *Station) requestRunCredentials() {
	now := time.Now()
	for _, rr := range s.orderedRuns() {
		if rr.SandboxID == "" || rr.CredentialsUntil == nil || s.sbx.states[rr.SandboxID] == nil {
			continue
		}
		if !parseStamp(rr.CredentialsUntil).After(now) {
			s.releaseRunCredentials(rr)
			continue
		}
		if s.relayCreds.holds(rr.SandboxID, rr.ID, now) {
			continue
		}
		id := rr.ID
		s.send(protocol.MessageSecretsRequest, nil, protocol.SecretsRequestBody{Target: protocol.SecretTarget{RunId: &id}, EnvDigest: rr.CredentialsDigest, Purpose: protocol.SecretPurposeRun})
		s.log.Warn("secrets.request: stationd holds no credentials for this run; waiting for Dispatch to deliver them again", "run", rr.ID, "sandbox", rr.SandboxID)
	}
}
