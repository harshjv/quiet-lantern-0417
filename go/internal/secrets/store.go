package secrets

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"sync"
	"time"

	"github.com/gowebpki/jcs"
	"github.com/harshjv/stationly/go/internal/protocol"
)

type Entry struct {
	Key       string
	Injection protocol.Injection
	Value     []byte
}

type Set struct {
	DeploymentID string
	Digest       string
	Entries      []Entry
	Redactor     *Redactor
	DeliveredAt  time.Time
	Purpose      protocol.SecretPurpose
}

func (s *Set) Env() []string {
	var out []string
	for _, e := range s.Entries {
		if e.Injection == protocol.InjectionEnv {
			out = append(out, e.Key+"="+string(e.Value))
		}
	}
	return out
}

func (s *Set) Files() []Entry {
	var out []Entry
	for _, e := range s.Entries {
		if e.Injection == protocol.InjectionFile {
			out = append(out, e)
		}
	}
	return out
}

type Store struct {
	mu   sync.Mutex
	sets map[string]*Set
}

func NewStore() *Store {
	return &Store{sets: map[string]*Set{}}
}

func (s *Store) Get(deploymentID string) *Set {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sets[deploymentID]
}

func (s *Store) Put(set *Set) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sets[set.DeploymentID] = set
}

func (s *Store) Drop(deploymentID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.sets[deploymentID]
	delete(s.sets, deploymentID)
	return ok
}

type Held struct {
	DeploymentID string   `json:"deployment_id"`
	EnvDigest    string   `json:"env_digest"`
	Keys         []string `json:"keys"`
	FileKeys     []string `json:"file_keys"`
	Redacting    int      `json:"redaction_patterns"`
	DeliveredAt  string   `json:"delivered_at"`
}

func (s *Store) Held() []Held {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []Held{}
	for id, set := range s.sets {
		h := Held{DeploymentID: id, EnvDigest: set.Digest, Keys: []string{}, FileKeys: []string{}, Redacting: set.Redactor.Patterns(), DeliveredAt: set.DeliveredAt.UTC().Format(time.RFC3339Nano)}
		for _, e := range set.Entries {
			if e.Injection == protocol.InjectionFile {
				h.FileKeys = append(h.FileKeys, e.Key)
			} else {
				h.Keys = append(h.Keys, e.Key)
			}
		}
		out = append(out, h)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].DeploymentID < out[j].DeploymentID })
	return out
}

func (s *Store) Live(keep func(deploymentID string) bool) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var dropped []string
	for id := range s.sets {
		if !keep(id) {
			delete(s.sets, id)
			dropped = append(dropped, id)
		}
	}
	return dropped
}

func NeedsValues(spec protocol.ContainerSpec) bool {
	return slices.ContainsFunc(spec.Env, func(e protocol.EnvEntry) bool { return !e.Platform })
}

func HasFiles(spec protocol.ContainerSpec) bool {
	return slices.ContainsFunc(spec.Env, func(e protocol.EnvEntry) bool { return !e.Platform && e.Injection == protocol.InjectionFile })
}

func Digest(env []protocol.EnvEntry) (string, error) {
	stripped := make([]protocol.EnvEntry, len(env))
	for i, e := range env {
		e.Value = nil
		if e.Refs == nil {
			e.Refs = []protocol.EnvRef{}
		}
		stripped[i] = e
	}
	raw, err := json.Marshal(stripped)
	if err != nil {
		return "", err
	}
	canonical, err := jcs.Transform(raw)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(canonical)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

func mismatch(format string, args ...any) *protocol.ErrorBody {
	return &protocol.ErrorBody{
		Code:        string(protocol.ErrorCodeSecretsMismatch),
		Explanation: fmt.Sprintf(format, args...),
		Fix:         "Dispatch resends secrets.deliver built from the same env_snapshot as the generation; the deployment waits until a matching delivery arrives.",
	}
}

func Verify(deploymentID string, spec protocol.ContainerSpec, body protocol.SecretsDeliverBody, now time.Time) (*Set, *protocol.ErrorBody) {
	specDigest, err := Digest(spec.Env)
	if err != nil {
		return nil, mismatch("compute env_digest of the generation: %v", err)
	}
	if specDigest != spec.EnvDigest {
		return nil, mismatch("the generation's env_digest %s does not match its env entries (%s)", spec.EnvDigest, specDigest)
	}
	if body.EnvDigest != spec.EnvDigest {
		return nil, mismatch("delivery env_digest %s differs from the generation's %s", body.EnvDigest, spec.EnvDigest)
	}
	byKey := map[string]protocol.SecretValue{}
	for _, v := range body.Values {
		if _, dup := byKey[v.Key]; dup {
			return nil, mismatch("delivery lists %s twice", v.Key)
		}
		byKey[v.Key] = v
	}
	rebuilt := make([]protocol.EnvEntry, 0, len(spec.Env))
	set := &Set{DeploymentID: deploymentID, Digest: spec.EnvDigest, DeliveredAt: now, Purpose: body.Purpose}
	var known []Known
	for _, e := range spec.Env {
		if e.Platform {
			rebuilt = append(rebuilt, e)
			continue
		}
		v, ok := byKey[e.Key]
		if !ok {
			return nil, mismatch("delivery has no value for %s", e.Key)
		}
		delete(byKey, e.Key)
		value, err := base64.RawURLEncoding.DecodeString(v.Value)
		if err != nil {
			return nil, mismatch("value of %s is not base64url: %v", e.Key, err)
		}
		rebuilt = append(rebuilt, protocol.EnvEntry{Key: v.Key, Injection: v.Injection, Refs: v.Refs, Platform: false})
		set.Entries = append(set.Entries, Entry{Key: v.Key, Injection: v.Injection, Value: value})
	}
	if len(byKey) > 0 {
		extra := make([]string, 0, len(byKey))
		for k := range byKey {
			extra = append(extra, k)
		}
		sort.Strings(extra)
		return nil, mismatch("delivery carries keys the generation does not list: %v", extra)
	}
	got, err := Digest(rebuilt)
	if err != nil {
		return nil, mismatch("compute env_digest of the delivery: %v", err)
	}
	if got != spec.EnvDigest {
		return nil, mismatch("the delivered keys, injections and refs hash to %s, the generation says %s", got, spec.EnvDigest)
	}
	for _, r := range body.Redaction {
		value, err := base64.RawURLEncoding.DecodeString(r.Value)
		if err != nil {
			return nil, mismatch("redaction value for %s is not base64url: %v", r.Key, err)
		}
		known = append(known, Known{Key: r.Key, Value: string(value)})
	}
	set.Redactor = NewRedactor(known)
	return set, nil
}
