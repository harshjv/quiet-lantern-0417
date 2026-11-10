package dispatch

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/harshjv/stationly/go/internal/protocol"
)

const (
	ChannelStdin  byte = 0
	ChannelStdout byte = 1
	ChannelStderr byte = 2
	frameHeader        = 5
	dataQueue          = 256
)

var ErrStreamClosed = errors.New("stream closed")

type StreamError struct {
	Code        protocol.ErrorCode
	Explanation string
}

func (e *StreamError) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Explanation)
}

type frame struct {
	binary bool
	b      []byte
}

type Stream struct {
	c        *Client
	Number   int
	mu       sync.Mutex
	credit   int
	recvLeft int
	closed   bool
	done     chan struct{}
	wake     chan struct{}
	onData   func(channel byte, p []byte)
	onCancel func()
}

type streams struct {
	mu   sync.Mutex
	byID map[int]*Stream
	next int
}

func (c *Client) OpenStream(window int, onData func(channel byte, p []byte), onCancel func()) (*Stream, error) {
	if !c.live.Load() {
		return nil, &StreamError{Code: protocol.ErrorCodeStationOffline, Explanation: "not connected to Dispatch"}
	}
	c.st.mu.Lock()
	defer c.st.mu.Unlock()
	if len(c.st.byID) >= protocol.LimitConcurrentStreams {
		return nil, &StreamError{Code: protocol.ErrorCodeProtocolLimit, Explanation: fmt.Sprintf("%d streams are open on this connection", len(c.st.byID))}
	}
	if c.st.next < 2 {
		c.st.next = 2
	}
	n := c.st.next
	c.st.next += 2
	if c.st.next > 0xFFFFFFFE {
		c.st.next = 2
	}
	s := &Stream{c: c, Number: n, credit: window, recvLeft: window, done: make(chan struct{}), wake: make(chan struct{}, 1), onData: onData, onCancel: onCancel}
	c.st.byID[n] = s
	return s, nil
}

func (c *Client) stream(n int) *Stream {
	c.st.mu.Lock()
	defer c.st.mu.Unlock()
	return c.st.byID[n]
}

func (c *Client) closeStreams() {
	c.st.mu.Lock()
	all := make([]*Stream, 0, len(c.st.byID))
	for _, s := range c.st.byID {
		all = append(all, s)
	}
	c.st.mu.Unlock()
	for _, s := range all {
		if s.close() && s.onCancel != nil {
			go s.onCancel()
		}
	}
}

func (s *Stream) Done() <-chan struct{} {
	return s.done
}

func (s *Stream) close() bool {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return false
	}
	s.closed = true
	close(s.done)
	s.mu.Unlock()
	s.c.st.mu.Lock()
	delete(s.c.st.byID, s.Number)
	s.c.st.mu.Unlock()
	return true
}

func (s *Stream) signal() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *Stream) acquire(ctx context.Context, n int) error {
	for {
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			return ErrStreamClosed
		}
		if s.credit >= n {
			s.credit -= n
			s.mu.Unlock()
			return nil
		}
		s.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-s.done:
			return ErrStreamClosed
		case <-s.wake:
		}
	}
}

func (s *Stream) enqueue(ctx context.Context, f frame) error {
	select {
	case s.c.data <- f:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-s.done:
		return ErrStreamClosed
	}
}

func (s *Stream) SendItems(ctx context.Context, items any) error {
	raw, err := json.Marshal(items)
	if err != nil {
		return err
	}
	if len(raw) > protocol.LimitStreamDataItemsBytes {
		return fmt.Errorf("stream.data items are %d bytes, above %d", len(raw), protocol.LimitStreamDataItemsBytes)
	}
	b, err := s.c.encode(protocol.MessageStreamData, nil, struct {
		Stream int             `json:"stream"`
		Items  json.RawMessage `json:"items"`
	}{s.Number, raw})
	if err != nil {
		return err
	}
	if err := s.acquire(ctx, len(b)); err != nil {
		return err
	}
	return s.enqueue(ctx, frame{b: b})
}

func (s *Stream) SendBinary(ctx context.Context, channel byte, p []byte) error {
	for len(p) > 0 {
		chunk := p
		if len(chunk) > protocol.LimitBinaryPayloadBytes {
			chunk = chunk[:protocol.LimitBinaryPayloadBytes]
		}
		p = p[len(chunk):]
		if err := s.acquire(ctx, len(chunk)); err != nil {
			return err
		}
		b := make([]byte, frameHeader+len(chunk))
		binary.BigEndian.PutUint32(b, uint32(s.Number))
		b[4] = channel
		copy(b[frameHeader:], chunk)
		if err := s.enqueue(ctx, frame{binary: true, b: b}); err != nil {
			return err
		}
	}
	return nil
}

func (s *Stream) Opened(ref string, window int) error {
	r := ref
	return s.c.Send(protocol.MessageStreamOpened, &r, protocol.StreamOpenedBody{Stream: s.Number, Window: window})
}

