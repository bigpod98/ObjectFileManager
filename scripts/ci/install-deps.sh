#!/usr/bin/env bash
set -euo pipefail
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates git curl xvfb xauth fonts-dejavu-core \
  libgtk-3-0 libnss3 libasound2 libgbm1 libsecret-1-0
if [[ ${1:-} == packages ]]; then
  apt-get install -y --no-install-recommends docker.io
  docker info >/dev/null
fi
