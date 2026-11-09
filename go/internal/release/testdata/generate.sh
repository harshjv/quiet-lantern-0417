#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

(cd "$root/installer/test-release/testsign" && GOWORK=off go build -trimpath -o "$work/testsign" .)
"$work/testsign" init --dir "$work/signer" >/dev/null
cp "$work/signer/trusted_root.json" "$here/trusted_root.json"

printf 'stationd fixture binary\n' >"$here/stationd-linux-amd64"
stationd=sha256:$(shasum -a 256 "$here/stationd-linux-amd64" | cut -d' ' -f1)
jq -n --arg d "$stationd" '{schema: 1, release: "0.1.0-test.1", channel: "edge", published_at: "2026-11-08T00:00:00Z", changelog: "",
	components: {stationd: {kind: "binary", version: "0.1.0-test.1", source: "registry.test/stationly/release", digest: null, platforms: {"linux/amd64": $d}}}}' >"$here/release-manifest.json"

for f in release-manifest.json stationd-linux-amd64; do
	"$work/testsign" sign-blob --dir "$work/signer" --identity release --tag v0.1.0-test.1 --in "$here/$f" --out "$here/$f.sigstore.json" >/dev/null
done
"$work/testsign" sign-blob --dir "$work/signer" --identity wrong --in "$here/release-manifest.json" --out "$here/release-manifest.json.wrong.sigstore.json" >/dev/null
