import type { BrowserCommand, BrowserOpenOptions, BrowserProfile } from "./commands.js";
/** Browser sessions are live resources owned by one worker, not durable agents. */
export interface BrowserSession {
  navigate(url: string): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  click(selector: string): Promise<void>;
  type(text: string): Promise<void>;
  press(key: string): Promise<void>;
  screenshot(): Promise<Uint8Array>;
  execute?(command: BrowserCommand): Promise<unknown>;
  close(): Promise<void>;
}

export interface BrowserAdapter {
  readonly name: string;
  readonly capabilities: { screenshots: true; independentSessions: true; profiles?: boolean; pages?: boolean; commands?: boolean; uploads?: boolean; downloads?: boolean; isolated?: boolean; pointer?: boolean; inspection?: boolean; locators?: boolean; dialogs?: boolean; diagnostics?: boolean; tracing?: boolean; networkRestricted?: boolean };
  open(options?: BrowserOpenOptions): Promise<BrowserSession>;
  ready?(): Promise<void>;
  bindTenant?(tenantId?: string): Promise<void>;
  close?(): Promise<void>;
  listProfiles?(): Promise<BrowserProfile[]>;
  deleteProfile?(id: string): Promise<void>;
}

export class BrowserUseError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "BrowserUseError";
  }
}
