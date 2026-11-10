package secrets

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/harshjv/stationly/go/internal/protocol"
)

const vectorsDir = "../../../packages/protocol/testdata"

type redactionVectors struct {
	Encodings []struct {
		Value string   `json:"value"`
		Forms []string `json:"forms"`
	} `json:"encodings"`
	Cases []struct {
		Name   string  `json:"name"`
		Known  []Known `json:"known"`
		Input  string  `json:"input"`
		Output string  `json:"output"`
	} `json:"cases"`
}

type digestVectors struct {
	Cases []struct {
		Name   string              `json:"name"`
		Env    []protocol.EnvEntry `json:"env"`
		Digest string              `json:"digest"`
	} `json:"cases"`
}

func loadVectors(t *testing.T, name string, into any) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(vectorsDir, name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, into); err != nil {
		t.Fatal(err)
	}
}

func TestRedactionVectors(t *testing.T) {
	var v redactionVectors
	loadVectors(t, "redaction-vectors.json", &v)
	for _, e := range v.Encodings {
		if got := encodedForms(e.Value); !slices.Equal(got, e.Forms) {
			t.Errorf("forms of %q = %q, want %q", e.Value, got, e.Forms)
		}
	}
	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			if got := NewRedactor(c.Known).Redact(c.Input); got != c.Output {
				t.Errorf("Redact(%q) = %q, want %q", c.Input, got, c.Output)
			}
		})
	}
}

func TestEnvDigestVectors(t *testing.T) {
	var v digestVectors
	loadVectors(t, "env-digest-vectors.json", &v)
	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			got, err := Digest(c.Env)
			if err != nil {
				t.Fatal(err)
			}
			if got != c.Digest {
				t.Errorf("Digest = %s, want %s", got, c.Digest)
			}
		})
	}
}
