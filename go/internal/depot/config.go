package depot

import (
	"fmt"
	"net/netip"
)

const (
	ConfigPath  = "/etc/distribution/config.yml"
	JWKSPath    = "/etc/distribution/stationd.jwks.json"
	StoragePath = "/var/lib/stationly/depot"
)

func Config(front, dist netip.AddrPort, readonly bool) []byte {
	return fmt.Appendf(nil, `version: 0.1
log:
  level: info
storage:
  filesystem:
    rootdirectory: %s
  delete:
    enabled: true
  maintenance:
    readonly:
      enabled: %t
http:
  addr: %s
auth:
  token:
    realm: http://%s/token
    service: %s
    issuer: %s
    jwks: %s
`, StoragePath, readonly, dist, front, Service, Issuer, JWKSPath)
}
