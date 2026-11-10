#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
release_config=$root/release.config.json
images=(dispatch sandbox-toolchain)
required=(stationd dispatch gateway buildkit depot coupler_image railpack_frontend syft_scanner litestream runsc sandbox_toolchain)

usage() {
	cat >&2 <<EOF
usage: $0 build --out DIR --version VERSION [--platforms linux/amd64[,linux/arm64]] [--cache DIR]
                [--reuse-dispatch] [--reuse-toolchain] [--reuse-runsc]
       $0 sly --out DIR --version VERSION --targets linux-amd64,linux-arm64,darwin-arm64,darwin-amd64 [--cache DIR]
       $0 push-images --out DIR --repository PREFIX [--plain-http]
       $0 manifest --out DIR --releases REPOSITORY [--channel stable|edge] [--changelog URL]
       $0 render --out DIR --releases URL [--test-trust-url URL --test-trust-sha256 HEX]
       $0 files --out DIR
       $0 push-release --out DIR --releases REPOSITORY [--plain-http]

The build half of a Stationly release, shared by .github/workflows/release.yml and the TEST release
builder (installer/test-release/build.sh). Signing is the caller's: it signs every file 'files' lists
(writing FILE.sigstore.json beside it) and every image in DIR/build/images.txt before push-release.

  build         stationd and the runsc archive per linux platform and the Dispatch and sandbox toolchain
                images as OCI layouts, into DIR/files and DIR/build
  sly           the sly single executable for each target into DIR/files (darwin targets only on macOS,
                which signs them ad hoc)
  push-images   push both images to PREFIX/dispatch and PREFIX/sandbox-toolchain under tag v<version>
  manifest      write DIR/files/release-manifest.json and DIR/build/images.txt (every image digest to sign)
  render        write install.sh (and install-sly.sh when sly was built) with the digests into DIR/files
  files         list the files in DIR/files that need a signature bundle
  push-release  push DIR/files as the OCI artifact REPOSITORY:v<version> and print its digest
EOF
	exit 2
}

say() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { printf 'release: %s\n' "$*" >&2; exit 1; }
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
need() { for t in "$@"; do command -v "$t" >/dev/null || die "$t is required"; done; }

[ $# -ge 1 ] || usage
cmd=$1
shift
out=
version=
platforms=linux/amd64
sly=
cache=
reuse_dispatch=false
reuse_toolchain=false
reuse_runsc=false
repository=
plain_http=false
releases=
channel=
changelog=
test_trust_url=
test_trust_sha256=
while [ $# -gt 0 ]; do
	case "$1" in
	--out) out=$2; shift 2 ;;
	--version) version=$2; shift 2 ;;
	--platforms) platforms=$2; shift 2 ;;
	--targets) sly=$2; shift 2 ;;
	--cache) cache=$2; shift 2 ;;
	--reuse-dispatch) reuse_dispatch=true; shift ;;
	--reuse-toolchain) reuse_toolchain=true; shift ;;
	--reuse-runsc) reuse_runsc=true; shift ;;
	--repository) repository=$2; shift 2 ;;
	--plain-http) plain_http=true; shift ;;
	--releases) releases=$2; shift 2 ;;
	--channel) channel=$2; shift 2 ;;
	--changelog) changelog=$2; shift 2 ;;
	--test-trust-url) test_trust_url=$2; shift 2 ;;
	--test-trust-sha256) test_trust_sha256=$2; shift 2 ;;
	*) usage ;;
	esac
done
[ -n "$out" ] || usage
mkdir -p "$out/files" "$out/build"
out=$(cd "$out" && pwd)
files=$out/files
build=$out/build
[ -n "$version" ] || version=$(cat "$build/version" 2>/dev/null || true)
[ -n "$version" ] || die "--version is required (no $build/version from an earlier build)"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "version $version is not X.Y.Z or X.Y.Z-PRERELEASE"
tag=v$version
arches() { tr ',' '\n' <<<"$platforms" | sed 's#^linux/##'; }

layout_summary() {
	local layout=$1 index
	index=$(jq -r '.manifests[0].digest' "$layout/index.json")
	jq -n --arg index "$index" --slurpfile inner "$layout/blobs/sha256/${index#sha256:}" \
		'{index: $index, platforms: ([$inner[0].manifests[] | select(.platform.os == "linux" and (.platform.architecture == "amd64" or .platform.architecture == "arm64")) | {key: "linux/\(.platform.architecture)", value: .digest}] | from_entries)}'
}

