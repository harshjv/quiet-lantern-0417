#!/usr/bin/env bash
set -uo pipefail

for attempt in 1 2 3 4 5; do
	"$@" && exit 0
	[ "$attempt" -eq 5 ] && break
	echo "attempt $attempt of $* failed; retrying in $((attempt * 15)) s" >&2
	sleep $((attempt * 15))
done
exit 1
