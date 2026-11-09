#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
status=0

normalize() { sed -E "s/^([A-Z0-9_]+)='[^']*'$/\1=''/" "$1"; }

functions() { awk -v want="$2" '$0 ~ "^" want "\\(\\) \\{" {p = 1} p {print} p && (/^}$/ || /; }$/) {p = 0}' "$1"; }

release=$(sed -nE "s/^STATIONLY_RELEASE='([^']*)'$/\1/p" "$root/public/install.sh")
tag="v$release"
if [ -z "$release" ]; then
	echo "public/install.sh names no release; public/ must hold the installers a release rendered" >&2
	exit 1
fi
if ! git -C "$root" rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
	echo "public/install.sh names release $release, which has no tag $tag in this repository yet; skipping the template comparison until a release here renders public/"
	scripts=()
else
	scripts=(install.sh install-sly.sh)
fi

for script in ${scripts[@]+"${scripts[@]}"}; do
	if ! diff -u <(git -C "$root" show "$tag:installer/$script" | normalize /dev/stdin) <(normalize "$root/public/$script") >/dev/null; then
		echo "public/$script differs from installer/$script at $tag beyond the values a release writes into it; copy the installers the $tag release workflow rendered, never edit them by hand" >&2
		diff -u <(git -C "$root" show "$tag:installer/$script" | normalize /dev/stdin) <(normalize "$root/public/$script") >&2 || true
		status=1
	fi
done

for f in bearer_param registry_get fetch_blob; do
	if ! diff <(functions "$root/installer/install.sh" "$f") <(functions "$root/installer/install-sly.sh" "$f") >/dev/null || [ -z "$(functions "$root/installer/install.sh" "$f")" ]; then
		echo "$f() differs between installer/install.sh and installer/install-sly.sh; both fetch from the releases repository the same way" >&2
		status=1
	fi
done

exit "$status"
