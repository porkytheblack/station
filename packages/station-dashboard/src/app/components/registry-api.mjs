/** Authenticated calls stay bound to the dashboard's operator-configured daemon. */
export class RegistryRequestError extends Error { constructor(message, status = 0) { super(message); this.status = status; } }
export function registryPrefix(stationId) {
  if (stationId && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(stationId)) throw new Error("Invalid registry Station ID.");
  return stationId ? `/api/v1/stations/${encodeURIComponent(stationId)}/registry` : "/api/v1/registry";
}
async function registryResponse(path, options = {}, stationId) {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\#]/.test(path) || path.split("?")[0].includes("..")) throw new Error("Invalid registry API path.");
  let response;
  try {
    response = await fetch(`${registryPrefix(stationId)}${path}`, {
      credentials: 'include', redirect: 'error', ...options,
      headers: { ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    });
  } catch { throw new Error(options.method && options.method !== 'GET' ? 'Connection lost. The operation may have completed; inspect the registry or runs before retrying.' : 'Cannot reach the daemon. Check the dashboard connection and retry.'); }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const code = body?.error;
    const hints = {
      image_execution_not_configured: 'Configure registry.execution on this daemon before installing or running images.',
      upstream_not_configured: 'Configure an authenticated registry upstream on this daemon before pulling.',
      immutable_conflict: 'This image version already has different content. Publish a new version.',
      revision_conflict: "Another operator changed this deployment. Refresh and review the latest revision before retrying.",
      deployment_inactive: "Activate a deployment generation before invoking an alias.",
      unavailable_target: 'The selected worker must be online with the image installed and compatible. Beacon intent requires shared instance storage and an eligible beacon worker.',
      registry_target_not_configured: 'This private registry is not configured in Headquarters registry.targets.',
      registry_target_mismatch: 'The private registry identity differs from the selected Station. Check Headquarters configuration.',
      upload_offset_conflict: 'Upload position changed. Resume to reconcile the accepted bytes.',
      upload_expired: 'The upload expired. Resume to start a new staged upload.',
      payload_too_large: 'This artifact exceeds the registry upload limit.',
    };
    const fallback = response.status === 401 ? 'Sign in again to access this registry.' : response.status === 403 ? 'This operation requires operator admin access.' : response.status === 404 ? 'Registry or image not found. Check registry configuration and the selected daemon.' : `Registry request failed (${response.status}).`;
    throw new RegistryRequestError(hints[code] ?? (typeof code === 'string' && /^[a-z_]+$/.test(code) ? `${fallback} (${code})` : fallback), response.status);
  }
  if (response.status === 204) return { data: null, headers: response.headers };
  if (!body || !Object.hasOwn(body, 'data')) throw new Error('The daemon returned an unexpected registry response. Check API compatibility.');
  return { data: body.data, headers: response.headers };
}
export async function registryRequest(path, options = {}, stationId) { return (await registryResponse(path, options, stationId)).data; }

/** Verify ALL selected artifacts before sending the first upload. */
export async function preparePublication(manifest, files) {
  if (!manifest || manifest.format !== 'station.image/v1' || manifest.protocol !== 'station.process/v1' || typeof manifest.name !== 'string' || typeof manifest.version !== 'string' || !Array.isArray(manifest.exports) || !manifest.exports.length || !Array.isArray(manifest.artifacts) || !manifest.artifacts.length) throw new Error('Select a valid station.image/v1 manifest with exports and artifacts.');
  if (!globalThis.crypto?.subtle) throw new Error('Artifact verification requires HTTPS or localhost.');
  if (files.length > 64 || manifest.artifacts.length > 64) throw new Error('Select at most 64 artifacts.');
  let total = 0;
  for (const file of files) {
    if (file.size > 128 * 1024 * 1024) throw new Error(`${file.name} exceeds the 128 MiB dashboard file limit.`);
    total += file.size;
  }
  if (total > 256 * 1024 * 1024) throw new Error('Selected artifacts exceed the 256 MiB dashboard upload limit.');
  const selected = [];
  for (const file of files) {
    const bytes = await file.arrayBuffer();
    const digest = 'sha256:' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    selected.push({ file, digest, bytes });
  }
  const matched = [];
  for (const artifact of manifest.artifacts) {
    if (!artifact || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest) || !Number.isSafeInteger(artifact.size) || artifact.size <= 0 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(artifact.entrypoint)) throw new Error('An artifact has an invalid digest, size or entrypoint.');
    const match = selected.find(item => item.file.name === artifact.entrypoint && item.digest === artifact.digest && item.file.size === artifact.size);
    if (!match) throw new Error(`Missing or mismatched artifact: ${artifact.entrypoint}. Select the exact compiled file declared in the manifest.`);
    if (!matched.some(item => item.digest === match.digest)) matched.push(match);
  }
  if (selected.some(item => !manifest.artifacts.some(artifact => artifact.entrypoint === item.file.name && artifact.digest === item.digest))) throw new Error('A selected file is not declared in the manifest. Remove extra files before publishing.');
  return matched;
}

