package dispatch

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/coder/websocket"

	"github.com/harshjv/stationly/go/internal/identity"
	"github.com/harshjv/stationly/go/internal/protocol"
)

type EnrollInfo struct {
	Os           protocol.StationOs
	Arch         protocol.StationArch
	Capabilities protocol.StationCapabilities
	Routes       any
	Resources    protocol.Resources
	Version      string
	Install      *protocol.EnrollInstall
}

func Refused(err error) (*protocol.ErrorBody, bool) {
	var ce *closeError
	if errors.As(err, &ce) && ce.err != nil {
		return ce.err, true
	}
	return nil, false
}

func Enroll(ctx context.Context, dispatchURL, token string, keys identity.Keys, info EnrollInfo) (*protocol.EnrolledBody, error) {
	if err := identity.CheckURL(dispatchURL); err != nil {
		return nil, err
	}
	u, err := identity.SocketURL(dispatchURL, protocol.StationConnectPath)
	if err != nil {
		return nil, err
	}
	conn, err := dial(ctx, u, func() {})
	if err != nil {
		return nil, err
	}
	defer func() { _ = conn.CloseNow() }()
	hctx, cancel := context.WithTimeout(ctx, handshakeTimeout)
	defer cancel()
	nonce, err := challenge(hctx, conn)
	if err != nil {
		return nil, err
	}
	now := uint64(time.Now().UnixMilli())
	msg, err := EnrollMessage(nonce, token, now)
	if err != nil {
		return nil, err
	}
	wg, err := keys.WireGuardPublic()
	if err != nil {
		return nil, err
	}
	body := protocol.EnrollBody{
		Token:           token,
		IdentityKey:     keys.IdentityPublic(),
		PublicKey:       wg,
		Timestamp:       int(now),
		Signature:       base64.RawURLEncoding.EncodeToString(sign(keys.Key, msg)),
		Os:              info.Os,
		Arch:            info.Arch,
		Capabilities:    info.Capabilities,
		Routes:          info.Routes,
		Resources:       info.Resources,
		StationdVersion: info.Version,
		Install:         info.Install,
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	b, err := json.Marshal(protocol.Envelope{Type: protocol.MessageEnroll, Id: newMessageID(), SentAt: stamp(), Body: raw})
	if err != nil {
		return nil, err
	}
	if err := conn.Write(hctx, websocket.MessageText, b); err != nil {
		return nil, err
	}
	env, err := readEnvelope(hctx, conn)
	if err != nil {
		return nil, err
	}
	switch env.Type {
	case protocol.MessageEnrolled:
		var out protocol.EnrolledBody
		if err := json.Unmarshal(env.Body, &out); err != nil {
			return nil, fmt.Errorf("enrolled: %w", err)
		}
		_ = closeOf(hctx, conn, nil)
		return &out, nil
	case protocol.MessageError:
		var e protocol.ErrorBody
		_ = json.Unmarshal(env.Body, &e)
		return nil, closeOf(hctx, conn, &e)
	}
	return nil, fmt.Errorf("Dispatch answered enroll with %s", env.Type)
}
