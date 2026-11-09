package dispatch

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/harshjv/stationly/go/internal/identity"
	"github.com/harshjv/stationly/go/internal/ids"
	"github.com/harshjv/stationly/go/internal/outbox"
	"github.com/harshjv/stationly/go/internal/protocol"
)

const (
	heartbeatEvery   = 10 * time.Second
	observedEvery    = 10 * time.Minute
	silenceLimit     = 45 * time.Second
	handshakeTimeout = 30 * time.Second
	backoffBase      = time.Second
	backoffCap       = 60 * time.Second
	backoffReset     = 60 * time.Second
	revokedFloor     = 10 * time.Minute
	writeTimeout     = 30 * time.Second
	controlQueue     = 512
	inboundQueue     = 256
)

var strictB64 = base64.RawURLEncoding.Strict()

var Capabilities = []string{
	string(protocol.CapabilityGenerationV1),
	string(protocol.CapabilitySecretsV1),
	string(protocol.CapabilityRegistryV1),
	string(protocol.CapabilityPlatformV1),
	string(protocol.CapabilityDoctorV1),
	string(protocol.CapabilityVolumesV1),
	string(protocol.CapabilityLogsFollow),
	string(protocol.CapabilityMetricsV1),
	string(protocol.CapabilityExecTty),
	string(protocol.CapabilityNetworkV1),
	string(protocol.CapabilitySandboxV1),
}

type Snapshot struct {
	Applied   protocol.AppliedGeneration
	Resources protocol.Resources
	Services  protocol.HeartbeatBodyServices
	Observed  *protocol.Observed
}

type Message struct {
	Type       string
	ID         string
	Ref        *string
	Generation int
	Body       json.RawMessage
	Connected  bool
}

type Status struct {
	Connected     bool     `json:"connected"`
	SessionID     string   `json:"session_id,omitempty"`
	ConnectedAt   string   `json:"connected_at,omitempty"`
	LastError     string   `json:"last_error,omitempty"`
	LastClose     int      `json:"last_close,omitempty"`
	Attempts      int      `json:"attempts"`
	VersionSkew   string   `json:"version_skew,omitempty"`
	Capabilities  []string `json:"capabilities,omitempty"`
	OutboxEpoch   string   `json:"outbox_epoch"`
	OutboxPending int      `json:"outbox_pending"`
	OutboxLastSeq int      `json:"outbox_last_seq"`
}

type Client struct {
	log       *slog.Logger
	id        *identity.Identity
	ob        *outbox.Outbox
	version   string
	bootID    string
	startedAt string
	url       string

	snapMu sync.Mutex
	snap   Snapshot

	inbound chan Message
	ctrl    chan []byte

	statusMu sync.Mutex
	status   Status
	live     atomic.Bool

	data    chan frame
	st      streams
	pendMu  sync.Mutex
	pending map[string]chan Message
}

func New(log *slog.Logger, id *identity.Identity, ob *outbox.Outbox, version string) (*Client, error) {
	u, err := identity.SocketURL(id.DispatchURL, protocol.StationConnectPath)
	if err != nil {
		return nil, err
	}
	boot, _ := os.ReadFile("/proc/sys/kernel/random/boot_id")
	return &Client{
		log:       log,
		id:        id,
		ob:        ob,
		version:   version,
		bootID:    strings.TrimSpace(string(boot)),
		startedAt: time.Now().UTC().Format(time.RFC3339),
		url:       u,
		inbound:   make(chan Message, inboundQueue),
		ctrl:      make(chan []byte, controlQueue),
		snap:      Snapshot{Services: protocol.HeartbeatBodyServices{}},
		data:      make(chan frame, dataQueue),
		st:        streams{byID: map[int]*Stream{}, next: 2},
		pending:   map[string]chan Message{},
	}, nil
}

func (c *Client) Inbound() <-chan Message {
	return c.inbound
}

