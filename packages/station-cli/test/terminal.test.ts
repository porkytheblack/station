import test from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { StationClient } from "station-client";
import { attachTerminal } from "../src/terminal.js";
class Input extends Readable {
  isTTY = true; isRaw = false; modes: boolean[] = [];
  _read() {}
  setRawMode(raw: boolean) { this.isRaw = raw; this.modes.push(raw); return this; }
}
class Output extends Writable {
  isTTY = true; columns = 80; rows = 24; text = "";
  _write(chunk: Buffer, _encoding: string, done: () => void) { this.text += chunk.toString(); done(); }
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("Terminal test timed out");
}
test("PTY attach forwards Ctrl-C and Unicode input, follows output cursors, resizes and detaches without closing", async () => {
  const input = new Input(), output = new Output(); input.pause();
  const requests: any[] = [];
  const client = new StationClient({ url: "https://hq.example", tenant: true }, { fetch: async (url, options) => {
    assert.match(String(url), /\/tenant\/stations\/owner\/execution\/sandbox$/);
    const body = JSON.parse(String(options?.body)); requests.push(body);
    assert.equal(body.id, "sandbox"); assert.equal(body.terminalId, "terminal");
    return new Response(JSON.stringify({ data: body.method === "terminal" ? { data: body.offset === 0 ? "hello" : "", nextOffset: 5, truncated: false, status: "running", exitCode: null } : null }));
  } });
  const listeners = process.listenerCount("SIGTERM");
  const attached = attachTerminal(client, "owner", "sandbox", "terminal", { input, output, pollMs: 1 });
  await until(() => output.text.includes("hello"));
  const unicode = Buffer.from("€"); input.push(unicode.subarray(0, 1)); input.push(unicode.subarray(1)); input.push(Buffer.from("\x03"));
  output.columns = 120; output.rows = 42; output.emit("resize");
  await until(() => requests.some(r => r.method === "terminalInput" && r.data === "\x03") && requests.some(r => r.method === "resizeTerminal" && r.cols === 120));
  assert.ok(requests.some(r => r.method === "terminalInput" && r.data === "€"));
  await until(() => requests.some(r => r.method === "terminal" && r.offset === 5));
  input.push(Buffer.from("\x1d")); assert.equal((await attached).detached, true);
  assert.deepEqual(input.modes, [true, false]); assert.equal(input.isPaused(), true);
  assert.equal(requests.some(r => r.method === "closeTerminal"), false);
  assert.equal(input.listenerCount("data"), 0); assert.equal(output.listenerCount("resize"), 0);
  assert.equal(process.listenerCount("SIGTERM"), listeners); assert.match(output.text, /\x1b\[\?25h/);
});
test("detaching aborts an in-flight transport and restores an already raw terminal", async () => {
  const input = new Input(), output = new Output(); input.isRaw = true;
  let aborted = false, requested = false;
  const client = new StationClient({ url: "https://hq.example" }, { fetch: async (_url, options) => {
    requested = true;
    return new Promise<Response>((_resolve, reject) => options?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); }, { once: true }));
  } });
  const attached = attachTerminal(client, "owner", "sandbox", "terminal", { input, output });
  await until(() => requested); input.push(Buffer.from("\x1d"));
  assert.equal((await attached).detached, true); assert.equal(aborted, true); assert.equal(input.isRaw, true);
});
test("terminal transport failure restores raw mode and removes handlers", async () => {
  const input = new Input(), output = new Output();
  const client = new StationClient({ url: "https://hq.example" }, { fetch: async () => { throw new Error("offline"); } });
  await assert.rejects(attachTerminal(client, "owner", "sandbox", "terminal", { input, output }), /unavailable/);
  assert.equal(input.isRaw, false); assert.equal(input.listenerCount("data"), 0);
});
