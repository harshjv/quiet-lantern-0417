package credproxy

import (
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"net"
	"slices"
	"testing"
	"time"
)

const (
	credentialHost = "api.credential.test"
	secondHost     = "api2.credential.test"
)

var testHosts = []string{secondHost, credentialHost}

func testCA(t *testing.T, name string, hosts []string, now time.Time) *CA {
	t.Helper()
	ca, err := NewCA(name, hosts, now)
	if err != nil {
		t.Fatal(err)
	}
	return ca
}

func caPool(ca *CA) *x509.CertPool {
	pool := x509.NewCertPool()
	pool.AddCert(ca.Cert)
	return pool
}

func signedBy(t *testing.T, ca *CA, now time.Time, dns []string, ips []net.IP) *x509.Certificate {
	t.Helper()
	serial, err := serialNumber()
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "leaf"},
		DNSNames:     dns,
		IPAddresses:  ips,
		NotBefore:    now.Add(-time.Minute),
		NotAfter:     now.Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.Cert, &ca.Key.PublicKey, ca.Key)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return leaf
}

func verifies(leaf *x509.Certificate, ca *CA, now time.Time) error {
	_, err := leaf.Verify(x509.VerifyOptions{Roots: caPool(ca), CurrentTime: now, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}})
	return err
}

func TestTheCAIsAConstrainedLeafOnlyAuthority(t *testing.T) {
	now := time.Now()
	ca := testCA(t, "sbx_test", testHosts, now)
	c := ca.Cert
	if !c.IsCA || !c.MaxPathLenZero || c.MaxPathLen != 0 {
		t.Errorf("IsCA %v, MaxPathLenZero %v, MaxPathLen %d; want a CA with path length zero", c.IsCA, c.MaxPathLenZero, c.MaxPathLen)
	}
	if !c.PermittedDNSDomainsCritical || !slices.Equal(c.PermittedDNSDomains, []string{credentialHost, secondHost}) {
		t.Errorf("permitted %v (critical %v), want the credential hosts, critical", c.PermittedDNSDomains, c.PermittedDNSDomainsCritical)
	}
	var excluded []string
	for _, r := range c.ExcludedIPRanges {
		excluded = append(excluded, r.String())
	}
	if !slices.Equal(excluded, []string{"0.0.0.0/0", "::/0"}) {
		t.Errorf("excluded IP ranges %v, want every IPv4 and IPv6 address", excluded)
	}
	if _, err := NewCA("sbx_test", nil, now); err == nil {
		t.Error("a CA was made with no hosts")
	}
}

func TestTheCAsSignatureIsWorthNothingOutsideTheCredentialHosts(t *testing.T) {
	now := time.Now()
	ca := testCA(t, "sbx_test", testHosts, now)
	for _, name := range []string{credentialHost, secondHost} {
		if err := verifies(signedBy(t, ca, now, []string{name}, nil), ca, now); err != nil {
			t.Errorf("a leaf for %s does not verify: %v", name, err)
		}
	}
	refused := []struct {
		name string
		dns  []string
		ips  []net.IP
	}{
		{"another name", []string{"api.anthropic.com"}, nil},
		{"the parent domain", []string{"credential.test"}, nil},
		{"a name that only ends like a credential host", []string{"evilapi.credential.test"}, nil},
		{"a credential host and another name", []string{credentialHost, "github.com"}, nil},
		{"an IPv4 address", nil, []net.IP{net.ParseIP("160.79.104.10")}},
		{"a loopback IPv4 address", nil, []net.IP{net.ParseIP("127.0.0.1")}},
		{"a credential host and an IPv4 address", []string{credentialHost}, []net.IP{net.ParseIP("10.0.0.1")}},
		{"an IPv6 address", nil, []net.IP{net.ParseIP("2607:6bc0::10")}},
		{"a loopback IPv6 address", nil, []net.IP{net.ParseIP("::1")}},
	}
	for _, tc := range refused {
		if err := verifies(signedBy(t, ca, now, tc.dns, tc.ips), ca, now); err == nil {
			t.Errorf("a leaf for %s verifies against the credentials CA", tc.name)
		}
	}
}