func (c *Client) Publish(s Snapshot) {
	c.snapMu.Lock()
	defer c.snapMu.Unlock()
	if s.Services == nil {
		s.Services = protocol.HeartbeatBodyServices{}
	}
	c.snap = s
}

func (c *Client) snapshot() Snapshot {
	c.snapMu.Lock()
	defer c.snapMu.Unlock()
	return c.snap
}

func (c *Client) Status() Status {
	c.statusMu.Lock()
	s := c.status
	c.statusMu.Unlock()
	s.OutboxEpoch, _, s.OutboxLastSeq = c.ob.Range()
	s.OutboxPending = c.ob.Pending()
	return s
}

func (c *Client) setStatus(f func(*Status)) {
	c.statusMu.Lock()
	defer c.statusMu.Unlock()
	f(&c.status)
}

func (c *Client) Connected() bool {
	return c.live.Load()
}

func stamp() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

func newMessageID() string {
	return ids.New("msg")
}

func (c *Client) encode(typ string, ref *string, body any) ([]byte, error) {
	return c.encodeID(newMessageID(), typ, ref, body)
}

func (c *Client) encodeID(id, typ string, ref *string, body any) ([]byte, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	b, err := json.Marshal(protocol.Envelope{
		Type:       typ,
		Id:         id,
		Ref:        protocol.EnvelopeRef(ref),
		Generation: c.snapshot().Applied.Number,
		SentAt:     stamp(),
		Body:       raw,
	})
	if err == nil && len(b) > protocol.LimitTextFrameBytes {
		return nil, fmt.Errorf("%s encodes to %d bytes, above the %d-byte text frame limit", typ, len(b), protocol.LimitTextFrameBytes)
	}
	return b, err
}

func (c *Client) Send(typ string, ref *string, body any) error {
	if !c.live.Load() {
		return errors.New("not connected to Dispatch")
	}
	b, err := c.encode(typ, ref, body)
	if err != nil {
		return err
	}
	select {
	case c.ctrl <- b:
		return nil
	default:
		return errors.New("control queue is full")
	}
}

func (c *Client) Emit(typ string, body any) (int, error) {
	r, err := c.ob.Append(typ, c.snapshot().Applied.Number, body)
	if err != nil {
		c.log.Error("outbox append", "type", typ, "error", err)
		return 0, err
	}
	return r.Seq, nil
}

type closeError struct {
	code   websocket.StatusCode
	reason string
	err    *protocol.ErrorBody
}

func (e *closeError) Error() string {
	if e.err != nil {
		return fmt.Sprintf("closed %d %s: %s", e.code, e.err.Code, e.err.Explanation)
	}
	return fmt.Sprintf("closed %d %s", e.code, e.reason)
}

func (c *Client) Run(ctx context.Context) {
	attempt := 0
	for ctx.Err() == nil {
		attempt++
		c.setStatus(func(s *Status) { s.Attempts = attempt })
		began := time.Now()
		err := c.session(ctx)
		c.live.Store(false)
		if ctx.Err() != nil {
			return
		}
		code := 0
		var ce *closeError
		if errors.As(err, &ce) {
			code = int(ce.code)
		} else if s := websocket.CloseStatus(err); s != -1 {
			code = int(s)
		}
		c.setStatus(func(s *Status) {
			s.Connected, s.SessionID, s.LastError, s.LastClose = false, "", fmt.Sprint(err), code
		})
		if time.Since(began) >= backoffReset {
			attempt = 1
		}
		delay := rand.N(min(backoffBase<<min(attempt-1, 6), backoffCap)) + time.Millisecond
		if code == protocol.CloseRevoked {
			delay = max(delay, revokedFloor)
		}
		c.log.Warn("Dispatch connection ended; reconnecting", "error", err, "close", code, "retry_in", delay.Round(time.Millisecond))
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
	}
}

