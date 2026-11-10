//go:build linux

package deploy

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/harshjv/stationly/go/internal/docker"
	"github.com/harshjv/stationly/go/internal/protocol"
)

func rolloutTestStation(t *testing.T) *Station {
	t.Helper()
	g := &protocol.Generation{
		Services:     map[string]protocol.DesiredService{alphaWhoami: {EnvironmentId: alphaEnv}},
		Deployments:  map[string]protocol.DesiredDeployment{"dep_01JCROLLOUT0000000000000A": {ServiceId: alphaWhoami, Number: 3}},
		Environments: map[string]protocol.DesiredEnvironment{},
	}
	return &Station{
		log:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		opts:     Options{StateDir: t.TempDir()},
		rollouts: map[string]*rollout{},
		plan: &Plan{
			Generation: g,
			Networks:   map[string]docker.NetworkSpec{alphaEnv: {Name: "sly-aaaaaaaaaaa"}},
			Services:   map[string]*ServicePlan{alphaWhoami: {ID: alphaWhoami, EnvID: alphaEnv, NetworkName: "sly-aaaaaaaaaaa"}},
		},
	}
}

func TestARolloutKeepsTheNetworkNameOfItsEnvironment(t *testing.T) {
	s := rolloutTestStation(t)
	s.syncRollouts()
	r := s.rollouts["dep_01JCROLLOUT0000000000000A"]
	if r == nil || r.Network != "sly-aaaaaaaaaaa" || r.EnvID != alphaEnv {
		t.Fatalf("the rollout must record its environment and network when it arrives, got %+v", r)
	}
}

func TestRolloutNamespaceOfAServiceThatLeftTheGenerationIsAbsentNotAPanic(t *testing.T) {
	s := rolloutTestStation(t)
	s.syncRollouts()
	r := s.rollouts["dep_01JCROLLOUT0000000000000A"]
	delete(s.plan.Generation.Services, alphaWhoami)
	delete(s.plan.Generation.Deployments, r.ID)
	delete(s.plan.Services, alphaWhoami)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, ok := s.rolloutNamespace(ctx, r, "sly-coupler-green"); ok {
		t.Fatal("a deleted service has no namespace to write")
	}
	if reason := s.cancelReason(r); reason == nil || *reason != protocol.CancelReasonSuperseded {
		t.Fatalf("a deployment that left the generation is cancelled as superseded before cutover, got %v", reason)
	}
}

func capStation(t *testing.T, cap int) (*Station, *rollout, *rollout) {
	t.Helper()
	first, second := "dep_01JCROLLOUT0000000000000A", "dep_01JCROLLOUT0000000000000B"
	g := &protocol.Generation{
		Station: protocol.DesiredStation{ConcurrencyCap: cap},
		Services: map[string]protocol.DesiredService{
			alphaWhoami: {EnvironmentId: alphaEnv},
			alphaClient: {EnvironmentId: alphaEnv},
		},
		Deployments: map[string]protocol.DesiredDeployment{
			first:  {ServiceId: alphaWhoami, Number: 3},
			second: {ServiceId: alphaClient, Number: 3},
		},
		Environments: map[string]protocol.DesiredEnvironment{},
	}
	s := &Station{
		log:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		opts:     Options{StateDir: t.TempDir()},
		rollouts: map[string]*rollout{},
		plan:     &Plan{Generation: g, Networks: map[string]docker.NetworkSpec{alphaEnv: {Name: "sly-aaaaaaaaaaa"}}},
	}
	s.syncRollouts()
	running := s.rollouts[first]
	running.Steps[0].Status = statusRunning
	return s, running, s.rollouts[second]
}

func TestADeploymentWaitsWhileTheConcurrencyCapIsFull(t *testing.T) {
	s, _, waiting := capStation(t, 1)
	if s.mayStart(waiting, waiting.current()) {
		t.Fatal("a second deployment must wait while the cap of 1 is taken")
	}
}

func TestARaisedConcurrencyCapStartsTheWaitingDeployment(t *testing.T) {
	s, _, waiting := capStation(t, 2)
	if !s.mayStart(waiting, waiting.current()) {
		t.Fatal("a second deployment may start under a cap of 2")
	}
}

func TestACancelledDeploymentDoesNotHoldTheConcurrencyCap(t *testing.T) {
	s, running, waiting := capStation(t, 1)
	s.plan.Generation.Deployments[running.ID] = protocol.DesiredDeployment{ServiceId: alphaWhoami, Number: 3, Cancel: &protocol.DesiredDeploymentCancel{Reason: protocol.CancelReasonSuperseded}}
	if !s.mayStart(waiting, waiting.current()) {
		t.Fatal("a deployment being cancelled gives its slot back")
	}
}
