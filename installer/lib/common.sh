work=

say() { printf '%s\n' "$INSTALLER: $*" >&2; }
fail() { printf '%s\n' "$INSTALLER: error: $*" >&2; exit 1; }

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
	scheme=${1%%://*}
	rest=${1#*://}
	registry=${rest%%/*}
	repository=${rest#*/}
	url=$scheme://$registry/v2/$repository/blobs/sha256:$2
	token=
	code=$(registry_get "$url" "$3")
	if [ "$code" = 401 ]; then
		challenge=$(tr -d '\r' <"$work/headers" | awk 'tolower($1) == "www-authenticate:" && tolower($2) == "bearer" {sub(/^[^:]*:[ \t]*[Bb]earer[ \t]+/, ""); print " " $0; exit}')
		realm=$(bearer_param "$challenge" realm)
		service=$(bearer_param "$challenge" service)
		scope=$(bearer_param "$challenge" scope)
		[ -n "$realm" ] || fail "$registry answered 401 for $url without a Bearer challenge"
		say "requesting an anonymous pull token from $realm"
		token=$(curl -fsS --retry 3 --proto "=$scheme" -G --data-urlencode "service=$service" --data-urlencode "scope=${scope:-repository:$repository:pull}" "$realm" | sed -n 's/.*"token"[ ]*:[ ]*"\([^"]*\)".*/\1/p') || fail "the token request to $realm failed"
		[ -n "$token" ] || fail "$realm returned no anonymous pull token for $repository"
		code=$(registry_get "$url" "$3")
	fi
	[ "$code" = 200 ] || fail "GET $url answered HTTP $code"
}
