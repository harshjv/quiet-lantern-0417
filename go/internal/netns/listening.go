package netns

import (
	"bufio"
	"bytes"
	"cmp"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"net/netip"
	"os"
	"slices"
	"strconv"
	"strings"
)

const SocketsMax = 32

type Socket struct {
	Address netip.Addr
	Port    uint16
	Proto   string
}

const (
	tcpListen = "0A"
	udpClose  = "07"
)

func Listening(pid int, port uint16, proto string) ([]Socket, error) {
	return listeningIn("/proc/"+strconv.Itoa(pid)+"/net/", port, proto)
}

func listeningIn(base string, port uint16, proto string) ([]Socket, error) {
	return listeningFrom(func(name string) (io.ReadCloser, error) { return os.Open(base + name) }, port, proto)
}

const SectionMark = "@@"

func ListeningDump(dump []byte, port uint16, proto string) ([]Socket, error) {
	sections := map[string][]byte{}
	var name string
	for _, line := range bytes.SplitAfter(dump, []byte("\n")) {
		if n, ok := bytes.CutPrefix(bytes.TrimRight(line, "\r\n"), []byte(SectionMark)); ok {
			name = string(n)
			continue
		}
		if name != "" {
			sections[name] = append(sections[name], line...)
		}
	}
	if len(sections) == 0 {
		return nil, errors.New("the dump holds no socket table")
	}
	return listeningFrom(func(file string) (io.ReadCloser, error) {
		body, ok := sections[file]
		if !ok {
			return nil, os.ErrNotExist
		}
		return io.NopCloser(bytes.NewReader(body)), nil
	}, port, proto)
}

func listeningFrom(open func(name string) (io.ReadCloser, error), port uint16, proto string) ([]Socket, error) {
	seen := map[Socket]bool{}
	var out []Socket
	var firstErr error
	read := 0
	for _, f := range []struct{ file, proto, state string }{
		{"tcp", "tcp", tcpListen}, {"tcp6", "tcp", tcpListen}, {"udp", "udp", udpClose}, {"udp6", "udp", udpClose},
	} {
		rc, err := open(f.file)
		var socks []Socket
		if err == nil {
			socks, err = parseSockets(rc, f.proto, f.state)
			rc.Close()
		}
		if err != nil {
			if firstErr == nil && !os.IsNotExist(err) {
				firstErr = err
			}
			continue
		}
		read++
		for _, s := range socks {
			if !seen[s] {
				seen[s] = true
				out = append(out, s)
			}
		}
	}
	if read == 0 && firstErr != nil {
		return nil, firstErr
	}
	rank := func(s Socket) int {
		switch {
		case s.Port == port && s.Proto == proto:
			return 0
		case s.Port == port:
			return 1
		}
		return 2
	}
	slices.SortStableFunc(out, func(a, b Socket) int {
		if c := cmp.Compare(rank(a), rank(b)); c != 0 {
			return c
		}
		if c := cmp.Compare(a.Proto, b.Proto); c != 0 {
			return c
		}
		if c := cmp.Compare(a.Port, b.Port); c != 0 {
			return c
		}
		return a.Address.Compare(b.Address)
	})
	if len(out) > SocketsMax {
		out = out[:SocketsMax]
	}
	return out, nil
}

func procSockets(path, proto, state string) ([]Socket, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return parseSockets(f, proto, state)
}

func parseSockets(r io.Reader, proto, state string) ([]Socket, error) {
	var out []Socket
	sc := bufio.NewScanner(r)
	first := true
	for sc.Scan() {
		if first {
			first = false
			continue
		}
		fields := strings.Fields(sc.Text())
		if len(fields) < 4 || fields[3] != state {
			continue
		}
		s, ok := parseLocal(fields[1], proto)
		if !ok || s.Port == 0 {
			continue
		}
		out = append(out, s)
	}
	return out, sc.Err()
}

func parseLocal(field, proto string) (Socket, bool) {
	host, portHex, ok := strings.Cut(field, ":")
	if !ok {
		return Socket{}, false
	}
	p, err := strconv.ParseUint(portHex, 16, 16)
	if err != nil {
		return Socket{}, false
	}
	raw, err := hex.DecodeString(host)
	if err != nil || (len(raw) != 4 && len(raw) != 16) {
		return Socket{}, false
	}
	b := make([]byte, len(raw))
	for i := 0; i < len(raw); i += 4 {
		binary.NativeEndian.PutUint32(b[i:], binary.BigEndian.Uint32(raw[i:i+4]))
	}
	a, ok := netip.AddrFromSlice(b)
	if !ok {
		return Socket{}, false
	}
	return Socket{Address: a.Unmap(), Port: uint16(p), Proto: proto}, true
}

func LoopbackOnly(socks []Socket, port uint16, proto string) bool {
	found := false
	for _, s := range socks {
		if s.Port != port || s.Proto != proto {
			continue
		}
		if !s.Address.IsLoopback() {
			return false
		}
		found = true
	}
	return found
}