func dial(ctx context.Context, url string, onPing func()) (*websocket.Conn, error) {
	dctx, cancel := context.WithTimeout(ctx, handshakeTimeout)
	defer cancel()
	conn, resp, err := websocket.Dial(dctx, url, &websocket.DialOptions{
		HTTPHeader:      http.Header{"User-Agent": []string{"stationd"}},
		Subprotocols:    []string{protocol.Subprotocol},
		CompressionMode: websocket.CompressionDisabled,
		OnPingReceived: func(context.Context, []byte) bool {
			onPing()
			return true
		},
	})
	if err != nil {
		if resp != nil {
			return nil, fmt.Errorf("upgrade refused with HTTP %d: %w", resp.StatusCode, err)
		}
		return nil, err
	}
	if conn.Subprotocol() != protocol.Subprotocol {
		conn.Close(websocket.StatusProtocolError, "subprotocol")
		return nil, fmt.Errorf("Dispatch answered subprotocol %q", conn.Subprotocol())
	}
	conn.SetReadLimit(protocol.LimitReadLimitBytes)
	return conn, nil
}

func readEnvelope(ctx context.Context, conn *websocket.Conn) (protocol.Envelope, error) {
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return protocol.Envelope{}, err
		}
		if typ != websocket.MessageText {
			continue
		}
		var env protocol.Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			return protocol.Envelope{}, fmt.Errorf("envelope: %w", err)
		}
		return env, nil
	}
}

func closeOf(conn *websocket.Conn, ctx context.Context, failure *protocol.ErrorBody) error {
	for {
		_, _, err := conn.Read(ctx)
		if err == nil {
			continue
		}
		var ce websocket.CloseError
		if errors.As(err, &ce) {
			return &closeError{code: ce.Code, reason: ce.Reason, err: failure}
		}
		if failure != nil {
			return &closeError{code: -1, err: failure}
		}
		return err
	}
}

func challenge(ctx context.Context, conn *websocket.Conn) ([]byte, error) {
	env, err := readEnvelope(ctx, conn)
	if err != nil {
		return nil, err
	}
	if env.Type != protocol.MessageChallenge {
		return nil, fmt.Errorf("first message from Dispatch is %s, not challenge", env.Type)
	}
	var ch protocol.ChallengeBody
	if err := json.Unmarshal(env.Body, &ch); err != nil {
		return nil, err
	}
	nonce, err := strictB64.DecodeString(ch.Nonce)
	if err != nil || len(nonce) != nonceLen {
		return nil, fmt.Errorf("challenge nonce is not 32 bytes of base64url")
	}
	return nonce, nil
}