func TestALeafNamesOnlyItsHost(t *testing.T) {
	now := time.Now()
	ca := testCA(t, "sbx_test", testHosts, now)
	c, err := ca.Leaf(credentialHost, now)
	if err != nil {
		t.Fatal(err)
	}
	leaf := c.Leaf
	if !slices.Equal(leaf.DNSNames, []string{credentialHost}) || len(leaf.IPAddresses) != 0 || len(leaf.EmailAddresses) != 0 || len(leaf.URIs) != 0 {
		t.Errorf("leaf names DNS %v, IPs %v, emails %v, URIs %v; want only %s", leaf.DNSNames, leaf.IPAddresses, leaf.EmailAddresses, leaf.URIs, credentialHost)
	}
	if leaf.IsCA || !slices.Equal(leaf.ExtKeyUsage, []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}) {
		t.Errorf("leaf IsCA %v, ext key usage %v; want a server-only end entity", leaf.IsCA, leaf.ExtKeyUsage)
	}
	if got := leaf.NotAfter.Sub(now); got > LeafValidity {
		t.Errorf("leaf lives %v, want at most %v", got, LeafValidity)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: caPool(ca), DNSName: credentialHost, CurrentTime: now}); err != nil {
		t.Errorf("leaf does not verify for its host: %v", err)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: caPool(ca), DNSName: secondHost, CurrentTime: now}); err == nil {
		t.Error("the leaf for one credential host verifies for another")
	}
	if again, _ := ca.Leaf(credentialHost, now); again != c {
		t.Error("a fresh leaf was not reused")
	}
	if renewed, _ := ca.Leaf(credentialHost, now.Add(LeafValidity-leafRenew)); renewed == c {
		t.Error("a leaf with an hour left was not reissued")
	}
}

func TestTheProxyIssuesLeavesOnlyForCredentialHosts(t *testing.T) {
	now := time.Now()
	p := New(Config{Hosts: testHosts, CA: testCA(t, "sbx_test", testHosts, now), Log: discardLog()})
	for _, name := range []string{"api.anthropic.com", "evil.test", "", "127.0.0.1"} {
		if c, err := p.tlsConfig.GetCertificate(&tls.ClientHelloInfo{ServerName: name}); err == nil || c != nil {
			t.Errorf("SNI %q got a leaf", name)
		}
	}
	c, err := p.tlsConfig.GetCertificate(&tls.ClientHelloInfo{ServerName: "API.Credential.Test"})
	if err != nil || !slices.Equal(c.Leaf.DNSNames, []string{credentialHost}) {
		t.Errorf("a credential SNI in another case got %v, %v; want the leaf for %s", c, err, credentialHost)
	}
}

func TestAStoredCAFitsOnlyItsHostsAndUntilItNearsItsEnd(t *testing.T) {
	now := time.Now()
	ca := testCA(t, "sbx_test", testHosts, now)
	keyPEM, err := ca.KeyPEM()
	if err != nil {
		t.Fatal(err)
	}
	stored, err := ParseCA(ca.CertPEM(), keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	if !stored.Cert.Equal(ca.Cert) || !stored.Key.Equal(ca.Key) {
		t.Fatal("the stored CA is not the CA that was written")
	}
	if !stored.Fits([]string{credentialHost, secondHost}, now) {
		t.Error("a CA does not fit its own hosts")
	}
	if stored.Fits([]string{credentialHost}, now) || stored.Fits([]string{credentialHost, secondHost, "api.openai.com"}, now) {
		t.Error("a CA fits a changed host list")
	}
	if stored.Fits(testHosts, stored.Cert.NotAfter.Add(-CARenewBelow)) {
		t.Error("a CA with 30 days left still fits")
	}
	if _, err := ParseCA([]byte("not pem"), keyPEM); err == nil {
		t.Error("a broken certificate file parsed")
	}
}
