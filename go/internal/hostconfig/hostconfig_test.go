package hostconfig

import (
	"strings"
	"testing"
)

func TestLitestreamValidate(t *testing.T) {
	ok := Litestream{Bucket: "sly-backups", AccessKey: "AK", SecretKey: "SK"}
	cases := []struct {
		name   string
		mutate func(*Litestream)
		valid  bool
	}{
		{"bucket only", func(*Litestream) {}, true},
		{"https endpoint", func(l *Litestream) { l.Endpoint = "https://abc.r2.cloudflarestorage.com" }, true},
		{"http on a private address", func(l *Litestream) { l.Endpoint = "http://10.0.0.5:9000" }, true},
		{"http on loopback", func(l *Litestream) { l.Endpoint = "http://127.0.0.1:9000" }, true},
		{"http on a public address", func(l *Litestream) { l.Endpoint = "http://8.8.8.8:9000" }, false},
		{"http on a name", func(l *Litestream) { l.Endpoint = "http://minio.lan:9000" }, false},
		{"credentials in the url", func(l *Litestream) { l.Endpoint = "https://u:p@host" }, false},
		{"ftp", func(l *Litestream) { l.Endpoint = "ftp://10.0.0.5" }, false},
		{"upper case bucket", func(l *Litestream) { l.Bucket = "Sly" }, false},
		{"short bucket", func(l *Litestream) { l.Bucket = "ab" }, false},
		{"no access key", func(l *Litestream) { l.AccessKey = "" }, false},
		{"no secret", func(l *Litestream) { l.SecretKey = "" }, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			l := ok
			c.mutate(&l)
			if err := l.Validate(); (err == nil) != c.valid {
				t.Fatalf("Validate() = %v, want valid %v", err, c.valid)
			}
		})
	}
}

func TestMasterKeyFromRecoveryInvertsRecoveryKey(t *testing.T) {
	key, err := NewMasterKey()
	if err != nil {
		t.Fatal(err)
	}
	recovery, err := (&Config{Dispatch: Dispatch{MasterKey: key}}).RecoveryKey()
	if err != nil {
		t.Fatal(err)
	}
	got, err := MasterKeyFromRecovery(recovery)
	if err != nil || got != key {
		t.Fatalf("%q %v, want %q", got, err, key)
	}
	got, err = MasterKeyFromRecovery("  " + strings.ToLower(recovery) + "\n")
	if err != nil || got != key {
		t.Fatalf("a retyped recovery key in lower case with spaces parsed to %q, %v", got, err)
	}
}

func TestMasterKeyFromRecoveryRefusesOtherText(t *testing.T) {
	for _, in := range []string{"", "sly-rk-", "sly-rk-AAAA", "xyz-rk-AAAA", "sly-rk-!!!!"} {
		if _, err := MasterKeyFromRecovery(in); err == nil {
			t.Fatalf("%q parsed", in)
		}
	}
}
