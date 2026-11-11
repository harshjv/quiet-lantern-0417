//go:build linux

package deploy

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/klauspost/compress/zstd"

	"github.com/harshjv/stationly/go/internal/dispatch"
	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/fsx"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/s3store"
	"github.com/harshjv/stationly/go/internal/secrets"
)

const (
	DefaultBackupRoot = "/var/lib/stationly/backups"
	archiveSuffix     = ".tar.zst"
	metadataSuffix    = ".json"
	backupTimeout     = 6 * time.Hour
)

type backupMeta struct {
	VolumeID      string  `json:"volume_id"`
	ServiceID     *string `json:"service_id"`
	EnvironmentID *string `json:"environment_id"`
	StationID     string  `json:"station_id"`
	MountPath     string  `json:"mount_path"`
	DeploymentID  *string `json:"deployment_id"`
	ImageRef      *string `json:"image_ref"`
	SizeBytes     int64   `json:"size_bytes"`
	SHA256        string  `json:"sha256"`
	Consistent    bool    `json:"consistent"`
	StartedAt     string  `json:"started_at"`
	FinishedAt    string  `json:"finished_at"`
}

func (s *Station) backupRoot() string {
	if s.opts.BackupRoot != "" {
		return s.opts.BackupRoot
	}
	return DefaultBackupRoot
}

type destination struct {
	dir    string
	store  *s3store.Client
	where  string
	redact *secrets.Redactor
}

func (d *destination) scrub(err error) error {
	if err == nil || d.redact == nil {
		return err
	}
	return errors.New(d.redact.Redact(err.Error()))
}

func (s *Station) pathDir(t protocol.BackupTarget) (string, *protocol.ErrorBody) {
	if t.Path == nil {
		return "", protocolError(protocol.ErrorCodeValidationFailed, "Name a directory under the station backup root.", "a path target needs a path")
	}
	root := filepath.Clean(s.backupRoot())
	p := *t.Path
	if filepath.IsAbs(p) {
		rel, err := filepath.Rel(root, filepath.Clean(p))
		if err != nil || rel == ".." || strings.HasPrefix(rel, "../") {
			return "", protocolError(protocol.ErrorCodeValidationFailed, "Name a directory under the station backup root "+root+".", "backup path %s is outside the station backup root %s", p, root)
		}
		p = rel
	}
	clean := filepath.Clean("/" + p)
	if strings.Contains(p, "..") {
		return "", protocolError(protocol.ErrorCodeValidationFailed, "Name a directory under the station backup root without '..'.", "backup path %s leaves the station backup root", *t.Path)
	}
	return filepath.Join(root, clean), nil
}

func (s *Station) destinationFor(snapshotID string, t protocol.BackupTarget) (*destination, *protocol.ErrorBody) {
	switch t.Type {
	case protocol.BackupTargetTypePath:
		dir, failure := s.pathDir(t)
		if failure != nil {
			return nil, failure
		}
		return &destination{dir: dir, where: dir}, nil
	case protocol.BackupTargetTypeS3:
		target := s3store.Target{Endpoint: deref(t.Endpoint), Bucket: deref(t.Bucket), Prefix: deref(t.Prefix)}
		if err := target.Validate(); err != nil {
			return nil, protocolError(protocol.ErrorCodeValidationFailed, "Set volume_backup.target to an S3 bucket reached over https, or over http on a private address.", "%v", err)
		}
		creds, ok := s.takeBackupCredentials(snapshotID)
		if !ok {
			return nil, &protocol.ErrorBody{Code: string(protocol.ErrorCodeSecretsUnavailable), Explanation: "the S3 credentials for backup " + snapshotID + " did not arrive", Fix: "Dispatch sends secrets.deliver for the backup before it asks for the job; start the backup again."}
		}
		store, err := s3store.New(target, creds)
		if err != nil {
			return nil, protocolError(protocol.ErrorCodeValidationFailed, "Check volume_backup.target and the sealed variable it names.", "%v", err)
		}
		redact := secrets.NewRedactor([]secrets.Known{{Key: "S3_ACCESS_KEY_ID", Value: creds.AccessKeyID}, {Key: "S3_SECRET_ACCESS_KEY", Value: creds.SecretAccessKey}})
		where := "s3://" + target.Bucket
		if target.Prefix != "" {
			where += "/" + target.Prefix
		}
		return &destination{store: store, where: where, redact: redact}, nil
	}
	return nil, protocolError(protocol.ErrorCodeValidationFailed, "Use a path or s3 target.", "target type %s is not supported by this stationd", t.Type)
}

