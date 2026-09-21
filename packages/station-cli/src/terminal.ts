import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { setTimeout } from "node:timers/promises";
import type { StationClient, ExecutionRequest } from "station-client";

type Input = Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?(raw: boolean): unknown };
type Output = Writable & { isTTY?: boolean; columns?: number; rows?: number };
interface TerminalOutput { data: string; nextOffset: number; truncated: boolean; status: "running" | "exited" | "interrupted"; exitCode: number | null }
export function terminalSize(output: Output = process.stdout) {
  return { cols: Math.max(2, Math.min(500, output.columns ?? 80)), rows: Math.max(1, Math.min(500, output.rows ?? 24)) };
}
/** Attach is only a client view: Ctrl-] detaches; Ctrl-C bytes go to the remote PTY. */
export async function attachTerminal(client: StationClient, owner: string, sandbox: string, terminal: string, options: { input?: Input; output?: Output; pollMs?: number; signal?: AbortSignal } = {}) {
  const input = options.input ?? process.stdin, output = options.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY || !input.setRawMode) throw new Error("Terminal attachment requires an interactive TTY.");
  const controller = new AbortController(), signal = controller.signal;
  const stop = () => controller.abort();
  const priorRaw = Boolean(input.isRaw), priorPaused = input.isPaused();
  const decoder = new StringDecoder("utf8");
  let failure: unknown, offset = 0, queuedBytes = 0, queue = Promise.resolve();
  const rpc = <T>(request: ExecutionRequest) => client.execution<T>(owner, "sandbox", { ...request, id: sandbox, terminalId: terminal }, signal);
  const enqueue = (request: ExecutionRequest, bytes = 0) => {
    queuedBytes += bytes;
    if (queuedBytes > 64 * 1024) { failure = new Error("Terminal input queue exceeded 64 KiB; detached without retrying input."); stop(); return; }
    queue = queue.then(async () => { if (!signal.aborted) await rpc(request); }).catch(error => { if (!signal.aborted) { failure = error; stop(); } }).finally(() => { queuedBytes -= bytes; });
  };
  const onInput = (chunk: Buffer | string) => {
    const data = typeof chunk === "string" ? chunk : decoder.write(chunk), detach = data.indexOf("\x1d");
    if (detach >= 0) { stop(); return; }
    if (data) enqueue({ method: "terminalInput", data }, Buffer.byteLength(data));
  };
  const onResize = () => enqueue({ method: "resizeTerminal", ...terminalSize(output) });
  options.signal?.addEventListener("abort", stop, { once: true });
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    if (options.signal?.aborted) return { detached: true };
    input.setRawMode(true); input.on("data", onInput); input.on("end", stop); output.on("resize", onResize); input.resume();
    // Resize only a live terminal. A previously exited terminal can still be replayed.
    let resized = false;
    while (!signal.aborted) {
      const result = await rpc<TerminalOutput>({ method: "terminal", offset });
      if (!result || typeof result.data !== "string" || !Number.isSafeInteger(result.nextOffset) || result.nextOffset < offset || !["running", "exited", "interrupted"].includes(result.status)) throw new Error("Invalid terminal output response.");
      if (result.truncated) output.write("\r\n[Earlier terminal output expired]\r\n");
      if (result.data && !output.write(result.data)) await new Promise<void>((resolve, reject) => {
        const done = () => { output.removeListener("drain", drain); signal.removeEventListener("abort", abort); resolve(); };
        const drain = () => done(), abort = () => { done(); reject(new Error("Terminal detached.")); };
        output.once("drain", drain); signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      offset = result.nextOffset;
      if (result.status !== "running") return { detached: false, exitCode: result.exitCode, status: result.status };
      if (!resized) { onResize(); resized = true; }
      await setTimeout(options.pollMs ?? 100, undefined, { signal });
    }
    return { detached: true };
  } catch (error) {
    if (!signal.aborted) throw error;
    return { detached: true };
  } finally {
    stop(); input.removeListener("data", onInput); input.removeListener("end", stop); output.removeListener("resize", onResize);
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); options.signal?.removeEventListener("abort", stop);
    input.setRawMode(priorRaw); if (priorPaused) input.pause();
    output.write("\x1b[?2004l\x1b[?25h\x1b[0m");
    await queue;
    if (failure) throw failure;
  }
}
