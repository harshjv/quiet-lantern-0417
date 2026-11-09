#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)

usage() {
	cat >&2 <<EOF
usage: $0 --out DIR --addr HOST [--release VERSION] [--http-port 8080] [--registry-port 5050]
          [--expires-days 30] [--acme-ca-server URL] [--acme-ca-certificate FILE] [--reuse-dispatch]
          [--reuse-toolchain] [--reuse-runsc] [--sly TARGETS]

Builds a signed TEST release of Stationly from the current tree for linux/amd64 and linux/arm64 with
installer/release/release.sh, the same build the release workflow runs, signs it with a throwaway
Sigstore identity, and publishes it on the TEST release host at HOST: the release artifact and the
images in its registry, install.sh, trust.json and the TUF repository on its file server.
Stations install it with: curl -fsSL http://HOST:8080/install.sh | sudo sh
Never a production release: the identity, the CA and the TUF repository are generated here.

  --addr HOST          address stations use to reach this machine (an IP or DNS name, never 127.0.0.1)
  --release VERSION    release version (default 0.1.0-test.<UTC timestamp>)
  --expires-days N     expiry of the TUF targets, snapshot and timestamp (default 30)
  --acme-ca-server URL ACME directory the test install's Gateway uses (default Let's Encrypt staging)
  --acme-ca-certificate FILE
                       PEM root that signs the ACME directory's TLS certificate (a local Pebble);
                       written into the trust as acme_ca_certificates
  --reuse-dispatch     reuse DIR/build/dispatch-VERSION.oci.tar instead of rebuilding the image
  --reuse-toolchain    reuse DIR/build/sandbox-toolchain-VERSION.oci.tar instead of rebuilding the image
  --reuse-runsc        reuse the runsc archives in DIR/cache instead of checking gVisor's repository again
  --sly TARGETS        also build sly for these targets (linux-amd64,linux-arm64,darwin-arm64,darwin-amd64)
                       and serve install-sly.sh
EOF
	exit 2
}

out=
addr=
release=0.1.0-test.$(date -u +%Y%m%d%H%M%S)
http_port=8080
registry_port=5050
expires_days=30
acme_ca_server=https://acme-staging-v02.api.letsencrypt.org/directory
acme_ca_certificate=
reuse_dispatch=false
reuse_toolchain=false
reuse_runsc=false
sly=
while [ $# -gt 0 ]; do
	case "$1" in
	--out) out=$2; shift 2 ;;
	--addr) addr=$2; shift 2 ;;
	--release) release=$2; shift 2 ;;
	--http-port) http_port=$2; shift 2 ;;
	--registry-port) registry_port=$2; shift 2 ;;
	--expires-days) expires_days=$2; shift 2 ;;
	--acme-ca-server) acme_ca_server=$2; shift 2 ;;
	--acme-ca-certificate) acme_ca_certificate=$2; shift 2 ;;
	--reuse-dispatch) reuse_dispatch=true; shift ;;
	--reuse-toolchain) reuse_toolchain=true; shift ;;
	--reuse-runsc) reuse_runsc=true; shift ;;
	--sly) sly=$2; shift 2 ;;
	*) usage ;;
	esac
done
[ -n "$out" ] && [ -n "$addr" ] || usage
[ -z "$acme_ca_certificate" ] || [ -r "$acme_ca_certificate" ] || { echo "--acme-ca-certificate $acme_ca_certificate is not readable" >&2; exit 2; }
case "$addr" in 127.* | localhost | ::1) echo "--addr must be an address the station reaches, not $addr" >&2; exit 2 ;; esac
[[ "$release" =~ ^[0-9]+\.[0-9]+\.[0-9]+-test(\.[0-9A-Za-z]+)*$ ]] || { echo "--release $release must look like 0.1.0-test.N: test releases are never plain versions" >&2; exit 2; }
for tool in go docker jq curl oras; do command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }; done

mkdir -p "$out"
out=$(cd "$out" && pwd)
www=$out/www
sig=$out/signer
rel=$out/releases/v$release
registry=$addr:$registry_port
base=http://$addr:$http_port
tag=v$release
releases=$registry/stationly/release
rs=$root/installer/release/release.sh
mkdir -p "$rel" "$www"

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
step() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

"$here/host.sh" up --out "$out" --http-port "$http_port" --registry-port "$registry_port" >&2
ts=$out/bin/testsign

if [ ! -f "$sig/trusted_root.json" ]; then
	step "creating the throwaway signing authority in $sig"
	mkdir -p "$out/logs"
	"$ts" init --dir "$sig" >"$out/logs/signer-init.json"
fi

