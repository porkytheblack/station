/** Private bootstrap context for this one-process-per-attempt signal execution. */
export interface SignalRunContext {
  readonly runId: string;
  readonly signalName: string;
  readonly attempt: number;
  /** Only explicitly injected application values; never the controller's inherited process environment. */
  readonly environment: Readonly<Record<string, string>>;
}
let current: SignalRunContext | undefined;
/** Returns undefined outside a SignalRunner child. Contains no adapter credentials or lease tokens. */
export function getRunContext(): SignalRunContext | undefined { return current; }
/** @internal Bootstrap only; not re-exported by the public package. */
export function setRunContext(context: SignalRunContext): void {
  if (current) throw new Error("Signal run context is already initialized.");
  current = Object.freeze({ ...context, environment: Object.freeze({ ...context.environment }) });
}
