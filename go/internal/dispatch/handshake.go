package dispatch

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"regexp"
)

const (
	helloPrefix  = "stationly-station-protocol-v1\x00"
	enrollPrefix = "stationly-station-enroll-v1\x00"
	nonceLen     = 32
)

var stationIDPattern = regexp.MustCompile(`^stn_[0-9A-HJKMNP-TV-Z]{26}$`)

func HelloMessage(nonce []byte, stationID string, timestampMs uint64) ([]byte, error) {
	if len(nonce) != nonceLen {
		return nil, fmt.Errorf("nonce is %d bytes, want %d", len(nonce), nonceLen)
	}
	if !stationIDPattern.MatchString(stationID) {
		return nil, fmt.Errorf("station id %q is not stn_ plus 26 Crockford base32 characters", stationID)
	}
	var msg []byte
	msg = append(msg, helloPrefix...)
	msg = append(msg, nonce...)
	msg = append(msg, stationID...)
	return binary.BigEndian.AppendUint64(msg, timestampMs), nil
}

func EnrollMessage(nonce []byte, token string, timestampMs uint64) ([]byte, error) {
	if len(nonce) != nonceLen {
		return nil, fmt.Errorf("nonce is %d bytes, want %d", len(nonce), nonceLen)
	}
	sum := sha256.Sum256([]byte(token))
	var msg []byte
	msg = append(msg, enrollPrefix...)
	msg = append(msg, nonce...)
	msg = append(msg, sum[:]...)
	return binary.BigEndian.AppendUint64(msg, timestampMs), nil
}

func sign(key ed25519.PrivateKey, msg []byte) []byte {
	return ed25519.Sign(key, msg)
}
