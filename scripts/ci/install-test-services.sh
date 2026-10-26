#!/usr/bin/env bash
# Requires Go and npm. Installs test tools outside the application dependency tree.
set -euo pipefail
manifest_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/test-services" && pwd)
service_dir=${OBJECTFILEMANAGER_TEST_SERVICE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/objectfilemanager-test-services}
mkdir -p "$service_dir/bin" "$service_dir/azurite"
# RELEASE.2025-09-07T16-13-09Z, pinned to its immutable source revision.
GOTOOLCHAIN=go1.25.5 GOBIN="$service_dir/bin" go install github.com/minio/minio@07c3a429bfed433e49018cb0f78a52145d4bedeb
# Copy both inputs on every run so stale cache manifests cannot change resolution.
# npm ci verifies the committed integrity hashes and replaces an old node_modules.
cp "$manifest_dir/package.json" "$manifest_dir/package-lock.json" "$service_dir/azurite/"
npm ci --prefix "$service_dir/azurite" --ignore-scripts --no-audit --no-fund