func (c *Client) session(ctx context.Context) error {
	var lastFrame atomic.Int64
	touch := func() { lastFrame.Store(time.Now().UnixNano()) }
	touch()
	conn, err := dial(ctx, c.url, touch)
	if err != nil {
		return err
	}
	defer conn.CloseNow()
	hctx, cancel := context.WithTimeout(ctx, handshakeTimeout)
	defer cancel()
	nonce, err := challenge(hctx, conn)
	if err != nil {
		return err
	}
	now := uint64(time.Now().UnixMilli())
	msg, err := HelloMessage(nonce, c.id.StationID, now)
	if err != nil {
		return err
	}
	snap := c.snapshot()
	epoch, first, last := c.ob.Range()
	hello := protocol.HelloBody{
		StationId:       c.id.StationID,
		Timestamp:       int(now),
		Signature:       base64.RawURLEncoding.EncodeToString(sign(c.id.Key, msg)),
		StationdVersion: c.version,
		Protocol:        protocol.ProtocolVersion,
		Capabilities:    Capabilities,
		Applied:         snap.Applied,
		Outbox:          protocol.OutboxRange{Epoch: epoch, FirstSeq: first, LastSeq: last},
		BootId:          c.bootID,
		StartedAt:       c.startedAt,
	}
	b, err := c.encode(protocol.MessageHello, nil, hello)
	if err != nil {
		return err
	}
	if err := conn.Write(hctx, websocket.MessageText, b); err != nil {
		return err
	}
	env, err := readEnvelope(hctx, conn)
	if err != nil {
		return err
	}
	if env.Type == protocol.MessageError {
		var e protocol.ErrorBody
		json.Unmarshal(env.Body, &e)
		return closeOf(conn, hctx, &e)
	}
	if env.Type != protocol.MessageWelcome {
		return fmt.Errorf("Dispatch answered hello with %s", env.Type)
	}
	var welcome protocol.WelcomeBody
	if err := json.Unmarshal(env.Body, &welcome); err != nil {
		return fmt.Errorf("welcome: %w", err)
	}
	cancel()
	if welcome.InstanceId != c.id.InstanceID {
		conn.Close(websocket.StatusPolicyViolation, "instance mismatch")
		return fmt.Errorf("Dispatch is instance %s, this station belongs to %s", welcome.InstanceId, c.id.InstanceID)
	}
	resume := 0
	if welcome.ResumeFromSeq != nil {
		resume = *welcome.ResumeFromSeq
		if _, err := c.ob.Ack(epoch, resume); err != nil {
			c.log.Error("outbox compaction", "error", err)
		}
	} else {
		resume = first - 1
	}
	connectedAt := time.Now()
	c.setStatus(func(s *Status) {
		s.Connected, s.SessionID, s.ConnectedAt, s.LastError, s.VersionSkew, s.Capabilities = true, welcome.SessionId, connectedAt.UTC().Format(time.RFC3339), "", string(welcome.VersionSkew), welcome.Capabilities
	})
	c.drainControl()
	c.live.Store(true)
	c.log.Info("connected to Dispatch", "url", c.url, "session", welcome.SessionId, "version_skew", welcome.VersionSkew, "desired", welcome.Desired.Number, "applied", snap.Applied.Number, "outbox_epoch", epoch, "resume_from_seq", welcome.ResumeFromSeq, "outbox_last_seq", last)

	sctx, stop := context.WithCancel(ctx)
	defer stop()
	errs := make(chan error, 3)
	go func() { errs <- c.reader(sctx, conn, touch) }()
	go func() { errs <- c.writer(sctx, conn, resume) }()
	go func() {
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-sctx.Done():
				errs <- nil
				return
			case <-t.C:
				if time.Since(time.Unix(0, lastFrame.Load())) > silenceLimit {
					errs <- fmt.Errorf("no frame from Dispatch for %s", silenceLimit)
					return
				}
			}
		}
	}()
	c.deliver(sctx, Message{Connected: true})
	err = <-errs
	stop()
	c.live.Store(false)
	c.closeStreams()
	c.drainData()
	if ctx.Err() != nil {
		conn.Close(websocket.StatusGoingAway, "stationd shutting down")
	}
	return err
}

func (c *Client) drainControl() {
	for {
		select {
		case <-c.ctrl:
		default:
			return
		}
	}
}

func (c *Client) drainData() {
	for {
		select {
		case <-c.data:
		default:
			return
		}
	}
}

func (c *Client) deliver(ctx context.Context, m Message) {
	select {
	case c.inbound <- m:
	case <-ctx.Done():
	}
}

func (c *Client) reader(ctx context.Context, conn *websocket.Conn, touch func()) error {
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			var ce websocket.CloseError
			if errors.As(err, &ce) {
				return &closeError{code: ce.Code, reason: ce.Reason}
			}
			return err
		}
		touch()
		if typ == websocket.MessageBinary {
			c.onBinary(data)
			continue
		}
		var env protocol.Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			c.log.Warn("undecodable message from Dispatch", "error", err)
			continue
		}
		if c.onStreamControl(env) || c.answer(env) {
			continue
		}
		switch env.Type {
		case protocol.MessageOutboxAck:
			var ack protocol.OutboxAckBody
			if err := json.Unmarshal(env.Body, &ack); err != nil {
				c.log.Warn("outbox.ack", "error", err)
				continue
			}
			if _, err := c.ob.Ack(ack.Epoch, ack.UpToSeq); err != nil {
				c.log.Error("outbox ack", "error", err)
			}
		case protocol.MessageObservedRequest:
			c.sendObserved(env.Id)
		case protocol.MessageError:
			var e protocol.ErrorBody
			json.Unmarshal(env.Body, &e)
			if env.Ref == nil {
				c.log.Warn("error from Dispatch", "code", e.Code, "explanation", e.Explanation)
				continue
			}
			c.deliver(ctx, Message{Type: env.Type, ID: env.Id, Ref: env.Ref, Generation: env.Generation, Body: env.Body})
		default:
			c.deliver(ctx, Message{Type: env.Type, ID: env.Id, Ref: env.Ref, Generation: env.Generation, Body: env.Body})
		}
	}
}

