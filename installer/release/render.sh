#!/usr/bin/env bash
set -euo pipefail

template=$1
shift
installer=$(cd "$(dirname "$0")/.." && pwd)
pairs=("INSTALLER_URL=$(jq -r .installer_url "$installer/../release.config.json")")
while IFS= read -r pair; do
	pairs+=("$pair")
done < <(sed -n "s/^\([A-Z_]*\)='\(.*\)'$/\1=\2/p" "$installer/lib/station.gen.sh")
expressions=()
for pair in "${pairs[@]}" "$@"; do
	expressions+=(-e "s|@${pair%%=*}@|${pair#*=}|")
done
awk -v dir="$(dirname "$template")" '
	/^\. "\$\(dirname "\$0"\)\/[^"]+"$/ {
		path = $0
		sub(/^\. "\$\(dirname "\$0"\)\//, "", path)
		sub(/"$/, "", path)
		file = dir "/" path
		while ((status = (getline line < file)) > 0) print line
		if (status < 0) { print "render: cannot read " file > "/dev/stderr"; exit 1 }
		close(file)
		next
	}
	{ print }
' "$template" | sed "${expressions[@]}"
