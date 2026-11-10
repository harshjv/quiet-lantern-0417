//go:build linux

package netns

import (
	"bytes"
	"slices"
	"testing"

	"github.com/google/nftables"
	"github.com/mdlayher/netlink"
	"golang.org/x/sys/unix"
)

func recordingConn(t *testing.T) (*nftables.Conn, *[]netlink.HeaderType) {
	t.Helper()
	var sent []netlink.HeaderType
	c, err := nftables.New(nftables.WithTestDial(func(req []netlink.Message) ([]netlink.Message, error) {
		for _, m := range req {
			if m.Header.Type>>8 == unix.NFNL_SUBSYS_NFTABLES {
				sent = append(sent, m.Header.Type&0xff)
			}
		}
		return nil, nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	return c, &sent
}

var testSet = &nftables.Set{Table: &nftables.Table{Name: "sly-test", Family: nftables.TableFamilyINet}, Name: "addrs", KeyType: nftables.TypeIPAddr}

func elements(keys ...byte) []nftables.SetElement {
	var out []nftables.SetElement
	for _, k := range keys {
		out = append(out, nftables.SetElement{Key: []byte{10, 0, 0, k}})
	}
	return out
}

func TestApplySetOpsSkipsTheFlushWhenNothingChanged(t *testing.T) {
	c, sent := recordingConn(t)
	changed, err := applySetOps(c, false, setOp{set: testSet}, setOp{set: testSet, del: true})
	if err != nil || changed || len(*sent) != 0 {
		t.Fatalf("changed %v err %v sent %v, want no change and nothing sent", changed, err, *sent)
	}
}

func TestApplySetOpsReportsAnEarlierChangeWithoutElements(t *testing.T) {
	c, sent := recordingConn(t)
	changed, err := applySetOps(c, true, setOp{set: testSet})
	if err != nil || !changed || len(*sent) != 0 {
		t.Fatalf("changed %v err %v sent %v, want a change and nothing sent", changed, err, *sent)
	}
}

func TestApplySetOpsSendsEachNonEmptyOpInOrderInOneFlush(t *testing.T) {
	c, sent := recordingConn(t)
	changed, err := applySetOps(c, false,
		setOp{set: testSet, els: elements(1), del: true},
		setOp{set: testSet},
		setOp{set: testSet, els: elements(2, 3)},
	)
	want := []netlink.HeaderType{unix.NFT_MSG_DELSETELEM, unix.NFT_MSG_NEWSETELEM}
	if err != nil || !changed || !slices.Equal(*sent, want) {
		t.Fatalf("changed %v err %v sent %v, want a change sending %v", changed, err, *sent, want)
	}
}

func byKey(a, b nftables.SetElement) int {
	return bytes.Compare(a.Key, b.Key)
}

func TestDiffElementsDeletesStaleKeysAndAddsNewAndChangedValues(t *testing.T) {
	have := map[byte]byte{1: 10, 2: 20, 3: 30}
	want := map[byte]byte{2: 20, 3: 31, 4: 40}
	key := func(k byte) []byte { return []byte{k} }
	val := func(v byte) []byte { return []byte{v} }
	del, add := diffElements(have, want, key, val)
	slices.SortFunc(del, byKey)
	slices.SortFunc(add, byKey)
	wantDel := []nftables.SetElement{{Key: []byte{1}}, {Key: []byte{3}}}
	wantAdd := []nftables.SetElement{{Key: []byte{3}, Val: []byte{31}}, {Key: []byte{4}, Val: []byte{40}}}
	if !slices.EqualFunc(del, wantDel, sameElement) || !slices.EqualFunc(add, wantAdd, sameElement) {
		t.Fatalf("del %v add %v, want del %v add %v", del, add, wantDel, wantAdd)
	}
	_, keysOnly := diffElements(map[byte]bool{}, map[byte]bool{5: true}, key, nil)
	if len(keysOnly) != 1 || keysOnly[0].Val != nil {
		t.Fatalf("add without a value func %v, want one element with no value", keysOnly)
	}
	if del, add := diffElements(want, want, key, val); del != nil || add != nil {
		t.Fatalf("equal maps diff to del %v add %v, want nothing", del, add)
	}
}

func sameElement(a, b nftables.SetElement) bool {
	return bytes.Equal(a.Key, b.Key) && bytes.Equal(a.Val, b.Val)
}