func objectsFor(name string) protocol.BackupObjects {
	return protocol.BackupObjects{Archive: name + archiveSuffix, Metadata: name + metadataSuffix}
}

func (s *Station) servicesMounting(volumeID string) []*ServicePlan {
	var out []*ServicePlan
	for _, id := range s.plan.ServiceIDs() {
		sp := s.plan.Services[id]
		for _, m := range sp.Spec.Volumes {
			if m.VolumeId == volumeID && sp.Run {
				out = append(out, sp)
				break
			}
		}
	}
	return out
}

func (s *Station) volumeBackup(_ context.Context, m dispatch.Message, b protocol.VolumeBackupBody) {
	dest, failure := s.destinationFor(b.SnapshotId, b.Target)
	if failure != nil {
		s.replyError(m, failure)
		return
	}
	if s.backups[b.VolumeId] {
		s.replyError(m, protocolError(protocol.ErrorCodeValidationFailed, "Wait for the running backup of this volume to finish.", "volume %s already has a backup or restore running", b.VolumeId))
		return
	}
	var stop []*ServicePlan
	if b.Quiesce {
		stop = s.servicesMounting(b.VolumeId)
		for _, sp := range stop {
			if s.heldByRollout(sp.ID) {
				s.replyError(m, protocolError(protocol.ErrorCodeValidationFailed, "Wait for the deployment to finish, or back up with quiesce false.", "service %s has a deployment in progress", sp.ID))
				return
			}
		}
	}
	s.backups[b.VolumeId] = true
	stopped := map[string]string{}
	for _, sp := range stop {
		s.quiesced[sp.ID] = true
		if st := s.services[sp.ID]; st != nil && st.service.id != "" {
			stopped[sp.ID] = st.service.id
		}
	}
	ref := m.ID
	objects := objectsFor(b.Name)
	s.send(protocol.MessageVolumeBackupAccepted, &ref, protocol.VolumeBackupAcceptedBody{SnapshotId: b.SnapshotId, Objects: objects})
	s.log.Info("volume backup accepted", "volume", b.VolumeId, "snapshot", b.SnapshotId, "target", dest.where, "quiesce", b.Quiesce, "stopping", len(stopped))
	drain := map[string]int{}
	for _, sp := range stop {
		drain[sp.ID] = sp.Spec.DrainTimeoutS
	}
	go func() {
		bctx, cancel := context.WithTimeout(context.Background(), backupTimeout)
		defer cancel()
		res := protocol.VolumeBackupResultBody{SnapshotId: b.SnapshotId, VolumeId: b.VolumeId, Objects: objects, StartedAt: tstamp(time.Now()), Consistent: b.Quiesce}
		for svc, id := range stopped {
			t := time.Now()
			if err := s.docker.Stop(bctx, id, drain[svc]); err != nil {
				s.log.Warn("stop the service for a quiesced backup", "service", svc, "error", err)
			}
			s.log.Info("service stopped for the backup", "service", svc, "took_ms", time.Since(t).Milliseconds())
		}
		size, sum, archived, err := s.writeBackup(bctx, b, dest, objects)
		for svc, id := range stopped {
			if err := s.docker.Start(bctx, id); err != nil {
				s.log.Error("start the service again after the backup", "service", svc, "error", err)
			}
		}
		res.FinishedAt = tstamp(time.Now())
		res.SizeBytes, res.ArchiveBytes = int(size), int(archived)
		if err != nil {
			res.Status = protocol.VolumeBackupStatusFailed
			err = dest.scrub(err)
			res.Failure = &protocol.VolumeBackupResultBodyFailure{Code: string(protocol.ErrorCodeInternalError), Explanation: err.Error(), Fix: "Check the backup target's free space or bucket access and the stationd log, then back up again."}
			s.log.Error("volume backup failed", "volume", b.VolumeId, "snapshot", b.SnapshotId, "error", err)
		} else {
			res.Status = protocol.VolumeBackupStatusComplete
			res.Sha256 = &sum
			s.log.Info("volume backup complete", "volume", b.VolumeId, "snapshot", b.SnapshotId, "archive", dest.where+"/"+objects.Archive, "size_bytes", size, "archive_bytes", archived, "sha256", sum)
		}
		s.post(context.Background(), func() {
			delete(s.backups, b.VolumeId)
			for _, sp := range stop {
				delete(s.quiesced, sp.ID)
			}
			s.resync = true
			s.emit(protocol.MessageVolumeBackupResult, res)
		})
	}()
}