func (s *Stream) Grant(n int) {
	if n <= 0 {
		return
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.recvLeft += n
	s.mu.Unlock()
	_ = s.c.Send(protocol.MessageStreamCredit, nil, protocol.StreamCreditBody{Stream: s.Number, Bytes: n})
}

func (s *Stream) End(reason string, exitCode *int) {
	if !s.close() {
		return
	}
	body := protocol.StreamEndBody{Stream: s.Number, Reason: reason, ExitCode: exitCode}
	b, err := s.c.encode(protocol.MessageStreamEnd, nil, body)
	if err != nil {
		return
	}
	select {
	case s.c.data <- frame{b: b}:
	case <-time.After(writeTimeout):
		_ = s.c.Send(protocol.MessageStreamEnd, nil, body)
	}
}

func (c *Client) streamError(code protocol.ErrorCode, n int, format string, args ...any) {
	_ = c.Send(protocol.MessageError, nil, protocol.ErrorBody{Code: string(code), Explanation: fmt.Sprintf(format, args...), Fix: "Open the stream again.", Details: protocol.ErrorBodyDetails{"stream": n}})
}

func (c *Client) onBinary(b []byte) {
	if len(b) < frameHeader {
		return
	}
	n := int(binary.BigEndian.Uint32(b))
	ch := b[4]
	payload := b[frameHeader:]
	s := c.stream(n)
	if s == nil {
		c.streamError(protocol.ErrorCodeStreamNotFound, n, "no stream %d is open on this connection", n)
		return
	}
	if len(payload) > protocol.LimitBinaryPayloadBytes {
		c.cancelStream(s, string(protocol.ErrorCodeProtocolMessageTooLarge))
		return
	}
	s.mu.Lock()
	s.recvLeft -= len(payload)
	over := s.recvLeft < 0
	s.mu.Unlock()
	if over {
		c.streamError(protocol.ErrorCodeStreamCreditExceeded, n, "stream %d received more bytes than the credit granted", n)
		c.cancelStream(s, string(protocol.ErrorCodeStreamCreditExceeded))
		return
	}
	if s.onData != nil {
		s.onData(ch, payload)
	}
}

func (c *Client) cancelStream(s *Stream, reason string) {
	if s.close() {
		_ = c.Send(protocol.MessageStreamEnd, nil, protocol.StreamEndBody{Stream: s.Number, Reason: reason})
		if s.onCancel != nil {
			go s.onCancel()
		}
	}
}

func (c *Client) onStreamControl(env protocol.Envelope) bool {
	switch env.Type {
	case protocol.MessageStreamCredit:
		var b protocol.StreamCreditBody
		if json.Unmarshal(env.Body, &b) != nil {
			return true
		}
		s := c.stream(b.Stream)
		if s == nil {
			c.streamError(protocol.ErrorCodeStreamNotFound, b.Stream, "no stream %d is open on this connection", b.Stream)
			return true
		}
		s.mu.Lock()
		s.credit += b.Bytes
		s.mu.Unlock()
		s.signal()
		return true
	case protocol.MessageStreamCancel, protocol.MessageStreamEnd:
		var b protocol.StreamRefBody
		if json.Unmarshal(env.Body, &b) != nil {
			return true
		}
		if s := c.stream(b.Stream); s != nil && s.close() && s.onCancel != nil {
			go s.onCancel()
		}
		return true
	case protocol.MessageStreamData, protocol.MessageStreamOpened:
		return true
	}
	return false
}

func (c *Client) Request(ctx context.Context, typ string, body any) (Message, error) {
	if !c.live.Load() {
		return Message{}, errors.New("not connected to Dispatch")
	}
	id := newMessageID()
	b, err := c.encodeID(id, typ, nil, body)
	if err != nil {
		return Message{}, err
	}
	reply := make(chan Message, 1)
	c.pendMu.Lock()
	c.pending[id] = reply
	c.pendMu.Unlock()
	defer func() {
		c.pendMu.Lock()
		delete(c.pending, id)
		c.pendMu.Unlock()
	}()
	select {
	case c.ctrl <- b:
	default:
		return Message{}, errors.New("control queue is full")
	}
	select {
	case m := <-reply:
		return m, nil
	case <-ctx.Done():
		return Message{}, ctx.Err()
	}
}

func (c *Client) answer(env protocol.Envelope) bool {
	if env.Ref == nil {
		return false
	}
	c.pendMu.Lock()
	reply, ok := c.pending[*env.Ref]
	c.pendMu.Unlock()
	if !ok {
		return false
	}
	select {
	case reply <- Message{Type: env.Type, ID: env.Id, Ref: env.Ref, Generation: env.Generation, Body: env.Body}:
	default:
	}
	return true
}

func (c *Client) Negotiated(capability protocol.Capability) bool {
	c.statusMu.Lock()
	defer c.statusMu.Unlock()
	for _, have := range c.status.Capabilities {
		if have == string(capability) {
			return true
		}
	}
	return false
}
