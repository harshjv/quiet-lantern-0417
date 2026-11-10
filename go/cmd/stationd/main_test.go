//go:build linux

package main

import (
	"bytes"
	"io"
	"maps"
	"slices"
	"strings"
	"testing"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

func executeArgs(args ...string) (int, string, string) {
	root := rootCmd(environment{})
	var stdout, stderr bytes.Buffer
	root.SetOut(&stdout)
	root.SetErr(io.Discard)
	root.SetArgs(args)
	code := execute(root, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestHelpExitsZeroAndListsEveryCommand(t *testing.T) {
	for _, args := range [][]string{{"--help"}, {"help"}, {"registry", "--help"}} {
		code, out, errOut := executeArgs(args...)
		if code != 0 || errOut != "" {
			t.Fatalf("%v exits %d with stderr %q, want 0 and nothing on stderr", args, code, errOut)
		}
		if !strings.Contains(out, "Usage:") {
			t.Fatalf("%v printed %q, want usage", args, out)
		}
	}
	_, out, _ := executeArgs("--help")
	for _, name := range []string{"enroll", "run", "install", "verify", "status", "connection", "doctor", "dispatch-env", "registry", "secrets", "logs"} {
		if !strings.Contains(out, "\n  "+name+" ") {
			t.Fatalf("help does not list %s:\n%s", name, out)
		}
	}
}

func TestUsageErrorsExitTwoWithUsage(t *testing.T) {
	for _, args := range [][]string{{}, {"bogus"}, {"registry"}, {"registry", "bogus"}, {"status", "--bogus"}, {"enroll"}, {"logs", "--tail", "many"}} {
		code, _, errOut := executeArgs(args...)
		if code != 2 || !strings.HasPrefix(errOut, "stationd: ") || !strings.Contains(errOut, "Usage:") {
			t.Fatalf("%v exits %d with stderr %q, want 2 with the error and usage", args, code, errOut)
		}
	}
}

func TestFlagsKeepTheirNames(t *testing.T) {
	want := map[string][]string{
		"stationd":                 nil,
		"stationd connection":      {"socket"},
		"stationd dispatch-env":    {"etc-dir", "state-dir"},
		"stationd doctor":          {"json", "socket"},
		"stationd enroll":          {"dispatch-url", "state-dir"},
		"stationd install":         {"allow-unsigned", "bin-dir", "daemon-json", "dispatch-url", "etc-dir", "link", "litestream-bucket", "litestream-endpoint", "no-host", "no-pull", "no-unit", "release", "run-arg", "sandbox-device", "sandbox-device-wipe", "sandbox-size", "sly-path", "state-dir", "sysctl-file", "trust", "unit-path"},
		"stationd logs":            {"deployment", "socket", "tail"},
		"stationd registry":        {"socket"},
		"stationd registry delete": {"digest", "repository"},
		"stationd registry gc":     nil,
		"stationd registry retain": {"project"},
		"stationd registry token":  {"scope", "ttl"},
		"stationd run":             {"backup-root", "bin-dir", "debug", "etc-dir", "handover", "link", "sigstore-fetch", "socket", "state-dir", "trust"},
		"stationd secrets":         {"socket"},
		"stationd secrets status":  nil,
		"stationd status":          {"json", "state-dir"},
		"stationd verify":          {"state-dir", "trust"},
		"stationd verify image":    {"component", "digest", "version"},
		"stationd verify refresh":  nil,
	}
	got := map[string][]string{}
	var walk func(c *cobra.Command)
	walk = func(c *cobra.Command) {
		var names []string
		c.LocalNonPersistentFlags().VisitAll(func(f *pflag.Flag) { names = append(names, f.Name) })
		c.PersistentFlags().VisitAll(func(f *pflag.Flag) { names = append(names, f.Name) })
		slices.Sort(names)
		got[c.CommandPath()] = names
		for _, sub := range c.Commands() {
			walk(sub)
		}
	}
	walk(rootCmd(environment{}))
	if !maps.EqualFunc(got, want, slices.Equal) {
		t.Fatalf("command flags\n got %q\nwant %q", got, want)
	}
}
