#!/usr/bin/env bash
set -euo pipefail
: "${S3_TEST_ENDPOINT:?CI requires its disposable MinIO service}"
node scripts/ci/wait-storage.cjs
npm ci
# Works with npm versions/configurations that block dependency install scripts.
node node_modules/electron/install.js
npm run check
npm test
# Only the disposable root-run CI container disables Chromium's sandbox.
export S3_TEST_NO_SANDBOX=1
xvfb-run -a npm run test:desktop
xvfb-run -a npm run test:desktop:expansion
