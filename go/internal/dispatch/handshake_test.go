package dispatch

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

var updateVectors = flag.Bool("update-vectors", false, "regenerate packages/protocol/testdata/handshake-vectors.go.json")

const vectorsDir = "../../../packages/protocol/testdata"

type signedVector struct {
	Message   string `json:"message"`
	Signature string `json:"signature"`
}

type vectors struct {
	Seed        string       `json:"seed"`
	Nonce       string       `json:"nonce"`
	StationID   string       `json:"station_id"`
	Token       string       `json:"token"`
	TimestampMs uint64       `json:"timestamp_ms"`
	Hello       signedVector `json:"hello"`
	Enroll      signedVector `json:"enroll"`
}

func sequence(start byte) []byte {
	b := make([]byte, 32)
	for i := range b {
		b[i] = start + byte(i)
	}
	return b
}

func buildVectors(t *testing.T) vectors {
	t.Helper()
	b64 := base64.RawURLEncoding
	seed, nonce := sequence(0), sequence(0x40)
	v := vectors{Seed: b64.EncodeToString(seed), Nonce: b64.EncodeToString(nonce), StationID: "stn_01JC7ZABCDEFGHJKMNPQRSTVWX", Token: "stationly-vector-token", TimestampMs: 1793528102317}
	key := ed25519.NewKeyFromSeed(seed)
	hello, err := HelloMessage(nonce, v.StationID, v.TimestampMs)
	if err != nil {
		t.Fatal(err)
	}
	enroll, err := EnrollMessage(nonce, v.Token, v.TimestampMs)
	if err != nil {
		t.Fatal(err)
	}
	v.Hello = signedVector{hex.EncodeToString(hello), b64.EncodeToString(sign(key, hello))}
	v.Enroll = signedVector{hex.EncodeToString(enroll), b64.EncodeToString(sign(key, enroll))}
	return v
}

func readVectors(t *testing.T, name string) vectors {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(vectorsDir, name))
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestGoVectorsAreWhatTheGeneratorProducesNow(t *testing.T) {
	built := buildVectors(t)
	path := filepath.Join(vectorsDir, "handshake-vectors.go.json")
	if *updateVectors {
		b, err := json.MarshalIndent(built, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if committed := readVectors(t, "handshake-vectors.go.json"); !reflect.DeepEqual(committed, built) {
		t.Fatalf("committed Go vectors are stale; run go test ./internal/dispatch -run TestGoVectors -update-vectors")
	}
}

func TestMessagesAreOneHundredBytesWithTheNonceAfterThePrefix(t *testing.T) {
	built := buildVectors(t)
	hello, _ := hex.DecodeString(built.Hello.Message)
	enroll, _ := hex.DecodeString(built.Enroll.Message)
	if len(hello) != 100 || len(enroll) != 100 {
		t.Fatalf("lengths %d and %d, want 100", len(hello), len(enroll))
	}
	if string(hello[:len(helloPrefix)]) != helloPrefix || string(enroll[:len(enrollPrefix)]) != enrollPrefix {
		t.Fatal("prefix missing")
	}
	if len(helloPrefix) != 30 || len(enrollPrefix) != 28 {
		t.Fatalf("prefix lengths %d and %d, want 30 and 28", len(helloPrefix), len(enrollPrefix))
	}
}

func TestBytesAndSignaturesBuiltByTypeScriptMatchAndVerify(t *testing.T) {
	ts := readVectors(t, "handshake-vectors.ts.json")
	if built := buildVectors(t); !reflect.DeepEqual(ts, built) {
		t.Fatalf("TypeScript vectors differ from Go:\nts %+v\ngo %+v", ts, built)
	}
	seed, _ := base64.RawURLEncoding.DecodeString(ts.Seed)
	pub := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)
	for name, s := range map[string]signedVector{"hello": ts.Hello, "enroll": ts.Enroll} {
		msg, _ := hex.DecodeString(s.Message)
		sig, _ := base64.RawURLEncoding.DecodeString(s.Signature)
		if !ed25519.Verify(pub, msg, sig) {
			t.Fatalf("%s signature built by TypeScript does not verify", name)
		}
	}
}
