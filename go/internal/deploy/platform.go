//go:build linux

package deploy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/harshjv/stationly/go/internal/depot"
	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/rootsocket"
	"github.com/harshjv/stationly/go/internal/workshop"
	"github.com/moby/moby/api/types/registry"
)

func (s *Station) configurePlatform(ctx context.Context) {
	g := s.plan.Generation
	s.workshops.SetGeneration(g)
	if _, err := s.workshops.EnsureAppArmor(); err != nil {
		s.log.Error("load the Workshop AppArmor profile", "error", err)
	}
	settings, err := depot.SettingsFrom(g)
	if err != nil {
		s.log.Error("Depot settings", "error", err)
		return
	}
	if rec, ok := s.comps["depot"]; ok && s.depot.Image() == "" {
		s.depot.SetImage(s.sourceOf("depot") + "@" + rec.Digest)
	}
	if err := s.depot.Configure(settings); err != nil {
		s.log.Error("Depot configuration", "error", err)
		return
	}
	s.registryAddr = g.Station.Registry.Address
	s.checkInsecureRegistry(ctx)
}

func (s *Station) checkInsecureRegistry(ctx context.Context) {
	info, err := s.docker.Info(ctx)
	if err != nil {
		return
	}
	ok, detail := InsecureRegistryListed(info.Info.RegistryConfig, s.registryAddr)
	s.insecureOK.Store(ok)
	s.workshops.SetInsecureRegistries(InsecureRegistries(info.Info.RegistryConfig))
	if ok {
		s.log.Info("daemon.json insecure-registries lists Depot", "address", s.registryAddr, "match", detail)
		return
	}
	s.log.Error("daemon.json insecure-registries does not list Depot; dockerd pulls from Depot fail with \"http: server gave HTTP response to HTTPS client\"", "address", s.registryAddr, "fix", "add the address to insecure-registries in /etc/docker/daemon.json and run systemctl reload docker (an install-time step)")
}

func InsecureRegistryListed(cfg *registry.ServiceConfig, addr string) (bool, string) {
	if cfg == nil {
		return false, ""
	}
	if idx, ok := cfg.IndexConfigs[addr]; ok && !idx.Secure {
		return true, "IndexConfigs[" + addr + "]"
	}
	ap, err := netip.ParseAddrPort(addr)
	if err != nil {
		return false, ""
	}
	for _, p := range cfg.InsecureRegistryCIDRs {
		if p.Contains(ap.Addr()) {
			return true, "InsecureRegistryCIDRs " + p.String()
		}
	}
	return false, ""
}

