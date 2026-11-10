//go:build linux

package deploy

import (
	"context"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/harshjv/stationly/go/internal/dispatch"
	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/moby/moby/api/pkg/stdcopy"
	"github.com/moby/moby/client"
)

type stdinQueue struct {
	mu   sync.Mutex
	q    [][]byte
	eof  bool
	wake chan struct{}
}

func (q *stdinQueue) push(p []byte) {
	q.mu.Lock()
	if len(p) == 0 {
		q.eof = true
	} else {
		q.q = append(q.q, append([]byte(nil), p...))
	}
	q.mu.Unlock()
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

func (q *stdinQueue) pop() ([]byte, bool, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.q) > 0 {
		p := q.q[0]
		q.q = q.q[1:]
		return p, false, true
	}
	return nil, q.eof, false
}

type attachment struct {
	runID      string
	stream     *dispatch.Stream
	stdin      *stdinQueue
	outputDone chan struct{}
	hijack     *client.HijackedResponse
	started    bool
}

func (s *Station) post(ctx context.Context, f func()) {
	go func() {
		select {
		case s.inspections <- f:
		case <-ctx.Done():
		}
	}()
}

func (s *Station) openAttachment(ctx context.Context, rr *runRecord) (*attachment, error) {
	att := &attachment{runID: rr.ID, stdin: &stdinQueue{wake: make(chan struct{}, 1)}, outputDone: make(chan struct{})}
	id := rr.ID
	st, err := s.link.OpenStream(protocol.LimitStreamWindowBytes, func(ch byte, p []byte) {
		if ch == dispatch.ChannelStdin {
			att.stdin.push(p)
		}
	}, func() {
		s.post(ctx, func() {
			if r := s.runs[id]; r != nil && !r.terminal() {
				s.stopRun(ctx, r, "the attached client went away")
			}
		})
	})
	if err != nil {
		return nil, err
	}
	att.stream = st
	s.attached[id] = att
	s.attachByStream[st.Number] = id
	return att, nil
}

type streamWriter struct {
	ctx     context.Context
	stream  *dispatch.Stream
	channel byte
	line    *lineSink
}

func (w *streamWriter) Write(p []byte) (int, error) {
	w.line.Write(p)
	if err := w.stream.SendBinary(w.ctx, w.channel, p); err != nil && err != dispatch.ErrStreamClosed {
		return 0, err
	}
	return len(p), nil
}

func (s *Station) attachRun(ctx context.Context, rr *runRecord, containerID string) *protocol.ErrorBody {
	att := s.attached[rr.ID]
	if att == nil {
		return protocolError(protocol.ErrorCodeRunDeploymentUnknown, "Start the shell again.", "the attached session for run %s is gone", rr.ID)
	}
	hj, err := s.docker.Attach(ctx, containerID)
	if err != nil {
		return protocolError(protocol.ErrorCodeExitNonzero, "Check the run container.", "attach to %s: %v", docker.RunName(rr.ID), err)
	}
	att.hijack = &hj
	att.started = true
	w := s.logs.Single(rr.LogRef, runLogCap)
	logSink := func(stream string) *lineSink {
		return &lineSink{emit: func(_ time.Time, text string) {
			w.Write(time.Now(), docker.RoleRun, stream, s.redactorFor(rr.DeploymentID).Redact(text))
		}}
	}
	bg := context.Background()
	stdout := &streamWriter{ctx: bg, stream: att.stream, channel: dispatch.ChannelStdout, line: logSink(string(protocol.LogStreamStdout))}
	stderr := &streamWriter{ctx: bg, stream: att.stream, channel: dispatch.ChannelStderr, line: logSink(string(protocol.LogStreamStderr))}
	tty := rr.TTY
	go func() {
		defer close(att.outputDone)
		defer s.logs.Release(w)
		if tty {
			io.Copy(stdout, hj.Reader)
		} else {
			stdcopy.StdCopy(stdout, stderr, hj.Reader)
		}
		stdout.line.Flush()
		stderr.line.Flush()
	}()
	go func() {
		for {
			p, eof, ok := att.stdin.pop()
			switch {
			case ok:
				if _, err := hj.Conn.Write(p); err != nil {
					return
				}
				att.stream.Grant(len(p))
				continue
			case eof:
				hj.CloseWrite()
				return
			}
			select {
			case <-att.stdin.wake:
			case <-att.stream.Done():
				return
			case <-att.outputDone:
				return
			}
		}
	}()
	return nil
}

func (s *Station) finishAttachment(rr *runRecord) {
	att := s.attached[rr.ID]
	if att == nil {
		return
	}
	delete(s.attached, rr.ID)
	delete(s.attachByStream, att.stream.Number)
	go func() {
		if att.started {
			select {
			case <-att.outputDone:
			case <-time.After(5 * time.Second):
			}
		}
		reason := "exited"
		exitCode := rr.ExitCode
		if rr.Status != protocol.RunStatusSucceeded && rr.Status != protocol.RunStatusFailed {
			reason = string(rr.Status)
			exitCode = nil
		} else if rr.ExitCode == nil {
			reason = "failed"
		}
		att.stream.End(reason, exitCode)
		if att.hijack != nil {
			att.hijack.Close()
		}
	}()
}

func (s *Station) resizeExec(_ context.Context, m dispatch.Message, b protocol.ExecResizeBody) {
	runID, ok := s.attachByStream[b.Stream]
	if !ok {
		s.replyError(m, protocolError(protocol.ErrorCodeStreamNotFound, "Resize a stream of an attached run.", "no attached run is on stream %d", b.Stream))
		return
	}
	ref := m.ID
	if handled, err := s.resizeSandboxRun(runID, b.Rows, b.Cols); handled {
		if err != nil {
			s.send(protocol.MessageError, &ref, protocolError(protocol.ErrorCodeStreamNotFound, "Resize after the shell starts.", "resize run %s: %v", runID, err))
			return
		}
		s.send(protocol.MessageExecResized, &ref, protocol.StreamRefBody{Stream: b.Stream})
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := s.docker.Resize(ctx, docker.RunName(runID), b.Rows, b.Cols); err != nil && !strings.Contains(err.Error(), "is not running") {
			s.send(protocol.MessageError, &ref, protocolError(protocol.ErrorCodeStreamNotFound, "Resize after the shell starts.", "resize %s: %v", docker.RunName(runID), err))
			return
		}
		s.send(protocol.MessageExecResized, &ref, protocol.StreamRefBody{Stream: b.Stream})
	}()
}
