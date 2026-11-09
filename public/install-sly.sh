#!/bin/sh
set -eu

SLY_RELEASE='0.1.0-rc.5'
STATIONLY_RELEASES='https://ghcr.io/harshjv/stationly/release'
SLY_SHA256_LINUX_AMD64='be8077d869a2fdd8503393fb1f121f6ee195c9de0b6fbc40af0d899c35112f59'
SLY_SHA256_LINUX_ARM64='e4746ce4a5a4694d60b014aaeeebbcd803e4afe1144c1f195ec16623d48830ea'
SLY_SHA256_DARWIN_ARM64='2d2668b734c9fe62bf941f8f4967961d6cd845e8dfbb303fdad5800f7c4bc2ec'
SLY_SHA256_DARWIN_AMD64='ec852ffb44087f5932e834109e5699c98c0f0c0a8d4e960364c49fab0379c7b3'

dir=
work=

say() { printf '%s\n' "sly installer: $*" >&2; }
fail() { printf '%s\n' "sly installer: error: $*" >&2; exit 1; }

usage() {
	cat >&2 <<EOF
usage: curl -fsSL https://stationly.netlify.app/install-sly.sh | sh
       curl -fsSL https://stationly.netlify.app/install-sly.sh | sh -s -- [--dir DIR]

Installs sly ${SLY_RELEASE}, the Stationly CLI, as a single binary on macOS (arm64, x86_64) or Linux
(amd64, arm64). The binary comes from ${STATIONLY_RELEASES} and is checked against the SHA-256
written into this script. No Node.js or npm is needed.

  --dir DIR    install into DIR (default /usr/local/bin as root, otherwise ~/.local/bin)
EOF
}

placeholder() { case "$1" in @*@) return 0 ;; *) return 1 ;; esac; }

cleanup() { if [ -n "$work" ]; then rm -rf "$work"; fi; }

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

bearer_param() { printf '%s\n' "$1" | sed -n "s/.*[ ,]$2=\"\([^\"]*\)\".*/\1/p"; }

registry_get() {
	curl -sS --retry 3 --proto "=$scheme" --proto-redir "=$scheme" -L -D "$work/headers" -o "$2" -w '%{http_code}' ${token:+-H "Authorization: Bearer $token"} "$1" || echo 000
}

fetch_blob() {
	scheme=${releases%%://*}
	rest=${releases#*://}
	registry=${rest%%/*}
	repository=${rest#*/}
	url=$scheme://$registry/v2/$repository/blobs/sha256:$1
	token=
	code=$(registry_get "$url" "$2")
	if [ "$code" = 401 ]; then
		challenge=$(tr -d '\r' <"$work/headers" | awk 'tolower($1) == "www-authenticate:" && tolower($2) == "bearer" {sub(/^[^:]*:[ \t]*[Bb]earer[ \t]+/, ""); print " " $0; exit}')
		realm=$(bearer_param "$challenge" realm)
		service=$(bearer_param "$challenge" service)
		scope=$(bearer_param "$challenge" scope)
		[ -n "$realm" ] || fail "$registry answered 401 for $url without a Bearer challenge"
		say "requesting an anonymous pull token from $realm"
		token=$(curl -fsS --retry 3 --proto "=$scheme" -G --data-urlencode "service=$service" --data-urlencode "scope=${scope:-repository:$repository:pull}" "$realm" | sed -n 's/.*"token"[ ]*:[ ]*"\([^"]*\)".*/\1/p') || fail "the token request to $realm failed"
		[ -n "$token" ] || fail "$realm returned no anonymous pull token for $repository"
		code=$(registry_get "$url" "$2")
	fi
	[ "$code" = 200 ] || fail "GET $url answered HTTP $code"
}

parse_args() {
	while [ $# -gt 0 ]; do
		case "$1" in
		--dir) dir=${2:?--dir needs a directory}; shift 2 ;;
		-h | --help) usage; exit 0 ;;
		*) usage; fail "unknown option $1" ;;
		esac
	done
}

platform() {
	case "$(uname -s)" in
	Linux) os=linux ;;
	Darwin) os=darwin ;;
	*) fail "$(uname -s) is not supported; sly runs on macOS and Linux" ;;
	esac
	case "$(uname -m)" in
	x86_64 | amd64) arch=amd64 ;;
	arm64 | aarch64) arch=arm64 ;;
	*) fail "architecture $(uname -m) is not supported; sly runs on amd64 and arm64" ;;
	esac
	case "$os-$arch" in
	linux-amd64) want=$SLY_SHA256_LINUX_AMD64 ;;
	linux-arm64) want=$SLY_SHA256_LINUX_ARM64 ;;
	darwin-arm64) want=$SLY_SHA256_DARWIN_ARM64 ;;
	darwin-amd64) want=$SLY_SHA256_DARWIN_AMD64 ;;
	esac
	placeholder "$SLY_RELEASE" && fail "this install-sly.sh is the unrendered template from the repository; use the one a release publishes"
	[ -n "$want" ] || fail "release $SLY_RELEASE publishes no sly for $os/$arch"
	releases=$STATIONLY_RELEASES
	if [ "$os" = linux ] && command -v ldconfig >/dev/null 2>&1 && ! ldconfig -p 2>/dev/null | grep -q 'libatomic\.so\.1'; then
		say "warning: libatomic.so.1 is missing and sly needs it (apt-get install libatomic1, dnf install libatomic)"
	fi
}

target_dir() {
	if [ -z "$dir" ]; then
		if [ "$(id -u)" = 0 ]; then dir=/usr/local/bin; else dir=$HOME/.local/bin; fi
	fi
	mkdir -p "$dir" || fail "cannot create $dir"
	[ -w "$dir" ] || fail "$dir is not writable; pass --dir or run as root"
}

main() {
	parse_args "$@"
	trap cleanup EXIT INT TERM
	platform
	target_dir
	work=$(mktemp -d)
	say "downloading sly $SLY_RELEASE for $os/$arch from ${releases#*://}:v$SLY_RELEASE (blob sha256:$want)"
	fetch_blob "$want" "$work/sly"
	got=$(sha256_of "$work/sly")
	[ "$got" = "$want" ] || fail "sly has SHA-256 $got, but this installer expects $want; refusing to install"
	chmod 0755 "$work/sly"
	mv "$work/sly" "$dir/sly"
	say "installed $dir/sly ($("$dir/sly" version 2>/dev/null || echo "sly $SLY_RELEASE"))"
	case ":$PATH:" in
	*":$dir:"*) ;;
	*) say "$dir is not on PATH; add it, for example: export PATH=\"$dir:\$PATH\"" ;;
	esac
}

main "$@"
