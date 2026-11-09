package main

import (
	"bytes"
	"context"
	"crypto"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/cyberphone/json-canonicalization/go/src/webpki.org/jsoncanonicalizer"
	"github.com/go-openapi/strfmt"
	"github.com/sigstore/rekor/pkg/generated/client/entries"
	"github.com/sigstore/rekor/pkg/generated/models"
	"github.com/sigstore/rekor/pkg/types"
	"github.com/sigstore/rekor/pkg/util"
	"github.com/sigstore/sigstore-go/pkg/sign"
	"github.com/sigstore/sigstore-go/pkg/tlog"
	"github.com/sigstore/sigstore/pkg/signature"
)

const rekorTreeID = int64(1193050959916656506)

type rekorState struct {
	Leaves []string `json:"leaves"`
}

type fakeRekor struct {
	authority      *authority
	integratedTime time.Time
	logIndex       int64
}

var _ sign.RekorClient = (*fakeRekor)(nil)

func (r *fakeRekor) statePath() string { return filepath.Join(r.authority.dir, "rekor", "log.json") }

func (r *fakeRekor) loadState() (*rekorState, error) {
	var s rekorState
	b, err := os.ReadFile(r.statePath())
	if errors.Is(err, os.ErrNotExist) {
		return &s, nil
	}
	if err != nil {
		return nil, err
	}
	return &s, json.Unmarshal(b, &s)
}

func (r *fakeRekor) saveState(s *rekorState) error {
	if err := os.MkdirAll(filepath.Dir(r.statePath()), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(r.statePath(), b, 0o644)
}

func (r *fakeRekor) CreateLogEntryContext(ctx context.Context, params *entries.CreateLogEntryParams, _ ...entries.ClientOption) (*entries.CreateLogEntryCreated, error) {
	entry, err := types.CreateVersionedEntry(params.ProposedEntry)
	if err != nil {
		return nil, err
	}
	body, err := types.CanonicalizeEntry(ctx, entry)
	if err != nil {
		return nil, err
	}
	state, err := r.loadState()
	if err != nil {
		return nil, err
	}
	leafHash := hashLeaf(body)
	state.Leaves = append(state.Leaves, hex.EncodeToString(leafHash))
	leaves := make([][]byte, len(state.Leaves))
	for i, h := range state.Leaves {
		if leaves[i], err = hex.DecodeString(h); err != nil {
			return nil, err
		}
	}
	index := int64(len(leaves) - 1)
	treeSize := int64(len(leaves))
	rootHash := merkleRoot(leaves)
	path := inclusionPath(index, leaves)

	signer, err := signature.LoadECDSASignerVerifier(r.authority.rekorKey, crypto.SHA256)
	if err != nil {
		return nil, err
	}
	checkpoint, err := util.CreateAndSignCheckpoint(ctx, rekorHostname, rekorTreeID, uint64(treeSize), rootHash, signer)
	if err != nil {
		return nil, err
	}
	id, err := logID(r.authority.rekorKey.Public())
	if err != nil {
		return nil, err
	}
	logIDHex := hex.EncodeToString(id)
	integrated := time.Now().Unix()
	bodyB64 := base64.StdEncoding.EncodeToString(body)
	payload, err := json.Marshal(tlog.RekorPayload{Body: bodyB64, IntegratedTime: integrated, LogIndex: index, LogID: logIDHex})
	if err != nil {
		return nil, err
	}
	canonical, err := jsoncanonicalizer.Transform(payload)
	if err != nil {
		return nil, err
	}
	set, err := signer.SignMessage(bytes.NewReader(canonical))
	if err != nil {
		return nil, err
	}
	hashes := make([]string, len(path))
	for i, h := range path {
		hashes[i] = hex.EncodeToString(h)
	}
	rootHex := hex.EncodeToString(rootHash)
	cp := string(checkpoint)
	uuid := hex.EncodeToString(leafHash)
	anon := models.LogEntryAnon{
		Body:           bodyB64,
		IntegratedTime: &integrated,
		LogID:          &logIDHex,
		LogIndex:       &index,
		Verification: &models.LogEntryAnonVerification{
			InclusionProof: &models.InclusionProof{
				Checkpoint: &cp,
				Hashes:     hashes,
				LogIndex:   &index,
				RootHash:   &rootHex,
				TreeSize:   &treeSize,
			},
			SignedEntryTimestamp: strfmt.Base64(set),
		},
	}
	if err := r.saveState(state); err != nil {
		return nil, err
	}
	r.integratedTime = time.Unix(integrated, 0)
	r.logIndex = index
	return &entries.CreateLogEntryCreated{ETag: uuid, Payload: models.LogEntry{uuid: anon}}, nil
}

func (r *fakeRekor) GetLogEntryByUUIDContext(context.Context, *entries.GetLogEntryByUUIDParams, ...entries.ClientOption) (*entries.GetLogEntryByUUIDOK, error) {
	return nil, errors.New("fake rekor: lookup by UUID is not supported")
}

func hashLeaf(data []byte) []byte {
	h := sha256.New()
	h.Write([]byte{0})
	h.Write(data)
	return h.Sum(nil)
}

func hashChildren(l, r []byte) []byte {
	h := sha256.New()
	h.Write([]byte{1})
	h.Write(l)
	h.Write(r)
	return h.Sum(nil)
}

func splitPoint(n int) int {
	k := 1
	for k<<1 < n {
		k <<= 1
	}
	return k
}

func merkleRoot(leaves [][]byte) []byte {
	if len(leaves) == 1 {
		return leaves[0]
	}
	k := splitPoint(len(leaves))
	return hashChildren(merkleRoot(leaves[:k]), merkleRoot(leaves[k:]))
}

func inclusionPath(m int64, leaves [][]byte) [][]byte {
	if len(leaves) <= 1 {
		return nil
	}
	k := splitPoint(len(leaves))
	if int(m) < k {
		return append(inclusionPath(m, leaves[:k]), merkleRoot(leaves[k:]))
	}
	return append(inclusionPath(m-int64(k), leaves[k:]), merkleRoot(leaves[:k]))
}