func tstamp(t time.Time) string { return t.UTC().Format(timestampLayout) }

func (s *Station) volumeMountpoint(ctx context.Context, dockerName string) (string, error) {
	v, err := s.docker.InspectVolume(ctx, dockerName)
	if err != nil {
		return "", err
	}
	if v.Labels[docker.LabelStation] != s.opts.Identity.StationID {
		return "", fmt.Errorf("volume %s is not labeled for this station", dockerName)
	}
	if err := docker.CheckVolume(v, s.info.DockerRootDir); err != nil {
		return "", err
	}
	return v.Mountpoint, nil
}

type countingWriter struct {
	w io.Writer
	n int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

func archive(ctx context.Context, root string, sink io.Writer) (int64, int64, string, error) {
	hash := sha256.New()
	counted := &countingWriter{w: io.MultiWriter(sink, hash)}
	zw, err := zstd.NewWriter(counted)
	if err != nil {
		return 0, 0, "", err
	}
	size, err := tarTree(ctx, root, zw)
	if cerr := zw.Close(); err == nil {
		err = cerr
	}
	return size, counted.n, hex.EncodeToString(hash.Sum(nil)), err
}

func (s *Station) backupMetadata(b protocol.VolumeBackupBody, size int64, sum string, started time.Time) []byte {
	meta := backupMeta{
		VolumeID: b.VolumeId, ServiceID: (*string)(b.ServiceId), EnvironmentID: (*string)(b.EnvironmentId), StationID: s.opts.Identity.StationID,
		MountPath: b.MountPath, DeploymentID: (*string)(b.DeploymentId), ImageRef: (*string)(b.ImageRef), SizeBytes: size, SHA256: sum,
		Consistent: b.Quiesce, StartedAt: tstamp(started), FinishedAt: tstamp(time.Now()),
	}
	mb, _ := json.MarshalIndent(meta, "", "  ")
	return append(mb, '\n')
}

func (s *Station) writeBackup(ctx context.Context, b protocol.VolumeBackupBody, dest *destination, objects protocol.BackupObjects) (int64, string, int64, error) {
	root, err := s.volumeMountpoint(ctx, b.DockerName)
	if err != nil {
		return 0, "", 0, err
	}
	started := time.Now()
	if dest.store != nil {
		return s.uploadBackup(ctx, b, dest, objects, root, started)
	}
	if err := os.MkdirAll(dest.dir, 0o700); err != nil {
		return 0, "", 0, err
	}
	final := filepath.Join(dest.dir, objects.Archive)
	tmp := final + ".partial"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return 0, "", 0, err
	}
	defer os.Remove(tmp)
	size, archived, sum, err := archive(ctx, root, f)
	if serr := f.Sync(); err == nil {
		err = serr
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return size, "", archived, err
	}
	if err := os.Rename(tmp, final); err != nil {
		return size, "", archived, err
	}
	if err := fsx.WriteFile(filepath.Join(dest.dir, objects.Metadata), s.backupMetadata(b, size, sum, started), 0o600); err != nil {
		return size, sum, archived, err
	}
	return size, sum, archived, nil
}

