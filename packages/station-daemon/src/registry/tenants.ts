import type { ExportKind, ImageRegistry, ImageUploadManager } from "station-images";
export interface TenantImageRunTarget { reference: string; export: string; kind: ExportKind; id: string }
export type RegistryPermission = "read" | "publish" | "activate" | "invoke";
/** Operator-bound gateway to ONE tenant's dedicated isolated worker; never a shared controller. */
export interface TenantRegistryExecution {
  tenantId: string;
  registryIdentity: string;
  dedicated: true;
  isolation: "container" | "vm";
  install(reference: string): Promise<unknown>;
  run(reference: string, exportName: string, input: unknown): Promise<unknown>;
  inspect?(target: TenantImageRunTarget): Promise<unknown>;
  cancel?(target: TenantImageRunTarget): Promise<unknown>;
  restart?(target: TenantImageRunTarget): Promise<unknown>;
}
export interface TenantRegistryNamespace {
  registry: ImageRegistry;
  uploads?: ImageUploadManager;
  execution?: TenantRegistryExecution;
}
export interface TenantRegistryGrant { tenantId: string; permissions: RegistryPermission[] }
export interface TenantImageRegistryConfig {
  namespaces: Record<string, TenantRegistryNamespace>;
  /** Verified API key record IDs, never API key plaintext or request-selected tenant IDs. */
  apiKeys: Record<string, TenantRegistryGrant>;
  limits?: { requestsPerSecond?: number; burst?: number; maxInFlightPerTenant?: number; maxInFlight?: number };
}
const tenantPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const permissions = new Set<RegistryPermission>(["read", "publish", "activate", "invoke"]);
export class RegistryTenantAccess {
  readonly namespaces: ReadonlyMap<string, TenantRegistryNamespace>;
  private readonly grants: ReadonlyMap<string, { tenantId: string; permissions: ReadonlySet<RegistryPermission> }>;
  constructor(config: TenantImageRegistryConfig, excludedRegistryIdentities: readonly string[] = []) {
    if (!config || typeof config !== "object" || !config.namespaces || Array.isArray(config.namespaces) || !config.apiKeys || Array.isArray(config.apiKeys) || Object.keys(config).some(key => !["namespaces", "apiKeys", "limits"].includes(key)) || Object.keys(config.namespaces).length > 1000 || Object.keys(config.apiKeys).length > 10_000) throw new Error("Invalid tenant registry configuration");
    const seen = new Set(excludedRegistryIdentities), namespaces = new Map<string,TenantRegistryNamespace>();
    for (const [tenantId, namespace] of Object.entries(config.namespaces)) {
      if (!tenantPattern.test(tenantId) || !namespace?.registry || Object.keys(namespace).some(key => !["registry", "uploads", "execution"].includes(key)) || seen.has(namespace.registry.identity)) throw new Error("Tenant registries require distinct operator-configured storage identities");
      if (namespace.uploads && namespace.uploads.registryIdentity !== namespace.registry.identity) throw new Error("Tenant staging must commit only to its own registry namespace");
      const execution = namespace.execution;
      if (execution && (execution.tenantId !== tenantId || execution.registryIdentity !== namespace.registry.identity || execution.dedicated !== true || !["container", "vm"].includes(execution.isolation) || typeof execution.install !== "function" || typeof execution.run !== "function" || [execution.inspect, execution.cancel, execution.restart].some(method => method !== undefined && typeof method !== "function"))) throw new Error("Tenant execution requires a namespace-bound dedicated isolated worker gateway");
      seen.add(namespace.registry.identity); namespaces.set(tenantId, Object.freeze({ ...namespace }));
    }
    const grants = new Map<string,{tenantId:string;permissions:ReadonlySet<RegistryPermission>}>();
    for (const [keyId, grant] of Object.entries(config.apiKeys)) {
      if (!keyId || keyId.length > 128 || /[\r\n\0]/.test(keyId) || !grant || Object.keys(grant).some(key => !["tenantId", "permissions"].includes(key)) || !namespaces.has(grant.tenantId) || !Array.isArray(grant.permissions) || grant.permissions.length < 1 || grant.permissions.length > 4 || new Set(grant.permissions).size !== grant.permissions.length || grant.permissions.some(permission => !permissions.has(permission))) throw new Error("Invalid tenant registry key grant");
      grants.set(keyId, {tenantId:grant.tenantId,permissions:new Set(grant.permissions)});
    }
    const limits=config.limits;
    if (limits && (typeof limits!=="object" || Array.isArray(limits) || Object.entries(limits).some(([key,value])=>!["requestsPerSecond","burst","maxInFlightPerTenant","maxInFlight"].includes(key)||!Number.isSafeInteger(value)||value<1||value>100_000))) throw new Error("Invalid tenant registry request limits");
    this.namespaces=namespaces;this.grants=grants;
  }
  resolve(authType: unknown, scopes: unknown, keyId: unknown) {
    if (authType!=="api-key" || !Array.isArray(scopes) || scopes.length!==1 || scopes[0]!=="registry" || typeof keyId!=="string") return undefined;
    const grant=this.grants.get(keyId);if(!grant)return undefined;
    return {tenantId:grant.tenantId,permissions:grant.permissions,namespace:this.namespaces.get(grant.tenantId)!};
  }
}