build_image() {
	local name=$1 reuse=$2 dockerfile=$3 context=$4 tar=$cache/$1-${platforms//[\/,]/_}.oci.tar
	if [ "$reuse" != true ] || [ ! -f "$tar" ]; then
		say "building the $name image $version for $platforms (log: $build/$name.log)"
		docker buildx build --platform "$platforms" --build-arg "VERSION=$version" --provenance=mode=min --sbom=true \
			-f "$dockerfile" -o "type=oci,dest=$tar.partial" "$context" >"$build/$name.log" 2>&1 || { tail -n 40 "$build/$name.log" >&2; die "the $name image build failed"; }
		mv "$tar.partial" "$tar"
	fi
	rm -rf "$build/$name-oci" && mkdir -p "$build/$name-oci" && tar -xf "$tar" -C "$build/$name-oci"
	jq -e '.manifests | length == 1 and (.[0].mediaType | endswith("image.index.v1+json"))' "$build/$name-oci/index.json" >/dev/null || die "the $name layout does not hold one image index"
	layout_summary "$build/$name-oci" >"$build/$name.layout.json"
	for p in $(tr ',' ' ' <<<"$platforms"); do
		jq -e --arg p "$p" '.platforms[$p] != null' "$build/$name.layout.json" >/dev/null || die "the $name index has no $p image"
	done
}

cmd_build() {
	need go docker jq
	cache=${cache:-$out/cache}
	mkdir -p "$cache"
	cache=$(cd "$cache" && pwd)
	printf '%s\n' "$version" >"$build/version"
	printf '%s\n' "$platforms" >"$build/platforms"
	for arch in $(arches); do
		case "$arch" in amd64 | arm64) ;; *) die "platform linux/$arch is not linux/amd64 or linux/arm64" ;; esac
		say "building stationd $version for linux/$arch"
		(cd "$root/go" && CGO_ENABLED=0 GOOS=linux GOARCH=$arch go build -trimpath \
			-ldflags "-s -w -X github.com/harshjv/stationly/go/internal/deploy.buildVersion=$version" \
			-o "$files/stationd-linux-$arch" ./cmd/stationd)
	done
	build_image dispatch "$reuse_dispatch" "$root/apps/dispatch/Dockerfile" "$root"
	build_image sandbox-toolchain "$reuse_toolchain" "$root/images/sandbox-toolchain/Dockerfile" "$root/images/sandbox-toolchain"
	local runsc_out=$cache/runsc-release
	if [ "$reuse_runsc" != true ] || [ ! -f "$cache/runsc.json" ]; then
		say "building the runsc archives from gVisor's signed apt repository"
		"$here/runsc.sh" --out "$runsc_out" --cache "$cache/runsc" >"$cache/runsc.json"
	fi
	jq --argjson p "$(arches | jq -R . | jq -sc 'map("linux/" + .)')" '.platforms |= with_entries(select(.key as $k | $p | index($k)))' "$cache/runsc.json" >"$build/runsc.json"
	for arch in $(arches); do
		cp "$runsc_out/runsc-linux-$arch.tar.zst" "$files/runsc-linux-$arch.tar.zst"
		[ "sha256:$(sha256 "$files/runsc-linux-$arch.tar.zst")" = "$(jq -r --arg p "linux/$arch" '.platforms[$p]' "$build/runsc.json")" ] || die "runsc-linux-$arch.tar.zst does not match $cache/runsc.json"
	done
	say "built $version for $platforms in $out"
}

cmd_sly() {
	need node
	[ -n "$sly" ] || usage
	cache=${cache:-$out/cache}
	mkdir -p "$cache"
	rm -f "$files"/sly-* "$build/sly.json"
	say "building sly $version for $sly"
	(cd "$root/packages/cli" && node scripts/sea.ts --version "$version" --out "$files" --cache "$cache/sea" --targets "$sly") >"$build/sly.json"
	jq -e '.platforms | length > 0' "$build/sly.json" >/dev/null || die "the sly build wrote no platforms to $build/sly.json"
}

