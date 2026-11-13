FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2

ARG TARGETARCH
ARG NODE_VERSION=26.13.0
ARG BUN_VERSION=1.4.4
ARG MISE_VERSION=2026.11.6
ARG GH_VERSION=2.103.3
ARG DOCKER_VERSION=5:29.9.3-1~debian.13~trixie
ARG CONTAINERD_VERSION=2.4.2-3~debian.13~trixie
ARG BUILDX_VERSION=0.38.1-1~debian.13~trixie
ARG COMPOSE_VERSION=5.7.0-1~debian.13~trixie
ARG DOCKER_APT_GPG_SHA256=1500c1f56fa9e26b9b8f42452a553675796ade0807cdce11975eb98170b3a570

SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
	ca-certificates curl git tini libatomic1 python3 python3-venv python3-pip iptables iproute2 tmux procps unzip xz-utils dnsutils \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL --retry 5 --retry-all-errors --retry-delay 5 https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && echo "$DOCKER_APT_GPG_SHA256  /etc/apt/keyrings/docker.asc" | sha256sum -c - \
 && chmod 0644 /etc/apt/keyrings/docker.asc \
 && printf 'Types: deb\nURIs: https://download.docker.com/linux/debian\nSuites: trixie\nComponents: stable\nSigned-By: /etc/apt/keyrings/docker.asc\n' >/etc/apt/sources.list.d/docker.sources \
 && gh=gh_${GH_VERSION}_linux_$TARGETARCH.deb \
 && curl -fsSL --retry 5 --retry-all-errors --retry-delay 5 "https://github.com/cli/cli/releases/download/v$GH_VERSION/$gh" -o "/tmp/$gh" \
 && curl -fsSL --retry 5 --retry-all-errors --retry-delay 5 "https://github.com/cli/cli/releases/download/v$GH_VERSION/gh_${GH_VERSION}_checksums.txt" -o /tmp/gh_checksums.txt \
 && (cd /tmp && grep "  $gh\$" gh_checksums.txt | sha256sum -c -) \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
	"docker-ce=$DOCKER_VERSION" "docker-ce-cli=$DOCKER_VERSION" "containerd.io=$CONTAINERD_VERSION" \
	"docker-buildx-plugin=$BUILDX_VERSION" "docker-compose-plugin=$COMPOSE_VERSION" "/tmp/$gh" \
 && rm -rf /var/lib/apt/lists/* "/tmp/$gh" /tmp/gh_checksums.txt

RUN case "$TARGETARCH" in \
	amd64) node_arch=x64 bun_arch=x64 mise_arch=x64 ;; \
	arm64) node_arch=arm64 bun_arch=aarch64 mise_arch=arm64 ;; \
	*) echo "unsupported architecture $TARGETARCH" >&2; exit 1 ;; \
	esac \
 && work=$(mktemp -d) && cd "$work" \
 && node=node-v$NODE_VERSION-linux-$node_arch.tar.xz \
 && curl -fsSLO --retry 5 --retry-all-errors --retry-delay 5 "https://nodejs.org/dist/v$NODE_VERSION/$node" \
 && curl -fsSLO --retry 5 --retry-all-errors --retry-delay 5 "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" \
 && grep "  $node\$" SHASUMS256.txt | sha256sum -c - \
 && tar -xJf "$node" -C /usr/local --strip-components=1 --no-same-owner \
	--exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE' \
 && rm SHASUMS256.txt \
 && bun=bun-linux-$bun_arch.zip \
 && curl -fsSLO --retry 5 --retry-all-errors --retry-delay 5 "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/$bun" \
 && curl -fsSLO --retry 5 --retry-all-errors --retry-delay 5 "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/SHASUMS256.txt" \
 && grep "  $bun\$" SHASUMS256.txt | sha256sum -c - \
 && unzip -q "$bun" \
 && install -m 0755 "bun-linux-$bun_arch/bun" /usr/local/bin/bun \
 && ln -s bun /usr/local/bin/bunx \
 && mise=mise-v$MISE_VERSION-linux-$mise_arch \
 && curl -fsSLO --retry 5 --retry-all-errors --retry-delay 5 "https://github.com/jdx/mise/releases/download/v$MISE_VERSION/$mise" \
 && curl -fsSL --retry 5 --retry-all-errors --retry-delay 5 "https://github.com/jdx/mise/releases/download/v$MISE_VERSION/SHASUMS256.txt" -o MISE_SHASUMS256.txt \
 && grep "  ./$mise\$" MISE_SHASUMS256.txt | sha256sum -c - \
 && install -m 0755 "$mise" /usr/local/bin/mise \
 && printf '%s\n' 'export PATH="$HOME/.local/share/mise/shims:$PATH"' >/etc/profile.d/mise.sh \
 && cd / && rm -rf "$work"

RUN update-alternatives --set iptables /usr/sbin/iptables-legacy \
 && update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy \
 && useradd --create-home --groups docker --uid 1000 --home-dir /home/agent --shell /bin/bash agent \
 && install -d -o agent -g agent /workspaces

COPY --chmod=0755 sandbox-init /usr/local/bin/sandbox-init
COPY --chmod=0755 sandbox-agent-hook /usr/local/bin/sandbox-agent-hook
COPY --chmod=0644 claude-managed-settings.json /etc/claude-code/managed-settings.d/stationly.json
COPY --from=sly --chmod=0755 sly-linux-${TARGETARCH} /usr/local/bin/sly

USER root
WORKDIR /root
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/sandbox-init"]
