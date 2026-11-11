package imageuser

import "testing"

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
		uid, gid, err := Resolve(c.spec, []byte(passwd), []byte(group))
		if err != nil || uid != c.uid || gid != c.gid {
			t.Errorf("Resolve(%q) = %d, %d, %v; want %d, %d", c.spec, uid, gid, err, c.uid, c.gid)
		}
	}
}

func TestResolveRefuses(t *testing.T) {
	for _, spec := range []string{":", "app:", ":staff", "nobody", "app:nogroup", "-1", "4294967295", "app:4294967295"} {
		if uid, gid, err := Resolve(spec, []byte(passwd), []byte(group)); err == nil {
			t.Errorf("Resolve(%q) = %d, %d, want an error", spec, uid, gid)
		}
	}
}

func TestResolveWithoutAccountFiles(t *testing.T) {
	uid, gid, err := Resolve("1234:5", nil, nil)
	if err != nil || uid != 1234 || gid != 5 {
		t.Errorf("Resolve(1234:5) = %d, %d, %v; want 1234, 5", uid, gid, err)
	}
	if _, _, err := Resolve("root", nil, nil); err == nil {
		t.Error("Resolve(root) without /etc/passwd succeeded")
	}
	if _, _, err := Resolve("1234:staff", nil, nil); err == nil {
		t.Error("Resolve(1234:staff) without /etc/group succeeded")
	}
}
