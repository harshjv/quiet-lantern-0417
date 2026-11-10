#!/bin/sh
set -eu

SLY_RELEASE='@RELEASE@'
STATIONLY_RELEASES='@RELEASES@'
SLY_SHA256_LINUX_AMD64='@SLY_SHA256_LINUX_AMD64@'
SLY_SHA256_LINUX_ARM64='@SLY_SHA256_LINUX_ARM64@'
SLY_SHA256_DARWIN_ARM64='@SLY_SHA256_DARWIN_ARM64@'
SLY_SHA256_DARWIN_AMD64='@SLY_SHA256_DARWIN_AMD64@'

dir=

INSTALLER='sly installer'
. "$(dirname "$0")/lib/common.sh"

usage() {
	cat >&2 <<EOF
usage: curl -fsSL @INSTALLER_URL@/install-sly.sh | sh
       curl -fsSL @INSTALLER_URL@/install-sly.sh | sh -s -- [--dir DIR]

Installs sly ${SLY_RELEASE}, the Stationly CLI, as a single binary on macOS (arm64, x86_64) or Linux
(amd64, arm64). The binary comes from ${STATIONLY_RELEASES} and is checked against the SHA-256
written into this script. No Node.js or npm is needed.

  --dir DIR    install into DIR (default /usr/local/bin as root, otherwise ~/.local/bin)
EOF
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
	fetch_blob "$releases" "$want" "$work/sly"
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
