package netns

import (
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

const tcpHeader = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"

func tcpRow(sl int, local, state string) string {
	return "   " + strconv.Itoa(sl) + ": " + local + " 00000000:0000 " + state + " 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0\n"
}

func writeProc(t *testing.T, name, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestParseLocalDecodesIPv4InNativeByteOrder(t *testing.T) {
	cases := []struct {
		field string
		want  string
		port  uint16
	}{
		{"0100007F:1F90", "127.0.0.1", 8080},
		{"00000000:0050", "0.0.0.0", 80},
		{"0A01C8AC:01BB", "172.200.1.10", 443},
	}
	for _, c := range cases {
		s, ok := parseLocal(c.field, "tcp")
		if !ok || s.Address != netip.MustParseAddr(c.want) || s.Port != c.port || s.Proto != "tcp" {
			t.Errorf("%s: %+v ok=%v", c.field, s, ok)
		}
	}
}

func TestParseLocalDecodesIPv6AndUnmapsMappedIPv4(t *testing.T) {
	s, ok := parseLocal("00000000000000000000000001000000:0BB8", "tcp")
	if !ok || s.Address != netip.MustParseAddr("::1") || s.Port != 3000 {
		t.Errorf("loopback v6: %+v ok=%v", s, ok)
	}
	s, ok = parseLocal("0000000000000000FFFF00000100007F:1F90", "tcp")
	if !ok || s.Address != netip.MustParseAddr("127.0.0.1") {
		t.Errorf("mapped v4: %+v ok=%v", s, ok)
	}
	s, ok = parseLocal("00000000000000000000000000000000:1F90", "tcp")
	if !ok || s.Address != netip.IPv6Unspecified() {
		t.Errorf("unspecified v6: %+v ok=%v", s, ok)
	}
}

func TestParseLocalRejectsMalformedFields(t *testing.T) {
	for _, f := range []string{"", "0100007F", "0100007F:ZZ", "0100007F:10000", "01007F:1F90", "XYZ:1F90", ":"} {
		if s, ok := parseLocal(f, "tcp"); ok {
			t.Errorf("%q parsed as %+v", f, s)
		}
	}
}

func TestProcSocketsKeepsOnlyListeningRowsAndSkipsHeader(t *testing.T) {
	body := tcpHeader +
		tcpRow(0, "0100007F:1F90", "0A") +
		tcpRow(1, "00000000:0050", "0A") +
		tcpRow(2, "0A01C8AC:01BB", "01") +
		tcpRow(3, "00000000:0000", "0A")
	socks, err := procSockets(writeProc(t, "tcp", body), "tcp", tcpListen)
	if err != nil {
		t.Fatal(err)
	}
	want := []Socket{
		{Address: netip.MustParseAddr("127.0.0.1"), Port: 8080, Proto: "tcp"},
		{Address: netip.MustParseAddr("0.0.0.0"), Port: 80, Proto: "tcp"},
	}
	if !slices.Equal(socks, want) {
		t.Fatalf("got %+v", socks)
	}
}

func TestProcSocketsUDPKeepsUnconnectedState(t *testing.T) {
	body := tcpHeader + tcpRow(0, "00000000:1F90", "07") + tcpRow(1, "00000000:1F91", "01")
	socks, err := procSockets(writeProc(t, "udp", body), "udp", udpClose)
	if err != nil {
		t.Fatal(err)
	}
	if len(socks) != 1 || socks[0].Port != 8080 || socks[0].Proto != "udp" {
		t.Fatalf("got %+v", socks)
	}
}

func TestProcSocketsSkipsShortAndUnparseableRows(t *testing.T) {
	body := tcpHeader + "garbage\n" + "0: nothex:1F90 00000000:0000 0A\n" + tcpRow(1, "0100007F:1F90", "0A")
	socks, err := procSockets(writeProc(t, "tcp", body), "tcp", tcpListen)
	if err != nil {
		t.Fatal(err)
	}
	if len(socks) != 1 {
		t.Fatalf("got %+v", socks)
	}
}

func TestProcSocketsReportsAMissingFile(t *testing.T) {
	_, err := procSockets(filepath.Join(t.TempDir(), "absent"), "tcp", tcpListen)
	if !os.IsNotExist(err) {
		t.Fatalf("got %v", err)
	}
}

func TestLoopbackOnlyIsTrueWhenEveryMatchingSocketIsLoopback(t *testing.T) {
	lo := netip.MustParseAddr("127.0.0.1")
	any4 := netip.MustParseAddr("0.0.0.0")
	cases := []struct {
		name  string
		socks []Socket
		want  bool
	}{
		{"only loopback", []Socket{{lo, 8080, "tcp"}}, true},
		{"loopback v6", []Socket{{netip.MustParseAddr("::1"), 8080, "tcp"}}, true},
		{"wildcard", []Socket{{any4, 8080, "tcp"}}, false},
		{"loopback and wildcard", []Socket{{lo, 8080, "tcp"}, {any4, 8080, "tcp"}}, false},
		{"loopback on another port and wildcard on the declared one", []Socket{{lo, 9090, "tcp"}, {any4, 8080, "tcp"}}, false},
		{"loopback on another port only", []Socket{{lo, 9090, "tcp"}}, false},
		{"another protocol is ignored", []Socket{{lo, 8080, "tcp"}, {any4, 8080, "udp"}}, true},
		{"nothing listening", nil, false},
	}
	for _, c := range cases {
		if got := LoopbackOnly(c.socks, 8080, "tcp"); got != c.want {
			t.Errorf("%s: got %v", c.name, got)
		}
	}
}

func TestListeningReadsAllFourProcTablesAndRanksTheDeclaredPortFirst(t *testing.T) {
	dir := t.TempDir()
	net := filepath.Join(dir, "net")
	if err := os.MkdirAll(net, 0o755); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"tcp":  tcpHeader + tcpRow(0, "0100007F:2328", "0A") + tcpRow(1, "0100007F:1F90", "0A"),
		"tcp6": tcpHeader + tcpRow(0, "00000000000000000000000001000000:1F90", "0A"),
		"udp":  tcpHeader + tcpRow(0, "00000000:1F90", "07"),
		"udp6": tcpHeader,
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(net, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	socks, err := listeningIn(net+"/", 8080, "tcp")
	if err != nil {
		t.Fatal(err)
	}
	if len(socks) != 4 {
		t.Fatalf("got %+v", socks)
	}
	if socks[0].Port != 8080 || socks[0].Proto != "tcp" || socks[1].Port != 8080 || socks[1].Proto != "tcp" {
		t.Errorf("declared tcp port not first: %+v", socks)
	}
	if socks[2].Port != 8080 || socks[2].Proto != "udp" {
		t.Errorf("same port other protocol not next: %+v", socks)
	}
	if socks[3].Port != 9000 {
		t.Errorf("other port last: %+v", socks)
	}
}

func TestListeningDeduplicatesSocketsSeenInBothTables(t *testing.T) {
	dir := t.TempDir()
	row := tcpRow(0, "0100007F:1F90", "0A")
	for name, body := range map[string]string{"tcp": tcpHeader + row + row, "tcp6": tcpHeader, "udp": tcpHeader, "udp6": tcpHeader} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	socks, err := listeningIn(dir+"/", 8080, "tcp")
	if err != nil {
		t.Fatal(err)
	}
	if len(socks) != 1 {
		t.Fatalf("got %+v", socks)
	}
}

func TestListeningCapsTheResultAtSocketsMax(t *testing.T) {
	dir := t.TempDir()
	var rows strings.Builder
	rows.WriteString(tcpHeader)
	for i := 0; i < SocketsMax+10; i++ {
		rows.WriteString(tcpRow(i, "00000000:"+strings.ToUpper(strconv.FormatInt(int64(0x2000+i), 16)), "0A"))
	}
	for name, body := range map[string]string{"tcp": rows.String(), "tcp6": tcpHeader, "udp": tcpHeader, "udp6": tcpHeader} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	socks, err := listeningIn(dir+"/", 0x2005, "tcp")
	if err != nil {
		t.Fatal(err)
	}
	if len(socks) != SocketsMax {
		t.Fatalf("got %d", len(socks))
	}
	if socks[0].Port != 0x2005 {
		t.Errorf("declared port must survive the cap: %+v", socks[0])
	}
}

func TestListeningToleratesSomeMissingTablesButFailsWhenNoneRead(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "tcp"), []byte(tcpHeader+tcpRow(0, "0100007F:1F90", "0A")), 0o600); err != nil {
		t.Fatal(err)
	}
	socks, err := listeningIn(dir+"/", 8080, "tcp")
	if err != nil || len(socks) != 1 {
		t.Fatalf("partial: %+v %v", socks, err)
	}
	socks, err = listeningIn(t.TempDir()+"/", 8080, "tcp")
	if err != nil || len(socks) != 0 {
		t.Fatalf("nothing there: %+v %v", socks, err)
	}
}

func TestListeningDumpSplitsSectionsAndRanksTheQueriedPortFirst(t *testing.T) {
	dump := SectionMark + "tcp\n" + tcpHeader + tcpRow(0, "0100007F:0BB8", "0A") + tcpRow(1, "00000000:1F90", "0A") +
		SectionMark + "tcp6\n" + tcpHeader +
		SectionMark + "udp\n" + tcpHeader + tcpRow(0, "00000000:0035", "07") +
		SectionMark + "udp6\n" + tcpHeader
	socks, err := ListeningDump([]byte(dump), 8080, "tcp")
	if err != nil {
		t.Fatal(err)
	}
	want := []Socket{
		{Address: netip.MustParseAddr("0.0.0.0"), Port: 8080, Proto: "tcp"},
		{Address: netip.MustParseAddr("127.0.0.1"), Port: 3000, Proto: "tcp"},
		{Address: netip.MustParseAddr("0.0.0.0"), Port: 53, Proto: "udp"},
	}
	if !slices.Equal(socks, want) {
		t.Fatalf("got %+v", socks)
	}
}

func TestListeningDumpWithoutSectionsFails(t *testing.T) {
	if _, err := ListeningDump([]byte("sh: cat: not found\n"), 80, "tcp"); err == nil {
		t.Fatal("a dump with no section must be an error")
	}
}

func TestListeningDumpParsesRunscExecOutputFromGVisor(t *testing.T) {
	dump, err := os.ReadFile(filepath.Join("testdata", "gvisor-proc-net.txt"))
	if err != nil {
		t.Fatal(err)
	}
	socks, err := ListeningDump(dump, 8080, "tcp")
	if err != nil {
		t.Fatal(err)
	}
	want := []Socket{{Address: netip.MustParseAddr("0.0.0.0"), Port: 8080, Proto: "tcp"}}
	if !slices.Equal(socks, want) {
		t.Fatalf("got %+v", socks)
	}
}

func TestListeningSkipsDockersEmbeddedResolver(t *testing.T) {
	dir := t.TempDir()
	resolver := tcpRow(0, "0B00007F:894B", "0A")
	app := tcpRow(1, "00000000:0BB8", "0A")
	for name, body := range map[string]string{"tcp": tcpHeader + resolver + app, "tcp6": tcpHeader, "udp": tcpHeader + tcpRow(0, "0B00007F:A1B2", "07"), "udp6": tcpHeader} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	socks, err := listeningIn(dir+"/", 80, "tcp")
	if err != nil {
		t.Fatal(err)
	}
	want := []Socket{{Address: netip.MustParseAddr("0.0.0.0"), Port: 3000, Proto: "tcp"}}
	if !slices.Equal(socks, want) {
		t.Fatalf("got %+v", socks)
	}
}
