/** Browser sessions are live resources owned by one worker, not durable agents. */
export interface BrowserSession {
  navigate(url: string): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  click(selector: string): Promise<void>;
  type(text: string): Promise<void>;
  press(key: string): Promise<void>;
  screenshot(): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface BrowserAdapter {
  readonly name: string;
  readonly capabilities: { screenshots: true; independentSessions: true };
  open(): Promise<BrowserSession>;
}

export class BrowserUseError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "BrowserUseError";
  }
}
