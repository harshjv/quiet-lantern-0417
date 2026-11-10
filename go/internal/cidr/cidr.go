package cidr

import (
	"encoding/binary"
	"net/netip"
)

func toUint(a netip.Addr) uint32 {
	b := a.As4()
	return binary.BigEndian.Uint32(b[:])
}

func fromUint(v uint32) netip.Addr {
	var b [4]byte
	binary.BigEndian.PutUint32(b[:], v)
	return netip.AddrFrom4(b)
}

func Offset(p netip.Prefix, n uint32) netip.Addr {
	return fromUint(toUint(p.Masked().Addr()) + n)
}

func Slash24(pool netip.Prefix, index int) netip.Prefix {
	return netip.PrefixFrom(Offset(pool, uint32(index)<<8), 24)
}

func UpperHalf(p netip.Prefix) netip.Prefix {
	return netip.PrefixFrom(Offset(p, 1<<(32-p.Bits()-1)), p.Bits()+1)
}

func Last(p netip.Prefix) netip.Addr {
	return Offset(p, 1<<(32-p.Bits())-1)
}
