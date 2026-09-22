# Production execution environments

The confirmed target is public multi-tenant execution on operator-managed Linux workers. Add a separate customer boundary: mapped execution-only API keys, dedicated tenant workers, immutable storage ownership, bounded request admission, and isolated/network-restricted Sandbox and Browser Use backends. Do not expose the administrator dashboard to customers or label the trusted host backend isolated.

## Required implementation and acceptance

- Sandbox: persistent workspace/home/tool installs, bounded file operations, interactive PTY input/resize/reconnectable output, supervised long-lived services with explicit restart policy, exclusive root ownership, recovery and cleanup.
- Container backend: real Docker/Podman engine, one container/volume per environment, nonroot workloads, dropped capabilities, no-new-privileges, enforced CPU/memory/PID constraints, explicit network policy, no host runtime socket or arbitrary mounts exposed to workloads, ownership labels and reconciliation. Actual engine integration tests must pass.
- Browser Use: explicit capabilities; durable, bounded recording history with restart recovery and TTL; persistent Playwright profiles and exclusive profile ownership; multiple pages and richer page controls; bounded upload/download artifacts; idle expiry and audit metadata. Unsupported Bun features fail explicitly.
- Gateway/dashboard: validated advanced RPCs, owner routing, authorization and draining behavior; terminal/service/file management; page/profile/artifact/recording controls; retained existing workflows.
- Verification: real terminals and HTTP services, custom tool installation across restarts, container cleanup/isolation/resource configuration, real browser profiles/pages/files and recording recovery; full dashboard integration and release preflight.
- Documentation: API contracts, supported capabilities, operational storage/ownership rules, backup/recovery, deployment configuration, limits and validated environments; site, agent skill and generated LLM docs.

## Completion discipline

A build or passing unit tests alone do not establish production readiness. Record precisely which configurations and failure paths ran. Do not claim hostile-tenant isolation, cloud deployment, high availability or arbitrary load capacity without evidence. Keep the running user preview's sessions intact until a new environment is ready for review. No cloud deployment or npm publication is part of this implementation request.

## Tracks

1. Host Sandbox features and terminal/service/file contracts.
2. Docker/Podman implementation and real Linux validation.
3. Browser persistence and full browser controls.
4. Headquarters integration, capability-aware dashboard, E2E, documentation and release checks.
