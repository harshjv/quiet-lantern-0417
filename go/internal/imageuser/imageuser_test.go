package imageuser

import (
	"slices"
	"strings"
	"testing"
)

const (
	passwd = "root:x:0:0:root:/root:/bin/sh\n# comment\n\nbroken:x:nope:1::/:/bin/sh\napp:x:1000:1001::/home/app:/bin/sh\n"
	group  = "root:x:0:\nstaff:x:50:app\n"
)

func TestResolve(t *testing.T) {
	cases := []struct {
		spec     string
		uid, gid int
	}{
		{"", 0, 0},
		{"root", 0, 0},
		{"0:0", 0, 0},
		{"app", 1000, 1001},
		{"app:staff", 1000, 50},
		{"app:7", 1000, 7},
		{"1000", 1000, 1001},
		{"4242", 4242, 0},
		{"4242:43", 4242, 43},
		{"4242:staff", 4242, 50},
		{"broken", 0, 1},
	}
	for _, c := range cases {
		uid, gid, _, err := Resolve(c.spec, []byte(passwd), []byte(group))
		if err != nil || uid != c.uid || gid != c.gid {
			t.Errorf("Resolve(%q) = %d, %d, %v; want %d, %d", c.spec, uid, gid, err, c.uid, c.gid)
		}
	}
}

func TestResolveRefuses(t *testing.T) {
	for _, spec := range []string{":", "app:", ":staff", "nobody", "app:nogroup", "-1", "4294967295", "app:4294967295"} {
		if uid, gid, _, err := Resolve(spec, []byte(passwd), []byte(group)); err == nil {
			t.Errorf("Resolve(%q) = %d, %d, want an error", spec, uid, gid)
		}
	}
}

func TestResolveWithoutAccountFiles(t *testing.T) {
	uid, gid, _, err := Resolve("1234:5", nil, nil)
	if err != nil || uid != 1234 || gid != 5 {
		t.Errorf("Resolve(1234:5) = %d, %d, %v; want 1234, 5", uid, gid, err)
	}
	if _, _, _, err := Resolve("root", nil, nil); err == nil {
		t.Error("Resolve(root) without /etc/passwd succeeded")
	}
	if _, _, _, err := Resolve("1234:staff", nil, nil); err == nil {
		t.Error("Resolve(1234:staff) without /etc/group succeeded")
	}
}

func TestResolveSupplementaryGroups(t *testing.T) {
	const members = "root:x:0:\nstaff:x:50:app\ndocker:x:998:app,other\n"
	cases := []struct {
		spec   string
		groups []int
	}{
		{"app", []int{50, 998}},
		{"1000", []int{50, 998}},
		{"other", []int{998}},
		{"app:staff", nil},
		{"1000:1001", nil},
		{"root", nil},
	}
	for _, c := range cases {
		_, _, groups, err := Resolve(c.spec, []byte(passwd+"other:x:1002:1002::/:/bin/sh\n"), []byte(members))
		if err != nil {
			t.Fatalf("Resolve(%q): %v", c.spec, err)
		}
		if !slices.Equal(groups, c.groups) {
			t.Errorf("Resolve(%q) groups = %v; want %v", c.spec, groups, c.groups)
		}
	}
}

func TestResolveSkipsBrokenGroupLines(t *testing.T) {
	const members = "bad:x:notnum:app\nroot:x:0:\ntoobig:x:4294967295:app\nneg:x:-1:app\nshort:x\n" +
		"docker:x:998:app\n" + "long:x:77:" + "app,pad,pad,pad,pad,pad,pad,pad,pad\n"
	_, _, groups, err := Resolve("app", []byte(passwd), []byte(members))
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if want := []int{998, 77}; !slices.Equal(groups, want) {
		t.Errorf("groups = %v; want %v", groups, want)
	}
}

func TestResolveIgnoresOversizedGroupLine(t *testing.T) {
	huge := "huge:x:5:app," + strings.Repeat("u,", maxGroupLine) + "\ndocker:x:998:app\n"
	_, _, groups, err := Resolve("app", []byte(passwd), []byte(huge))
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if want := []int{998}; !slices.Equal(groups, want) {
		t.Errorf("groups = %v; want %v", groups, want)
	}
}