func (c *Client) sendObserved(ref string) {
	snap := c.snapshot()
	if snap.Observed == nil {
		return
	}
	var r *string
	if ref != "" {
		r = &ref
	}
	if err := c.Send(protocol.MessageObservedReport, r, snap.Observed); err != nil {
		c.log.Warn("observed.report", "error", err)
	}
}

func (c *Client) heartbeat() []byte {
	snap := c.snapshot()
	b, _ := c.encode(protocol.MessageHeartbeat, nil, protocol.HeartbeatBody{
		Applied:   snap.Applied,
		Resources: snap.Resources,
		Outbox:    protocol.HeartbeatOutbox{LastSeq: c.ob.LastSeq()},
		Services:  snap.Services,
	})
	return b
}

func (c *Client) writer(ctx context.Context, conn *websocket.Conn, resume int) error {
	write := func(b []byte) error {
		wctx, cancel := context.WithTimeout(ctx, writeTimeout)
		defer cancel()
		return conn.Write(wctx, websocket.MessageText, b)
	}
	if err := write(c.heartbeat()); err != nil {
		return err
	}
	c.sendObserved("")
	hb := time.NewTicker(heartbeatEvery)
	defer hb.Stop()
	obs := time.NewTicker(observedEvery)
	defer obs.Stop()
	retry := time.NewTicker(time.Second)
	defer retry.Stop()
	sent := resume
	for {
		if err := c.flushControl(write); err != nil {
			return err
		}
		_, first, _ := c.ob.Range()
		if sent < first-1 {
			sent = first - 1
		}
		room := protocol.LimitOutboxInFlight - (sent - (first - 1))
		if room > 0 {
			for _, r := range c.ob.After(sent, min(room, 100)) {
				b, err := json.Marshal(protocol.Envelope{Type: r.Type, Id: newMessageID(), Generation: r.Generation, SentAt: stamp(), Body: r.Body})
				if err != nil {
					return err
				}
				if err := write(b); err != nil {
					return err
				}
				sent = r.Seq
			}
			if len(c.ob.After(sent, 1)) > 0 && sent-(first-1) < protocol.LimitOutboxInFlight {
				continue
			}
		}
		select {
		case <-ctx.Done():
			return nil
		case b := <-c.ctrl:
			if err := write(b); err != nil {
				return err
			}
		case f := <-c.data:
			if err := c.flushControl(write); err != nil {
				return err
			}
			if f.binary {
				wctx, cancel := context.WithTimeout(ctx, writeTimeout)
				err := conn.Write(wctx, websocket.MessageBinary, f.b)
				cancel()
				if err != nil {
					return err
				}
			} else if err := write(f.b); err != nil {
				return err
			}
		case <-c.ob.Notify():
		case <-retry.C:
		case <-hb.C:
			if err := write(c.heartbeat()); err != nil {
				return err
			}
		case <-obs.C:
			c.sendObserved("")
		}
	}
}

func (c *Client) flushControl(write func([]byte) error) error {
	for {
		select {
		case b := <-c.ctrl:
			if err := write(b); err != nil {
				return err
			}
		default:
			return nil
		}
	}
}

func (c *Client) OutboxFull() bool {
	return c.ob.Full()
}
