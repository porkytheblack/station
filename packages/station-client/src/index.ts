import { Buffer } from "node:buffer";
export const STATION_API_PROTOCOL = "station.api/v1" as const;
export interface StationInfo {
  protocol: typeof STATION_API_PROTOCOL;
  version: string;
  stationId: string;
  role: "station" | "headquarters" | "standalone";
  capabilities: string[];
}
export interface StationConnection {
  url: string;
  token?: string;
  /** Expected daemon identity. Checked by connect() before using this connection. */
  stationId?: string;
  /** Use the restricted tenant execution gateway. The server derives tenant identity from the key. */
  tenant?: boolean;
}
export interface ExecutionStation {
  stationId: string;
  name: string;
  available: boolean;
  capabilities: { sandbox: boolean; browser: boolean };
  backends: { sandbox?: string; browser?: string };
  features?: Record<string, unknown>;
}
export interface Definition { name: string; [key: string]: unknown }
export interface RunReceipt { id: string; status: string; createdAt: string }
export interface ExecutionRequest { method: string; [key: string]: unknown }
export interface SandboxFileChunk { path: string; base64: string; bytes: number; totalBytes: number; nextOffset: number }
export interface BrowserFile { name: string; mimeType: string; bytes: Uint8Array }
export type BrowserLocator = { selector: string; target?: never } | { target: { by: "selector" | "text" | "label" | "testId"; value: string; exact?: boolean; frame?: string[]; nth?: number } | { by: "role"; role: string; name?: string; exact?: boolean; frame?: string[]; nth?: number }; selector?: never };
export interface BrowserDownload { id: string; name: string; mimeType: string; bytes: number; createdAt: string }
export function decodeFileBytes(base64: unknown, maxBytes = 8 * 1024 * 1024): Uint8Array {
  if (typeof base64 !== "string" || base64.length > Math.ceil(maxBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new StationApiError("invalid_response", 0, "Invalid or oversized base64 file response.");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > maxBytes || bytes.toString("base64") !== base64) throw new StationApiError("invalid_response", 0, "Invalid or oversized base64 file response.");
  return bytes;
}
export interface ImageUploadStatus { id: string; digest: string; size: number; offset: number; state: "open" | "committed"; createdAt: number; expiresAt: number; maxChunkBytes: number }
export interface StationEvent { event: string; data: string; id?: string }
export class StationApiError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message); this.name = "StationApiError";
  }
}
/** Only loopback HTTP is accepted. Remote credentials require TLS. */
export function validateEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid Station endpoint URL."); }
  if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("Station endpoint must be an HTTP(S) origin without credentials, query or fragment.");
  }
  if (url.pathname !== "/") throw new Error("Station endpoint must be an origin without a path.");
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Remote Station endpoints require HTTPS.");
  }
  return url.origin;
}
const segment = (value: string) => encodeURIComponent(value);
export class StationClient {
  readonly url: string;
  private readonly transport: typeof fetch;
  constructor(readonly connection: StationConnection, readonly options: { fetch?: typeof fetch; timeoutMs?: number; maxResponseBytes?: number } = {}) {
    this.url = validateEndpoint(connection.url);
    if (connection.token && /[\r\n]/.test(connection.token)) throw new Error("Invalid API token.");
    this.transport = options.fetch ?? fetch;
  }
  private endpoint(path: string) {
    if (!path.startsWith("/") || path.startsWith("//") || /[\\#]/.test(path)) throw new Error("API path must be relative to /api/v1.");
    const url = new URL(`${this.url}/api/v1${path}`);
    if (url.origin !== this.url || !url.pathname.startsWith("/api/v1/")) throw new Error("API path escapes /api/v1.");
    return url;
  }
  private headers(): Record<string, string> {
    return { accept: "application/json", ...(this.connection.token ? { authorization: `Bearer ${this.connection.token}` } : {}) };
  }
  private async requestResult<T = unknown>(method: string, path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>): Promise<{ data: T; headers: Headers }> {
    const deadline = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
    let response: Response;
    try {
      response = await this.transport(this.endpoint(path), {
        method, headers: { ...headers, ...this.headers(), ...(body === undefined ? {} : { "content-type": body instanceof Uint8Array ? "application/octet-stream" : "application/json" }) },
        ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body as unknown as BodyInit : JSON.stringify(body) }),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline, redirect: "error",
      });
      const limit = this.options.maxResponseBytes ?? 16 * 1024 * 1024;
      const reader = response.body?.getReader();
      let bytes = 0; const chunks: Uint8Array[] = [];
      if (reader) {
        try {
          for (;;) {
            const next = await reader.read(); if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > limit) { await reader.cancel(); throw new StationApiError("response_too_large", response.status, "Station response exceeded the client size limit."); }
            chunks.push(next.value);
          }
        } finally { reader.releaseLock(); }
      }
      if (response.status === 204) return { data: undefined as T, headers: response.headers };
      const combined = new Uint8Array(bytes); let offset = 0;
      for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }
      let payload: { data?: T; error?: unknown };
      try { payload = JSON.parse(new TextDecoder().decode(combined)); }
      catch { throw new StationApiError("invalid_response", response.status, "Station returned a non-JSON response."); }
      if (!response.ok) {
        const code = typeof payload?.error === "string" && /^[a-z_]{1,80}$/.test(payload.error) ? payload.error : "request_failed";
        // Do not surface arbitrary upstream response text: providers may include credentials.
        throw new StationApiError(code, response.status, `Station request failed (${response.status}, ${code}).`);
      }
      if (!payload || typeof payload !== "object" || !("data" in payload)) throw new StationApiError("invalid_response", response.status, "Station response is missing data.");
      return { data: payload.data as T, headers: response.headers };
    } catch (error) {
      if (error instanceof StationApiError) throw error;
      if (signal?.aborted) throw new StationApiError("cancelled", 0, "Station request was cancelled.");
      if (deadline.aborted) throw new StationApiError("timeout", 0, "Station request timed out. A mutation may already have been accepted; inspect its state before retrying.");
      throw new StationApiError("unavailable", 0, "Station endpoint is unavailable. No automatic retry was made.");
    }
  }
  async request<T = unknown>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return (await this.requestResult<T>(method, path, body, signal)).data;
  }
  registryPath(stationId?: string) {
    if (stationId && this.connection.tenant) throw new Error("Private registry forwarding requires an operator context.");
    return `${this.connection.tenant ? "/tenant" : stationId ? `/stations/${segment(stationId)}` : ""}/registry`;
  }
  private async uploadRequest(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
    const result = await this.requestResult<Omit<ImageUploadStatus, "maxChunkBytes">>(method, path, body, undefined, headers), data = result.data;
    const maxChunkBytes = Number(result.headers.get("Upload-Max-Chunk-Bytes") ?? 1024 * 1024);
    if (!data || typeof data.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(data.id) || !/^sha256:[a-f0-9]{64}$/.test(data.digest) || !Number.isSafeInteger(data.size) || data.size < 1 || !Number.isSafeInteger(data.offset) || data.offset < 0 || data.offset > data.size || !["open", "committed"].includes(data.state) || !Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1 || maxChunkBytes > 8 * 1024 * 1024) throw new StationApiError("invalid_response", 0, "Invalid upload status response.");
    return { ...data, maxChunkBytes };
  }
  createImageUpload(digest: string, size: number, stationId?: string) { return this.uploadRequest("POST", `${this.registryPath(stationId)}/uploads`, { digest, size }); }
  imageUploadStatus(id: string, stationId?: string) { return this.uploadRequest("GET", `${this.registryPath(stationId)}/uploads/${segment(id)}`); }
  appendImageUpload(id: string, offset: number, bytes: Uint8Array, chunkDigest: string, stationId?: string) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !/^sha256:[a-f0-9]{64}$/.test(chunkDigest)) throw new Error("Invalid upload chunk metadata.");
    return this.uploadRequest("PATCH", `${this.registryPath(stationId)}/uploads/${segment(id)}`, bytes, { "Upload-Offset": String(offset), "X-Chunk-SHA256": chunkDigest });
  }
  commitImageUpload(id: string, stationId?: string) { return this.uploadRequest("POST", `${this.registryPath(stationId)}/uploads/${segment(id)}/commit`, {}); }
  cancelImageUpload(id: string, stationId?: string) { return this.request<void>("DELETE", `${this.registryPath(stationId)}/uploads/${segment(id)}`); }
  async connect(signal?: AbortSignal): Promise<StationInfo> {
    const info = await this.request<StationInfo>("GET", "/info", undefined, signal);
    if (info?.protocol !== STATION_API_PROTOCOL || !/^3\./.test(info.version ?? "") || typeof info.stationId !== "string") {
      throw new StationApiError("incompatible_version", 0, "This client requires a Station 3 daemon using station.api/v1.");
    }
    if (this.connection.stationId && info.stationId !== this.connection.stationId) throw new StationApiError("identity_mismatch", 0, "Station identity does not match the saved context.");
    return info;
  }
  putBlob(digest: string, bytes: Uint8Array, stationId?: string) {
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid artifact digest.");
    return this.request<{ digest: string; size: number }>("PUT", `${this.registryPath(stationId)}/blobs/${segment(digest)}`, bytes);
  }
  health() { return this.request<{ ok: boolean }>("GET", "/health"); }
  signals() { return this.request<Definition[]>("GET", "/signals"); }
  broadcasts() { return this.request<Definition[]>("GET", "/broadcasts"); }
  beacons() { return this.request<Definition[]>("GET", "/beacons"); }
  triggerSignal(signalName: string, input: unknown = {}) { return this.request<RunReceipt>("POST", "/trigger", { signalName, input }); }
  triggerBroadcast(broadcastName: string, input: unknown = {}) { return this.request<RunReceipt>("POST", "/trigger-broadcast", { broadcastName, input }); }
  executionStations() { return this.request<ExecutionStation[]>("GET", this.connection.tenant ? "/tenant/execution" : "/execution"); }
  execution<T = unknown>(stationId: string, primitive: "sandbox" | "browser", request: ExecutionRequest, signal?: AbortSignal) {
    return this.request<T>("POST", `${this.connection.tenant ? "/tenant" : ""}/stations/${segment(stationId)}/execution/${primitive}`, request, signal);
  }
  async sandboxReadFile(stationId: string, id: string, path: string, options: { offset?: number; length?: number } = {}) {
    const result = await this.execution<SandboxFileChunk>(stationId, "sandbox", { method: "readFile", id, path, options });
    const data = decodeFileBytes(result.base64, 4 * 1024 * 1024), offset = options.offset ?? 0;
    if (result.bytes !== data.length || result.nextOffset !== offset + data.length || !Number.isSafeInteger(result.totalBytes) || result.totalBytes < result.nextOffset || (options.length !== undefined && data.length > options.length)) throw new StationApiError("invalid_response", 0, "Inconsistent sandbox file response.");
    return { path: result.path, data, totalBytes: result.totalBytes, nextOffset: result.nextOffset };
  }
  sandboxWriteFile(stationId: string, id: string, path: string, bytes: Uint8Array, options: { createParents?: boolean } = {}) {
    if (bytes.length > 4 * 1024 * 1024) throw new Error("Sandbox uploads are limited to 4 MiB.");
    return this.execution(stationId, "sandbox", { method: "writeFile", id, path, options: { ...options, base64: Buffer.from(bytes).toString("base64") } });
  }
  async browserScreenshot(stationId: string, id: string, controlToken?: string) {
    const result = await this.execution<{ mimeType: string; base64: string }>(stationId, "browser", { method: "action", id, action: "screenshot", ...(controlToken ? { controlToken } : {}) });
    if (result.mimeType !== "image/png") throw new StationApiError("invalid_response", 0, "Unexpected screenshot format.");
    return decodeFileBytes(result.base64);
  }
  browserUpload(stationId: string, id: string, locator: BrowserLocator, files: BrowserFile[], controlToken?: string) {
    if (files.length > 16 || files.reduce((sum, file) => sum + file.bytes.length, 0) > 4 * 1024 * 1024) throw new Error("Browser uploads are limited to 16 files and 4 MiB total.");
    if (files.some(file => !file.name || file.name === "." || file.name === ".." || /[\\/\0]/.test(file.name) || Buffer.byteLength(file.name) > 255 || Buffer.byteLength(file.mimeType) > 255)) throw new Error("Invalid browser upload filename or MIME type.");
    return this.execution(stationId, "browser", { method: "execute", id, command: { op: "upload", ...locator, files: files.map(file => ({ name: file.name, mimeType: file.mimeType, base64: Buffer.from(file.bytes).toString("base64") })) }, ...(controlToken ? { controlToken } : {}) });
  }
  browserDownload(stationId: string, id: string, locator: BrowserLocator, controlToken?: string) {
    return this.execution<BrowserDownload>(stationId, "browser", { method: "execute", id, command: { op: "download", ...locator }, ...(controlToken ? { controlToken } : {}) });
  }
  async browserReadDownload(stationId: string, id: string, artifactId: string) {
    const result = await this.execution<BrowserDownload & { base64: string }>(stationId, "browser", { method: "execute", id, command: { op: "downloadRead", artifactId } });
    const data = decodeFileBytes(result.base64);
    if (result.bytes !== data.length) throw new StationApiError("invalid_response", 0, "Inconsistent browser download response.");
    return { id: result.id, name: result.name, mimeType: result.mimeType, data };
  }
  /** SSE stream: no reconnect/replay is performed implicitly. Caller owns retry policy. */
  async *events(signal: AbortSignal, options: { lastEventId?: string; onOpen?: () => void } = {}): AsyncGenerator<StationEvent> {
    if (options.lastEventId !== undefined && (options.lastEventId.length > 256 || /[\r\n\0]/.test(options.lastEventId))) throw new Error("Invalid event cursor.");
    const response = await this.transport(this.endpoint("/events"), { headers: { ...this.headers(), accept: "text/event-stream", ...(options.lastEventId ? { "Last-Event-ID": options.lastEventId } : {}) }, signal, redirect: "error" });
    if (!response.ok || !response.body) throw new StationApiError("stream_failed", response.status, "Station event stream unavailable.");
    options.onOpen?.();
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");
        if (buffer.length > 1024 * 1024) throw new StationApiError("response_too_large", 0, "Station event exceeds the client limit.");
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const event: StationEvent = { event: "message", data: "" }; const data: string[] = [];
          for (const line of frame.split("\n")) {
            const index = line.indexOf(":"); if (index < 0) continue;
            const key = line.slice(0, index), value = line.slice(index + 1).replace(/^ /, "");
            if (key === "event") event.event = value;
            if (key === "id") event.id = value;
            if (key === "data") data.push(value);
          }
          if (data.length) { event.data = data.join("\n"); yield event; }
        }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
