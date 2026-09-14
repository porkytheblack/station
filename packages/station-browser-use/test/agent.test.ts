import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserAgentTools, type BrowserAgentTools } from "../src/agent.js";
import { BrowserUseClientError } from "../src/client.js";

function fixture(options: Partial<Parameters<typeof createBrowserAgentTools>[0]> = {}) {
  const calls: Record<string, unknown>[] = [];
  let next = 0;
  const tools = createBrowserAgentTools({ client: { async request<T>(body: Record<string, unknown>) {
    calls.push(body);
    if (body.method === "open" || body.method === "checkpointResume") return { id: `session-${++next}`, backend: "playwright" } as T;
    if (body.method === "checkpoint") return { id: "checkpoint-1" } as T;
    if (body.action === "screenshot") return { mimeType: "image/png", base64: "iVBORw0KGgo=" } as T;
    return { title: "Fixture", elements: [] } as T;
  } }, ...options });
  return { tools, calls };
}
const execute = (tools: BrowserAgentTools, name: string, input: unknown) => tools.find(tool => tool.name === `station_browser_${name}`)!.execute(input);

test("agent tools validate inputs and confine sessions, profiles and checkpoints to host grants", async () => {
  const { tools, calls } = fixture({ profileIds: ["approved"] });
  for (const [name, input] of [
    ["navigate", { sessionId: "someone-else", url: "https://example.com" }],
    ["open", { options: { profileId: "other" } }],
    ["resume", { checkpointId: "other" }],
    ["open", { options: {}, apiKey: "model-token" }],
    ["open", { options: { tenantId: "other" } }],
  ] as const) assert.equal((await execute(tools, name, input)).status, "error");
  assert.equal(calls.length, 0);
  assert.equal((await execute(tools, "open", { options: { profileId: "approved" } })).status, "success");
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "https://user:password@example.com"]) {
    assert.equal((await execute(tools, "navigate", { sessionId: "session-1", url })).error?.code, "invalid_input");
    assert.equal((await execute(tools, "interact", { sessionId: "session-1", command: { op: "newPage", url } })).error?.code, "invalid_input");
  }
  assert.equal(calls.length, 1);
  await execute(tools, "checkpoint", { sessionId: "session-1" });
  assert.equal((await execute(tools, "resume", { checkpointId: "checkpoint-1" })).status, "success");
  assert.deepEqual(tools.sessionIds(), ["session-1", "session-2"]);
  await tools.close();
  assert.deepEqual(tools.sessionIds(), []);
});

test("screenshots are model images, never base64 in text results; observations are bounded", async () => {
  const { tools } = fixture();
  await execute(tools, "open", {});
  const result = await execute(tools, "screenshot", { sessionId: "session-1" });
  assert.deepEqual(result.data, { mimeType: "image/png", bytes: 8 });
  assert.equal(result.images?.[0].base64, "iVBORw0KGgo=");
  assert.ok(!JSON.stringify(result.data).includes("iVBOR"));
  const long = fixture({ sessionIds: ["session-1"], maxResultChars: 1024, client: { async request<T>() { return { title: "x".repeat(2000) } as T; } } });
  const observed = await execute(long.tools, "observe", { sessionId: "session-1" });
  assert.equal((observed.data as { truncated: boolean }).truncated, true);
  assert.equal((observed.data as { text: string }).text.length, 1024);
});

test("command policy applies to observe and interact and cannot be bypassed through extra fields", async () => {
  const policy = ["inspect"] as Array<"inspect">;
  const { tools, calls } = fixture({ sessionIds: ["owned"], allowedCommands: policy });
  policy.length = 0; // Snapshot operator configuration.
  assert.equal((await execute(tools, "observe", { sessionId: "owned" })).status, "success");
  assert.equal((await execute(tools, "observe", { sessionId: "owned", mode: "accessibility" })).error?.code, "forbidden");
  assert.equal((await execute(tools, "interact", { sessionId: "owned", command: { op: "click", selector: "button" } })).error?.code, "forbidden");
  assert.equal((await execute(tools, "interact", { sessionId: "owned", command: { op: "inspect", controlToken: "bypass" } })).error?.code, "invalid_input");
  assert.equal(calls.length, 1);
});

