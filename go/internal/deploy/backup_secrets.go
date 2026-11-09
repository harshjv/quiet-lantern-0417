//go:build linux

package deploy

import (
	"encoding/base64"
	"fmt"
	"time"

	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/s3store"
)

const (
	backupAccessKeyID     = "STATIONLY_S3_ACCESS_KEY_ID"
	backupSecretAccessKey = "STATIONLY_S3_SECRET_ACCESS_KEY"
	backupSecretsTTL      = 10 * time.Minute
)

type backupCredential struct {
	creds s3store.Credentials
	at    time.Time
}

func decodeBackupCredentials(body protocol.SecretsDeliverBody) (s3store.Credentials, error) {
	var c s3store.Credentials
	for _, v := range body.Values {
		raw, err := base64.RawURLEncoding.DecodeString(v.Value)
		if err != nil {
			return c, fmt.Errorf("backup credential %s is not base64url", v.Key)
		}
		switch v.Key {
		case backupAccessKeyID:
			c.AccessKeyID = string(raw)
		case backupSecretAccessKey:
			c.SecretAccessKey = string(raw)
		}
	}
	if c.AccessKeyID == "" || c.SecretAccessKey == "" {
		return c, fmt.Errorf("the delivery holds no %s and %s", backupAccessKeyID, backupSecretAccessKey)
	}
	return c, nil
}

func (s *Station) storeBackupCredentials(snapshotID string, c s3store.Credentials, now time.Time) {
	for id, held := range s.backupSecrets {
		if now.Sub(held.at) > backupSecretsTTL {
			delete(s.backupSecrets, id)
		}
	}
	s.backupSecrets[snapshotID] = backupCredential{creds: c, at: now}
}

func (s *Station) takeBackupCredentials(snapshotID string) (s3store.Credentials, bool) {
	held, ok := s.backupSecrets[snapshotID]
	delete(s.backupSecrets, snapshotID)
	return held.creds, ok
}