const sha256 = async bytes => 'sha256:' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
/** Explicit resubmission resumes server-acknowledged offsets; no mutation is retried automatically. */
export async function publishPrepared(manifest, artifacts, onProgress = (_message) => {}, options = {}) {
  const {stationId, signal} = options;
  const storage = options.storage ?? globalThis.sessionStorage;
  if (!storage) throw new Error('Session storage is required to retain resumable upload receipts.');
  const request = (path, init = {}) => registryResponse(path, {...init, signal}, stationId);
  for (const artifact of artifacts) {
    const key = 'station.registry.upload.' + await sha256(new TextEncoder().encode(JSON.stringify([options.receiptScope ?? globalThis.location?.origin ?? '', stationId ?? '', artifact.digest])));
    let receipt, status;
    const stored = storage.getItem(key);
    if (stored) {
      try { receipt = JSON.parse(stored); } catch { throw new Error('Invalid local upload receipt. Clear this dashboard session storage before retrying.'); }
      if (!receipt || !/^[a-zA-Z0-9_-]{1,128}$/.test(receipt.id) || receipt.digest !== artifact.digest || receipt.size !== artifact.bytes.byteLength) throw new Error('Local upload receipt does not match the artifact.');
    }
    const check = result => {
      const s = result.data, chunk = Number(result.headers.get('Upload-Max-Chunk-Bytes') ?? 1048576);
      if (!s || !/^[a-zA-Z0-9_-]{1,128}$/.test(s.id) || s.digest !== artifact.digest || s.size !== artifact.bytes.byteLength || !Number.isSafeInteger(s.offset) || s.offset < 0 || s.offset > s.size || !['open','committed'].includes(s.state) || (s.state === 'committed' && s.offset !== s.size) || !Number.isSafeInteger(chunk) || chunk < 1 || chunk > 8388608 || receipt && receipt.id !== s.id) throw new Error('Invalid upload status returned by the registry.');
      return {...s,chunk};
    };
    if (receipt) {
      try { status = check(await request(`/uploads/${encodeURIComponent(receipt.id)}`)); }
      catch (error) { if (!(error instanceof RegistryRequestError) || ![404,410].includes(error.status)) throw error; storage.removeItem(key); receipt = undefined; }
    }
    if (!status) {
      status = check(await request('/uploads',{method:'POST',body:JSON.stringify({digest:artifact.digest,size:artifact.bytes.byteLength})}));
      receipt = {id:status.id,digest:artifact.digest,size:artifact.bytes.byteLength};
      storage.setItem(key,JSON.stringify(receipt));
    }
    onProgress(`${artifact.file.name}: ${status.offset.toLocaleString()} / ${status.size.toLocaleString()} bytes accepted`);
    while (status.offset < status.size) {
      const offset = status.offset, chunk = artifact.bytes.slice(offset, Math.min(status.size,offset+status.chunk));
      status = check(await request(`/uploads/${encodeURIComponent(status.id)}`,{method:'PATCH',body:chunk,headers:{'Content-Type':'application/octet-stream','Upload-Offset':String(offset),'X-Chunk-SHA256':await sha256(chunk)}}));
      if (status.offset < offset+chunk.byteLength) throw new Error('Upload did not acknowledge the complete chunk. Resume to reconcile.');
      onProgress(`${artifact.file.name}: ${status.offset.toLocaleString()} / ${status.size.toLocaleString()} bytes accepted`);
    }
    if (status.state !== 'committed') status = check(await request(`/uploads/${encodeURIComponent(status.id)}/commit`,{method:'POST'}));
    if (status.state !== 'committed') throw new Error('Artifact has not been committed.');
    await request(`/uploads/${encodeURIComponent(status.id)}`,{method:'DELETE'});
    storage.removeItem(key);
  }
  onProgress('Publishing immutable manifest');
  return registryRequest('/images',{method:'POST',body:JSON.stringify(manifest),signal},stationId);
}

export function environmentBindings(rows) {
  const result = Object.create(null);
  for (const row of rows) {
    const key = row.key.trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || key.startsWith('STATION_')) throw new Error('Each binding needs a valid environment key outside the reserved STATION_ prefix.');
    if (Object.hasOwn(result,key)) throw new Error('Environment binding keys must be unique.');
    if (row.kind === 'reference') {
      const fromEnv = row.value.trim();
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(fromEnv)) throw new Error('Environment references must name a configured environment key.');
      result[key] = {fromEnv};
    } else if (row.kind === 'literal' && row.nonsecret === true) result[key] = {value:row.value};
    else throw new Error('Literal values require explicit confirmation that they contain no secret. Use an environment reference for credentials.');
  }
  return result;
}