test("parallel opens reserve capacity; shutdown waits for opening then closes its session", async () => {
  let complete!: (value: unknown) => void;
  const calls: string[] = [];
  const { tools } = fixture({ maxSessions: 1, client: { async request<T>(body) {
    calls.push(body.method as string);
    if (body.method === "open") return await new Promise(resolve => { complete = resolve; }) as T;
    return null as T;
  } } });
  const first = execute(tools, "open", {});
  assert.equal((await execute(tools, "open", {})).error?.code, "capacity");
  const closing = tools.close();
  assert.equal((await execute(tools, "open", {})).error?.code, "closed");
  complete({ id: "opened", backend: "playwright" });
  assert.equal((await first).status, "success");
  await closing;
  assert.deepEqual(calls, ["open", "close"]);
  assert.deepEqual(tools.sessionIds(), []);
});

test("uncertain mutations are not retried and cancellation before dispatch makes no request", async () => {
  let calls = 0;
  const { tools } = fixture({ sessionIds: ["owned"], client: { async request() {
    calls++;
    throw new BrowserUseClientError("timeout", "Request timed out.", undefined, "unknown");
  } } });
  const result = await execute(tools, "navigate", { sessionId: "owned", url: "https://example.com" });
  assert.equal(result.error?.outcome, "unknown");
  assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort();
  const aborted = await tools.find(tool => tool.name.endsWith("_navigate"))!.execute({ sessionId: "owned", url: "https://example.com" }, { signal: controller.signal });
  assert.equal(aborted.error?.code, "aborted");
  assert.equal(calls, 1);
});

test("human takeover conflicts retain session ownership for later cleanup", async () => {
  let busy = true;
  const { tools } = fixture({ sessionIds: ["owned"], client: { async request<T>() {
    if (busy) throw new BrowserUseClientError("busy", "Human controls this session.", 409);
    return null as T;
  } } });
  assert.equal((await execute(tools, "close", { sessionId: "owned" })).error?.code, "busy");
  await assert.rejects(tools.close(), AggregateError);
  assert.deepEqual(tools.sessionIds(), ["owned"]);
  busy = false;
  await tools.close();
  assert.deepEqual(tools.sessionIds(), []);
});

test('uncertain open/resume fences admission and shutdown reports unresolved ownership', async () => {
  for (const method of ['open', 'resume']) {
    const calls: string[] = [];
    const { tools } = fixture({ maxSessions: 1, checkpointIds: ['approved'], client: { async request<T>(body) {
      calls.push(body.method as string);
      if (body.method === 'open' || body.method === 'checkpointResume') throw new BrowserUseClientError('timeout', 'Outcome unknown', undefined, 'unknown');
      return null as T;
    } } });
    const result = await execute(tools, method, method === 'resume' ? { checkpointId: 'approved' } : {});
    assert.equal(result.error?.outcome, 'unknown');
    assert.equal(tools.uncertainOpenings(), 1);
    assert.equal((await execute(tools, 'open', {})).error?.code, 'unresolved_sessions');
    await assert.rejects(tools.close(), error => error instanceof AggregateError && error.errors[0].code === 'unresolved_sessions');
    assert.equal(calls.length, 1); // Never enumerate or close another workflow's sessions.
  }
});

test('a malformed successful handle leaves an unknown open instead of releasing admission', async () => {
  const { tools } = fixture({ client: { async request<T>() { return { id: 'invalid/id' } as T; } } });
  const result = await execute(tools, 'open', {});
  assert.equal(result.error?.code, 'invalid_response'); assert.equal(result.error?.outcome, 'unknown');
  assert.equal(tools.uncertainOpenings(), 1);
  assert.equal((await execute(tools, 'open', {})).error?.code, 'unresolved_sessions');
  await assert.rejects(tools.close(), AggregateError);
});

test('expired sessions release workflow capacity and concurrent shutdown shares cleanup', async () => {
  let closeCalls = 0;
  const { tools } = fixture({ maxSessions: 1, sessionIds: ['expired'], client: { async request<T>(body) {
    if (body.method === 'close') { closeCalls++; throw new BrowserUseClientError('not_found', 'Expired', 404); }
    return { id: 'replacement' } as T;
  } } });
  assert.equal((await execute(tools, 'close', { sessionId: 'expired' })).status, 'success');
  assert.equal((await execute(tools, 'open', {})).status, 'success');
  const first = tools.close(), second = tools.close();
  assert.equal(first, second); await first;
  assert.deepEqual(tools.sessionIds(), []); assert.equal(closeCalls, 2);
});
