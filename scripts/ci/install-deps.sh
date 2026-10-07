#!/usr/bin/env bash
set -euo pipefail
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates git curl xvfb xauth fonts-dejavu-core \
  libgtk-3-0 libnss3 libasound2 libgbm1 libsecret-1-0
if [[ ${1:-} == packages ]]; then
  # Use a current client for the runner's Docker daemon. Bookworm's docker.io
  # client only supports API 1.41, which newer daemons reject.
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
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
