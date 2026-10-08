#!/usr/bin/env bash
# Requires Go and npm. Installs test tools outside the project and its lockfile.
set -euo pipefail
service_dir=${OBJECTFILEMANAGER_TEST_SERVICE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/objectfilemanager-test-services}
mkdir -p "$service_dir/bin"
# RELEASE.2025-09-07T16-13-09Z, pinned to its immutable source revision.
GOTOOLCHAIN=go1.25.5 GOBIN="$service_dir/bin" go install github.com/minio/minio@07c3a429bfed433e49018cb0f78a52145d4bedeb
npm install --prefix "$service_dir/azurite" --no-save --package-lock=false azurite@3.35.0