func (s *Station) uploadBackup(ctx context.Context, b protocol.VolumeBackupBody, dest *destination, objects protocol.BackupObjects, root string, started time.Time) (int64, string, int64, error) {
	pr, pw := io.Pipe()
	type produced struct {
		size, archived int64
		sum            string
		err            error
	}
	done := make(chan produced, 1)
	go func() {
		size, archived, sum, err := archive(ctx, root, pw)
		pw.CloseWithError(err)
		done <- produced{size, archived, sum, err}
	}()
	sent, err := dest.store.Put(ctx, objects.Archive, pr)
	pr.CloseWithError(err)
	p := <-done
	if err == nil {
		err = p.err
	}
	if err == nil && sent != p.archived {
		err = fmt.Errorf("uploaded %d bytes of an archive of %d bytes", sent, p.archived)
	}
	if err == nil {
		var stored int64
		if stored, err = dest.store.Head(ctx, objects.Archive); err == nil && stored != p.archived {
			err = fmt.Errorf("the bucket holds %d bytes of an archive of %d bytes", stored, p.archived)
		}
	}
	if err == nil {
		err = dest.store.PutBytes(ctx, objects.Metadata, s.backupMetadata(b, p.size, p.sum, started))
	}
	if err != nil {
		cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
		defer cancel()
		_ = dest.store.Delete(cctx, objects.Archive)
		return p.size, "", p.archived, err
	}
	return p.size, p.sum, p.archived, nil
}

func tarTree(ctx context.Context, root string, w io.Writer) (int64, error) {
	tw := tar.NewWriter(w)
	var size int64
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		link := ""
		if info.Mode()&os.ModeSymlink != 0 {
			if link, err = os.Readlink(path); err != nil {
				return err
			}
		}
		hdr, err := tar.FileInfoHeader(info, link)
		if err != nil {
			return err
		}
		hdr.Name = filepath.ToSlash(rel)
		if info.IsDir() {
			hdr.Name += "/"
		}
		hdr.Uname, hdr.Gname = "", ""
		hdr.Format = tar.FormatPAX
		if st, ok := info.Sys().(*syscall.Stat_t); ok {
			hdr.Uid, hdr.Gid = int(st.Uid), int(st.Gid)
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			f, err := os.Open(path)
			if err != nil {
				return err
			}
			n, err := io.Copy(tw, f)
			f.Close()
			size += n
			if err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return size, err
	}
	return size, tw.Close()
}

