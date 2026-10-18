#!/usr/bin/env bash
set -euo pipefail
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates git curl xvfb xauth fonts-dejavu-core \
  libgtk-3-0 libnss3 libasound2 libgbm1 libsecret-1-0
if [[ ${1:-} == packages ]]; then
  # Use a current client for the runner's Docker daemon. Bookworm's docker.io
  # client only supports API 1.41, which newer daemons reject.
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  curl -fsSL https://download.docker.com/linux/debian/gpg -o "$work/docker.asc"
  # Pin the exact upstream key (primary fingerprint
  # 9DC858229FC7DD38854AE2D88D81803C0EBFCD88) before making apt trust it.
  # A key rotation or even a re-export requires reviewing this checksum.
  if ! echo "1500c1f56fa9e26b9b8f42452a553675796ade0807cdce11975eb98170b3a570  $work/docker.asc" | sha256sum --check --status; then
    echo 'Docker signing key checksum mismatch; refusing to install apt trust.' >&2
    exit 1
  fi
  install -m 0755 -d /etc/apt/keyrings
  install -m 0644 "$work/docker.asc" /etc/apt/keyrings/docker.asc
  source /etc/os-release
  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: ${VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt-get update
  apt-get install -y --no-install-recommends docker-ce-cli
  docker info >/dev/null
fi