cmd_push_images() {
	need oras jq
	[ -n "$repository" ] || usage
	local flags=() name key
	if [ "$plain_http" = true ]; then flags=(--to-plain-http); fi
	jq -n '{}' >"$build/images.json"
	for name in "${images[@]}"; do
		key=${name//-/_}
		local index
		index=$(jq -r .index "$build/$name.layout.json")
		say "pushing $name $index to $repository/$name:$tag"
		oras cp ${flags[@]+"${flags[@]}"} --from-oci-layout "$build/$name-oci@$index" "$repository/$name:$tag" >&2
		jq --arg k "$key" --arg src "$repository/$name" --slurpfile l "$build/$name.layout.json" '.[$k] = ($l[0] + {source: $src})' "$build/images.json" >"$build/images.json.tmp"
		mv "$build/images.json.tmp" "$build/images.json"
	done
}

third_party_platforms() {
	oras manifest fetch "$1" | jq -c '[.manifests[] | select(.platform.os == "linux" and (.platform.architecture == "amd64" or .platform.architecture == "arm64")) | {key: "linux/\(.platform.architecture)", value: .digest}] | unique_by(.key) | from_entries'
}

cmd_manifest() {
	need oras jq
	[ -n "$releases" ] || usage
	[ -f "$build/images.json" ] || die "run push-images first"
	platforms=$(cat "$build/platforms")
	[ -n "$channel" ] || { case "$version" in *-*) channel=edge ;; *) channel=stable ;; esac; }
	local manifest=$files/release-manifest.json stationd='{}' arch name entry ref p
	for arch in $(arches); do
		stationd=$(jq -c --arg k "linux/$arch" --arg v "sha256:$(sha256 "$files/stationd-linux-$arch")" '.[$k] = $v' <<<"$stationd")
	done
	jq -n --arg r "$version" --arg ch "$channel" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg cl "$changelog" --arg src "$releases" \
		--argjson sd "$stationd" --slurpfile img "$build/images.json" --slurpfile runsc "$build/runsc.json" \
		'{schema: 1, release: $r, channel: $ch, published_at: $at, changelog: $cl, components: {
			stationd: {kind: "binary", version: $r, source: $src, digest: null, platforms: $sd},
			dispatch: {kind: "image", version: $r, source: $img[0].dispatch.source, digest: $img[0].dispatch.index, platforms: $img[0].dispatch.platforms},
			sandbox_toolchain: {kind: "image", version: $r, source: $img[0].sandbox_toolchain.source, digest: $img[0].sandbox_toolchain.index, platforms: $img[0].sandbox_toolchain.platforms},
			runsc: {kind: "archive", version: $runsc[0].version, source: $src, digest: null, platforms: $runsc[0].platforms}
		}}' >"$manifest"
	if [ -f "$build/sly.json" ]; then
		jq --arg src "$releases" --slurpfile s "$build/sly.json" \
			'.clients = {sly: {kind: "binary", version: $s[0].version, source: $src, platforms: ($s[0].platforms | with_entries(.key |= sub("-"; "/")))}}' "$manifest" >"$manifest.tmp"
		mv "$manifest.tmp" "$manifest"
	fi
	jq -r '.[] | .source + "@" + .index' "$build/images.json" >"$build/images.txt"
	for name in $(jq -r '.components | keys[]' "$release_config"); do
		entry=$(jq -c --arg n "$name" '.components[$n]' "$release_config")
		ref=$(jq -r '.source + "@" + .digest' <<<"$entry")
		say "resolving $name $ref"
		p=$(third_party_platforms "$ref") || die "$name: cannot read the index $ref"
		jq --arg n "$name" --argjson e "$entry" --argjson p "$p" \
			'.components[$n] = ({kind: "image", version: $e.version, source: $e.source, digest: $e.digest, platforms: $p} + (if $e.variant then {variant: $e.variant} else {} end))' \
			"$manifest" >"$manifest.tmp"
		mv "$manifest.tmp" "$manifest"
		printf '%s\n' "$ref" >>"$build/images.txt"
	done
	local missing
	missing=$(jq -r --argjson want "$(printf '%s\n' "${required[@]}" | jq -R . | jq -sc .)" --argjson p "$(arches | jq -R . | jq -sc 'map("linux/" + .)')" \
		'[$want[] as $c | $p[] as $pl | select(.components[$c] == null or .components[$c].platforms[$pl] == null) | "\($c) (\($pl))"] | join(", ")' "$manifest")
	[ -z "$missing" ] || die "the manifest does not pin $missing"
	say "wrote $manifest ($(jq '.components | length' "$manifest") components, $(wc -l <"$build/images.txt" | tr -d ' ') image digests to sign)"
}

