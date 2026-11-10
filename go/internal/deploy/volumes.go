//go:build linux

package deploy

import (
	"context"
	"fmt"
	"sort"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/volume"

	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/protocol"
)

const volumeSizeInterval = time.Minute

type volumeState struct {
	failure   *protocol.ErrorBody
	exists    bool
	destroyed bool
	mountedBy []string
}

func volumeFailure(code protocol.ErrorCode, format string, args ...any) *protocol.ErrorBody {
	return &protocol.ErrorBody{
		Code:        string(code),
		Explanation: fmt.Sprintf(format, args...),
		Fix:         "Give the volume a docker_name no other Docker volume uses, or remove the conflicting volume by hand, then apply again.",
	}
}

func (s *Station) reconcileVolumes(ctx context.Context, containers []container.Summary) []protocol.UnknownObject {
	g := s.plan.Generation
	listed, err := s.docker.VolumesWithLabel(ctx, docker.LabelStation)
	if err != nil {
		s.log.Warn("list volumes", "error", err)
		return nil
	}
	mounted := map[string][]string{}
	for _, c := range containers {
		for _, m := range c.Mounts {
			if m.Name != "" {
				mounted[m.Name] = append(mounted[m.Name], containerName(c))
			}
		}
	}
	var unknown []protocol.UnknownObject
	byName := map[string]volume.Volume{}
	for _, v := range listed {
		if v.Labels[docker.LabelStation] != g.StationId {
			unknown = append(unknown, protocol.UnknownObject{Kind: protocol.UnknownObjectKindVolume, DockerId: ptr(v.Name), Labels: v.Labels})
			continue
		}
		if v.Labels[docker.LabelRole] != docker.RoleVolume {
			continue
		}
		byName[v.Name] = v
		if _, ok := g.Volumes[v.Labels[docker.LabelVolume]]; !ok {
			unknown = append(unknown, protocol.UnknownObject{Kind: protocol.UnknownObjectKindVolume, DockerId: ptr(v.Name), Labels: v.Labels})
		}
	}
	for id := range s.volumes {
		if _, ok := g.Volumes[id]; !ok {
			delete(s.volumes, id)
		}
	}
	root := s.info.DockerRootDir
	for _, id := range sortedKeys(g.Volumes) {
		want := g.Volumes[id]
		st := s.volumes[id]
		if st == nil {
			st = &volumeState{}
			s.volumes[id] = st
		}
		st.mountedBy = mounted[want.DockerName]
		sort.Strings(st.mountedBy)
		v, ok := byName[want.DockerName]
		if want.Status == protocol.DesiredVolumeStatusDestroy {
			st.exists = ok
			continue
		}
		if !ok {
			existing, err := s.docker.InspectVolume(ctx, want.DockerName)
			switch {
			case err == nil:
				st.failure = volumeFailure(protocol.ErrorCodeStationInvariantViolation, "docker_name %s is taken by a volume stationd does not own (labels %v)", want.DockerName, existing.Labels)
				st.exists = false
				continue
			case !cerrdefs.IsNotFound(err):
				st.failure = dockerFailure(protocol.ErrorCodeStationInvariantViolation, "inspect volume "+want.DockerName, err)
				continue
			}
			created, _, err := s.docker.EnsureVolume(ctx, want.DockerName, docker.VolumeLabels(g.StationId, id, string(want.Owner), want.ServiceId))
			if err != nil {
				st.failure = dockerFailure(protocol.ErrorCodeStationInvariantViolation, "create volume "+want.DockerName, err)
				s.log.Error("create volume", "volume", id, "name", want.DockerName, "error", err)
				continue
			}
			s.log.Info("created volume", "volume", id, "name", want.DockerName, "owner", want.Owner, "mountpoint", created.Mountpoint)
			v = created
		} else if v.Labels[docker.LabelVolume] != id {
			st.failure = volumeFailure(protocol.ErrorCodeStationInvariantViolation, "docker_name %s belongs to volume %s, not %s", want.DockerName, v.Labels[docker.LabelVolume], id)
			continue
		}
		if err := docker.CheckVolume(v, root); err != nil {
			st.failure = volumeFailure(protocol.ErrorCodeStationInvariantViolation, "%v", err)
			s.log.Error("volume breaks the volume root invariant", "volume", id, "error", err)
			continue
		}
		st.exists, st.failure = true, nil
	}
	if time.Since(s.volumeSizesAt) >= volumeSizeInterval {
		if sizes, err := s.docker.VolumeSizes(ctx); err == nil {
			s.volumeSizes, s.volumeSizesAt = sizes, time.Now()
		} else {
			s.log.Warn("volume sizes", "error", err)
		}
	}
	return unknown
}

