#!/bin/sh
# Harness-only: Chromium's own sandbox may require unavailable user namespaces.
# Tests run trusted loopback fixtures as nonroot inside the unprivileged container.
exec /usr/bin/chromium --no-sandbox --disable-dev-shm-usage "$@"
