#!/usr/bin/env bash
# Usage: bash scripts/ci/with-test-services.sh npm test
# First run: bash scripts/ci/install-test-services.sh (requires Go and npm).
# Runs the command against fresh local services; never uses an existing endpoint.
set -euo pipefail
if [[ $# == 0 ]]; then
  echo 'Usage: bash scripts/ci/with-test-services.sh COMMAND [ARG...]' >&2
  exit 2
fi
service_dir=${S3BROWSER_TEST_SERVICE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/s3browser-test-services}
minio="$service_dir/bin/minio"
azurite="$service_dir/azurite/node_modules/.bin/azurite-blob"
if [[ ! -x "$minio" || ! -x "$azurite" ]]; then
  echo 'Install test services first: bash scripts/ci/install-test-services.sh' >&2
  exit 1
fi
root=$(mktemp -d)
minio_pid=
azurite_pid=
cleanup() {
  result=$?
  trap - EXIT
  for pid in "$minio_pid" "$azurite_pid"; do
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; fi
  done
  for pid in "$minio_pid" "$azurite_pid"; do
    if [[ -n "$pid" ]]; then wait "$pid" 2>/dev/null || true; fi
  done
  if [[ $result != 0 ]]; then
    cat "$root/minio.log" "$root/azurite.log" >&2 || true
  fi
  rm -rf "$root"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Ask the OS for distinct available ports, keeping parallel runs independent.
read -r minio_port azurite_port < <(node - <<'JS'
const net = require('node:net');
(async () => {
  const servers = await Promise.all([0, 1].map(() => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  })));
  console.log(servers.map(server => server.address().port).join(' '));
  servers.forEach(server => server.close());
})();
JS
)
export S3_TEST_ACCESS_KEY=s3browser-test
export S3_TEST_SECRET_KEY=s3browser-test-secret
export S3_TEST_ENDPOINT="http://127.0.0.1:$minio_port"
export AZURITE_INTEGRATION=1
export AZURITE_TEST_ACCOUNT_NAME=s3browsertest
export AZURITE_TEST_ACCOUNT_KEY=BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=
export AZURITE_TEST_ENDPOINT="http://127.0.0.1:$azurite_port/$AZURITE_TEST_ACCOUNT_NAME"
MINIO_ROOT_USER=s3browser-test MINIO_ROOT_PASSWORD=s3browser-test-secret \
  MINIO_BROWSER=off "$minio" server --address "127.0.0.1:$minio_port" "$root/minio" >"$root/minio.log" 2>&1 &
minio_pid=$!
AZURITE_ACCOUNTS="$AZURITE_TEST_ACCOUNT_NAME:$AZURITE_TEST_ACCOUNT_KEY" \
  "$azurite" --blobHost 127.0.0.1 --blobPort "$azurite_port" \
  --location "$root/azurite" --skipApiVersionCheck --silent >"$root/azurite.log" 2>&1 &
azurite_pid=$!
S3_TEST_SERVICE_PIDS="$minio_pid,$azurite_pid" node "$(dirname "$0")/wait-storage.cjs"
kill -0 "$minio_pid" "$azurite_pid"
"$@"
