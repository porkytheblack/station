# Linux execution primitive validation

This harness builds and runs fresh Linux versions of `station-sandbox` and `station-browser-use`. It uses Node 22 on Debian Bookworm, Bun 1.3.14, distro Chromium, Bash and Git. npm installs the repository's current exact tsx, TypeScript, Node types and Playwright versions into a new Linux dependency directory. It never copies macOS `node_modules`, native binaries or prebuilt package output.

Run from a checkout with a ready Linux Podman/Docker engine:

```sh
CONTAINER_ENGINE=podman scripts/execution-linux/run.sh
# or CONTAINER_ENGINE=docker scripts/execution-linux/run.sh
```

The runner creates a small temporary build context containing only the two packages' source/tests/manifests, their shared TypeScript configuration and this harness. It removes the context afterward. It does not create a VM or change engine settings. The default image tag is `station-execution-linux:local`, overridable with `STATION_LINUX_IMAGE`.

Build-time network access downloads the base image, Debian Chromium/dependencies, Bun and the npm test dependencies. The resulting container runs as the nonroot `node` user without privileged mode or a host runtime socket. Runtime networking is disabled except for loopback. Memory is capped at 3 GiB, CPU at two cores, and shared memory at 256 MiB; the engine needs sufficient resources for two Chromium sessions.

The harness runs:

1. Both packages' unit suites on Node, including real Bash commands, offline `npm pack`/global and local installs, fresh-command execution and workspace persistence across adapter restart.
2. The same unit suites with Bun's Node compatibility layer.
3. A Linux-only smoke suite against the newly compiled JavaScript exports: both Bun WebView and Playwright navigate a loopback page, type/click/press keys, evaluate, capture PNG bytes, keep cookies separate, cancel pending evaluation and close sessions independently.

The smoke suite mirrors the existing browser integration scenarios while supplying the distro Chromium executable explicitly. It avoids downloading a second Playwright-managed browser. Version lines and TAP output identify the tested runtime/browser versions. Any failed test exits nonzero; there is no skip for unavailable Bun WebView.

`chromium-test.sh` disables Chromium's own browser sandbox for these trusted local fixture tests, because unprivileged test containers may lack the required user namespaces. This is a harness configuration, not a production browser-isolation recommendation. The test must not be presented as proof of tenant isolation, production hardening, Railway deployment or the complete Headquarters dashboard topology. That topology has its own dashboard integration harness.

The container and test workspaces are removed on exit; the built image remains in the local engine cache. To remove it afterward, run `podman image rm station-execution-linux:local` (or the Docker equivalent).

Validated September 14, 2026 on Debian ARM64: Node 22.23.2, Bun 1.3.14 and Chromium 152.0.7977.82. At that checkpoint all 23 Node tests, 23 Bun tests and both real browser smoke tests passed without skips. The subsequent recording suite is included for future Linux runs; its first validation was on macOS Node and Bun.
