import { ImageError, type ImageRecord, type ImageSource, validateManifest, assertDigest, manifestDigest } from 'station-images';

export interface RegistryUpstream { url: string; token: string; maxBlobBytes?: number; syncIntervalMs?: number }
/** Fixed operator-supplied upstream. Request callers cannot choose URLs or credentials. */
export function registrySource(config: RegistryUpstream): ImageSource & { list(): Promise<ImageRecord[]> } {
  const origin = new URL(config.url);
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Registry upstream must be an HTTP(S) origin');
  if (origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw new Error('Remote registry credentials require HTTPS');
  if (!config.token || /[\r\n]/.test(config.token)) throw new Error('Registry upstream requires a valid token');
  if (config.maxBlobBytes !== undefined && (!Number.isSafeInteger(config.maxBlobBytes) || config.maxBlobBytes < 1 || config.maxBlobBytes > 256 * 1024 * 1024)) throw new Error('Registry blob limit must be a positive integer at most 256 MiB');
  const record = (value: unknown): ImageRecord => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ImageError('upstream_invalid', 'Invalid registry record');
    const result = value as ImageRecord;
    assertDigest(result.digest);
    validateManifest(result.manifest);
    if (manifestDigest(result.manifest) !== result.digest) throw new ImageError('digest_mismatch', 'Registry record digest does not match its manifest');
    return result;
  };
  const read = async (path: string, limit: number) => {
    const response = await fetch(new URL(path, origin), {
      headers: { authorization: `Bearer ${config.token}` }, redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new ImageError('upstream_unavailable', `Registry upstream returned HTTP ${response.status}`); }
    const length = response.headers.get('content-length');
    if (length && Number(length) > limit) { await response.body?.cancel(); throw new ImageError('upstream_limit', 'Registry response exceeds limit'); }
    const reader = response.body?.getReader(); if (!reader) throw new ImageError('upstream_unavailable', 'Empty registry response');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > limit) throw new ImageError('upstream_limit', 'Registry response exceeds limit');
        chunks.push(value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    return Buffer.concat(chunks);
  };
  return {
    async list() {
      const bytes = await read('/api/v1/registry/images', 8 * 1024 * 1024);
      let result: { data?: unknown };
      try { result = JSON.parse(bytes.toString('utf8')); } catch { throw new ImageError('upstream_invalid', 'Invalid registry catalog'); }
      if (!Array.isArray(result?.data) || result.data.length > 10000) throw new ImageError('upstream_invalid', 'Invalid registry catalog');
      return result.data.map(record);
    },
    async resolve(reference) {
      const bytes = await read(`/api/v1/registry/resolve?ref=${encodeURIComponent(reference)}`, 300 * 1024);
      let result: { data?: ImageRecord };
      try { result = JSON.parse(bytes.toString('utf8')); } catch { throw new ImageError('upstream_invalid', 'Invalid registry response'); }
      if (!result.data) throw new ImageError('upstream_invalid', 'Missing registry record');
      return record(result.data);
    },
    getBlob: digest => read(`/api/v1/registry/blobs/${encodeURIComponent(digest)}`, config.maxBlobBytes ?? 64 * 1024 * 1024),
  };
}