reuse=()
[ "$reuse_dispatch" != true ] || reuse+=(--reuse-dispatch)
[ "$reuse_toolchain" != true ] || reuse+=(--reuse-toolchain)
[ "$reuse_runsc" != true ] || reuse+=(--reuse-runsc)
"$rs" build --out "$rel" --version "$release" --platforms linux/amd64,linux/arm64 --cache "$out/cache" ${reuse[@]+"${reuse[@]}"}
[ -z "$sly" ] || "$rs" sly --out "$rel" --version "$release" --targets "$sly" --cache "$out/cache"
"$rs" push-images --out "$rel" --repository "$registry/stationly" --plain-http
"$rs" manifest --out "$rel" --releases "$releases" --channel edge

step "refreshing the TUF repository (expires in $expires_days days)"
"$ts" tuf --dir "$sig" --expires-days "$expires_days" >"$rel/build/tuf.json"
rm -rf "$www/tuf" && cp -R "$sig/tuf" "$www/tuf"

trust=$www/trust.json
jq -n --arg name "Stationly TEST release identity at $addr (throwaway; never production)" \
	--arg sigrepo "$registry/stationly/signatures" --arg reg "$registry" --arg tuf "$base/tuf" \
	--arg releases "$releases" --arg dsrc "$registry/stationly/dispatch" --arg tsrc "$registry/stationly/sandbox-toolchain" \
	--arg acme "$acme_ca_server" \
	--rawfile acmeca "${acme_ca_certificate:-/dev/null}" \
	--slurpfile root "$www/tuf/1.root.json" \
	'{name: $name,
	  identity: {
	    san_regex: "^https://github\\.com/stationly-test/stationly/\\.github/workflows/release\\.yml@refs/tags/v[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.]+)?$",
	    issuer: "https://token.actions.githubusercontent.com",
	    extensions: {sourceRepositoryURI: "https://github.com/stationly-test/stationly", sourceRepositoryIdentifier: "100001", sourceRepositoryOwnerIdentifier: "200002", runnerEnvironment: "github-hosted"}
	  },
	  signatures_repository: $sigrepo, insecure_registries: [$reg], tuf_mirror: $tuf, releases_repository: $releases,
	  sources: {dispatch: $dsrc, sandbox_toolchain: $tsrc}, acme_ca_server: $acme, tuf_root: $root[0]}
	 + (if $acmeca == "" then {} else {acme_ca_certificates: $acmeca} end)' >"$trust"

"$rs" render --out "$rel" --releases "http://$releases" --test-trust-url "$base/trust.json" --test-trust-sha256 "$(sha256 "$trust")"

files=()
while IFS= read -r f; do files+=("$f"); done < <("$rs" files --out "$rel")
step "signing ${#files[@]} release files and $(wc -l <"$rel/build/images.txt" | tr -d ' ') image digests with the TEST identity ($tag)"
for f in "${files[@]}"; do
	"$ts" sign-blob --dir "$sig" --identity release --tag "$tag" --in "$rel/files/$f" --out "$rel/files/$f.sigstore.json" >/dev/null
done
while IFS= read -r ref; do
	digest=${ref##*@}
	subject=()
	case "$ref" in "$registry"/*) ;; *) subject=(--subject-ref "$ref") ;; esac
	"$ts" sign-image --dir "$sig" --identity release --tag "$tag" --digest "$digest" --repo "127.0.0.1:$registry_port/stationly/signatures" --insecure ${subject[@]+"${subject[@]}"} >/dev/null
done <"$rel/build/images.txt"

artifact=$("$rs" push-release --out "$rel" --releases "$releases" --plain-http)
step "pushed the release artifact $releases:$tag@$artifact"
cp "$rel/files/install.sh" "$www/install.sh"
if [ -f "$rel/files/install-sly.sh" ]; then cp "$rel/files/install-sly.sh" "$www/install-sly.sh"; else rm -f "$www/install-sly.sh"; fi
printf '%s\n' "$release" >"$www/latest"

jq -n --arg release "$release" --arg ref "$releases:$tag@$artifact" --arg install "curl -fsSL $base/install.sh | sudo sh" \
	--arg trust "$base/trust.json" --arg trust_sha "$(sha256 "$trust")" --arg registry "$registry" --arg out "$out" \
	--slurpfile m "$rel/files/release-manifest.json" \
	'{release: $release, release_ref: $ref, install: $install, trust: $trust, trust_sha256: $trust_sha, registry: $registry, out: $out,
	  components: ($m[0].components | with_entries(.value = "\(.value.version) \(.value.digest // .value.platforms["linux/arm64"])"))}'
