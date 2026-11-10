#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
release_config=$root/release.config.json
client_image=docker.io/library/ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852
net=stationly-installer-test
reg=stationly-installer-test-registry
proxy=stationly-installer-test-proxy
version=0.1.0-test.1

usage() {
	cat >&2 <<EOF
usage: $0 --work DIR [--sly DIR]

Runs install.sh's stationd download and install-sly.sh against a local registry that behaves like
GHCR (anonymous bearer token, blob redirect to a separate host that refuses an Authorization header):
in an Ubuntu 24.04 container for linux/amd64, and on this host when it is macOS. With --sly DIR the
sly binaries in DIR (sly-linux-amd64, sly-darwin-arm64, ... from release.sh sly) are installed and
run; otherwise small stand-ins are.
EOF
	exit 2
}

work=
sly_dir=
while [ $# -gt 0 ]; do
	case "$1" in
	--work) work=$2; shift 2 ;;
	--sly) sly_dir=$2; shift 2 ;;
	*) usage ;;
	esac
done
[ -n "$work" ] || usage
for t in docker oras go jq; do command -v "$t" >/dev/null || { echo "$t is required" >&2; exit 2; }; done
mkdir -p "$work"
work=$(cd "$work" && pwd)
files=$work/files
rm -rf "$files" "${work:?}/bin" && mkdir -p "$files" "$work/bin"

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
pass=0
failed=0
ok() { pass=$((pass + 1)); printf 'ok    %s\n' "$1"; }
bad() { failed=$((failed + 1)); printf 'FAIL  %s\n%s\n' "$1" "${2:-}" | sed 's/^/      /;1s/^      //'; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "got: $2 | want: $3"; fi; }

