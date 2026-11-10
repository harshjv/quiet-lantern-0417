#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
container=stationly-test-release-registry

usage() {
	cat >&2 <<EOF
usage: $0 up --out DIR [--http-port 8080] [--registry-port 5050]
       $0 down --out DIR
       $0 status --out DIR

The TEST release host: a Distribution registry container for the images, the release artifact and the signature
bundles, and a static file server for tuf/, trust.json and the installers under DIR/www; the release itself is
an OCI artifact in the registry (stationly/release:v<version>).
EOF
	exit 2
}

[ $# -ge 1 ] || usage
cmd=$1
shift
out=
http_port=8080
registry_port=5050
while [ $# -gt 0 ]; do
	case "$1" in
	--out) out=$2; shift 2 ;;
	--http-port) http_port=$2; shift 2 ;;
	--registry-port) registry_port=$2; shift 2 ;;
	*) usage ;;
	esac
done
[ -n "$out" ] || usage
mkdir -p "$out"
out=$(cd "$out" && pwd)
pidfile=$out/serve.pid

serving() { [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; }

registry_running() { [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || true)" = true ]; }

testsign() {
	if [ ! -x "$out/bin/testsign" ]; then
		mkdir -p "$out/bin"
		(cd "$here/testsign" && GOWORK=off go build -trimpath -o "$out/bin/testsign" .)
	fi
}

up() {
	mkdir -p "$out/www" "$out/registry"
	if ! registry_running; then
		docker rm -f "$container" >/dev/null 2>&1 || true
		image="$(jq -r '.components.depot.source + "@" + .components.depot.digest' "$here/../../release.config.json")"
		docker run -d --name "$container" --restart no -p "$registry_port:5000" \
			-e REGISTRY_STORAGE_DELETE_ENABLED=true -e REGISTRY_LOG_LEVEL=warn \
			-v "$out/registry:/var/lib/registry" "$image" >/dev/null
	fi
	testsign
	if ! serving; then
		nohup "$out/bin/testsign" serve --dir "$out/www" --addr ":$http_port" >>"$out/serve.log" 2>&1 </dev/null &
		echo $! >"$pidfile"
	fi
	printf 'http_port=%s\nregistry_port=%s\n' "$http_port" "$registry_port" >"$out/host.env"
	for _ in $(seq 50); do
		if curl -fs -o /dev/null "http://127.0.0.1:$registry_port/v2/" && curl -fs -o /dev/null "http://127.0.0.1:$http_port/"; then
			echo "TEST release host up: registry 127.0.0.1:$registry_port, files http://127.0.0.1:$http_port from $out/www"
			return 0
		fi
		sleep 0.2
	done
	echo "TEST release host did not come up; see $out/serve.log and docker logs $container" >&2
	exit 1
}

down() {
	if serving; then kill "$(cat "$pidfile")"; fi
	rm -f "$pidfile"
	docker rm -f "$container" >/dev/null 2>&1 || true
	echo "TEST release host down (files and registry data kept in $out)"
}

status() {
	echo "registry: $(registry_running && echo running || echo stopped); file server: $(serving && echo "running (pid $(cat "$pidfile"))" || echo stopped)"
}

case "$cmd" in
up) up ;;
down) down ;;
status) status ;;
*) usage ;;
esac
