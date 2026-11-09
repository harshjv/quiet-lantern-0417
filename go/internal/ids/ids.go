package ids

import (
	"crypto/rand"
	"encoding/binary"
	"time"
)

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

func New(prefix string) string {
	var b [16]byte
	binary.BigEndian.PutUint64(b[:8], uint64(time.Now().UnixMilli())<<16)
	rand.Read(b[6:])
	out := make([]byte, 26)
	var acc uint64
	bits := 0
	j := 0
	for i := 0; i < 16 && j < 26; i++ {
		acc = acc<<8 | uint64(b[i])
		bits += 8
		for bits >= 5 && j < 26 {
			bits -= 5
			out[j] = crockford[(acc>>bits)&31]
			j++
		}
	}
	for j < 26 {
		out[j] = crockford[(acc<<(5-bits))&31]
		bits = 0
		j++
	}
	return prefix + "_" + string(out)
}