func InsecureRegistries(cfg *registry.ServiceConfig) []string {
	if cfg == nil {
		return nil
	}
	var out []string
	for name, idx := range cfg.IndexConfigs {
		if idx != nil && !idx.Secure {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

func (s *Station) pullAuth(ref string) (string, bool, error) {
	prefix := s.registryAddr + "/"
	if s.registryAddr == "" || !strings.HasPrefix(ref, prefix) {
		return "", false, nil
	}
	repo := strings.TrimPrefix(ref, prefix)
	if i := strings.IndexAny(repo, "@"); i >= 0 {
		repo = repo[:i]
	} else if i := strings.LastIndex(repo, ":"); i >= 0 {
		repo = repo[:i]
	}
	signer := s.depot.Signer()
	if signer == nil {
		return "", false, fmt.Errorf("Depot signing key is not loaded")
	}
	tok, err := signer.Mint("dockerd", []depot.Access{depot.Repository(repo, depot.ActionPull)}, depot.PullTokenTTL)
	if err != nil {
		return "", false, err
	}
	auth, err := docker.RegistryTokenAuth(tok)
	if err != nil {
		return "", false, err
	}
	s.log.Info("per-pull registry token minted", "scope", "repository:"+repo+":pull", "ttl", depot.PullTokenTTL, "ref", ref)
	return auth, true, nil
}

var (
	projectID = regexp.MustCompile(`^prj_[0-9A-HJKMNP-TV-Z]{26}$`)
	serviceID = regexp.MustCompile(`^svc_[0-9A-HJKMNP-TV-Z]{26}$`)
)

func invalidParams(err error) *protocol.ErrorBody {
	return &protocol.ErrorBody{Code: string(protocol.ErrorCodeProtocolInvalidMessage), Explanation: "params: " + err.Error(), Fix: "Send the params the op documents."}
}

func (s *Station) handlers() map[string]rootsocket.Handler {
	return map[string]rootsocket.Handler{
		protocol.RootSocketOpStatus:              s.opStatus,
		protocol.RootSocketOpRegistryToken:       s.opToken,
		protocol.RootSocketOpRegistryDelete:      s.opDelete,
		protocol.RootSocketOpRegistryRetain:      s.opRetain,
		protocol.RootSocketOpRegistryGc:          s.opGC,
		protocol.RootSocketOpSecretsStatus:       s.opSecretsStatus,
		protocol.RootSocketOpLogs:                s.opLogs,
		protocol.RootSocketOpSetup:               s.opSetup,
		protocol.RootSocketOpPublicAddressDetect: s.opDetectPublicAddress,
		protocol.RootSocketOpAdminRecoveryKey:    s.opRecoveryKey,
		protocol.RootSocketOpDoctor:              s.opDoctor,
	}
}

func (s *Station) opStatus(ctx context.Context, _ json.RawMessage, _ func(string, string)) (any, *protocol.ErrorBody) {
	state, failure := s.depot.State()
	front, dist := s.registryAddresses()
	return map[string]any{
		"registry": map[string]any{
			"state": state, "failure": failure, "front": front, "distribution": dist,
			"insecure_registries_listed": s.insecureOK.Load(),
		},
		"workshops": s.workshops.Observed(),
		"dispatch":  s.link.Status(),
		"arch":      s.workshops.Arch(),
	}, nil
}

func (s *Station) registryAddresses() (string, string) {
	ds := s.depot.Settings()
	if ds.Front.IsValid() {
		return ds.Front.String(), ds.Dist.String()
	}
	if s.opts.Install != nil {
		if front, err := netip.ParseAddrPort(s.opts.Install.RegistryAddress); err == nil {
			return front.String(), depot.DistAddress(front).String()
		}
	}
	return "", ""
}

func (s *Station) opToken(ctx context.Context, params json.RawMessage, _ func(string, string)) (any, *protocol.ErrorBody) {
	var p protocol.RootSocketTokenParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, invalidParams(err)
	}
	var ttl time.Duration
	if p.TtlS != nil {
		ttl = time.Duration(*p.TtlS) * time.Second
	}
	if ttl <= 0 || ttl > depot.PullTokenTTL {
		ttl = depot.PullTokenTTL
	}
	signer := s.depot.Signer()
	if signer == nil {
		return nil, &protocol.ErrorBody{Code: string(protocol.ErrorCodeBuildFailed), Explanation: "Depot signing key is not loaded", Fix: "Apply a generation first."}
	}
	access := depot.ParseScopes(p.Scopes)
	tok, err := signer.Mint("root-socket", access, ttl)
	if err != nil {
		return nil, invalidParams(err)
	}
	return map[string]any{"token": tok, "access": access, "expires_in": int(ttl.Seconds())}, nil
}

func (s *Station) deleteItems(ctx context.Context, items []protocol.RegistryDeleteItem) protocol.RegistryDeleteResultBody {
	out := protocol.RegistryDeleteResultBody{Items: []protocol.RegistryDeleteResult{}}
	client := s.depot.Client()
	for _, it := range items {
		r := protocol.RegistryDeleteResult{Repository: it.Repository, Digest: it.Digest}
		status, err := client.Delete(ctx, it.Repository, it.Digest)
		r.Status = protocol.RegistryDeleteStatus(status)
		if err != nil {
			r.Error = &protocol.RegistryDeleteResultError{Code: string(protocol.ErrorCodeBuildFailed), Explanation: err.Error(), Fix: "Check that Depot is serving and retry."}
		}
		s.log.Info("registry delete", "repository", it.Repository, "digest", it.Digest, "reason", it.Reason, "status", status)
		out.Items = append(out.Items, r)
	}
	return out
}

func (s *Station) opDelete(ctx context.Context, params json.RawMessage, _ func(string, string)) (any, *protocol.ErrorBody) {
	var body protocol.RegistryDeleteBody
	if err := json.Unmarshal(params, &body); err != nil {
		return nil, invalidParams(err)
	}
	return s.deleteItems(ctx, body.Items), nil
}

func inUseDigests(g *protocol.Generation) map[string]bool {
	used := map[string]bool{}
	add := func(ref string) {
		if i := strings.Index(ref, "@"); i >= 0 {
			used[ref[i+1:]] = true
		}
	}
	for _, svc := range g.Services {
		if svc.Current != nil {
			add(svc.Current.Spec.ImageRef)
		}
	}
	for _, d := range g.Deployments {
		add(d.Target.ImageRef)
	}
	return used
}

func (s *Station) opRetain(ctx context.Context, params json.RawMessage, progress func(string, string)) (any, *protocol.ErrorBody) {
	var p protocol.RootSocketRetainParams
	if err := json.Unmarshal(params, &p); err != nil || p.ProjectId == "" {
		return nil, invalidParams(errors.New("project_id is required"))
	}
	g := s.workshops.Generation()
	ws, ok := g.Workshops[p.ProjectId]
	if !ok {
		return nil, invalidParams(fmt.Errorf("project %s has no Workshop entry in the generation", p.ProjectId))
	}
	records, err := workshop.Records(s.opts.StateDir)
	if err != nil {
		return nil, invalidParams(err)
	}
	used := inUseDigests(g)
	byService := map[string][]workshop.Record{}
	for _, r := range records {
		if r.ProjectID == p.ProjectId && r.Result.Status == protocol.BuildStatusSucceeded && !r.Pruned && r.Result.IndexDigest != nil {
			byService[r.ServiceID] = append(byService[r.ServiceID], r)
		}
	}
	var items []protocol.RegistryDeleteItem
	prune := map[string]workshop.Record{}
	kept := map[string][]string{}
	services := make([]string, 0, len(byService))
	for id := range byService {
		services = append(services, id)
	}
	sort.Strings(services)
	for _, svc := range services {
		rs := byService[svc]
		for i, r := range rs {
			digest := *r.Result.IndexDigest
			if i < ws.ImageRetentionCount || used[digest] {
				kept[svc] = append(kept[svc], digest)
				continue
			}
			items = append(items, protocol.RegistryDeleteItem{Repository: depot.RepositoryFor(p.ProjectId, svc), Digest: digest, Reason: fmt.Sprintf("retention: older than the newest %d", ws.ImageRetentionCount)})
			prune[digest] = r
		}
	}
	progress("retention", fmt.Sprintf("keep %d per service, delete %d", ws.ImageRetentionCount, len(items)))
	res := s.deleteItems(ctx, items)
	for _, it := range res.Items {
		if it.Status == protocol.RegistryDeleteStatusDeleted || it.Status == protocol.RegistryDeleteStatusAbsent {
			r := prune[it.Digest]
			r.Pruned = true
			if err := workshop.SaveRecord(s.opts.StateDir, r); err != nil {
				s.log.Error("mark build record pruned", "build", r.BuildID, "error", err)
			}
		}
	}
	return map[string]any{"image_retention_count": ws.ImageRetentionCount, "kept": kept, "deleted": res.Items}, nil
}

func (s *Station) opGC(ctx context.Context, params json.RawMessage, progress func(string, string)) (any, *protocol.ErrorBody) {
	res, failure := s.maintenance(ctx, "root-socket", progress)
	if failure != nil {
		return res, failure
	}
	return res, nil
}
