export interface BrowserUseClientOptions {
  baseUrl: string;
  stationId: string;
  apiKey: string;
  access?: "tenant" | "operator";
  timeoutMs?: number;
}

export class BrowserUseClientError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly outcome?: "unknown";
  constructor(code: string, message: string, status?: number, outcome?: "unknown") {
    super(message);
    this.name = "BrowserUseClientError";
    this.code = code;
    this.status = status;
    this.outcome = outcome;
  }
}

const MAX_RESPONSE_BYTES = 33 * 1024 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const serverMessages: Record<string, string> = {
  invalid_input: "The browser request was rejected.",
  unauthorized: "Browser authentication is required.",
  forbidden: "Browser access was denied.",
  not_found: "The browser worker or resource was not found.",
  busy: "The browser resource is busy.",
  capacity: "Browser capacity was reached.",
  rate_limited: "The browser request limit was reached.",
  challenge_required: "Page requires human review. Pause the agent and use live takeover; do not retry blindly.",
  provider_auth: "Browser provider credentials or permissions were rejected.",
  provider_disconnected: "Remote browser disconnected. Check provider expiry and reconcile before creating a replacement.",
  provider_capacity: "Browser provider session capacity reached.",
  provider_unavailable: "Browser provider unavailable; reconcile retained sessions before retrying.",
  payload_too_large: "The browser request was too large.",
  unsupported: "The browser capability is unavailable.",
  invalid_state: "The browser resource state is unavailable.",
  unavailable: "The browser worker is unavailable.",
  execution_failed: "The browser operation could not be completed.",
  timeout: "The browser operation timed out.",
  cancelled: "The browser operation was cancelled.",
};
function invalidConfig(): never { throw new BrowserUseClientError("invalid_config", "Invalid browser client configuration."); }
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A single-owner RPC client. Failed mutations are never retried automatically. */
export class BrowserUseClient {
  readonly #endpoint: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;

  constructor(options: BrowserUseClientOptions) {
    if (!object(options)) invalidConfig();
    const { baseUrl, stationId, apiKey, access = "tenant", timeoutMs = 30_000 } = options;
    if (typeof baseUrl !== "string" || !/^https?:\/\/[^/?#\s\\]+\/?$/i.test(baseUrl)) invalidConfig();
    let url: URL;
    try { url = new URL(baseUrl); } catch { invalidConfig(); }
    if (url.username || url.password || baseUrl.includes("@") || url.search || url.hash || url.pathname !== "/") invalidConfig();
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) invalidConfig();
    if (access !== "tenant" && access !== "operator") invalidConfig();
    if (typeof apiKey !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(apiKey)) invalidConfig();
    if (typeof stationId !== "string" || !stationId.trim() || stationId.length > 256 || /[\x00-\x1f\x7f]/.test(stationId) || stationId === "." || stationId === "..") invalidConfig();
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) invalidConfig();
    let owner: string;
    try { owner = encodeURIComponent(stationId); } catch { invalidConfig(); }
    this.#endpoint = `${url.origin}/api/v1/${access === "tenant" ? "tenant/" : ""}stations/${owner}/execution/browser`;
    this.#apiKey = apiKey;
    this.#timeoutMs = timeoutMs;
    Object.freeze(this);
  }

  async request<T = unknown>(body: Record<string, unknown>, options: { signal?: AbortSignal } = {}): Promise<T> {
    let serialized: string;
    try {
      if (!object(body)) throw new Error();
      serialized = JSON.stringify(body);
      if (!serialized || serialized[0] !== "{") throw new Error();
      if (new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BYTES) throw new Error();
    } catch { throw new BrowserUseClientError("invalid_input", "The browser request must be a bounded JSON object."); }
    if (!object(options)) throw new BrowserUseClientError("invalid_input", "Invalid browser request options.");
    const signal = options.signal;
    if (signal !== undefined && (!object(signal) || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) throw new BrowserUseClientError("invalid_input", "Invalid browser request signal.");
    if (signal?.aborted) throw new BrowserUseClientError("cancelled", "The browser request was cancelled before dispatch.");
    const controller = new AbortController();
    let timedOut = false;
    let status: number | undefined;
    const cancel = () => { if (!controller.signal.aborted) controller.abort(); };
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => { if (!controller.signal.aborted) { timedOut = true; controller.abort(); } }, this.#timeoutMs);
    const uncertain = (code: string, message: string) => new BrowserUseClientError(code, message, status, "unknown");
    try {
      const response = await fetch(this.#endpoint, {
        method: "POST", redirect: "manual", credentials: "omit", cache: "no-store",
        headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json", accept: "application/json" },
        body: serialized, signal: controller.signal,
      });
      status = response.status;
      if (response.type === "opaqueredirect" || (status >= 300 && status < 400)) throw uncertain("redirect_refused", "Browser redirects are not followed.");
      const declared = response.headers.get("content-length");
      if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) throw uncertain("response_too_large", "The browser response exceeded the client limit.");
      if (!response.body) throw uncertain("invalid_response", "The browser response was incomplete.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const chunks: string[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) throw uncertain("response_too_large", "The browser response exceeded the client limit.");
          try { chunks.push(decoder.decode(next.value, { stream: true })); }
          catch { throw uncertain("invalid_response", "The browser response was not valid JSON."); }
        }
        try { chunks.push(decoder.decode()); }
        catch { throw uncertain("invalid_response", "The browser response was not valid JSON."); }
      } finally { reader.releaseLock(); }
      if (controller.signal.aborted) throw uncertain(timedOut ? "timeout" : "cancelled", "The browser request ended before its outcome was known.");
      let payload: unknown;
      try { payload = JSON.parse(chunks.join("")); }
      catch { throw uncertain("invalid_response", "The browser response was not valid JSON."); }
      if (!response.ok) {
        const code = object(payload) && typeof payload.error === "string" && Object.hasOwn(serverMessages, payload.error) ? payload.error : "http_error";
        throw new BrowserUseClientError(code, serverMessages[code] ?? "The browser request failed.", status, status >= 500 || code === "timeout" || code === "cancelled" ? "unknown" : undefined);
      }
      if (!object(payload) || !Object.hasOwn(payload, "data") || Object.hasOwn(payload, "error")) throw uncertain("invalid_response", "The browser response did not contain a result.");
      return payload.data as T;
    } catch (error) {
      if (controller.signal.aborted) throw uncertain(timedOut ? "timeout" : "cancelled", "The browser request ended before its outcome was known.");
      if (error instanceof BrowserUseClientError) throw error;
      throw uncertain("network_error", "The browser request failed before its outcome was known.");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      // Also closes oversized, redirected and malformed response bodies.
      controller.abort();
    }
  }
}
