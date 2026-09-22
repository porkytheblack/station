# Tenant image registries

The tenant registry API separates artifact namespaces and permissions from the
operator registry. It does not automatically turn the fleet-wide image controller
into a tenant scheduler. Configure namespaces and key grants on the operator side;
request bodies, URL parameters and headers never select another tenant.

`TenantImageRegistryConfig`, in `src/registry/tenants.ts`, contains:

```ts
const tenants = {
  namespaces: {
    "customer-a": {
      registry: customerARegistry,
      uploads: customerAUploads, // Optional ImageUploadManager bound to this registry.
    },
    "customer-b": { registry: customerBRegistry },
  },
  apiKeys: {
    [customerAKeyRecord.id]: {
      tenantId: "customer-a",
      permissions: ["read", "publish"],
    },
  },
  limits: {
    requestsPerSecond: 30,
    burst: 60,
    maxInFlightPerTenant: 4,
    maxInFlight: 64,
  },
};
```

Keys must have **exactly the `registry` scope** and pass the normal live key
verification middleware. Ordinary `read`, `trigger`, `execution`, operator/session
credentials, unmapped keys and mixed-scope keys cannot use this API. Revoking the
key prevents later requests even when the configured mapping remains. Permissions
are independent: `publish` does not implicitly grant `read`, `activate` or `invoke`.
The mapping contains verified key record IDs, never plaintext secrets.

`tenantImageRegistryRoutes(tenants, [operatorRegistry.identity])` mounts paths
beneath `/api/v1/tenant/registry` when attached to the daemon's v1 router. Pass any
operator registry identities as exclusions. Every tenant needs distinct metadata,
blob and upload storage namespaces; unique identity labels alone cannot make two
operator adapters pointing at the same physical storage isolated. The router
rejects duplicate configured identities and upload managers bound to another
registry. Backing adapters must enforce their documented atomicity and quota
contracts across all clients.

| Permission | Routes relative to `/api/v1/tenant/registry` |
| --- | --- |
| `read` | `GET /images`, `GET /resolve?ref=…`, `GET /blobs/:digest` |
| `publish` | `PUT /blobs/:digest`, `POST /images`, `PUT /tags`, upload create/status/chunks/commit/cancel |
| `activate` | `POST /install` with `{reference}` |
| `invoke` | `POST /run` with `{reference, export, input}` |

`GET /api/v1/tenant/registry` reports the caller's own permission set and whether
uploads/execution are configured. Blob, manifest, tag and dependency resolution
always occurs in that namespace. Knowing another tenant's digest or upload ID does
not grant access. Upload operations use the same offset/digest protocol documented
in `station-images/README.md`. Direct request bodies are bounded to 8MiB; use
resumable uploads for larger artifacts. Staging and final blob quotas remain
separate. Rate/concurrency limits aggregate all mapped keys for a tenant.

## Optional execution gateway

Registry-only namespaces return `409 tenant_execution_not_configured` for
activation or invocation, even when the key holds the permission. An operator may
supply an explicitly bound gateway:

```ts
execution: {
  tenantId: "customer-a",
  registryIdentity: customerARegistry.identity,
  dedicated: true,
  isolation: "container", // Or a separately implemented VM gateway.
  install: async (pinnedReference) => dedicatedWorker.install(pinnedReference),
  run: async (pinnedReference, exportName, input) =>
    dedicatedWorker.run(pinnedReference, exportName, input),
}
```

These methods must use fixed authenticated worker destinations owned by that
tenant, verify/import artifacts from its namespace, and preserve tenant ownership
through queues, dependencies, retries, environment grants and recovery. The markers
are operator assertions and configuration checks, not network enforcement. A shared
`ImageController` is not a safe substitute. Neither `stationId`, worker URL,
filesystem path nor a caller-provided tenant is accepted in activation/run bodies.
The API resolves references within the caller's registry and passes immutable
digests to the gateway, preventing a later mutable tag update from changing the
selected version. Invocation inputs are checked against the selected export schema.

The built-in grant layer is tested with real key verification/revocation and two
separate in-memory registries. Gateway tests verify permission and binding contracts;
they do not claim an implemented multi-tenant image scheduler or a real isolated
worker deployment. Public hosting still needs that deployment-specific execution
gateway, storage isolation, syscall/network/resource controls and recovery checks.