func (s *Station) destroyVolumes(ctx context.Context) {
	g := s.plan.Generation
	for _, id := range sortedKeys(g.Volumes) {
		want, st := g.Volumes[id], s.volumes[id]
		if want.Status != protocol.DesiredVolumeStatusDestroy || st == nil || !st.exists {
			if st != nil && want.Status == protocol.DesiredVolumeStatusDestroy && !st.exists {
				st.destroyed, st.failure = true, nil
			}
			continue
		}
		if len(st.mountedBy) > 0 {
			st.failure = volumeFailure(protocol.ErrorCodeGenerationInvalid, "volume %s is still mounted by %v; stationd destroys it once nothing mounts it", want.DockerName, st.mountedBy)
			continue
		}
		v, err := s.docker.InspectVolume(ctx, want.DockerName)
		if err != nil || v.Labels[docker.LabelVolume] != id || v.Labels[docker.LabelStation] != g.StationId {
			st.failure = volumeFailure(protocol.ErrorCodeStationInvariantViolation, "volume %s is not labeled as volume %s of this station; stationd never removes it", want.DockerName, id)
			continue
		}
		if err := s.docker.RemoveVolume(ctx, want.DockerName); err != nil {
			st.failure = dockerFailure(protocol.ErrorCodeStationInvariantViolation, "remove volume "+want.DockerName, err)
			continue
		}
		st.exists, st.destroyed, st.failure = false, true, nil
		s.log.Warn("destroyed volume on an explicit destroy in the generation", "volume", id, "name", want.DockerName)
	}
}

func (s *Station) volumeBlock(spec protocol.ContainerSpec) *protocol.ErrorBody {
	for _, m := range spec.Volumes {
		st := s.volumes[m.VolumeId]
		switch {
		case st == nil:
			return volumeFailure(protocol.ErrorCodeStationInvariantViolation, "volume %s is not reconciled yet", m.VolumeId)
		case st.failure != nil:
			return st.failure
		case !st.exists:
			return volumeFailure(protocol.ErrorCodeStationInvariantViolation, "volume %s does not exist", m.VolumeId)
		}
	}
	return nil
}

func (s *Station) volumeBlockedBy(spec protocol.ContainerSpec) string {
	for _, m := range spec.Volumes {
		if st := s.volumes[m.VolumeId]; st == nil || st.failure != nil || !st.exists {
			return "volumes/" + m.VolumeId
		}
	}
	return ""
}

func (s *Station) observedVolumes(applied bool) protocol.ObservedVolumes {
	out := protocol.ObservedVolumes{}
	for id, want := range s.plan.Generation.Volumes {
		st := s.volumes[id]
		ov := protocol.ObservedVolume{Result: protocol.ObjectResultPending, MountedBy: []string{}}
		if st != nil {
			switch {
			case st.failure != nil:
				ov.Result, ov.Failure = protocol.ObjectResultFailed, st.failure
			case st.exists || st.destroyed:
				ov.Result = protocol.ObjectResultOk
				if applied {
					ov.AppliedHash = ptr(want.Hash)
				}
			}
			if st.mountedBy != nil {
				ov.MountedBy = st.mountedBy
			}
		}
		ov.SizeBytes = int(s.volumeSizes[want.DockerName])
		out[id] = ov
	}
	return out
}
