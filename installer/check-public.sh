#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
status=0

normalize() { sed -E "s/^([A-Z0-9_]+)='[^']*'$/\1=''/" "$1"; }

release=$(sed -nE "s/^STATIONLY_RELEASE='([^']*)'$/\1/p" "$root/public/install.sh")
tag="v$release"
if [ -z "$release" ]; then
	echo "public/install.sh names no release; public/ must hold the installers a release rendered" >&2
	exit 1
fi
if ! git -C "$root" rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
	echo "public/install.sh names release $release, which has no tag $tag in this repository yet; skipping the template comparison until a release here renders public/"
	exit 0
fi

tree=$(mktemp -d)
trap 'rm -rf "$tree"' EXIT
git -C "$root" archive "$tag" installer release.config.json | tar -x -C "$tree"

for script in install.sh install-sly.sh; do
	if ! diff -u <("$tree/installer/release/render.sh" "$tree/installer/$script" | normalize /dev/stdin) <(normalize "$root/public/$script") >&2; then
		echo "public/$script differs from installer/$script rendered at $tag beyond the values a release writes into it; copy the installers the $tag release workflow rendered, never edit them by hand" >&2
		status=1
	fi
done

exit "$status"
