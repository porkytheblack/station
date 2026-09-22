import { manifestDigest, validateManifest } from "./manifest.js";
import type { ImageRegistry } from "./registry.js";
import { fail, type Digest, type ImageRecord } from "./types.js";
export interface ImageSource {
  /** Transport MUST enforce fixed approved origin, authentication, tenant and response byte limits. */
  resolve(reference: string): Promise<ImageRecord>;
  getBlob(digest: Digest): Promise<Uint8Array>;
}
/** Copy and verify a pinned dependency closure. No activation or execution; interrupted imports are safe to retry. */
export async function importImage(registry: ImageRegistry, reference: string, source: ImageSource): Promise<ImageRecord> {
  const imported = new Map<Digest, ImageRecord>();
  const pending = new Set<Digest>();
  const copy = async (ref: string, depth: number): Promise<ImageRecord> => {
    if (depth > 32) fail("dependency_limit", "Import dependency depth exceeds 32");
    const record = await source.resolve(ref);
    validateManifest(record.manifest);
    if (manifestDigest(record.manifest) !== record.digest) fail("digest_mismatch", "Source manifest digest mismatch");
    const separator = ref.lastIndexOf("@");
    if (ref.startsWith("sha256:") && ref !== record.digest || separator >= 0 && (ref.slice(0, separator) !== record.manifest.name || ref.slice(separator + 1).startsWith("sha256:") && ref.slice(separator + 1) !== record.digest)) fail("invalid_reference", "Source returned a different image identity");
    if (separator >= 0) {
      const selector = ref.slice(separator + 1);
      if (/^\d+\.\d+\.\d+/.test(selector) && record.manifest.version !== selector) fail("invalid_reference", "Source returned a different image version");
    }
    const existing = imported.get(record.digest); if (existing) return existing;
    if (pending.has(record.digest)) fail("invalid_dependency", "Cyclic image dependency");
    if (imported.size + pending.size >= 128) fail("dependency_limit", "Import dependency closure exceeds 128 images");
    pending.add(record.digest);
    for (const dependency of Object.values(record.manifest.dependencies ?? {})) await copy(dependency.image, depth + 1);
    for (const artifact of record.manifest.artifacts) {
      try { const bytes = await registry.getBlob(artifact.digest); if (bytes.byteLength !== artifact.size) fail("size_mismatch", "Cached artifact size mismatch"); }
      catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "not_found") throw error;
        const bytes = await source.getBlob(artifact.digest);
        if (bytes.byteLength !== artifact.size) fail("size_mismatch", "Source artifact size mismatch");
        await registry.putBlob(bytes, artifact.digest);
      }
    }
    const published = await registry.publish(record.manifest);
    pending.delete(record.digest); imported.set(record.digest, published);
    return published;
  };
  return copy(reference, 0);
}