func (s *Station) volumeRestore(_ context.Context, m dispatch.Message, b protocol.VolumeRestoreBody) {
	dest, failure := s.destinationFor(b.SnapshotId, b.Target)
	if failure != nil {
		s.replyError(m, failure)
		return
	}
	if s.backups[b.VolumeId] {
		s.replyError(m, protocolError(protocol.ErrorCodeValidationFailed, "Wait for the running restore of this volume to finish.", "volume %s already has a restore running", b.VolumeId))
		return
	}
	s.backups[b.VolumeId] = true
	ref := m.ID
	s.send(protocol.MessageVolumeRestoreAccepted, &ref, protocol.VolumeRestoreAcceptedBody{VolumeId: b.VolumeId})
	go func() {
		rctx, cancel := context.WithTimeout(context.Background(), backupTimeout)
		defer cancel()
		res := protocol.VolumeRestoreResultBody{SnapshotId: b.SnapshotId, VolumeId: b.VolumeId, StartedAt: tstamp(time.Now())}
		size, files, tree, err := s.restoreInto(rctx, b, dest)
		res.FinishedAt = tstamp(time.Now())
		res.SizeBytes, res.Files = int(size), files
		if err != nil {
			res.Status = protocol.VolumeRestoreStatusFailed
			err = dest.scrub(err)
			res.Failure = &protocol.VolumeRestoreResultBodyFailure{Code: string(protocol.ErrorCodeValidationFailed), Explanation: err.Error(), Fix: "Restore from a complete backup into a new, empty volume."}
			s.log.Error("volume restore failed", "volume", b.VolumeId, "snapshot", b.SnapshotId, "error", err)
		} else {
			res.Status = protocol.VolumeRestoreStatusComplete
			res.Sha256, res.TreeSha256 = &b.Sha256, &tree
			s.log.Info("volume restore complete", "volume", b.VolumeId, "snapshot", b.SnapshotId, "files", files, "size_bytes", size, "tree_sha256", tree)
		}
		s.post(context.Background(), func() {
			delete(s.backups, b.VolumeId)
			s.resync = true
			s.emit(protocol.MessageVolumeRestoreResult, res)
		})
	}()
}

func clearDir(root string) {
	entries, _ := os.ReadDir(root)
	for _, e := range entries {
		os.RemoveAll(filepath.Join(root, e.Name()))
	}
}

func (s *Station) restoreInto(ctx context.Context, b protocol.VolumeRestoreBody, dest *destination) (size int64, files int, tree string, err error) {
	var src io.Reader
	var downloaded *teeHash
	if dest.store != nil {
		rc, _, gerr := dest.store.Get(ctx, filepath.Base(b.Objects.Archive))
		if gerr != nil {
			return 0, 0, "", gerr
		}
		defer rc.Close()
		downloaded = newTeeHash(rc)
		src = downloaded
	} else {
		archive := filepath.Join(dest.dir, filepath.Base(b.Objects.Archive))
		f, oerr := os.Open(archive)
		if oerr != nil {
			return 0, 0, "", oerr
		}
		defer f.Close()
		hash := sha256.New()
		if _, err := io.Copy(hash, f); err != nil {
			return 0, 0, "", err
		}
		if got := hex.EncodeToString(hash.Sum(nil)); got != b.Sha256 {
			return 0, 0, "", fmt.Errorf("archive %s has sha256 %s, the backup recorded %s", archive, got, b.Sha256)
		}
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			return 0, 0, "", err
		}
		src = f
	}
	labels := docker.VolumeLabels(s.opts.Identity.StationID, b.VolumeId, string(b.Owner), nil)
	if _, _, err := s.docker.EnsureVolume(ctx, b.DockerName, labels); err != nil {
		return 0, 0, "", fmt.Errorf("create volume %s: %w", b.DockerName, err)
	}
	root, err := s.volumeMountpoint(ctx, b.DockerName)
	if err != nil {
		return 0, 0, "", err
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return 0, 0, "", err
	}
	if len(entries) > 0 {
		return 0, 0, "", fmt.Errorf("volume %s is not empty (%d entries); restore only into a new volume", b.DockerName, len(entries))
	}
	if downloaded != nil {
		defer func() {
			if err != nil {
				clearDir(root)
			}
		}()
	}
	size, files, err = extractArchive(root, src, downloaded, b.Sha256)
	if err != nil {
		return size, files, "", err
	}
	tree, err = TreeSHA256(root)
	return size, files, tree, err
}

type teeHash struct {
	r io.Reader
	h hash.Hash
}

func newTeeHash(r io.Reader) *teeHash {
	h := sha256.New()
	return &teeHash{r: io.TeeReader(r, h), h: h}
}

func (t *teeHash) Read(p []byte) (int, error) { return t.r.Read(p) }

func (t *teeHash) sum() string { return hex.EncodeToString(t.h.Sum(nil)) }

