package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type fakeCall struct {
	match string
	out   string
	err   error
}

type fake struct {
	calls     []string
	responses []fakeCall
}

func (f *fake) run(_ context.Context, name string, args ...string) (string, error) {
	argv := strings.Join(append([]string{name}, args...), " ")
	f.calls = append(f.calls, argv)
	for _, r := range f.responses {
		if strings.HasPrefix(argv, r.match) {
			return r.out, r.err
		}
	}
	return "", nil
}

func (f *fake) rename(from, to string) error {
	f.calls = append(f.calls, "rename "+from+" "+to)
	return nil
}

func install(t *testing.T, responses ...fakeCall) *fake {
	t.Helper()
	f := &fake{responses: responses}
	oldRun, oldRename := run, rename
	run, rename = f.run, f.rename
	t.Cleanup(func() { run, rename = oldRun, oldRename })
	return f
}

func tempFS(t *testing.T, dirs ...string) FS {
	t.Helper()
	root := t.TempDir()
	for _, d := range dirs {
		if err := os.MkdirAll(filepath.Join(root, d), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return Open(root)
}

func expandMount(f FS, calls []string) []string {
	out := make([]string, len(calls))
	for i, c := range calls {
		out[i] = strings.ReplaceAll(c, "$M", f.Mount)
	}
	return out
}

func checkCalls(t *testing.T, f FS, got *fake, want ...string) {
	t.Helper()
	if w := expandMount(f, want); !reflect.DeepEqual(got.calls, w) {
		t.Fatalf("calls:\n got %q\nwant %q", got.calls, w)
	}
}

func gib(n float64) uint64 { return uint64(n * GiB) }

func TestDefaultSize(t *testing.T) {
	for _, tc := range []struct {
		free uint64
		want uint64
		ok   bool
	}{
		{gib(28.7), gib(28.7) / 2, true},
		{20 * GiB, 10 * GiB, true},
		{gib(19.9), 0, false},
		{100 * GiB, 50 * GiB, true},
		{30 * GiB, 15 * GiB, true},
		{21 * GiB, gib(10.5), true},
		{0, 0, false},
	} {
		got, ok := DefaultSize(tc.free)
		if got != tc.want || ok != tc.ok {
			t.Errorf("DefaultSize(%d) = %d, %v; want %d, %v", tc.free, got, ok, tc.want, tc.ok)
		}
	}
	if got, _ := DefaultSize(gib(28.7)); got/(GiB/100) != 1435 {
		t.Errorf("28.7 GiB free gives %d, want 14.35 GiB", got)
	}
}

func TestCheckSize(t *testing.T) {
	for _, tc := range []struct {
		size, free uint64
		ok         bool
	}{
		{10 * GiB, 20 * GiB, true},
		{10*GiB - 1, 100 * GiB, false},
		{15 * GiB, 25 * GiB, true},
		{15 * GiB, 25*GiB - 1, false},
		{50 * GiB, 30 * GiB, false},
	} {
		err := CheckSize(tc.size, tc.free)
		if (err == nil) != tc.ok {
			t.Errorf("CheckSize(%d, %d) = %v", tc.size, tc.free, err)
		}
		if err != nil && !errors.Is(err, ErrInvalidSize) {
			t.Errorf("CheckSize error %v does not wrap ErrInvalidSize", err)
		}
	}
}

func TestCheckGrowAndMaxGrow(t *testing.T) {
	cur := uint64(14 * GiB)
	for _, tc := range []struct {
		requested, rootFree uint64
		ok                  bool
	}{
		{18 * GiB, 14 * GiB, true},
		{18 * GiB, 14*GiB - 1, false},
		{cur, 100 * GiB, false},
		{cur - 1, 100 * GiB, false},
		{cur + 1, 10 * GiB, false},
		{cur + 1, 10*GiB + 1, true},
		{100 * GiB, 12 * GiB, false},
	} {
		err := CheckGrow(cur, tc.requested, tc.rootFree)
		if (err == nil) != tc.ok {
			t.Errorf("CheckGrow(%d, %d, %d) = %v", cur, tc.requested, tc.rootFree, err)
		}
		if err != nil && !errors.Is(err, ErrInvalidSize) {
			t.Errorf("CheckGrow error %v does not wrap ErrInvalidSize", err)
		}
	}
	for _, tc := range []struct{ rootFree, want uint64 }{
		{14 * GiB, 18 * GiB},
		{10 * GiB, cur},
		{5 * GiB, cur},
		{10*GiB + 1, cur + 1},
	} {
		got := MaxGrow(cur, tc.rootFree)
		if got != tc.want {
			t.Errorf("MaxGrow(%d, %d) = %d, want %d", cur, tc.rootFree, got, tc.want)
		}
		if got > cur && CheckGrow(cur, got, tc.rootFree) != nil {
			t.Errorf("CheckGrow refuses MaxGrow result %d", got)
		}
		if CheckGrow(cur, got+1, tc.rootFree) == nil {
			t.Errorf("CheckGrow accepts %d above MaxGrow", got+1)
		}
	}
}

func TestKernelSupported(t *testing.T) {
	for release, want := range map[string]bool{
		"6.8.0-138-generic":                true,
		"6.7":                              true,
		"6.7.0":                            true,
		"6.6.87.2-microsoft-standard-WSL2": false,
		"5.15.0-1-amd64":                   false,
		"6.1.0-26-amd64":                   false,
		"7.0.14-linuxkit":                  true,
		"6.12.48+deb13-amd64":              true,
		"6.10-rc1":                         true,
		"6":                                false,
		"":                                 false,
		"linux":                            false,
		"10.2.0":                           true,
	} {
		if got := KernelSupported(release); got != want {
			t.Errorf("KernelSupported(%q) = %v, want %v", release, got, want)
		}
	}
}

const qgroupShowSimple = `Qgroupid    Referenced    Exclusive  Max referenced  Max exclusive   Path 
--------    ----------    ---------  --------------  -------------   ---- 
0/5             131072       131072            none           none   <toplevel>
0/256       1795665920   1795665920            none           none   bases/toolchain
0/257          4276224      4276224     21474836480           none   disks/d1
0/258          4276224      4276224     21474836480           none   disks/d2
0/270         58802176     58802176      2147483648           none   disks/sbx_01jcb4grow01
0/373            32768        32768      4294967296           none   <stale>
0/381         16842752     16842752      4294967296           none   <stale>
0/457            16384        16384            none           none   snapshots/s1
0/957            16384        16384            none           none   disks/f1
`

const qgroupShowLayoutSubvolumes = `Qgroupid    Referenced    Exclusive  Max referenced  Max exclusive   Path 
--------    ----------    ---------  --------------  -------------   ---- 
0/5                  0            0            none           none   <toplevel>
0/256                0            0            none           none   bases
0/257                0            0            none           none   disks
0/258                0            0            none           none   snapshots
0/259                0            0            none           none   partial
0/260                0            0            none           none   bases/toolchain
0/267                0            0            none           none   disks/sbx_01jcb4joined
`

func TestUsage(t *testing.T) {
	f := tempFS(t)
	got := install(t, fakeCall{match: "btrfs qgroup show", out: qgroupShowSimple})
	usage, err := f.Usage(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]Usage{
		"bases/toolchain":        {Referenced: 1795665920, Exclusive: 1795665920},
		"disks/d1":               {Referenced: 4276224, Exclusive: 4276224, Limit: 21474836480},
		"disks/d2":               {Referenced: 4276224, Exclusive: 4276224, Limit: 21474836480},
		"disks/sbx_01jcb4grow01": {Referenced: 58802176, Exclusive: 58802176, Limit: 2147483648},
		"snapshots/s1":           {Referenced: 16384, Exclusive: 16384},
		"disks/f1":               {Referenced: 16384, Exclusive: 16384},
	}
	if !reflect.DeepEqual(usage, want) {
		t.Fatalf("usage = %v\nwant %v", usage, want)
	}
	checkCalls(t, f, got, "btrfs qgroup show --raw -re $M")
}

func TestUsageSkipsLayoutSubvolumes(t *testing.T) {
	f := tempFS(t)
	install(t, fakeCall{match: "btrfs qgroup show", out: qgroupShowLayoutSubvolumes})
	usage, err := f.Usage(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(usage) != 2 || usage["bases/toolchain"] != (Usage{}) {
		t.Fatalf("usage = %v", usage)
	}
	if _, ok := usage["disks/sbx_01jcb4joined"]; !ok {
		t.Fatalf("usage misses the disk: %v", usage)
	}
}

func TestUsageWithoutPathColumn(t *testing.T) {
	f := tempFS(t)
	got := install(t,
		fakeCall{match: "btrfs qgroup show", out: "qgroupid         rfer         excl     max_rfer     max_excl \n--------         ----         ----     --------     -------- \n0/5             16384        16384         none         none \n0/257         4276224      4276224    1073741824         none \n0/300           16384        16384         none         none \n1/100           16384        16384         none         none \n"},
		fakeCall{match: "btrfs subvolume list", out: "ID 257 gen 20 top level 5 path disks/d1\nID 258 gen 21 top level 5 path snapshots/s1\n"},
	)
	usage, err := f.Usage(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]Usage{"disks/d1": {Referenced: 4276224, Exclusive: 4276224, Limit: 1073741824}}
	if !reflect.DeepEqual(usage, want) {
		t.Fatalf("usage = %v, want %v", usage, want)
	}
	checkCalls(t, f, got, "btrfs qgroup show --raw -re $M", "btrfs subvolume list $M")
}

func TestParseQgroupShowErrors(t *testing.T) {
	for _, out := range []string{
		"",
		"0/5 1 1 none none <toplevel>\n",
		"Qgroupid Referenced Exclusive Max referenced Max exclusive Path\n0/5 x 1 none none a\n",
		"Qgroupid Referenced Exclusive Max referenced Max exclusive Path\n0/5 1 1 big none a\n",
	} {
		if _, err := parseQgroupShow(out); err == nil {
			t.Errorf("parseQgroupShow(%q) accepted", out)
		}
	}
}

func TestSubvolumes(t *testing.T) {
	f := tempFS(t)
	install(t, fakeCall{match: "btrfs subvolume list", out: `ID 256 gen 9 top level 5 path bases
ID 257 gen 9 top level 5 path disks
ID 258 gen 9 top level 5 path snapshots
ID 259 gen 9 top level 5 path partial
ID 260 gen 41 top level 256 path bases/toolchain
ID 267 gen 1203 top level 257 path disks/sbx_01jcb4joined
ID 270 gen 1300 top level 5 path <FS_TREE>/snapshots/snap_1
ID 271 gen 1301 top level 259 path partial/tc-go
ID 280 gen 1310 top level 267 path disks/sbx_01jcb4joined/var/lib/docker/btrfs/subvolumes/abc
ID 281 gen 1311 top level 5 path elsewhere
`})
	subs, err := f.Subvolumes(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{"bases/toolchain": true, "disks/sbx_01jcb4joined": true, "snapshots/snap_1": true, "partial/tc-go": true}
	if !reflect.DeepEqual(subs, want) {
		t.Fatalf("subvolumes = %v, want %v", subs, want)
	}
	if _, err := parseSubvolumeList("garbage line\n"); err == nil {
		t.Fatal("parseSubvolumeList accepted garbage")
	}
}

func TestCleanPartial(t *testing.T) {
	f := tempFS(t, "partial/a", "partial/b", "disks/d")
	got := install(t, fakeCall{match: "btrfs subvolume list", out: "ID 300 gen 1 top level 5 path partial/b\nID 301 gen 1 top level 5 path partial/a\nID 302 gen 1 top level 5 path disks/d\n"})
	if err := f.CleanPartial(context.Background()); err != nil {
		t.Fatal(err)
	}
	checkCalls(t, f, got, "btrfs subvolume list $M", "btrfs subvolume delete $M/partial/a", "btrfs subvolume delete $M/partial/b")
}

func TestDeleteValidation(t *testing.T) {
	f := tempFS(t, "disks/sbx_1", "snapshots/snap_1", "bases/sha256:ab-amd64", "partial/x", "logs/sbx_1")
	for _, p := range []string{
		"",
		f.Mount,
		f.Mount + "/",
		f.Mount + "/disks",
		f.Mount + "/disks/",
		f.Mount + "/disks/sbx_1/",
		f.Mount + "/disks/sbx_1/nested",
		f.Mount + "/disks/../etc",
		f.Mount + "/disks/..",
		f.Mount + "/disks/.",
		f.Mount + "/disks/./sbx_1",
		f.Mount + "//disks/sbx_1",
		f.Mount + "/logs/sbx_1",
		f.Mount + "/other/x",
		f.Mount + "x/disks/sbx_1",
		"/etc/passwd",
		"/var/lib/docker/disks/sbx_1",
		"../disks/sbx_1",
		"disks/../../etc",
		"disks/sbx_1/nested",
		"disks/-rf",
		"disks/a b",
	} {
		got := install(t)
		err := f.Delete(context.Background(), p)
		if !errors.Is(err, ErrInvalidPath) {
			t.Errorf("Delete(%q) = %v, want ErrInvalidPath", p, err)
		}
		if len(got.calls) != 0 {
			t.Errorf("Delete(%q) ran %q", p, got.calls)
		}
	}
	for _, p := range []string{f.Mount + "/disks/sbx_1", "snapshots/snap_1", f.BasePath("sha256:ab-amd64"), "partial/x"} {
		got := install(t)
		if err := f.Delete(context.Background(), p); err != nil {
			t.Errorf("Delete(%q) = %v", p, err)
		}
		abs := p
		if !filepath.IsAbs(abs) {
			abs = filepath.Join(f.Mount, p)
		}
		if want := []string{"btrfs subvolume delete " + abs}; !reflect.DeepEqual(got.calls, want) {
			t.Errorf("Delete(%q) ran %q, want %q", p, got.calls, want)
		}
	}
	got := install(t)
	if err := f.Delete(context.Background(), "disks/gone"); err != nil || len(got.calls) != 0 {
		t.Errorf("Delete of a missing disk = %v, ran %q", err, got.calls)
	}
}

func TestMakeDisk(t *testing.T) {
	f := tempFS(t, "bases/sha256:ab-amd64", "partial", "disks", "snapshots/snap_1")
	got := install(t)
	if err := f.MakeDisk(context.Background(), "sbx_1", f.BasePath("sha256:ab-amd64"), 2*GiB); err != nil {
		t.Fatal(err)
	}
	checkCalls(t, f, got,
		"btrfs subvolume snapshot $M/bases/sha256:ab-amd64 $M/partial/disk-sbx_1",
		"btrfs qgroup limit 2147483648 $M/partial/disk-sbx_1",
		"rename $M/partial/disk-sbx_1 $M/disks/sbx_1",
	)

	got = install(t)
	if err := f.MakeDisk(context.Background(), "sbx_2", f.SnapshotPath("snap_1"), 0); err != nil {
		t.Fatal(err)
	}
	checkCalls(t, f, got,
		"btrfs subvolume snapshot $M/snapshots/snap_1 $M/partial/disk-sbx_2",
		"btrfs qgroup limit none $M/partial/disk-sbx_2",
		"rename $M/partial/disk-sbx_2 $M/disks/sbx_2",
	)
}

func TestMakeDiskExistingAndLeftover(t *testing.T) {
	f := tempFS(t, "bases/b", "disks/sbx_1", "partial/disk-sbx_2")
	got := install(t)
	if err := f.MakeDisk(context.Background(), "sbx_1", f.BasePath("b"), GiB); err != nil || len(got.calls) != 0 {
		t.Fatalf("existing disk: %v, ran %q", err, got.calls)
	}
	got = install(t)
	if err := f.MakeDisk(context.Background(), "sbx_2", f.DiskPath("sbx_1"), GiB); err != nil {
		t.Fatal(err)
	}
	checkCalls(t, f, got,
		"btrfs subvolume delete $M/partial/disk-sbx_2",
		"btrfs subvolume snapshot $M/disks/sbx_1 $M/partial/disk-sbx_2",
		"btrfs qgroup limit 1073741824 $M/partial/disk-sbx_2",
		"rename $M/partial/disk-sbx_2 $M/disks/sbx_2",
	)
	for _, src := range []string{"/etc", f.Mount + "/partial/disk-sbx_2", f.BasePath("missing"), f.Mount + "/disks/sbx_1/x"} {
		got = install(t)
		if err := f.MakeDisk(context.Background(), "sbx_3", src, GiB); err == nil || len(got.calls) != 0 {
			t.Errorf("MakeDisk from %q = %v, ran %q", src, err, got.calls)
		}
	}
}

func TestSnapshot(t *testing.T) {
	f := tempFS(t, "disks/sbx_1", "snapshots/snap_old")
	got := install(t)
	if err := f.Snapshot(context.Background(), "sbx_1", "snap_1"); err != nil {
		t.Fatal(err)
	}
	checkCalls(t, f, got, "btrfs subvolume snapshot -r $M/disks/sbx_1 $M/snapshots/snap_1")
	got = install(t)
	if err := f.Snapshot(context.Background(), "sbx_1", "snap_old"); err != nil || len(got.calls) != 0 {
		t.Fatalf("existing snapshot: %v, ran %q", err, got.calls)
	}
	if err := f.Snapshot(context.Background(), "sbx_missing", "snap_2"); err == nil {
		t.Fatal("snapshot of a missing disk accepted")
	}
}

func TestPromoteBase(t *testing.T) {
	f := tempFS(t, "partial/sha256:ab-amd64", "bases")
	got := install(t)
	if err := f.PromoteBase(context.Background(), "sha256:ab-amd64"); err != nil {
		t.Fatal(err)
	}
	checkCalls(t, f, got,
		"rename $M/partial/sha256:ab-amd64 $M/bases/sha256:ab-amd64",
		"btrfs property set -ts $M/bases/sha256:ab-amd64 ro true",
	)

	f = tempFS(t, "partial/b", "bases/b")
	got = install(t)
	if err := f.PromoteBase(context.Background(), "b"); err != nil {
		t.Fatal(err)
	}
	checkCalls(t, f, got, "btrfs subvolume delete $M/partial/b", "btrfs property set -ts $M/bases/b ro true")
}

func TestCreatePartial(t *testing.T) {
	f := tempFS(t, "partial/stale")
	got := install(t)
	p, err := f.CreatePartial(context.Background(), "stale")
	if err != nil || p != filepath.Join(f.Mount, "partial", "stale") {
		t.Fatalf("CreatePartial = %q, %v", p, err)
	}
	checkCalls(t, f, got, "btrfs subvolume delete $M/partial/stale", "btrfs subvolume create $M/partial/stale")
	if _, err := f.CreatePartial(context.Background(), "../x"); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("CreatePartial(../x) = %v", err)
	}
}

func TestSetLimit(t *testing.T) {
	f := tempFS(t)
	got := install(t)
	if err := f.SetLimit(context.Background(), "disks/sbx_1", 5*GiB); err != nil {
		t.Fatal(err)
	}
	checkCalls(t, f, got, "btrfs qgroup limit 5368709120 $M/disks/sbx_1")
	if err := f.SetLimit(context.Background(), "/", GiB); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("SetLimit(/) = %v", err)
	}
}

func TestClearStale(t *testing.T) {
	f := tempFS(t)
	busy := "ERROR: cannot delete qgroup 0/373: Device or resource busy\nERROR: cannot delete qgroup 0/381: Device or resource busy\n"
	got := install(t, fakeCall{match: "btrfs qgroup clear-stale", out: busy, err: &CommandError{ExitCode: 1, Err: errors.New("exit status 1")}})
	if err := f.ClearStale(context.Background()); err != nil {
		t.Fatalf("busy clear-stale = %v", err)
	}
	checkCalls(t, f, got, "btrfs subvolume sync $M", "btrfs qgroup clear-stale $M")

	install(t, fakeCall{match: "btrfs qgroup clear-stale", out: "ERROR: can't list qgroups: quotas not enabled\n", err: &CommandError{ExitCode: 1, Err: errors.New("exit status 1")}})
	if err := f.ClearStale(context.Background()); err == nil {
		t.Fatal("quota error swallowed")
	}

	got = install(t, fakeCall{match: "btrfs subvolume sync", err: errors.New("boom")})
	if err := f.ClearStale(context.Background()); err == nil || len(got.calls) != 1 {
		t.Fatalf("sync failure = %v, ran %q", err, got.calls)
	}
}

func TestEnableDirectIO(t *testing.T) {
	f := tempFS(t)
	for _, tc := range []struct {
		info Info
		want []string
	}{
		{Info{Backing: BackingLoopFile, LoopDevice: "/dev/loop0"}, []string{"losetup --direct-io=on /dev/loop0"}},
		{Info{Backing: BackingLoopFile, LoopDevice: "/dev/loop0", DirectIO: true}, nil},
		{Info{Backing: BackingDevice, Device: "/dev/sdb"}, nil},
	} {
		got := install(t)
		if err := f.enableDirectIO(context.Background(), tc.info); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got.calls, tc.want) {
			t.Errorf("enableDirectIO(%+v) ran %q, want %q", tc.info, got.calls, tc.want)
		}
	}
}

func TestGrowLoop(t *testing.T) {
	f := Open(Mount)
	got := install(t)
	if err := f.growLoop(context.Background(), ImageFile, "/dev/loop0", 14*GiB, 18*GiB, 20*GiB); err != nil {
		t.Fatal(err)
	}
	checkCalls(t, f, got,
		"fallocate -l 19327352832 "+ImageFile,
		"losetup --set-capacity /dev/loop0",
		"btrfs filesystem resize max $M",
	)

	got = install(t)
	err := f.growLoop(context.Background(), ImageFile, "/dev/loop0", 14*GiB, 18*GiB, 12*GiB)
	if !errors.Is(err, ErrInvalidSize) || len(got.calls) != 0 {
		t.Fatalf("grow past the root reserve = %v, ran %q", err, got.calls)
	}
	var ge *GrowError
	if errors.As(err, &ge) {
		t.Fatalf("validation failure is a GrowError: %v", err)
	}

	got = install(t)
	if err := f.growLoop(context.Background(), ImageFile, "/dev/loop0", 14*GiB, 14*GiB, 100*GiB); !errors.Is(err, ErrInvalidSize) || len(got.calls) != 0 {
		t.Fatalf("grow to the same size = %v, ran %q", err, got.calls)
	}

	for step, match := range map[string]string{"fallocate": "fallocate", "loop": "losetup", "resize": "btrfs filesystem resize"} {
		install(t, fakeCall{match: match, err: errors.New("boom")})
		err := f.growLoop(context.Background(), ImageFile, "/dev/loop0", 14*GiB, 18*GiB, 20*GiB)
		if !errors.As(err, &ge) || ge.Step != step {
			t.Errorf("failing %s gives %v, want step %s", match, err, step)
		}
	}
}

func TestGrowDevice(t *testing.T) {
	f := Open(Mount)
	got := install(t, fakeCall{match: "blockdev", out: "53687091200\n"})
	if err := f.growDevice(context.Background(), "/dev/sdb", 50*GiB); err != nil {
		t.Fatal(err)
	}
	checkCalls(t, f, got, "blockdev --getsize64 /dev/sdb", "btrfs filesystem resize max $M")

	got = install(t, fakeCall{match: "blockdev", out: "53687091200\n"})
	if err := f.growDevice(context.Background(), "/dev/sdb", 60*GiB); !errors.Is(err, ErrInvalidSize) || len(got.calls) != 1 {
		t.Fatalf("size above the device = %v, ran %q", err, got.calls)
	}

	install(t, fakeCall{match: "blockdev", out: "53687091200\n"}, fakeCall{match: "btrfs", err: errors.New("boom")})
	var ge *GrowError
	if err := f.growDevice(context.Background(), "/dev/sdb", 50*GiB); !errors.As(err, &ge) || ge.Step != "resize" {
		t.Fatalf("resize failure = %v", err)
	}
}

func TestMountUnit(t *testing.T) {
	loop := mountUnit(BackingLoopFile, ImageFile)
	wantLoop := `[Unit]
Description=Stationly sandbox filesystem

[Mount]
What=/var/lib/stationly/sandboxes.img
Where=/var/lib/stationly/sandboxes
Type=btrfs
Options=loop,noatime,nodiscard

[Install]
WantedBy=local-fs.target
`
	if loop != wantLoop {
		t.Errorf("loop unit:\n%s\nwant:\n%s", loop, wantLoop)
	}
	dev := mountUnit(BackingDevice, "/dev/disk/by-id/scsi-0HC_Volume_1")
	if !strings.Contains(dev, "\nWhat=/dev/disk/by-id/scsi-0HC_Volume_1\n") || !strings.Contains(dev, "\nOptions=noatime\n") || !strings.Contains(dev, "\nWantedBy=local-fs.target\n") {
		t.Errorf("device unit:\n%s", dev)
	}
}

func TestParseDeviceStats(t *testing.T) {
	stats, err := parseDeviceStats(`[/dev/loop0].write_io_errs    0
[/dev/loop0].read_io_errs     0
[/dev/loop0].flush_io_errs    0
[/dev/loop0].corruption_errs  3
[/dev/loop0].generation_errs  0
`)
	if err != nil {
		t.Fatal(err)
	}
	if len(stats) != 5 || stats["/dev/loop0.corruption_errs"] != 3 || stats["/dev/loop0.write_io_errs"] != 0 {
		t.Fatalf("stats = %v", stats)
	}
	if _, err := parseDeviceStats("nonsense here x\n"); err == nil {
		t.Fatal("garbage accepted")
	}
}

func TestParseMountInfo(t *testing.T) {
	data := `22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw,discard,errors=remount-ro
101 22 0:45 / /var/lib/stationly/sandboxes rw,noatime shared:60 - btrfs /dev/loop0 rw,ssd,space_cache=v2,subvolid=5,subvol=/
102 22 0:46 / /mnt/with\040space rw - btrfs /dev/sdb rw
`
	e, ok, err := parseMountInfo(data, Mount)
	if err != nil || !ok {
		t.Fatalf("parseMountInfo = %v, %v", ok, err)
	}
	if e.FSType != "btrfs" || e.Source != "/dev/loop0" || e.Options != "rw,noatime" {
		t.Fatalf("entry = %+v", e)
	}
	if e, ok, _ := parseMountInfo(data, "/mnt/with space"); !ok || e.Source != "/dev/sdb" {
		t.Fatalf("escaped mount point: %+v %v", e, ok)
	}
	if _, ok, _ := parseMountInfo(data, "/var/lib/stationly"); ok {
		t.Fatal("found an unmounted path")
	}
	if _, _, err := parseMountInfo("broken\n", Mount); err == nil {
		t.Fatal("broken mountinfo accepted")
	}
}

func TestParseIncompatFlags(t *testing.T) {
	flags, err := parseIncompatFlags("superblock: bytenr=65536, device=/dev/loop0\nflags\t\t\t0x1\nincompat_flags\t\t0x10361\n\t\t\t( MIXED_BACKREF |\n\t\t\t  SIMPLE_QUOTA )\n")
	if err != nil || flags&incompatSimpleQta == 0 {
		t.Fatalf("flags = %#x, %v", flags, err)
	}
	flags, err = parseIncompatFlags("incompat_flags\t\t0x361\n")
	if err != nil || flags&incompatSimpleQta != 0 {
		t.Fatalf("flags = %#x, %v", flags, err)
	}
	if _, err := parseIncompatFlags("nothing\n"); err == nil {
		t.Fatal("missing flags accepted")
	}
}

func TestParseBlkid(t *testing.T) {
	kv := parseBlkid("DEVNAME=/dev/sdb\nLABEL=stationly-sandboxes\nUUID=1\nTYPE=btrfs\n")
	if kv["TYPE"] != "btrfs" || kv["LABEL"] != Label {
		t.Fatalf("blkid = %v", kv)
	}
}

func TestPaths(t *testing.T) {
	f := Open(Mount)
	for got, want := range map[string]string{
		f.BasePath("sha256:ab-amd64"): Mount + "/bases/sha256:ab-amd64",
		f.DiskPath("sbx_1"):           Mount + "/disks/sbx_1",
		f.SnapshotPath("snap_1"):      Mount + "/snapshots/snap_1",
		f.LogDir("sbx_1"):             Mount + "/logs/sbx_1",
	} {
		if got != want {
			t.Errorf("%s, want %s", got, want)
		}
	}
	if f.DiskExists("../../etc") || f.BaseExists("") || f.SnapshotExists("/") {
		t.Fatal("invalid name reported as existing")
	}
}

func TestTrimOutput(t *testing.T) {
	var lines []string
	for range 30 {
		lines = append(lines, "line")
	}
	out := trimOutput(strings.Join(lines, "\n"))
	if n := strings.Count(out, "\n"); n != 20 || !strings.HasSuffix(out, "... 10 more lines") {
		t.Fatalf("trimmed to %d newlines: %q", n, out)
	}
}
