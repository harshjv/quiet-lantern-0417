//go:build linux

package flows

import (
	"encoding/binary"

	"golang.org/x/sys/unix"
)

const (
	ctaTupleOrig     = 1
	ctaTupleReply    = 2
	ctaStatus        = 3
	ctaProtoinfo     = 4
	ctaCountersOrig  = 9
	ctaCountersReply = 10
	ctaID            = 12
	ctaTimestamp     = 20

	ctaTupleIP    = 1
	ctaTupleProto = 2
	ctaIPv4Src    = 1
	ctaIPv4Dst    = 2
	ctaProtoNum   = 1
	ctaProtoSrc   = 2
	ctaProtoDst   = 3

	ctaProtoinfoTCP      = 1
	ctaProtoinfoTCPState = 1

	ctaCountersBytes  = 2
	ctaTimestampStart = 1

	ctaStatsGlobalEntries = 1

	msgNew      = 0
	msgGet      = 1
	msgDelete   = 2
	msgGetStats = 5

	nlaNested  = 0x8000
	nlaTypeMax = 0x3fff

	nlmsgHeaderLen = 16
	nfgenHeaderLen = 4
	headerLen      = nlmsgHeaderLen + nfgenHeaderLen

	groupNew     = 1
	groupDestroy = 3
)

type kind uint8

const (
	kindNone kind = iota
	kindNew
	kindDestroy
	kindReply
)

type Tuple struct {
	Src, Dst     [4]byte
	SPort, DPort uint16
	Proto        uint8
}

type key struct {
	id   uint32
	orig Tuple
}

type message struct {
	kind     kind
	key      key
	reply    Tuple
	hasReply bool
	origB    uint64
	replB    uint64
	counters bool
	start    int64
	tcp      uint8
	hasTCP   bool
}

func walk(b []byte, fn func(t uint16, v []byte)) {
	for len(b) >= 4 {
		l := int(binary.NativeEndian.Uint16(b))
		if l < 4 || l > len(b) {
			return
		}
		fn(binary.NativeEndian.Uint16(b[2:])&nlaTypeMax, b[4:l])
		next := (l + 3) &^ 3
		if next >= len(b) {
			return
		}
		b = b[next:]
	}
}

func decodeTuple(v []byte, t *Tuple) {
	walk(v, func(typ uint16, v []byte) {
		switch typ {
		case ctaTupleIP:
			walk(v, func(typ uint16, v []byte) {
				if len(v) != 4 {
					return
				}
				switch typ {
				case ctaIPv4Src:
					copy(t.Src[:], v)
				case ctaIPv4Dst:
					copy(t.Dst[:], v)
				}
			})
		case ctaTupleProto:
			walk(v, func(typ uint16, v []byte) {
				switch {
				case typ == ctaProtoNum && len(v) >= 1:
					t.Proto = v[0]
				case typ == ctaProtoSrc && len(v) >= 2:
					t.SPort = binary.BigEndian.Uint16(v)
				case typ == ctaProtoDst && len(v) >= 2:
					t.DPort = binary.BigEndian.Uint16(v)
				}
			})
		}
	})
}

func counterBytes(v []byte) uint64 {
	var out uint64
	walk(v, func(typ uint16, v []byte) {
		if typ == ctaCountersBytes && len(v) >= 8 {
			out = binary.BigEndian.Uint64(v)
		}
	})
	return out
}

func decode(m []byte, out *message) bool {
	*out = message{}
	if len(m) < headerLen {
		return false
	}
	typ := binary.NativeEndian.Uint16(m[4:])
	flags := binary.NativeEndian.Uint16(m[6:])
	if typ>>8 != unix.NFNL_SUBSYS_CTNETLINK || m[nlmsgHeaderLen] != unix.AF_INET {
		return false
	}
	switch typ & 0xff {
	case msgDelete:
		out.kind = kindDestroy
	case msgNew:
		if flags&unix.NLM_F_CREATE != 0 {
			out.kind = kindNew
		} else {
			out.kind = kindReply
		}
	default:
		return false
	}
	walk(m[headerLen:], func(typ uint16, v []byte) {
		switch typ {
		case ctaTupleOrig:
			decodeTuple(v, &out.key.orig)
		case ctaTupleReply:
			decodeTuple(v, &out.reply)
			out.hasReply = true
		case ctaID:
			if len(v) >= 4 {
				out.key.id = binary.BigEndian.Uint32(v)
			}
		case ctaCountersOrig:
			out.origB = counterBytes(v)
			out.counters = true
		case ctaCountersReply:
			out.replB = counterBytes(v)
			out.counters = true
		case ctaTimestamp:
			walk(v, func(typ uint16, v []byte) {
				if typ == ctaTimestampStart && len(v) >= 8 {
					out.start = int64(binary.BigEndian.Uint64(v))
				}
			})
		case ctaProtoinfo:
			walk(v, func(typ uint16, v []byte) {
				if typ != ctaProtoinfoTCP {
					return
				}
				walk(v, func(typ uint16, v []byte) {
					if typ == ctaProtoinfoTCPState && len(v) >= 1 {
						out.tcp, out.hasTCP = v[0], true
					}
				})
			})
		}
	})
	return true
}

func messages(b []byte, fn func(m []byte)) {
	for len(b) >= nlmsgHeaderLen {
		l := int(binary.NativeEndian.Uint32(b))
		if l < nlmsgHeaderLen || l > len(b) {
			return
		}
		fn(b[:l])
		next := (l + 3) &^ 3
		if next >= len(b) {
			return
		}
		b = b[next:]
	}
}

const tupleAttrLen = 52

func tupleAttr(b []byte, which uint16, t Tuple) []byte {
	var a [tupleAttrLen]byte
	put := func(off int, l, typ uint16) {
		binary.NativeEndian.PutUint16(a[off:], l)
		binary.NativeEndian.PutUint16(a[off+2:], typ)
	}
	put(0, tupleAttrLen, which|nlaNested)
	put(4, 20, ctaTupleIP|nlaNested)
	put(8, 8, ctaIPv4Src)
	copy(a[12:], t.Src[:])
	put(16, 8, ctaIPv4Dst)
	copy(a[20:], t.Dst[:])
	put(24, 28, ctaTupleProto|nlaNested)
	put(28, 5, ctaProtoNum)
	a[32] = t.Proto
	put(36, 6, ctaProtoSrc)
	binary.BigEndian.PutUint16(a[40:], t.SPort)
	put(44, 6, ctaProtoDst)
	binary.BigEndian.PutUint16(a[48:], t.DPort)
	return append(b, a[:]...)
}

func header(b []byte, msg uint16, family byte, seq uint32, bodyLen int) []byte {
	var h [headerLen]byte
	binary.NativeEndian.PutUint32(h[:], uint32(headerLen+bodyLen))
	binary.NativeEndian.PutUint16(h[4:], unix.NFNL_SUBSYS_CTNETLINK<<8|msg)
	binary.NativeEndian.PutUint16(h[6:], unix.NLM_F_REQUEST)
	binary.NativeEndian.PutUint32(h[8:], seq)
	h[16], h[17] = family, unix.NFNETLINK_V0
	return append(b, h[:]...)
}
