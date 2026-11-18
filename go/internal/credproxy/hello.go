package credproxy

import (
	"bytes"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"time"
)

var errHelloRead = errors.New("client hello read")

type helloConn struct {
	r io.Reader
	net.Conn
}

func (c helloConn) Read(b []byte) (int, error) { return c.r.Read(b) }

func (helloConn) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

type replayConn struct {
	r io.Reader
	net.Conn
}

func (c *replayConn) Read(b []byte) (int, error) { return c.r.Read(b) }

func peekHello(conn net.Conn, timeout time.Duration) (string, net.Conn, error) {
	var seen bytes.Buffer
	sni := ""
	if err := conn.SetReadDeadline(time.Now().Add(timeout)); err != nil {
		return "", nil, err
	}
	err := tls.Server(helloConn{r: io.TeeReader(conn, &seen), Conn: conn}, &tls.Config{
		GetConfigForClient: func(h *tls.ClientHelloInfo) (*tls.Config, error) {
			sni = h.ServerName
			return nil, errHelloRead
		},
	}).Handshake()
	if err := conn.SetReadDeadline(time.Time{}); err != nil {
		return "", nil, err
	}
	replay := &replayConn{r: io.MultiReader(bytes.NewReader(seen.Bytes()), conn), Conn: conn}
	if errors.Is(err, errHelloRead) {
		return sni, replay, nil
	}
	if seen.Len() == 0 {
		return "", nil, err
	}
	return "", replay, nil
}
