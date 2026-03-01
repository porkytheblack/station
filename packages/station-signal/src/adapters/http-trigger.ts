import type { TriggerAdapter } from "./trigger.js";
import { StationRemoteError } from "../errors.js";

interface ErrorBody {
  error?: string;
  message?: string;
}

interface SuccessBody {
  data: { id: string };
}

export interface HttpTriggerOptions {
  endpoint: string;
  apiKey?: string;
  timeout?: number;
  fetch?: typeof globalThis.fetch;
}

export class HttpTriggerAdapter implements TriggerAdapter {
  private endpoint: string;
  private apiKey?: string;
  private timeout: number;
  private fetchFn: typeof globalThis.fetch;

  constructor(options: HttpTriggerOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeout = options.timeout ?? 10_000;
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  async trigger(signalName: string, input: unknown): Promise<string> {
    const url = `${this.endpoint}/api/v1/trigger`;
    const response = await this.fetchFn(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ signalName, input }),
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as ErrorBody;
      throw new StationRemoteError(response.status, body.error, body.message);
    }
    const body = await response.json() as SuccessBody;
    return body.data.id;
  }

  async triggerBroadcast(broadcastName: string, input: unknown): Promise<string> {
    const url = `${this.endpoint}/api/v1/trigger-broadcast`;
    const response = await this.fetchFn(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ broadcastName, input }),
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as ErrorBody;
      throw new StationRemoteError(response.status, body.error, body.message);
    }
    const body = await response.json() as SuccessBody;
    return body.data.id;
  }

  async ping(): Promise<boolean> {
    try {
      const url = `${this.endpoint}/api/v1/health`;
      const response = await this.fetchFn(url, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }
}
