#!/bin/sh
set -eu

STATIONLY_RELEASE='0.1.0'
STATIONLY_RELEASES='https://ghcr.io/harshjv/stationly/release'
STATIOND_SHA256_AMD64='97685bb6ca7726babac7bb3a55e1a6398a0918ffc07e3b9ac061fb96e968c8bf'
STATIOND_SHA256_ARM64=''
TEST_TRUST_URL='@TEST_TRUST_URL@'
TEST_TRUST_SHA256='@TEST_TRUST_SHA256@'

DOCKER_MAJOR=29
DOCKER_KEY_SHA256=1500c1f56fa9e26b9b8f42452a553675796ade0807cdce11975eb98170b3a570
DOCKER_KEYRING=/etc/apt/keyrings/docker.asc
DOCKER_SOURCES=/etc/apt/sources.list.d/docker.sources
DOCKER_PIN=/etc/apt/preferences.d/stationly-docker
UNIT=stationly-stationd
LOG=/var/log/stationly-install.log
DISPATCH_HEALTH=http://127.0.0.1:7900/v1/healthz

test_release=
test_trust=
test_trust_sha256=
test_stationd_sha256=
litestream_bucket=
litestream_endpoint=
sandbox_device=
sandbox_device_wipe=
sandbox_size=
work=

say() { printf '%s\n' "stationly: $*" >&2; }
fail() { printf '%s\n' "stationly: error: $*" >&2; exit 1; }

usage() {
	cat >&2 <<EOF
usage: curl -fsSL https://stationly.netlify.app/install.sh | sudo sh
       curl -fsSL https://stationly.netlify.app/install.sh | sudo sh -s -- [options]

Installs Stationly release ${STATIONLY_RELEASE} on this Ubuntu 22.04, Ubuntu 24.04 or Debian 12 host
(amd64 or arm64): host prerequisites, Docker Engine ${DOCKER_MAJOR}.x, then stationd, which verifies and
installs everything else. Run sly setup afterwards.

Sandbox options (sandboxes need kernel 6.7 or later and a btrfs filesystem; stationd install skips them on an
older kernel or below 20 GiB free, with a warning):
  --sandbox-device PATH         format this block device (a Hetzner Volume, a second disk) as the sandbox
                                filesystem instead of a loop file under /var/lib/stationly
  --sandbox-device-wipe         allow formatting a --sandbox-device that holds a filesystem or partition table
  --sandbox-size SIZE           size of the sandbox loop file in bytes or GiB (40G, 40GiB); default
                                max(10 GiB, min(free / 2, free - 10 GiB))

Restore options (a replacement host; the credentials come from the environment, which sudo clears unless
you pass it: sudo env LITESTREAM_ACCESS_KEY_ID=... LITESTREAM_SECRET_ACCESS_KEY=... sh -s -- ...):
  --litestream-bucket NAME      restore Dispatch's database from this bucket before Dispatch starts, then keep
                                replicating to it; no sly setup is needed afterwards
  --litestream-endpoint URL     S3-compatible endpoint of the bucket (default AWS S3; R2 is
                                https://<account>.r2.cloudflarestorage.com)
  STATIONLY_RECOVERY_KEY      required with the restore: the recovery key (sly-rk-...) of the lost host

Test-only options (CI and development; never for production):
  --test-release URL            install the test release at URL (http://HOST:PORT/REPOSITORY:v<version>)
  --test-trust URL|FILE         the test release's trust file, in place of the Stationly release identity
  --test-trust-sha256 HEX       SHA-256 of the trust file (default: the one written into this script)
  --test-stationd-sha256 HEX    SHA-256 of stationd for this host's architecture (default: the one written
                                into this script)
EOF
}

placeholder() { case "$1" in @*@) return 0 ;; *) return 1 ;; esac; }

cleanup() { if [ -n "$work" ]; then rm -rf "$work"; fi; }

