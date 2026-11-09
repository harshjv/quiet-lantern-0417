//go:build linux

package deploy

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/harshjv/stationly/go/internal/protocol"
	"github.com/harshjv/stationly/go/internal/secrets"
)

const gateDeployment = "dep_01JCGATE00000000000000000A"

func gateStation(t *testing.T) (*Station, *ServicePlan) {
	t.Helper()
	spec := protocol.ContainerSpec{
		Env: []protocol.EnvEntry{{Key: "SECRET_KEY", Injection: protocol.InjectionEnv}},
	}
	digest, err := secrets.Digest(spec.Env)
	if err != nil {
		t.Fatal(err)
	}
	spec.EnvDigest = digest
	s := &Station{log: slog.New(slog.NewTextHandler(io.Discard, nil)), secrets: secrets.NewStore()}
	return s, &ServicePlan{ID: "svc_gate", DeploymentID: gateDeployment, Spec: spec}
}

func exitedView(id string, at time.Time) view {
	code := 137
	return view{id: id, state: "exited", exitCode: &code, exitedAt: at.Format(time.RFC3339Nano)}
}

func TestAServiceWaitingForItsValuesSpendsNoRestartAndStartsWithTheFullBudget(t *testing.T) {
	s, sp := gateStation(t)
	st := &serviceState{service: exitedView("svc-old", time.Unix(0, 0)), coupler: exitedView("cpl-old", time.Unix(0, 0))}
	start := time.Unix(1_000, 0)
	st.downSince = start

	for i := 0; i <= 45; i++ {
		_, proceed := s.startGate(context.Background(), st, sp, start.Add(time.Duration(i)*time.Second), true, true)
		if proceed {
			t.Fatalf("pass %d started the service before its values arrived", i)
		}
		if st.exhausted || len(st.restarts) != 0 || st.failure != nil {
			t.Fatalf("pass %d: waiting changed the restart state: exhausted=%v restarts=%d failure=%v", i, st.exhausted, len(st.restarts), st.failure)
		}
		if st.blockedBy != "secrets/"+gateDeployment || st.blockedErr == nil || st.blockedErr.Code != string(protocol.ErrorCodeSecretsUnavailable) {
			t.Fatalf("pass %d: waiting state not reported: blockedBy=%q err=%v", i, st.blockedBy, st.blockedErr)
		}
	}

	s.secrets.Put(&secrets.Set{DeploymentID: gateDeployment, Digest: sp.Spec.EnvDigest, Entries: []secrets.Entry{{Key: "SECRET_KEY", Injection: protocol.InjectionEnv, Value: []byte("v")}}})
	env, proceed := s.startGate(context.Background(), st, sp, start.Add(46*time.Second), true, true)
	if !proceed || len(env) != 1 || env[0] != "SECRET_KEY=v" {
		t.Fatalf("the service did not start with its values once they arrived: proceed=%v env=%v", proceed, env)
	}
	if len(st.restarts) != 1 || st.exhausted || st.blockedBy != "" {
		t.Fatalf("after delivery: restarts=%d exhausted=%v blockedBy=%q, want one restart of %d spent", len(st.restarts), st.exhausted, st.blockedBy, restartBudget)
	}
}

func TestAFailedStartRetriedUnderTheSameExitSpendsNoMoreRestarts(t *testing.T) {
	s, sp := gateStation(t)
	s.secrets.Put(&secrets.Set{DeploymentID: gateDeployment, Digest: sp.Spec.EnvDigest})
	st := &serviceState{service: exitedView("svc-old", time.Unix(0, 0))}
	now := time.Unix(1_000, 0)
	st.downSince = now.Add(-time.Minute)
	for i := 0; i < 20; i++ {
		if _, proceed := s.startGate(context.Background(), st, sp, now.Add(time.Duration(i)*time.Minute), true, true); !proceed {
			t.Fatalf("retry %d was refused", i)
		}
	}
	if len(st.restarts) != 1 || st.exhausted {
		t.Fatalf("restarts=%d exhausted=%v, want the one exit counted once", len(st.restarts), st.exhausted)
	}
}

func TestACrashingContainerExhaustsTheBudget(t *testing.T) {
	s, sp := gateStation(t)
	s.secrets.Put(&secrets.Set{DeploymentID: gateDeployment, Digest: sp.Spec.EnvDigest})
	st := &serviceState{}
	now := time.Unix(1_000, 0)
	started := 0
	for i := 0; i < 30 && !st.exhausted; i++ {
		st.service = exitedView("svc", now)
		st.downSince = now.Add(-time.Hour)
		if _, proceed := s.startGate(context.Background(), st, sp, now, true, true); proceed {
			started++
		}
		now = now.Add(time.Minute)
	}
	if !st.exhausted || started != restartBudget {
		t.Fatalf("exhausted=%v started=%d, want exhausted after %d restarts", st.exhausted, started, restartBudget)
	}
	if st.failure == nil || st.failure.Code != string(protocol.ErrorCodeExitNonzero) {
		t.Fatalf("failure = %v, want EXIT_NONZERO", st.failure)
	}
}
