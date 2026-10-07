#!/usr/bin/env bash
set -euo pipefail
: "${S3_TEST_ENDPOINT:?Run this gate via scripts/ci/with-test-services.sh}"
: "${AZURITE_TEST_ENDPOINT:?Run this gate via scripts/ci/with-test-services.sh}"
npm ci
node scripts/ci/wait-storage.cjs
# Works with npm versions/configurations that block dependency install scripts.
node node_modules/electron/install.js
npx playwright install --with-deps chromium
npm run check
AZURITE_INTEGRATION=1 npm test
npm run test:desktop:providers
# Only the disposable root-run CI container disables Chromium's sandbox.
export S3_TEST_NO_SANDBOX=1
xvfb-run -a npm run test:desktop
xvfb-run -a npm run test:desktop:expansion