parse_args() {
	while [ $# -gt 0 ]; do
		case "$1" in
		--litestream-bucket) litestream_bucket=${2:?--litestream-bucket needs a bucket name}; shift 2 ;;
		--litestream-endpoint) litestream_endpoint=${2:?--litestream-endpoint needs a URL}; shift 2 ;;
		--sandbox-device) sandbox_device=${2:?--sandbox-device needs a block device path}; shift 2 ;;
		--sandbox-device-wipe) sandbox_device_wipe=1; shift ;;
		--sandbox-size) sandbox_size=${2:?--sandbox-size needs a size}; shift 2 ;;
		--test-release) test_release=${2:?--test-release needs a URL}; shift 2 ;;
		--test-trust) test_trust=${2:?--test-trust needs a URL or file}; shift 2 ;;
		--test-trust-sha256) test_trust_sha256=${2:?--test-trust-sha256 needs a hex digest}; shift 2 ;;
		--test-stationd-sha256) test_stationd_sha256=${2:?--test-stationd-sha256 needs a hex digest}; shift 2 ;;
		-h | --help) usage; exit 0 ;;
		*) usage; fail "unknown option $1" ;;
		esac
	done
}

size_valid() {
	n=${1%GiB}
	[ "$n" != "$1" ] || n=${1%G}
	case "$n" in '' | 0* | *[!0-9]*) return 1 ;; esac
}

check_sandbox() {
	[ -z "$sandbox_device_wipe" ] || [ -n "$sandbox_device" ] || fail "--sandbox-device-wipe needs --sandbox-device"
	[ -z "$sandbox_size" ] || size_valid "$sandbox_size" || fail "--sandbox-size $sandbox_size is not a size in bytes or GiB (40G, 40GiB)"
}

check_restore() {
	[ -z "$litestream_endpoint" ] || [ -n "$litestream_bucket" ] || fail "--litestream-endpoint needs --litestream-bucket"
	if [ -n "$litestream_bucket" ]; then
		[ -n "${LITESTREAM_ACCESS_KEY_ID:-}" ] && [ -n "${LITESTREAM_SECRET_ACCESS_KEY:-}" ] || fail "a restore needs LITESTREAM_ACCESS_KEY_ID and LITESTREAM_SECRET_ACCESS_KEY in the environment"
		export LITESTREAM_ACCESS_KEY_ID LITESTREAM_SECRET_ACCESS_KEY
	fi
	if [ -n "$litestream_bucket" ]; then
		[ -n "${STATIONLY_RECOVERY_KEY:-}" ] || fail "a restore needs the lost host's recovery key in STATIONLY_RECOVERY_KEY"
		export STATIONLY_RECOVERY_KEY
	elif [ -n "${STATIONLY_RECOVERY_KEY:-}" ]; then
		fail "STATIONLY_RECOVERY_KEY goes with --litestream-bucket"
	fi
}

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

check_sha256() {
	got=$(sha256_of "$1")
	[ "$got" = "$2" ] || fail "$3 has SHA-256 $got, but $4 expects $2; refusing to continue"
}

fetch() {
	case "$1" in
	http://* | https://*) curl -fsSL --retry 3 --proto '=https,http' -o "$2" "$1" || fail "download of $1 failed" ;;
	*) cp "$1" "$2" || fail "cannot read $1" ;;
	esac
}

os_field() { sed -n "s/^$1=//p" /etc/os-release | tr -d "\"'" | head -n 1; }

preflight() {
	[ "$(id -u)" = 0 ] || fail "run the installer as root (curl ... | sudo sh)"
	[ -r /etc/os-release ] || fail "/etc/os-release is missing; this is not a supported Linux distribution"
	os_id=$(os_field ID)
	os_version=$(os_field VERSION_ID)
	os_codename=$(os_field UBUNTU_CODENAME)
	[ -n "$os_codename" ] || os_codename=$(os_field VERSION_CODENAME)
	case "$os_id:$os_version" in
	ubuntu:22.04 | ubuntu:24.04 | debian:12) ;;
	*) fail "$os_id $os_version is not supported; Stationly installs on Ubuntu 22.04, Ubuntu 24.04 and Debian 12" ;;
	esac
	command -v dpkg >/dev/null 2>&1 || fail "dpkg is missing"
	arch=$(dpkg --print-architecture)
	case "$arch" in
	amd64 | arm64) ;;
	*) fail "architecture $arch is not supported; Stationly runs on amd64 and arm64" ;;
	esac
	[ -d /run/systemd/system ] || fail "systemd is not running as the init system; stationd is a systemd unit"
	say "host: $os_id $os_version ($os_codename), $arch, kernel $(uname -r)"
}