func extractArchive(root string, src io.Reader, downloaded *teeHash, want string) (int64, int, error) {
	zr, err := zstd.NewReader(src)
	if err != nil {
		return 0, 0, err
	}
	size, files, err := untar(root, zr)
	zr.Close()
	if err != nil {
		return size, files, err
	}
	if downloaded != nil {
		if _, err := io.Copy(io.Discard, downloaded); err != nil {
			return size, files, fmt.Errorf("read the rest of the archive: %w", err)
		}
		if got := downloaded.sum(); got != want {
			return size, files, fmt.Errorf("the downloaded archive has sha256 %s, the backup recorded %s", got, want)
		}
	}
	return size, files, nil
}

func entryName(hdr *tar.Header) string {
	return strings.TrimPrefix(filepath.Clean("/"+hdr.Name), "/")
}

func untar(dir string, r io.Reader) (int64, int, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return 0, 0, err
	}
	defer root.Close()
	tr := tar.NewReader(r)
	var size int64
	files := 0
	var dirs []*tar.Header
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return size, files, err
		}
		name := entryName(hdr)
		if name == "" {
			return size, files, fmt.Errorf("archive entry %s leaves the volume root", hdr.Name)
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := root.MkdirAll(name, 0o700); err != nil {
				return size, files, err
			}
			dirs = append(dirs, hdr)
			continue
		case tar.TypeReg:
			out, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
			if err != nil {
				return size, files, err
			}
			n, err := io.Copy(out, tr)
			size += n
			if cerr := out.Close(); err == nil {
				err = cerr
			}
			if err != nil {
				return size, files, err
			}
			files++
		case tar.TypeSymlink:
			if err := root.Symlink(hdr.Linkname, name); err != nil {
				return size, files, err
			}
			if err := root.Lchown(name, hdr.Uid, hdr.Gid); err != nil {
				return size, files, err
			}
			continue
		default:
			return size, files, fmt.Errorf("archive entry %s has type %c, which a volume backup never writes", hdr.Name, hdr.Typeflag)
		}
		if err := root.Chown(name, hdr.Uid, hdr.Gid); err != nil {
			return size, files, err
		}
		if err := root.Chmod(name, tarMode(hdr.Mode)); err != nil {
			return size, files, err
		}
		if err := root.Chtimes(name, hdr.ModTime, hdr.ModTime); err != nil {
			return size, files, err
		}
	}
	for i := len(dirs) - 1; i >= 0; i-- {
		name := entryName(dirs[i])
		_ = root.Chown(name, dirs[i].Uid, dirs[i].Gid)
		_ = root.Chmod(name, tarMode(dirs[i].Mode))
		_ = root.Chtimes(name, dirs[i].ModTime, dirs[i].ModTime)
	}
	return size, files, nil
}

func tarMode(m int64) os.FileMode {
	mode := os.FileMode(m).Perm()
	if m&0o4000 != 0 {
		mode |= os.ModeSetuid
	}
	if m&0o2000 != 0 {
		mode |= os.ModeSetgid
	}
	if m&0o1000 != 0 {
		mode |= os.ModeSticky
	}
	return mode
}

