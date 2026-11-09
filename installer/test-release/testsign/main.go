package main

import (
	"encoding/json"
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	commands := map[string]func([]string) error{
		"init":           cmdInit,
		"tuf":            cmdTUF,
		"sign-blob":      cmdSignBlob,
		"sign-image":     cmdSignImage,
		"verify-image":   cmdVerifyImage,
		"verify-blob":    cmdVerifyBlob,
		"serve":          cmdServe,
		"registry-proxy": cmdRegistryProxy,
	}
	run, ok := commands[os.Args[1]]
	if !ok {
		usage()
		os.Exit(2)
	}
	if err := run(os.Args[2:]); err != nil {
		var exit *exitError
		if asExit(err, &exit) {
			os.Exit(exit.code)
		}
		fmt.Fprintln(os.Stderr, "testsign:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `usage: testsign <command> [flags]   (TEST ONLY: a throwaway Sigstore CA, log and TUF repository; never a release identity)
  init         --dir D [--force]
  tuf          --dir D [--expires-days 7]
  sign-blob    --dir D --identity release|wrong [--tag vX.Y.Z-test.N] --in FILE --out BUNDLE
  sign-image   --dir D --identity release|wrong [--tag vX.Y.Z-test.N] --digest sha256:X --repo HOST/REPO [--insecure] [--attach-to sha256:Y] [--subject-ref REF] [--out BUNDLE]
  verify-image --dir D --repo HOST/REPO --digest sha256:X [--insecure] [--identity release]
  verify-blob  --dir D --in FILE --bundle BUNDLE [--identity release]
  serve        --dir D --addr HOST:PORT
  registry-proxy --upstream http://HOST:PORT --public HOST:PORT --blob-public HOST:PORT [--addr :5051] [--blob-addr :5052]`)
}

type exitError struct{ code int }

func (e *exitError) Error() string { return fmt.Sprintf("exit %d", e.code) }

func asExit(err error, target **exitError) bool {
	e, ok := err.(*exitError)
	if ok {
		*target = e
	}
	return ok
}

func printJSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	return enc.Encode(v)
}