choose_release() {
	if [ -n "$test_release" ] || [ -n "$test_trust" ]; then
		[ -n "$test_release" ] && [ -n "$test_trust" ] || fail "--test-release and --test-trust go together"
		mode='test'
		case "$test_release" in
		http://*/*:v* | https://*/*:v*) ;;
		*) fail "--test-release $test_release is not http(s)://HOST/REPOSITORY:v<version>" ;;
		esac
		release_version=${test_release##*:v}
		releases=${test_release%:v*}
		[ -n "$test_trust_sha256" ] || placeholder "$TEST_TRUST_SHA256" || test_trust_sha256=$TEST_TRUST_SHA256
		[ -n "$test_trust_sha256" ] || fail "--test-trust-sha256 is required: this script has no test trust digest written into it"
		trust_source=$test_trust
	elif ! placeholder "$TEST_TRUST_URL"; then
		mode='test'
		release_version=$STATIONLY_RELEASE
		releases=$STATIONLY_RELEASES
		trust_source=$TEST_TRUST_URL
		test_trust_sha256=$TEST_TRUST_SHA256
	else
		mode='production'
		placeholder "$STATIONLY_RELEASE" && fail "this install.sh is the unrendered template from the repository; use the install.sh published with a release, or pass the --test-* options"
		release_version=$STATIONLY_RELEASE
		releases=$STATIONLY_RELEASES
		case "$releases" in https://*/*) ;; *) fail "the releases repository $releases written into this script is not an https URL" ;; esac
	fi
	release_ref=${releases#*://}:v$release_version
	if [ -n "$test_stationd_sha256" ]; then
		[ "$mode" = test ] || fail "--test-stationd-sha256 is a test-only option"
		stationd_sha256=$test_stationd_sha256
	elif [ "$arch" = arm64 ]; then
		stationd_sha256=$STATIOND_SHA256_ARM64
	else
		stationd_sha256=$STATIOND_SHA256_AMD64
	fi
	placeholder "$stationd_sha256" && fail "this script has no stationd SHA-256 written into it; pass --test-stationd-sha256"
	[ -n "$stationd_sha256" ] || fail "release $release_version publishes no stationd for linux/$arch"
	if [ "$mode" = test ]; then
		say "############################################################################"
		say "TEST INSTALL. This release is verified against a throwaway test signing"
		say "identity, not the Stationly release identity. The Gateway gets Let's"
		say "Encrypt staging certificates. Never use this host for production."
		say "release: $release_ref"
		say "############################################################################"
	else
		say "installing Stationly $STATIONLY_RELEASE from $release_ref"
	fi
}

apt_install() {
	DEBIAN_FRONTEND=noninteractive apt-get install -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@" >>"$LOG" 2>&1 || fail "apt-get install $* failed; see $LOG"
}

apparmor_enabled() { [ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null)" = Y ]; }

prerequisites() {
	DEBIAN_FRONTEND=noninteractive apt-get update -q >>"$LOG" 2>&1 || fail "apt-get update failed; see $LOG"
	if apparmor_enabled; then
		say "installing prerequisites (ca-certificates, curl, git, apparmor: the kernel enforces AppArmor)"
		apt_install ca-certificates curl git apparmor
		command -v apparmor_parser >/dev/null 2>&1 || fail "apparmor_parser is missing after installing the apparmor package"
	else
		say "installing prerequisites (ca-certificates, curl, git)"
		apt_install ca-certificates curl git
	fi
	if kernel_sandboxes; then
		say "installing btrfs-progs for the sandbox filesystem (kernel $(uname -r))"
		apt_install btrfs-progs
	else
		say "kernel $(uname -r) is older than 6.7: sandboxes need btrfs simple quotas, so stationd install skips the sandbox filesystem; everything else installs"
	fi
}

kernel_sandboxes() {
	release=$(uname -r)
	major=${release%%.*}
	rest=${release#*.}
	minor=${rest%%[!0-9]*}
	[ "$major" -gt 6 ] || { [ "$major" -eq 6 ] && [ "${minor:-0}" -ge 7 ]; }
}

package_installed() { [ "$(dpkg-query -W -f='${db:Status-Status}' "$1" 2>/dev/null)" = installed ]; }

package_known() { dpkg-query -W -f='${db:Status-Status}' "$1" >/dev/null 2>&1; }

clear_leftovers() {
	for p in docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker; do
		package_installed "$p" && fail "package $p is installed and conflicts with Docker Engine from Docker's repository; remove it (apt-get remove $p) and run the installer again"
	done
	for p in docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker; do
		if package_known "$p"; then
			say "purging the configuration a removed $p left behind"
			dpkg --purge "$p" >>"$LOG" 2>&1 || fail "dpkg --purge $p failed; see $LOG"
		fi
	done
	systemctl stop docker.service docker.socket containerd.service >>"$LOG" 2>&1 || true
	systemctl reset-failed docker.service docker.socket containerd.service >>"$LOG" 2>&1 || true
	rm -f /run/docker.sock
	systemctl daemon-reload >>"$LOG" 2>&1 || fail "systemctl daemon-reload failed"
}

docker_version() { docker version --format '{{.Server.Version}}' 2>/dev/null || true; }

wait_docker() {
	i=0
	until docker info >/dev/null 2>&1; do
		i=$((i + 1))
		[ "$i" -le 60 ] || fail "Docker did not answer within 60 s; see journalctl -u docker"
		sleep 1
	done
}

docker_engine() {
	if dpkg -s docker-ce >/dev/null 2>&1; then
		systemctl enable --now docker >>"$LOG" 2>&1 || fail "systemctl enable --now docker failed"
		wait_docker
		version=$(docker_version)
		case "$version" in
		"$DOCKER_MAJOR".*) say "Docker Engine $version is already installed" ;;
		*) fail "Docker Engine $version is installed; Stationly needs $DOCKER_MAJOR.x. Upgrade or remove it, then run the installer again" ;;
		esac
		return
	fi
	clear_leftovers
	say "adding Docker's apt repository for $os_id $os_codename"
	install -m 0755 -d /etc/apt/keyrings
	key=$work/docker.asc
	fetch "https://download.docker.com/linux/$os_id/gpg" "$key"
	check_sha256 "$key" "$DOCKER_KEY_SHA256" "Docker's apt signing key" "this installer"
	install -m 0644 "$key" "$DOCKER_KEYRING"
	cat >"$DOCKER_SOURCES" <<EOF
Types: deb
URIs: https://download.docker.com/linux/$os_id
Suites: $os_codename
Components: stable
Architectures: $arch
Signed-By: $DOCKER_KEYRING
EOF
	cat >"$DOCKER_PIN" <<EOF
Package: docker-ce docker-ce-cli
Pin: version 5:$DOCKER_MAJOR.*
Pin-Priority: 1001
EOF
	DEBIAN_FRONTEND=noninteractive apt-get update -q >>"$LOG" 2>&1 || fail "apt-get update failed after adding Docker's repository; see $LOG"
	version=$(apt-cache madison docker-ce | awk '{print $3}' | grep "^5:$DOCKER_MAJOR\." | head -n 1)
	[ -n "$version" ] || fail "Docker's repository offers no docker-ce $DOCKER_MAJOR.x for $os_id $os_codename $arch"
	say "installing Docker Engine $version"
	apt_install "docker-ce=$version" "docker-ce-cli=$version" containerd.io
	systemctl daemon-reload >>"$LOG" 2>&1 || fail "systemctl daemon-reload failed"
	systemctl enable --now docker.socket docker >>"$LOG" 2>&1 || fail "systemctl enable --now docker failed"
	wait_docker
	say "Docker Engine $(docker_version) is running"
}

image_store() {
	store=$(docker info --format '{{json .DriverStatus}}' 2>/dev/null || true)
	case "$store" in
	*io.containerd.snapshotter.v1*) say "Docker uses the containerd image store" ;;
	*) fail "Docker does not use the containerd image store (driver status: $store); Stationly needs Docker $DOCKER_MAJOR.x installed fresh, where it is the default" ;;
	esac
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

