package workshop

import (
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/harshjv/stationly/go/internal/depot"
	"github.com/moby/buildkit/session/auth"
	"golang.org/x/crypto/nacl/sign"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const workshopTokenTTL = 300 * time.Second

type TokenEvent struct {
	Requested []string `json:"requested"`
	Granted   []string `json:"granted"`
	Dropped   []string `json:"dropped,omitempty"`
}

type depotAuth struct {
	auth.UnimplementedAuthServer
	log      *slog.Logger
	registry string
	project  string
	push     string
	signer   *depot.Signer
	seed     []byte
	mu       sync.Mutex
	events   []TokenEvent
}

func newDepotAuth(log *slog.Logger, signer *depot.Signer, registry, project, pushRepo string) *depotAuth {
	seed := make([]byte, 32)
	rand.Read(seed)
	return &depotAuth{log: log, registry: registry, project: project, push: pushRepo, signer: signer, seed: seed}
}

func (a *depotAuth) Register(s *grpc.Server) {
	auth.RegisterAuthServer(s, a)
}

func (a *depotAuth) authority(salt []byte) ed25519.PrivateKey {
	mac := hmac.New(sha256.New, salt)
	mac.Write(a.seed)
	return ed25519.NewKeyFromSeed(mac.Sum(nil)[:ed25519.SeedSize])
}

func (a *depotAuth) Credentials(ctx context.Context, req *auth.CredentialsRequest) (*auth.CredentialsResponse, error) {
	return &auth.CredentialsResponse{}, nil
}

func (a *depotAuth) GetTokenAuthority(ctx context.Context, req *auth.GetTokenAuthorityRequest) (*auth.GetTokenAuthorityResponse, error) {
	if req.Host != a.registry {
		return nil, status.Error(codes.Unimplemented, "no token authority for "+req.Host)
	}
	return &auth.GetTokenAuthorityResponse{PublicKey: a.authority(req.Salt).Public().(ed25519.PublicKey)}, nil
}

func (a *depotAuth) VerifyTokenAuthority(ctx context.Context, req *auth.VerifyTokenAuthorityRequest) (*auth.VerifyTokenAuthorityResponse, error) {
	if req.Host != a.registry {
		return nil, status.Error(codes.Unimplemented, "no token authority for "+req.Host)
	}
	priv := new([64]byte)
	copy(priv[:], a.authority(req.Salt))
	return &auth.VerifyTokenAuthorityResponse{Signed: sign.Sign(nil, req.Payload, priv)}, nil
}

func (a *depotAuth) FetchToken(ctx context.Context, req *auth.FetchTokenRequest) (*auth.FetchTokenResponse, error) {
	if req.Host != a.registry {
		return nil, status.Error(codes.Unimplemented, "no tokens for "+req.Host)
	}
	ev := TokenEvent{Requested: req.Scopes}
	var access []depot.Access
	for _, s := range req.Scopes {
		x, err := depot.ParseScope(s)
		if err != nil || x.Type != "repository" || !depot.UnderProject(a.project, x.Name) {
			if err == nil && x.Name == a.push && slices.Contains(x.Actions, depot.ActionPush) {
				return nil, status.Errorf(codes.PermissionDenied, "push target %s lies outside project prefix %s", x.Name, depot.ProjectPrefix(a.project))
			}
			ev.Dropped = append(ev.Dropped, s)
			continue
		}
		var actions []string
		for _, act := range x.Actions {
			if act == depot.ActionPull || act == depot.ActionPush {
				actions = append(actions, act)
			}
		}
		if len(actions) == 0 {
			ev.Dropped = append(ev.Dropped, s)
			continue
		}
		granted := depot.Repository(x.Name, actions...)
		access = append(access, granted)
		ev.Granted = append(ev.Granted, granted.Scope())
	}
	if slices.ContainsFunc(ev.Dropped, func(s string) bool { return strings.Contains(s, ":"+a.push+":") }) {
		return nil, status.Errorf(codes.PermissionDenied, "push target %s lies outside project prefix %s", a.push, depot.ProjectPrefix(a.project))
	}
	tok, err := a.signer.Mint("workshop:"+a.project, access, workshopTokenTTL)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	a.mu.Lock()
	a.events = append(a.events, ev)
	a.mu.Unlock()
	a.log.Info("Workshop token minted", "project", a.project, "granted", ev.Granted, "dropped", ev.Dropped)
	return &auth.FetchTokenResponse{Token: tok, ExpiresIn: int64(workshopTokenTTL.Seconds()), IssuedAt: time.Now().Unix()}, nil
}

func (a *depotAuth) Events() []TokenEvent {
	a.mu.Lock()
	defer a.mu.Unlock()
	return slices.Clone(a.events)
}
