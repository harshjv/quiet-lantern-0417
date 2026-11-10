//go:build linux

package rootsocket

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"sync"

	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/upgrade"
	"golang.org/x/sys/unix"
)

const maxRequest = 1 << 20

type Handler func(ctx context.Context, params json.RawMessage, progress func(step, detail string)) (any, *protocol.ErrorBody)

type Server struct {
	log      *slog.Logger
	handlers map[string]Handler
	ln       net.Listener
	wg       sync.WaitGroup
}

const rootKey = "root"

func Listen(log *slog.Logger, path string, handlers map[string]Handler) (*Server, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	inherited := upgrade.Inherited(rootKey)
	if !inherited {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	old := unix.Umask(0o177)
	ln, err := upgrade.Listen(rootKey, "unix", path)
	unix.Umask(old)
	if err != nil {
		return nil, err
	}
	ln.(*net.UnixListener).SetUnlinkOnClose(false)
	if err := os.Chmod(path, 0o600); err != nil {
		ln.Close()
		return nil, err
	}
	s := &Server{log: log, handlers: handlers, ln: ln}
	log.Info("root socket listening", "path", path)
	return s, nil
}

func (s *Server) Close() {
	upgrade.Forget(rootKey)
	s.ln.Close()
}

func (s *Server) Serve(ctx context.Context) {
	go func() {
		<-ctx.Done()
		s.ln.Close()
	}()
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			s.wg.Wait()
			return
		}
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.handle(ctx, conn.(*net.UnixConn))
		}()
	}
}

func peerUID(c *net.UnixConn) (uint32, error) {
	raw, err := c.SyscallConn()
	if err != nil {
		return 0, err
	}
	var cred *unix.Ucred
	var credErr error
	if err := raw.Control(func(fd uintptr) {
		cred, credErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil {
		return 0, err
	}
	if credErr != nil {
		return 0, credErr
	}
	return cred.Uid, nil
}

func (s *Server) handle(ctx context.Context, conn *net.UnixConn) {
	defer conn.Close()
	var mu sync.Mutex
	enc := json.NewEncoder(conn)
	write := func(l protocol.RootSocketLine) {
		mu.Lock()
		defer mu.Unlock()
		l.V = protocol.RootSocketVersion
		enc.Encode(l)
	}
	fail := func(id string, code protocol.ErrorCode, explanation, fix string) {
		f := false
		write(protocol.RootSocketLine{Id: id, Ok: &f, Error: &protocol.ErrorBody{Code: string(code), Explanation: explanation, Fix: fix}})
	}
	uid, err := peerUID(conn)
	if err != nil || uid != 0 {
		s.log.Warn("root socket peer refused", "uid", uid, "error", err)
		fail("", protocol.ErrorCodeProtocolInvalidMessage, "the root socket serves uid 0 only", "Run the command as root on the station host.")
		return
	}
	sc := bufio.NewScanner(conn)
	sc.Buffer(make([]byte, 64<<10), maxRequest)
	if !sc.Scan() {
		return
	}
	var req protocol.RootSocketRequest
	if err := json.Unmarshal(sc.Bytes(), &req); err != nil || req.V != protocol.RootSocketVersion || req.Op == "" {
		fail(req.Id, protocol.ErrorCodeProtocolInvalidMessage, fmt.Sprintf("request is not a v%d root socket request", protocol.RootSocketVersion), "Send {\"v\":1,\"id\",\"op\",\"params\"} on one line.")
		return
	}
	h, ok := s.handlers[req.Op]
	if !ok {
		fail(req.Id, protocol.ErrorCodeProtocolInvalidMessage, "unknown op "+req.Op, "Use one of the documented ops.")
		return
	}
	s.log.Info("root socket request", "id", req.Id, "op", req.Op)
	result, failure := h(ctx, req.Params, func(step, detail string) {
		write(protocol.RootSocketLine{Id: req.Id, Progress: &protocol.RootSocketProgress{Step: step, Detail: detail}})
	})
	if failure != nil {
		f := false
		write(protocol.RootSocketLine{Id: req.Id, Ok: &f, Error: failure, Result: marshal(result)})
		return
	}
	t := true
	write(protocol.RootSocketLine{Id: req.Id, Ok: &t, Result: marshal(result)})
}

func marshal(v any) json.RawMessage {
	if v == nil {
		return nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return b
}

func Call(path, op string, params any, progress func(protocol.RootSocketProgress)) (json.RawMessage, *protocol.ErrorBody, error) {
	conn, err := net.Dial("unix", path)
	if err != nil {
		return nil, nil, err
	}
	defer conn.Close()
	body, err := json.Marshal(params)
	if err != nil {
		return nil, nil, err
	}
	id := fmt.Sprintf("r%d", os.Getpid())
	if err := json.NewEncoder(conn).Encode(protocol.RootSocketRequest{V: protocol.RootSocketVersion, Id: id, Op: op, Params: body}); err != nil {
		return nil, nil, err
	}
	sc := bufio.NewScanner(conn)
	sc.Buffer(make([]byte, 64<<10), 64<<20)
	for sc.Scan() {
		var l protocol.RootSocketLine
		if err := json.Unmarshal(sc.Bytes(), &l); err != nil {
			return nil, nil, err
		}
		if l.Progress != nil {
			progress(*l.Progress)
			continue
		}
		if l.Ok != nil {
			if !*l.Ok {
				return l.Result, l.Error, nil
			}
			return l.Result, nil, nil
		}
	}
	if err := sc.Err(); err != nil {
		return nil, nil, err
	}
	return nil, nil, fmt.Errorf("root socket closed before a final line")
}
