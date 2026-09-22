#!/bin/sh
set -eu
cd /opt/station
node --version
bun --version
npm --version
/usr/bin/chromium --version
node --import tsx --test packages/station-sandbox/test/*.test.ts packages/station-browser-use/test/*.test.ts
bun test packages/station-sandbox/test/*.test.ts packages/station-browser-use/test/*.test.ts
node --test scripts/execution-linux/browser-smoke.mjs
node --import tsx --test packages/station-browser-use/test/advanced.integration.ts