cleanup() { docker rm -f "$reg" "$proxy" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

(cd "$root/installer/test-release/testsign" && GOWORK=off CGO_ENABLED=0 GOOS=linux GOARCH="$(docker version -f '{{.Server.Arch}}')" go build -trimpath -o "$work/testsign-linux" .)
registry_image=$(jq -r '.components.depot.source + "@" + .components.depot.digest' "$release_config")
docker network create "$net" >/dev/null
docker run -d --name "$reg" --network "$net" -p 127.0.0.1::5000 "$registry_image" >/dev/null
reg_port=$(docker port "$reg" 5000/tcp | head -n1 | sed 's/.*://')
docker run -d --name "$proxy" --network "$net" -p 127.0.0.1:15051:5051 -p 127.0.0.1:15052:5052 -v "$work/testsign-linux:/testsign:ro" \
	"$client_image" /testsign registry-proxy --upstream "http://$reg:5000" --public "$proxy:5051" --blob-public "$proxy:5052" >/dev/null
for _ in $(seq 50); do curl -fs -o /dev/null "http://127.0.0.1:$reg_port/v2/" && break; sleep 0.2; done

printf 'stationd stand-in for %s\n' "$version" >"$files/stationd-linux-amd64"
for t in linux-amd64 linux-arm64 darwin-arm64 darwin-amd64; do
	if [ -n "$sly_dir" ] && [ -f "$sly_dir/sly-$t" ]; then
		cp "$sly_dir/sly-$t" "$files/sly-$t"
	else
		printf '#!/bin/sh\necho "sly %s (%s stand-in)"\n' "$version" "$t" >"$files/sly-$t"
	fi
done
(cd "$files" && oras push --plain-http --artifact-type "$(jq -r .media_types.release_artifact "$release_config")" "127.0.0.1:$reg_port/stationly/release:v$version" ./* >/dev/null)
ok "pushed the release artifact to the local registry"

render_sly() {
	"$here/render.sh" "$root/installer/install-sly.sh" "RELEASE=$version" "RELEASES=$1" \
		"SLY_SHA256_LINUX_AMD64=$2" "SLY_SHA256_LINUX_ARM64=$(sha256 "$files/sly-linux-arm64")" \
		"SLY_SHA256_DARWIN_ARM64=$(sha256 "$files/sly-darwin-arm64")" "SLY_SHA256_DARWIN_AMD64=$(sha256 "$files/sly-darwin-amd64")"
}
in_proxy_net="http://$proxy:5051/stationly/release"
render_sly "$in_proxy_net" "$(sha256 "$files/sly-linux-amd64")" >"$work/install-sly.sh"
render_sly "$in_proxy_net" "$(printf '%064d' 0)" >"$work/install-sly-wrong.sh"
"$here/render.sh" "$root/installer/install.sh" | sed '$d' >"$work/install-lib.sh"

cat >"$work/linux.sh" <<EOF
set -eu
if [ -n "${sly_dir}" ]; then apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends curl ca-certificates libatomic1 >/dev/null 2>&1; else apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends curl ca-certificates >/dev/null 2>&1; fi
echo "== install-sly.sh"
sh /work/install-sly.sh --dir /tmp/bin && echo "installed: \$(/tmp/bin/sly version)"
echo "== install-sly.sh with a digest the release does not hold"
sh /work/install-sly-wrong.sh --dir /tmp/wrong >/dev/null 2>&1 && echo "wrong: installed" || echo "wrong: refused"
[ -e /tmp/wrong/sly ] && echo "wrong: file present" || echo "wrong: no file"
echo "== install.sh stationd download"
. /work/install-lib.sh
work=\$(mktemp -d)
releases=$in_proxy_net
release_ref=\${releases#*://}:v$version
stationd_sha256=$(sha256 "$files/stationd-linux-amd64")
arch=amd64
mode=production
fetch_stationd 2>/tmp/fetch.err && echo "stationd: verified \$(sha256sum "\$work/stationd" | cut -d' ' -f1)"
grep -c 'anonymous pull token' /tmp/fetch.err | sed 's/^/token requests: /'
stationd_sha256=$(printf '%064d' 0)
( fetch_stationd ) >/dev/null 2>&1 && echo "missing blob: fetched" || echo "missing blob: refused"
EOF
out=$(docker run --rm --platform linux/amd64 --network "$net" -v "$work:/work:ro" "$client_image" sh /work/linux.sh 2>&1) || true
printf '%s\n' "$out" >"$work/linux.out"
if [ -n "$sly_dir" ]; then want_sly="sly $version"; else want_sly="sly $version (linux-amd64 stand-in)"; fi
check "linux/amd64: install-sly.sh installs sly and it runs" "$(grep '^installed: ' "$work/linux.out" | sed 's/^installed: //' || true)" "$want_sly"
check "linux/amd64: install-sly.sh refuses a digest the release does not hold and leaves no file" "$(grep '^wrong: ' "$work/linux.out" | tr '\n' ' ')" "wrong: refused wrong: no file "
check "linux/amd64: install.sh downloads stationd by digest through the token flow and the blob redirect" "$(grep '^stationd: ' "$work/linux.out" || true)" "stationd: verified $(sha256 "$files/stationd-linux-amd64")"
check "linux/amd64: install.sh asked for one anonymous pull token" "$(grep '^token requests: ' "$work/linux.out" || true)" "token requests: 1"
check "linux/amd64: install.sh refuses a digest the release does not hold" "$(grep '^missing blob: ' "$work/linux.out" || true)" "missing blob: refused"
docker logs "$proxy" >"$work/proxy.log" 2>&1
if grep -q 'blob request carried an Authorization header' "$work/proxy.log"; then bad "no client sent the bearer token to the blob host" "$(cat "$work/proxy.log")"; else ok "no client sent the bearer token to the blob host"; fi

if [ "$(uname -s)" = Darwin ]; then
	host_arch=$(uname -m)
	[ "$host_arch" = x86_64 ] && host_arch=amd64
	render_sly "http://127.0.0.1:15051/stationly/release" "$(sha256 "$files/sly-linux-amd64")" >"$work/install-sly-mac.sh"
	docker rm -f "$proxy" >/dev/null
	docker run -d --name "$proxy" --network "$net" -p 127.0.0.1:15051:5051 -p 127.0.0.1:15052:5052 -v "$work/testsign-linux:/testsign:ro" \
		"$client_image" /testsign registry-proxy --upstream "http://$reg:5000" --public "127.0.0.1:15051" --blob-public "127.0.0.1:15052" >/dev/null
	for _ in $(seq 50); do curl -s -o /dev/null "http://127.0.0.1:15051/v2/" && break; sleep 0.2; done
	if sh "$work/install-sly-mac.sh" --dir "$work/bin" >"$work/mac.out" 2>&1; then
		if [ -n "$sly_dir" ]; then want_sly="sly $version"; else want_sly="sly $version (darwin-$host_arch stand-in)"; fi
		check "darwin/$host_arch: install-sly.sh installs sly and it runs" "$("$work/bin/sly" version 2>&1)" "$want_sly"
		if [ -n "$sly_dir" ]; then
			if codesign -v "$work/bin/sly" 2>/dev/null; then ok "darwin/$host_arch: the installed sly carries a valid ad hoc signature"; else bad "darwin/$host_arch: the installed sly carries a valid ad hoc signature" "$(codesign -dv "$work/bin/sly" 2>&1)"; fi
		fi
	else
		bad "darwin/$host_arch: install-sly.sh installs sly and it runs" "$(cat "$work/mac.out")"
	fi
fi

printf '%d passed, %d failed (logs in %s)\n' "$pass" "$failed" "$work"
[ "$failed" = 0 ]
