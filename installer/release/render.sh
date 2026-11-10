#!/usr/bin/env bash
set -euo pipefail

template=$1
shift
expressions=()
for pair in "INSTALLER_URL=$(jq -r .installer_url "$(dirname "$0")/../../release.config.json")" "$@"; do
	expressions+=(-e "s|@${pair%%=*}@|${pair#*=}|")
done
sed "${expressions[@]}" "$template"