fetch_stationd() {
	say "downloading stationd for linux/$arch from $release_ref (blob sha256:$stationd_sha256)"
	fetch_blob "$stationd_sha256" "$work/stationd"
	check_sha256 "$work/stationd" "$stationd_sha256" "stationd" "this installer"
	chmod 0755 "$work/stationd"
	if [ "$mode" = test ]; then
		fetch "$trust_source" "$work/trust.json"
		check_sha256 "$work/trust.json" "$test_trust_sha256" "the test trust file" "--test-trust-sha256"
	fi
}

run_install() {
	say "stationd install: TUF refresh, signature checks, Docker daemon configuration, image pulls, systemd unit"
	set -- install --release "$release_version"
	if [ "$mode" = test ]; then
		set -- "$@" --trust "$work/trust.json"
	fi
	if [ -n "$litestream_bucket" ]; then
		set -- "$@" --litestream-bucket "$litestream_bucket"
		[ -z "$litestream_endpoint" ] || set -- "$@" --litestream-endpoint "$litestream_endpoint"
	fi
	[ -z "$sandbox_device" ] || set -- "$@" --sandbox-device "$sandbox_device"
	[ -z "$sandbox_device_wipe" ] || set -- "$@" --sandbox-device-wipe
	[ -z "$sandbox_size" ] || set -- "$@" --sandbox-size "$sandbox_size"
	if ! "$work/stationd" "$@" >"$work/install.json" 2>>"$LOG"; then
		cat "$work/install.json" >>"$LOG"
		reason=$(sed -n 's/.*"explanation": "\(.*\)".*/\1/p' "$work/install.json" | head -n 1)
		fail "stationd install failed: ${reason:-see $LOG}"
	fi
	cat "$work/install.json" >>"$LOG"
	install -d -m 0755 /var/lib/stationly
	install -m 0600 "$work/install.json" /var/lib/stationly/install-report.json
	image_store
}