func TreeSHA256(root string) (string, error) {
	var lines []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		if rel == "." {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		st, _ := info.Sys().(*syscall.Stat_t)
		uid, gid := uint32(0), uint32(0)
		if st != nil {
			uid, gid = st.Uid, st.Gid
		}
		content := "-"
		switch {
		case info.Mode().IsRegular():
			f, err := os.Open(path)
			if err != nil {
				return err
			}
			h := sha256.New()
			_, err = io.Copy(h, f)
			f.Close()
			if err != nil {
				return err
			}
			content = hex.EncodeToString(h.Sum(nil))
		case info.Mode()&os.ModeSymlink != 0:
			content, _ = os.Readlink(path)
		}
		lines = append(lines, fmt.Sprintf("%s %o %d:%d %s", filepath.ToSlash(rel), info.Mode(), uid, gid, content))
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Strings(lines)
	h := sha256.New()
	for _, l := range lines {
		_, _ = io.WriteString(h, l+"\n")
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func failedDelete(r protocol.VolumeBackupDeleteResult, code, explanation, fix string) protocol.VolumeBackupDeleteResult {
	r.Status, r.Error = protocol.VolumeBackupDeleteStatusFailed, &protocol.VolumeBackupDeleteResultError{Code: code, Explanation: explanation, Fix: fix}
	return r
}

func deleteFiles(r protocol.VolumeBackupDeleteResult, dir string, objects protocol.BackupObjects) protocol.VolumeBackupDeleteResult {
	absent := 0
	for _, name := range []string{objects.Archive, objects.Metadata} {
		err := os.Remove(filepath.Join(dir, filepath.Base(name)))
		switch {
		case err == nil:
		case errors.Is(err, os.ErrNotExist):
			absent++
		default:
			r = failedDelete(r, string(protocol.ErrorCodeInternalError), err.Error(), "Check the backup directory permissions.")
		}
	}
	if absent == 2 && r.Error == nil {
		r.Status = protocol.VolumeBackupDeleteStatusAbsent
	}
	return r
}

func deleteObjects(ctx context.Context, r protocol.VolumeBackupDeleteResult, dest *destination, objects protocol.BackupObjects) protocol.VolumeBackupDeleteResult {
	names := []string{filepath.Base(objects.Archive), filepath.Base(objects.Metadata)}
	absent := 0
	for _, name := range names {
		if _, err := dest.store.Head(ctx, name); s3store.IsNotFound(err) {
			absent++
		} else if err != nil {
			return failedDelete(r, string(protocol.ErrorCodeInternalError), dest.scrub(err).Error(), "Check the bucket access and the stationd log, then expire the backup again.")
		}
	}
	if absent == len(names) {
		r.Status = protocol.VolumeBackupDeleteStatusAbsent
		return r
	}
	for _, name := range names {
		if err := dest.store.Delete(ctx, name); err != nil {
			return failedDelete(r, string(protocol.ErrorCodeInternalError), dest.scrub(err).Error(), "Check the bucket access and the stationd log, then expire the backup again.")
		}
	}
	return r
}

func (s *Station) volumeBackupDelete(_ context.Context, m dispatch.Message, b protocol.VolumeBackupDeleteBody) {
	results := make([]protocol.VolumeBackupDeleteResult, len(b.Items))
	remote := map[int]*destination{}
	for i, it := range b.Items {
		r := protocol.VolumeBackupDeleteResult{SnapshotId: it.SnapshotId, Status: protocol.VolumeBackupDeleteStatusDeleted}
		dest, failure := s.destinationFor(it.SnapshotId, it.Target)
		switch {
		case failure != nil:
			r = failedDelete(r, failure.Code, failure.Explanation, failure.Fix)
		case dest.store != nil:
			remote[i] = dest
		default:
			r = deleteFiles(r, dest.dir, it.Objects)
			s.log.Info("volume backup deleted", "snapshot", it.SnapshotId, "target", dest.where, "status", r.Status)
		}
		results[i] = r
	}
	ref := m.ID
	if len(remote) == 0 {
		s.send(protocol.MessageVolumeBackupDeleteResult, &ref, protocol.VolumeBackupDeleteResultBody{Items: results})
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), backupTimeout)
		defer cancel()
		for i, dest := range remote {
			results[i] = deleteObjects(ctx, results[i], dest, b.Items[i].Objects)
			s.log.Info("volume backup deleted", "snapshot", b.Items[i].SnapshotId, "target", dest.where, "status", results[i].Status)
		}
		s.post(context.Background(), func() {
			s.send(protocol.MessageVolumeBackupDeleteResult, &ref, protocol.VolumeBackupDeleteResultBody{Items: results})
		})
	}()
}