digest_hex() { jq -r --arg k "$2" '(.platforms // {})[$k] // "" | sub("^sha256:"; "")' "$1"; }

cmd_render() {
	[ -n "$releases" ] || usage
	local manifest=$files/release-manifest.json sd
	[ -f "$manifest" ] || die "run manifest first"
	sd=$(jq '.components.stationd' "$manifest")
	"$here/render.sh" "$root/installer/install.sh" "RELEASE=$version" "RELEASES=$releases" \
		"STATIOND_SHA256_AMD64=$(digest_hex <(echo "$sd") linux/amd64)" "STATIOND_SHA256_ARM64=$(digest_hex <(echo "$sd") linux/arm64)" \
		"TEST_TRUST_URL=${test_trust_url:-@TEST_TRUST_URL@}" "TEST_TRUST_SHA256=${test_trust_sha256:-@TEST_TRUST_SHA256@}" >"$files/install.sh"
	rm -f "$files/install-sly.sh"
	if jq -e '.clients.sly' "$manifest" >/dev/null; then
		local s
		s=$(jq '.clients.sly' "$manifest")
		"$here/render.sh" "$root/installer/install-sly.sh" "RELEASE=$version" "RELEASES=$releases" \
			"SLY_SHA256_LINUX_AMD64=$(digest_hex <(echo "$s") linux/amd64)" "SLY_SHA256_LINUX_ARM64=$(digest_hex <(echo "$s") linux/arm64)" \
			"SLY_SHA256_DARWIN_ARM64=$(digest_hex <(echo "$s") darwin/arm64)" "SLY_SHA256_DARWIN_AMD64=$(digest_hex <(echo "$s") darwin/amd64)" >"$files/install-sly.sh"
	fi
	chmod 0644 "$files"/install*.sh
	say "rendered the installers for $version from $releases"
}

signed_files() {
	local f
	for f in "$files"/*; do
		f=${f##*/}
		case "$f" in *.sigstore.json | SHA256SUMS) ;; *) printf '%s\n' "$f" ;; esac
	done
}

cmd_files() { signed_files; }

media_type() {
	case "$1" in
	*.sigstore.json) jq -r .media_types.sigstore_bundle "$release_config" ;;
	*.json) echo application/json ;;
	*.sh) echo text/x-shellscript ;;
	SHA256SUMS) echo text/plain ;;
	*) echo application/octet-stream ;;
	esac
}

cmd_push_release() {
	need oras jq
	[ -n "$releases" ] || usage
	local f flags=() args=()
	for f in $(signed_files); do
		[ -s "$files/$f.sigstore.json" ] || die "$f has no signature bundle $f.sigstore.json; sign every file before push-release"
	done
	(cd "$files" && for f in $(signed_files); do printf '%s  %s\n' "$(sha256 "$f")" "$f"; done) >"$files/SHA256SUMS"
	if [ "$plain_http" = true ]; then flags=(--plain-http); fi
	for f in "$files"/*; do f=${f##*/}; args+=("$f:$(media_type "$f")"); done
	say "pushing ${#args[@]} files to $releases:$tag"
	(cd "$files" && oras push ${flags[@]+"${flags[@]}"} --artifact-type "$(jq -r .media_types.release_artifact "$release_config")" \
		--annotation "org.opencontainers.image.version=$version" --annotation "org.opencontainers.image.source=$(jq -r .signing_identity.source_repository "$release_config")" \
		--format json "$releases:$tag" "${args[@]}") >"$build/release.json"
	jq -r .digest "$build/release.json"
}

case "$cmd" in
build) cmd_build ;;
sly) cmd_sly ;;
push-images) cmd_push_images ;;
manifest) cmd_manifest ;;
render) cmd_render ;;
files) cmd_files ;;
push-release) cmd_push_release ;;
*) usage ;;
esac