start_stationd() {
	say "starting $UNIT"
	systemctl enable "$UNIT" >>"$LOG" 2>&1 || fail "systemctl enable $UNIT failed"
	systemctl restart "$UNIT" >>"$LOG" 2>&1 || fail "$UNIT did not start; see journalctl -u $UNIT"
	i=0
	until curl -fsS -o /dev/null "$DISPATCH_HEALTH" 2>/dev/null; do
		i=$((i + 1))
		[ "$i" -le 180 ] || fail "Dispatch did not answer $DISPATCH_HEALTH within 180 s; see journalctl -u $UNIT"
		sleep 1
	done
	say "Dispatch answers on 127.0.0.1:7900"
	wait_enrolled
}

wait_enrolled() {
	identity=/var/lib/stationly/stationd/identity/station.json
	since=$(date '+%Y-%m-%d %H:%M:%S')
	say "waiting for stationd to enroll with Dispatch"
	i=0
	until [ -s "$identity" ]; do
		refusal=$(journalctl -u "$UNIT" --since "$since" --no-pager -o cat 2>/dev/null | grep 'Dispatch refused' | tail -n 1)
		[ -z "$refusal" ] || { printf '%s\n' "$refusal" >>"$LOG"; fail "stationd could not enroll with Dispatch: $refusal"; }
		i=$((i + 1))
		[ "$i" -le 120 ] || fail "stationd did not enroll within 120 s; see journalctl -u $UNIT"
		sleep 1
	done
	say "stationd enrolled with Dispatch"
}

next_steps() {
	say "installed. Nothing listens on the public interface but SSH until sly setup puts Dispatch on its hostnames."
	if [ -n "$litestream_bucket" ]; then
		say "Dispatch was restored from bucket $litestream_bucket; sign in with the existing admin, sly setup is not needed"
	else
		say "next, on this host as root:  sly setup"
	fi
	if [ "$mode" = test ]; then
		say "reminder: TEST INSTALL ($release_ref); /etc/stationly/test-trust.json replaces the release identity"
	fi
}

main() {
	parse_args "$@"
	trap cleanup EXIT INT TERM
	check_sandbox
	check_restore
	preflight
	: >>"$LOG"
	work=$(mktemp -d)
	choose_release
	prerequisites
	docker_engine
	fetch_stationd
	run_install
	start_stationd
	next_steps
}

main "$@"
