# Enforced Linux browser deployment

This profile supplies a concrete network boundary and hard persistent-storage quota for a tenant-dedicated Browser Use worker. It requires an operator-managed **local, rootful Linux Docker host**, iptables, br_netfilter, and XFS mounted with `prjquota`. It does not run inside an ordinary managed application container, on rootless Docker/Podman, or against a remote engine. The general container adapter still supports Docker/Podman with `network: 'none'` and named volumes.

Each tenant gets a separate internal bridge and proxy, plus an XFS project covering profiles, controller metadata, recordings, durable browser state and Station metadata. Browser sessions cannot connect directly to the host, other containers, metadata services or the internet. They can connect only to their proxy on TCP8080. The proxy accepts HTTPS CONNECT to port443, checks all returned IPv4 addresses, rejects private/reserved addresses and connects to the exact validated IP. Workload DNS is disabled so it cannot become an alternate egress path. IPv6, HTTP, UDP/QUIC and non443 ports are unavailable in this profile.

`allowedHosts` matches CONNECT authorities; it is not TLS inspection or application-level authorization. A permitted shared/CDN IP may serve other virtual hosts inside an encrypted tunnel. Use dedicated upstreams or an application-aware gateway when that distinction matters. An explicit `"*"` permits public IPv4 destinations, while still denying private and reserved ranges.

## Prepare and provision

Install Docker, Python3, iptables/ip6tables, iproute2, util-linux and xfsprogs. The host must enable Yama with `kernel.yama.ptrace_scope` at least1; preflight rejects missing or permissive Yama. This prevents guarded descendants from injecting into Docker's unguarded init ancestor. Provision and mount a dedicated XFS filesystem with project quotas using your normal storage workflow. These scripts never format disks. Reserve disk capacity outside tenant budgets for the host and image cache. Enable and persist bridge filtering:

```sh
modprobe br_netfilter
sysctl -w net.bridge.bridge-nf-call-iptables=1 net.bridge.bridge-nf-call-ip6tables=1
sysctl -w kernel.yama.ptrace_scope=1
```

Build and pin the two images from the repository root:

```sh
pnpm --filter station-browser-use build
docker build --target runtime -t station-browser:release -f scripts/execution-container/Containerfile .
docker build -t station-egress:release -f scripts/execution-container/enforced/Containerfile .
```

The browser runtime target includes `/usr/local/bin/station-quota-guard`. Directory-backed profiles require this immutable image helper; an arbitrary image without it fails to start. The guard stacks a seccomp filter beneath the browser and its descendants to deny project-ID/inheritance mutation through `FS_IOC_FSSETXATTR`, `FS_IOC_SETFLAGS` and `file_setattr`. The engine's normal seccomp profile remains active. The image root is read-only, and neither the helper nor the worker command is caller configurable through the tenant API. The guard supports Linux aarch64 and x86_64; keep it current with kernel filesystem APIs.

Copy `example.json` into operator-owned configuration. Choose a unique tenant/network, an unused non-overlapping172.16/12 /24, an unused XFS project ID and a new directory beneath the mounted XFS filesystem. Set `proxyImage` to your immutable image ID/digest, configure `allowedHosts`, and choose quota/UID/GID values. Do not put configuration under a workload's profile directory.

```sh
sudo python3 scripts/execution-container/enforced/provision.py preflight /etc/station/customer-a.json
sudo python3 scripts/execution-container/enforced/provision.py apply /etc/station/customer-a.json
sudo python3 scripts/execution-container/enforced/provision.py verify /etc/station/customer-a.json
```

`apply` installs deny rules before attaching any workloads. It refuses existing directories or project IDs. A failed partial deployment leaves its deny rules and resources in place for inspection; it never deletes existing tenant data. `verify` checks quota accounting/enforcement, hard limits, inheritance, proxy image/policy/address, internal-network properties and effective firewall order, including the FORWARD dispatch into DOCKER-USER. It rejects a stale broad allowlist or an earlier permissive rule. Other generated tenant profiles may coexist on the host.

Persist and restore the firewall rules with the host's firewall service **before** starting workers. Use `verify` as a privileged `ExecStartPre`/deployment gate for the worker; never start it if verification fails. Docker/firewall reconfiguration must drain and stop workers first, reapply policy and reverify. The library's `networkRestricted: true` is still an operator assertion, not continuous firewall attestation. Do not expose Docker control to customers.

## Connect the private worker

Run the trusted controller with the same numeric UID/GID as the workload, with access to the local Docker socket. That access is host-administrative; only the trusted controller receives it. Workload containers never mount the socket or controller roots. Example paths below assume the default example configuration:

```ts
import { BrowserSessionManager } from 'station-browser-use';
import { ContainerBrowserAdapter } from 'station-browser-use/container';

const tenantId = 'customer-a';
const root = '/srv/station-xfs/customer-a';
const browser = new BrowserSessionManager(new ContainerBrowserAdapter({
  tenantId,
  rootDir: `${root}/browser`,
  profileStorageRoot: `${root}/profiles`,
  engine: 'docker',
  image: 'your-registry/station-browser@sha256:VERIFIED_DIGEST',
  network: 'station-customer-a',
  networkRestricted: true,
  proxy: { server: 'http://172.30.200.2:8080' },
  user: '1000:1000',
  memoryMb: 1024, cpus: 1, pidsLimit: 256, tmpfsMb: 256,
}), 3, {
  tenantId,
  recordingRootDir: `${root}/recordings`,
  stateRootDir: `${root}/state`,
});
// Use execution: { token: serviceSecret, tenantId, browser } and this tenant's
// stationDir: `${root}/station`. Headquarters remains the only public service.
```

Use the exact paths and proxy address printed by `apply`. Each persistent profile gets a generated subdirectory inside `profileStorageRoot`. All those directories inherit the same tenant hard block/inode quota. Transient browser data/artifacts live in bounded tmpfs and count against container memory; retention limits remain additional application limits. Filling the shared quota may prevent new recordings, checkpoints or metadata writes: handle capacity errors and preserve operational headroom. This profile does not add hard quotas to Sandbox named volumes; provision separate storage enforcement for those.

One tenant remains pinned to its dedicated worker and storage. Local exclusive locks and durable state do not provide distributed fencing, live browser migration or automatic HA. Back up the tenant roots, stop the old worker before restoring, and preserve tenant bindings. The control plane, engine, proxy and host kernel remain trusted infrastructure.

## Reproduce boundary tests

Use a disposable tenant on a Linux test host, with `example.com` allowed, a small disk quota and more than twice that quota free on the backing filesystem. The harness temporarily inserts an early permissive FORWARD rule to verify that readiness rejects it, restoring it in `finally`; never run it against active customer workers.

```sh
pnpm test:execution:policy
docker build --target quota-guard-build -t station-quota-test -f scripts/execution-container/Containerfile .
sudo python3 scripts/execution-container/enforced/verify-live.py /etc/station/test-tenant.json station-quota-test
```

The test checks successful HTTPS through the proxy, direct/peer/metadata/IPv6/DNS denial, rejected proxy destinations, policy drift, effective firewall order, forbidden project changes on an owned directory across child exec, and actual disk exhaustion while the host still has free space. XFS may report project exhaustion as `ENOSPC`; the test verifies allocated bytes stay below the configured tenant limit and rules out a full backing filesystem. It does not certify every host, kernel, cloud network, or hostile browser exploit.
