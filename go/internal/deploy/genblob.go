//go:build linux

package deploy

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/harshjv/stationly/go/internal/dispatch"
	"github.com/harshjv/stationly/go/internal/protocol"
)

const generationBlobLimit = 64 << 20

var errGrantRefused = errors.New("the blob grant was refused")

func (s *Station) fetchBlob(ctx context.Context, grant protocol.BlobGrant, w io.Writer) error {
	url := strings.TrimRight(s.opts.Identity.DispatchURL, "/") + "/v1/stations/" + s.opts.Identity.StationID + "/blobs/" + grant.BlobId
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+grant.Token)
	resp, err := (&http.Client{Timeout: 10 * time.Minute}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		return errGrantRefused
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s answered %d", url, resp.StatusCode)
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(w, h), io.LimitReader(resp.Body, int64(grant.Size)+1))
	if err != nil {
		return err
	}
	if n != int64(grant.Size) {
		return fmt.Errorf("blob is %d bytes, the grant says %d", n, grant.Size)
	}
	if sum := hex.EncodeToString(h.Sum(nil)); sum != grant.Sha256 {
		return fmt.Errorf("blob sha256 is %s, the grant says %s", sum, grant.Sha256)
	}
	return nil
}

func (s *Station) regrant(ctx context.Context, blobID string) (protocol.BlobGrant, error) {
	id := blobID
	reply, err := s.link.Request(ctx, protocol.MessageBlobGrant, protocol.BlobGrantRequestBody{BlobId: &id})
	if err != nil {
		return protocol.BlobGrant{}, err
	}
	if reply.Type != protocol.MessageBlobGranted {
		var e protocol.ErrorBody
		_ = json.Unmarshal(reply.Body, &e)
		return protocol.BlobGrant{}, fmt.Errorf("blob.grant answered %s %s: %s", reply.Type, e.Code, e.Explanation)
	}
	var g protocol.BlobGrant
	return g, json.Unmarshal(reply.Body, &g)
}

func (s *Station) fetchGrantedBlob(ctx context.Context, grant protocol.BlobGrant) ([]byte, error) {
	var buf bytes.Buffer
	err := s.fetchBlob(ctx, grant, &buf)
	if errors.Is(err, errGrantRefused) {
		fresh, gerr := s.regrant(ctx, grant.BlobId)
		if gerr != nil {
			return nil, gerr
		}
		buf.Reset()
		err = s.fetchBlob(ctx, fresh, &buf)
	}
	return buf.Bytes(), err
}

func (s *Station) generationAvailable(ctx context.Context, m dispatch.Message) {
	var b protocol.GenerationAvailableBody
	ref := m.ID
	refuse := func(number int, hash string, format string, args ...any) {
		s.log.Error("generation.available rejected", "number", number, "explanation", fmt.Sprintf(format, args...))
		s.send(protocol.MessageGenerationAck, &ref, protocol.GenerationAckBody{Number: number, Hash: hash, Status: protocol.AppliedStatusRejected, Results: []protocol.GenerationResult{}, Failure: protocolError(protocol.ErrorCodeGenerationInvalid, "Send the generation again.", format, args...)})
	}
	if err := json.Unmarshal(m.Body, &b); err != nil {
		refuse(m.Generation, "sha256:"+strings.Repeat("0", 64), "generation.available body: %v", err)
		return
	}
	s.log.Info("generation available through blob fetch", "number", b.Number, "hash", b.Hash, "blob", b.Blob.BlobId, "size", b.Blob.Size)
	go func() {
		start := time.Now()
		fctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
		defer cancel()
		raw, err := s.fetchGrantedBlob(fctx, b.Blob)
		if err != nil {
			refuse(b.Number, b.Hash, "fetch blob %s: %v", b.Blob.BlobId, err)
			return
		}
		gz, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			refuse(b.Number, b.Hash, "blob %s is not gzip: %v", b.Blob.BlobId, err)
			return
		}
		doc, err := io.ReadAll(io.LimitReader(gz, generationBlobLimit+1))
		if err != nil {
			refuse(b.Number, b.Hash, "gunzip blob %s: %v", b.Blob.BlobId, err)
			return
		}
		if len(doc) > generationBlobLimit {
			refuse(b.Number, b.Hash, "the generation document is above %d bytes", generationBlobLimit)
			return
		}
		var head struct {
			Number int    `json:"number"`
			Hash   string `json:"hash"`
		}
		if err := json.Unmarshal(doc, &head); err != nil {
			refuse(b.Number, b.Hash, "the generation document is not JSON: %v", err)
			return
		}
		if head.Hash != b.Hash || head.Number != b.Number {
			refuse(b.Number, b.Hash, "the document is generation %d %s, generation.available named %d %s", head.Number, head.Hash, b.Number, b.Hash)
			return
		}
		s.log.Info("generation blob fetched", "number", b.Number, "compressed", len(raw), "bytes", len(doc), "took_ms", time.Since(start).Milliseconds())
		s.post(ctx, func() {
			s.applyGeneration(ctx, dispatch.Message{Type: protocol.MessageGeneration, ID: m.ID, Generation: b.Number, Body: doc})
			s.writeObserved()
		})
	}()
}
