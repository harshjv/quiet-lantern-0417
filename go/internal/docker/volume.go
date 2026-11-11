package docker

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/moby/moby/api/types/volume"
	"github.com/moby/moby/client"
)

func VolumeLabels(stationID, volumeID, owner string, serviceID *string) map[string]string {
	labels := map[string]string{
		LabelStation: stationID,
		LabelRole:    RoleVolume,
		LabelVolume:  volumeID,
		LabelOwner:   owner,
	}
	if serviceID != nil {
		labels[LabelService] = *serviceID
	}
	return labels
}

func (c *Client) InspectVolume(ctx context.Context, name string) (volume.Volume, error) {
	res, err := c.api.VolumeInspect(ctx, name, client.VolumeInspectOptions{})
	return res.Volume, err
}

func (c *Client) VolumeSizes(ctx context.Context) (map[string]int64, error) {
	res, err := c.api.DiskUsage(ctx, client.DiskUsageOptions{Volumes: true, Verbose: true})
	if err != nil {
		return nil, err
	}
	out := map[string]int64{}
	for _, v := range res.Volumes.Items {
		if v.UsageData != nil && v.UsageData.Size >= 0 {
			out[v.Name] = v.UsageData.Size
		}
	}
	return out, nil
}

func CheckVolume(v volume.Volume, dockerRoot string) error {
	if v.Driver != "local" {
		return fmt.Errorf("volume %s uses driver %s, only local is allowed", v.Name, v.Driver)
	}
	if len(v.Options) > 0 {
		return fmt.Errorf("volume %s carries driver options %v, which can bind a host path", v.Name, v.Options)
	}
	root := filepath.Join(dockerRoot, "volumes")
	if !under(filepath.Clean(v.Mountpoint), root) {
		return fmt.Errorf("volume %s mounts from %s, outside the volume root %s", v.Name, v.Mountpoint, root)
	}
	return nil
}
