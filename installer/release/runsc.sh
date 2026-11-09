#!/usr/bin/env bash
set -euo pipefail

image=docker.io/library/debian:13-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
repo=https://storage.googleapis.com/gvisor/releases
key_url=https://gvisor.dev/archive.key
key_fingerprint=6F1DF85E3A71C24918E727D56FC6D554E32BD943

usage() {
	cat >&2 <<EOF
usage: $0 --out DIR --cache DIR

Builds runsc-linux-amd64.tar.zst and runsc-linux-arm64.tar.zst in DIR from gVisor's apt package, verified
against the repository's signed InRelease and the gVisor key $key_fingerprint, keeping runsc and gvisor-bin/
only, packed reproducibly. Downloads and archives are cached in the cache DIR. Prints the version and the
archive checksums as JSON.
EOF
	exit 2
}

out=
cache=
while [ $# -gt 0 ]; do
	case "$1" in
	--out) out=$2; shift 2 ;;
	--cache) cache=$2; shift 2 ;;
	*) usage ;;
	esac
done
[ -n "$out" ] && [ -n "$cache" ] || usage
command -v docker >/dev/null || { echo "docker is required" >&2; exit 2; }
mkdir -p "$out" "$cache"
out=$(cd "$out" && pwd)
cache=$(cd "$cache" && pwd)

docker run --rm -i -v "$out:/out" -v "$cache:/cache" \
	-e "REPO=$repo" -e "KEY_URL=$key_url" -e "KEY_FINGERPRINT=$key_fingerprint" \
	-e "HOST_UID=$(id -u)" -e "HOST_GID=$(id -g)" \
	"$image" bash -s <<'EOF'
set -euo pipefail
say() { printf '%s\n' "runsc: $*" >&2; }
fail() { printf '%s\n' "runsc: error: $*" >&2; exit 1; }
sha256() { sha256sum "$1" | cut -d' ' -f1; }

apt-get update -q >/tmp/apt.log 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends ca-certificates curl gpg gpgv zstd >>/tmp/apt.log 2>&1 || { cat /tmp/apt.log >&2; fail "installing the build tools failed"; }

work=$(mktemp -d)
export GNUPGHOME=$work/gnupg
mkdir -m 0700 "$GNUPGHOME"
curl -fsSL --retry 3 -o "$work/archive.key" "$KEY_URL"
fingerprints=$(gpg --batch --with-colons --import-options show-only --import "$work/archive.key" 2>/dev/null | awk -F: '$1 == "pub" {p = 1; next} p && $1 == "fpr" {print $10; p = 0}')
[ "$fingerprints" = "$KEY_FINGERPRINT" ] || fail "$KEY_URL holds the key(s) ${fingerprints:-none}, expected exactly $KEY_FINGERPRINT"
gpg --batch --dearmor <"$work/archive.key" >"$work/gvisor.gpg"

curl -fsSL --retry 3 -o "$work/InRelease" "$REPO/dists/release/InRelease"
gpgv --keyring "$work/gvisor.gpg" --output "$work/Release" "$work/InRelease" 2>"$work/gpgv.log" || { cat "$work/gpgv.log" >&2; fail "InRelease does not verify against $KEY_FINGERPRINT"; }
say "InRelease verified ($(sed -n 's/^Date: //p' "$work/Release"))"

version=
result=
for arch in amd64 arm64; do
	index=main/binary-$arch/Packages
	want=$(awk -v f="$index" '/^SHA256:/ {s = 1; next} /^[^ ]/ {s = 0} s && $3 == f {print $1}' "$work/Release")
	[ -n "$want" ] || fail "InRelease lists no SHA256 for $index"
	curl -fsSL --retry 3 -o "$work/Packages-$arch" "$REPO/dists/release/$index"
	[ "$(sha256 "$work/Packages-$arch")" = "$want" ] || fail "$index does not match its SHA256 in InRelease"
	entry=$(awk '
		/^$/ {if (p == "runsc") print v, f, s; p = v = f = s = ""; next}
		/^Package: / {p = $2} /^Version: / {v = $2} /^Filename: / {f = $2} /^SHA256: / {s = $2}
		END {if (p == "runsc") print v, f, s}' "$work/Packages-$arch" | sort -V | tail -n 1)
	read -r v filename deb_sha <<<"$entry"
	[ -n "$v" ] && [ -n "$filename" ] && [ -n "$deb_sha" ] || fail "$index has no runsc entry with Version, Filename and SHA256"
	[ -z "$version" ] || [ "$version" = "$v" ] || fail "amd64 offers runsc $version but $arch offers $v"
	version=$v
	deb=/cache/runsc_${version}_$arch.deb
	if [ ! -f "$deb" ] || [ "$(sha256 "$deb")" != "$deb_sha" ]; then
		say "downloading $filename"
		curl -fsSL --retry 3 -o "$deb.partial" "$REPO/$filename"
		mv "$deb.partial" "$deb"
	fi
	[ "$(sha256 "$deb")" = "$deb_sha" ] || fail "$filename does not match its SHA256 in the signed Packages index"
	archive=/cache/runsc-linux-$arch-$version.tar.zst
	if [ ! -f "$archive" ]; then
		say "packing runsc $version for linux/$arch"
		rm -rf "$work/deb-$arch" "$work/pack-$arch"
		dpkg-deb -x "$deb" "$work/deb-$arch"
		[ -f "$work/deb-$arch/usr/bin/runsc" ] || fail "the $arch package has no usr/bin/runsc"
		[ -f "$work/deb-$arch/usr/bin/gvisor-bin/runsc-fd-parking" ] || fail "the $arch package has no usr/bin/gvisor-bin/runsc-fd-parking"
		mkdir "$work/pack-$arch"
		cp -a "$work/deb-$arch/usr/bin/runsc" "$work/deb-$arch/usr/bin/gvisor-bin" "$work/pack-$arch/"
		(cd "$work/pack-$arch" && tar --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0 -cf - runsc gvisor-bin | zstd -19 -T0 -q -o "$archive.partial")
		mv "$archive.partial" "$archive"
	fi
	cp "$archive" "/out/runsc-linux-$arch.tar.zst"
	chown "$HOST_UID:$HOST_GID" "/out/runsc-linux-$arch.tar.zst" "$deb" "$archive"
	result="$result${result:+, }\"linux/$arch\": \"sha256:$(sha256 "/out/runsc-linux-$arch.tar.zst")\""
	say "linux/$arch: $(stat -c %s "/out/runsc-linux-$arch.tar.zst") bytes"
done
rm -rf "$work"
printf '{"version": "%s", "platforms": {%s}}\n' "$version" "$result"
EOF
