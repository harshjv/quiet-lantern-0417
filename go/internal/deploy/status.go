//go:build linux

package deploy

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"text/tabwriter"

	"github.com/harshjv/stationly/go/internal/protocol"
)

func PrintStatus(w io.Writer, stateDir string, asJSON bool) error {
	raw, err := os.ReadFile(filepath.Join(stateDir, ObservedFile))
	if err != nil {
		return err
	}
	if asJSON {
		_, err := w.Write(raw)
		return err
	}
	var o protocol.Observed
	if err := json.Unmarshal(raw, &o); err != nil {
		return err
	}
	applied, _ := loadApplied(stateDir)
	names := map[string]string{}
	checked := map[string]bool{}
	if applied != nil {
		for id, svc := range applied.Services {
			names[id] = svc.Name
			checked[id] = svc.Current != nil && ruleFor(svc.Current.Spec.Health, svc.Current.Spec.Ports) != nil
		}
	}
	status := "none"
	if o.Applied.Status != nil {
		status = string(*o.Applied.Status)
	}
	hash := "none"
	if o.Applied.Hash != nil {
		hash = *o.Applied.Hash
	}
	fmt.Fprintf(w, "station %s  observed %s\n", o.StationId, o.ObservedAt)
	fmt.Fprintf(w, "generation %d  %s  %s\n", o.Applied.Number, status, hash)
	fmt.Fprintf(w, "docker %s  unknown objects %d\n", o.Station.DockerVersion, len(o.Unknown))
	fmt.Fprintf(w, "registry %s\n", o.Station.Registry.State)
	for _, id := range sortedKeys(o.Workshops) {
		ws := o.Workshops[id]
		fmt.Fprintf(w, "workshop %s  running %t  builds %d\n", id, ws.Running, ws.BuildsRunning)
	}
	fmt.Fprintln(w)

	tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "ENVIRONMENT\tRESULT\tNETWORK\tBRIDGE\tFAILURE")
	for _, id := range sortedKeys(o.Environments) {
		e := o.Environments[id]
		network := "-"
		if e.DockerNetworkId != nil {
			network = shortID(*e.DockerNetworkId)
		}
		bridge := "down"
		if e.BridgeUp {
			bridge = "up"
		}
		failure := "-"
		if e.Failure != nil {
			failure = e.Failure.Code + ": " + e.Failure.Explanation
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", id, e.Result, network, bridge, failure)
	}
	fmt.Fprintln(tw)
	vips := map[string]string{}
	if applied != nil {
		for id, svc := range applied.Services {
			vips[id] = svc.VirtualIp
		}
	}
	fmt.Fprintln(tw, "SERVICE\tNAME\tSTATUS\tHINT\tHEALTH\tRESTARTS\tVIRTUAL_IP\tSWITCH\tCONTAINERS\tFAILURE")
	for _, id := range sortedKeys(o.Services) {
		svc := o.Services[id]
		restarts := 0
		var parts []string
		for _, c := range svc.Containers {
			addr := "-"
			if c.Address != nil {
				addr = *c.Address
			}
			exit := ""
			if c.ExitCode != nil {
				exit = fmt.Sprintf(" exit=%d", *c.ExitCode)
			}
			parts = append(parts, fmt.Sprintf("%s=%s:%s@%s%s", c.Role, shortID(c.ContainerId), c.State, addr, exit))
			restarts = max(restarts, c.Restarts)
		}
		failure := "-"
		if svc.Failure != nil {
			failure = svc.Failure.Code + ": " + svc.Failure.Explanation
		}
		health := fmt.Sprintf("%s/%d", svc.Health.State, svc.Health.Consecutive)
		sw := "-"
		if svc.SwitchAddress != nil {
			sw = *svc.SwitchAddress
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%d\t%s\t%s\t%s\t%s\n", id, names[id], derivedStatus(svc, checked[id]), svc.StatusHint, health, restarts, vips[id], sw, strings.Join(parts, " "), failure)
	}
	if err := tw.Flush(); err != nil {
		return err
	}
	if err := printGateway(w, o, applied); err != nil {
		return err
	}
	if err := printVolumes(w, o, applied); err != nil {
		return err
	}
	if err := printRuns(w, o, names); err != nil {
		return err
	}
	if len(o.Deployments) == 0 {
		return nil
	}
	fmt.Fprintln(w)
	tw = tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "DEPLOYMENT\tSERVICE\tNUMBER\tSTRATEGY\tSTATUS\tSTEP\tCANCEL")
	ids := sortedKeys(o.Deployments)
	for _, id := range ids {
		d := o.Deployments[id]
		number, strategy, service := "-", "-", "-"
		if applied != nil {
			if dd, ok := applied.Deployments[id]; ok {
				number, strategy, service = fmt.Sprint(dd.Number), string(dd.Strategy), names[dd.ServiceId]
			}
		}
		cancel := "-"
		if applied != nil {
			if dd, ok := applied.Deployments[id]; ok && dd.Cancel != nil {
				cancel = string(dd.Cancel.Reason)
			}
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s/%s\t%s\n", id, service, number, strategy, DeploymentStatus(d), d.Step, d.StepStatus, cancel)
	}
	if err := tw.Flush(); err != nil {
		return err
	}
	for _, id := range ids {
		d := o.Deployments[id]
		fmt.Fprintf(w, "\n%s  %s", id, DeploymentStatus(d))
		if d.CancelReason != nil {
			fmt.Fprintf(w, " (%s)", *d.CancelReason)
		}
		if d.FinishedAt != nil {
			fmt.Fprintf(w, "  finished %s", *d.FinishedAt)
		}
		fmt.Fprintln(w)
		for _, st := range d.Steps {
			if st.Status == protocol.DeploymentStepStatusPending && st.Attempt == 0 {
				continue
			}
			at, took := "-", ""
			if st.StartedAt != nil {
				at = *st.StartedAt
				if st.FinishedAt != nil {
					took = fmt.Sprintf(" %.3fs", parseStamp(st.FinishedAt).Sub(parseStamp(st.StartedAt)).Seconds())
				}
			}
			detail, _ := json.Marshal(st.Detail)
			fmt.Fprintf(w, "  %-10s %-7s #%d %s%s %s\n", st.Step, st.Status, st.Attempt, at, took, detail)
		}
		if d.Failure != nil {
			b, _ := json.MarshalIndent(d.Failure, "  ", "  ")
			fmt.Fprintf(w, "  diagnosis: %s\n", b)
		}
	}
	return nil
}

func DeploymentStatus(d protocol.ObservedDeployment) string {
	if d.Outcome != nil {
		return string(*d.Outcome)
	}
	if d.Step == protocol.DeploymentStepNamePull && d.StepStatus == protocol.DeploymentStepStatusPending {
		return "queued"
	}
	switch d.Step {
	case protocol.DeploymentStepNamePull:
		return "building"
	case protocol.DeploymentStepNamePreDeploy:
		return "pre_deploy"
	case protocol.DeploymentStepNameHealth:
		return "waiting_health"
	case protocol.DeploymentStepNameCutover:
		return "cutover"
	case protocol.DeploymentStepNameDrain, protocol.DeploymentStepNameCleanup:
		return "draining"
	}
	return "starting"
}

func derivedStatus(svc protocol.ObservedService, checked bool) string {
	switch {
	case svc.Result == protocol.ObjectResultFailed || svc.Result == protocol.ObjectResultBlocked || svc.Health.State == protocol.HealthStateFailed:
		return "red"
	case svc.StatusHint == protocol.StatusHintStopped:
		return "stopped"
	case svc.StatusHint == protocol.StatusHintRunning && (svc.Health.State == protocol.HealthStatePassing || svc.Health.State == protocol.HealthStateNone && !checked):
		return "green"
	default:
		return "amber"
	}
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func shortID(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

func printVolumes(w io.Writer, o protocol.Observed, applied *protocol.Generation) error {
	if len(o.Volumes) == 0 {
		return nil
	}
	fmt.Fprintln(w)
	tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "VOLUME\tDOCKER_NAME\tOWNER\tSERVICE\tSTATUS\tRETAIN_UNTIL\tRESULT\tSIZE\tMOUNTED_BY\tFAILURE")
	for _, id := range sortedKeys(o.Volumes) {
		v := o.Volumes[id]
		name, owner, service, want, until := "-", "-", "-", "-", "-"
		if applied != nil {
			if d, ok := applied.Volumes[id]; ok {
				name, owner, want = d.DockerName, string(d.Owner), string(d.Status)
				if d.ServiceId != nil {
					service = *d.ServiceId
				}
				if d.RetainUntil != nil {
					until = *d.RetainUntil
				}
			}
		}
		mounted := "-"
		if len(v.MountedBy) > 0 {
			mounted = strings.Join(v.MountedBy, ",")
		}
		failure := "-"
		if v.Failure != nil {
			failure = v.Failure.Code + ": " + v.Failure.Explanation
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%d\t%s\t%s\n", id, name, owner, service, want, until, v.Result, v.SizeBytes, mounted, failure)
	}
	return tw.Flush()
}

func printRuns(w io.Writer, o protocol.Observed, names map[string]string) error {
	if len(o.Runs) == 0 {
		return nil
	}
	ids := sortedKeys(o.Runs)
	at := func(r protocol.ObservedRun) string {
		for _, p := range []*string{r.ScheduledAt, r.StartedAt, r.FinishedAt} {
			if p != nil {
				return *p
			}
		}
		return ""
	}
	sort.SliceStable(ids, func(i, j int) bool { return at(o.Runs[ids[i]]) < at(o.Runs[ids[j]]) })
	fmt.Fprintln(w)
	tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "RUN\tSERVICE\tKIND\tSTATUS\tEXIT\tSCHEDULED\tSTARTED\tFINISHED\tSECONDS\tLOG\tFAILURE")
	for _, id := range ids {
		r := o.Runs[id]
		exit, secs := "-", "-"
		if r.ExitCode != nil {
			exit = fmt.Sprint(*r.ExitCode)
		}
		if r.StartedAt != nil && r.FinishedAt != nil {
			secs = fmt.Sprintf("%.2f", parseStamp(r.FinishedAt).Sub(parseStamp(r.StartedAt)).Seconds())
		}
		failure := "-"
		if r.Failure != nil {
			failure = r.Failure.Code + ": " + r.Failure.Summary
		}
		name := names[r.ServiceId]
		if name == "" {
			name = r.ServiceId
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", id, name, r.Kind, r.Status, exit, orDash(r.ScheduledAt), orDash(r.StartedAt), orDash(r.FinishedAt), secs, r.LogRef, failure)
	}
	return tw.Flush()
}

func orDash(p *string) string {
	if p == nil {
		return "-"
	}
	return *p
}

func printGateway(w io.Writer, o protocol.Observed, applied *protocol.Generation) error {
	gw, ok := o.Components["gateway"]
	if !ok && len(o.PortAllocations) == 0 {
		return nil
	}
	fmt.Fprintln(w)
	if ok {
		fmt.Fprintf(w, "gateway traefik %s  %s  container %s  %s\n", gw.Version, gw.Status, shortID(orDash(gw.ContainerId)), orDash(gw.Digest))
	}
	tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "ROUTE\tHOSTNAME\tINGRESS\tTARGET\tRESULT\tCERTIFICATE\tEXPIRES")
	for _, id := range sortedKeys(o.Gateway.Routes) {
		r := o.Gateway.Routes[id]
		host, ingress, target := "-", "-", "-"
		if applied != nil {
			if ar, ok := applied.Gateway.Routes[id]; ok {
				host, ingress, target = ar.Hostname, string(ar.Ingress), fmt.Sprintf("%s:%d", ar.Target.VirtualIp, ar.Target.Port)
			}
		}
		result := string(r.Result)
		if r.BlockedBy != nil {
			result += " (" + *r.BlockedBy + ")"
		}
		cert, expires := "-", "-"
		if r.Certificate != nil {
			cert, expires = string(r.Certificate.Status), orDash(r.Certificate.ExpiresAt)
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n", id, host, ingress, target, result, cert, expires)
	}
	if len(o.PortAllocations) > 0 {
		fmt.Fprintln(tw, "PORT ALLOCATION\tHOST PORT\tSERVICE\tTARGET\tRESULT\t\t")
		for _, id := range sortedKeys(o.PortAllocations) {
			p := o.PortAllocations[id]
			port, svc, target := "-", "-", "-"
			if applied != nil {
				if ap, ok := applied.PortAllocations[id]; ok {
					port, svc, target = fmt.Sprint(ap.HostPort), ap.ServiceId, fmt.Sprintf("%s:%d", ap.VirtualIp, ap.ContainerPort)
				}
			}
			result := string(p.Result)
			if p.BlockedBy != nil {
				result += " (" + *p.BlockedBy + ")"
			}
			fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t\t\n", id, port, svc, target, result)
		}
	}
	return tw.Flush()
}
