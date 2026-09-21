import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright";
import { BrowserbaseBrowserAdapter, SteelBrowserAdapter, type RemoteBrowserOptions } from "../src/remote.js";

function fakeBrowser(): Browser {
  const page = Object.assign(new EventEmitter(), { url: () => "about:blank", isClosed: () => false, title: async () => "fixture", evaluate: async () => false, screenshot: async () => Buffer.from("png") });
  const context = Object.assign(new EventEmitter(), { pages: () => [page], setDefaultTimeout() {}, tracing: {} });
  return { isConnected: () => true, contexts: () => [context], close: async () => {} } as unknown as Browser;
}
class BrowserbaseFixture extends BrowserbaseBrowserAdapter { protected override async attach() { return fakeBrowser(); } }
class SteelFixture extends SteelBrowserAdapter { protected override async attach() { return fakeBrowser(); } }
const root = () => mkdtempSync(join(tmpdir(), "station-remote-test-"));
const options = (rootDir: string, fetch: typeof globalThis.fetch): RemoteBrowserOptions => ({ rootDir, apiKey: "PRIVATE-KEY", projectId: "project-a", tenantId: "tenant-a", fetch });

for (const [name, Adapter] of [["browserbase", BrowserbaseFixture], ["steel", SteelFixture]] as const) {
  test(`${name}: provider payload, profile exclusivity, screenshot and explicit release`, async t => {
    const rootDir = root(); t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const calls: Array<{ url: string; body: any; headers: Headers }> = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      return Response.json(String(url).endsWith("/v1/sessions") ? { id: "provider-session", connectUrl: "wss://connect.browserbase.com?apiKey=PRIVATE-KEY" } : {});
    };
    const adapter = new Adapter({ ...options(rootDir, fetch), profiles: { account: "profile-a" } });
    t.after(() => adapter.close());
    await adapter.bindTenant("tenant-a");
    await assert.rejects(adapter.bindTenant("tenant-b"), { code: "invalid_state" });
    await assert.rejects(adapter.open({ profileId: "other" }), { code: "not_found" });
    assert.equal(calls.length, 0);
    const session = await adapter.open({ profileId: "account", viewport: { width: 900, height: 700 } });
    await assert.rejects(adapter.open({ profileId: "account" }), { code: "busy" });
    assert.deepEqual(await adapter.listProfiles(), [{ id: "account", inUse: true }]);
    assert.equal((await session.screenshot()).toString(), "png");
    assert.equal(calls[0].body.projectId, "project-a");
    if (name === "browserbase") {
      assert.equal(calls[0].body.timeout, 900); assert.equal(calls[0].headers.get("X-BB-API-Key"), "PRIVATE-KEY");
      assert.deepEqual(calls[0].body.browserSettings.context, { id: "profile-a", persist: true });
    } else {
      assert.equal(calls[0].body.timeout, 900000); assert.equal(calls[0].headers.get("steel-api-key"), "PRIVATE-KEY");
      assert.equal(calls[0].body.profileId, "profile-a"); assert.equal(calls[0].body.persistProfile, true);
    }
    assert.ok(!readFileSync(join(rootDir, ".station-remote.json"), "utf8").includes("PRIVATE-KEY"));
    await session.close(); await session.close();
    assert.equal(calls.length, 2);
    assert.ok(calls[1].url.endsWith(name === "steel" ? "/provider-session/release" : "/provider-session"));
    if (name === "browserbase") assert.equal(calls[1].body.status, "REQUEST_RELEASE");
    assert.deepEqual(await adapter.listProfiles(), [{ id: "account", inUse: false }]);
    assert.deepEqual(adapter.pendingSessions(), []);
    assert.equal(adapter.capabilities.isolated, false); assert.equal(adapter.capabilities.networkRestricted, false);
    assert.equal(adapter.capabilities.tracing, false); assert.equal(adapter.capabilities.downloads, false);
  });
}
test("uncertain create is journaled across restart; no implicit retries; explicit reconciliation unblocks admission", async t => {
  const rootDir = root(); t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  let requests = 0;
  const fetch: typeof globalThis.fetch = async () => { requests++; throw new Error("secret URL PRIVATE-KEY"); };
  const adapter = new BrowserbaseFixture(options(rootDir, fetch));
  await assert.rejects(adapter.open(), error => (error as Error).message.includes("PRIVATE-KEY") === false);
  assert.equal(requests, 1);
  const [record] = adapter.pendingSessions(); assert.ok(record && !record.providerSessionId);
  await assert.rejects(adapter.open(), { code: "provider_unavailable" }); assert.equal(requests, 1);
  await assert.rejects(adapter.close(), { code: "provider_unavailable" });
  const recovered = new BrowserbaseFixture(options(rootDir, fetch));
  t.after(() => recovered.close());
  assert.equal(recovered.pendingSessions()[0].id, record.id);
  await assert.rejects(recovered.reconcile(), { code: "provider_unavailable" });
  await recovered.reconcile({ [record.id]: null }); // Operator fixture confirms no provider resource exists.
  assert.deepEqual(recovered.pendingSessions(), []);
});
test("definitive auth/capacity errors do not strand an unknown creation or leak response bodies", async t => {
  for (const [status, code] of [[401, "provider_auth"], [429, "provider_capacity"]] as const) {
    const rootDir = root(); t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const adapter = new SteelFixture(options(rootDir, async () => new Response("PRIVATE-KEY", { status })));
    await assert.rejects(adapter.open(), { code }); assert.deepEqual(adapter.pendingSessions(), []); await adapter.close();
  }
});
test("connection failure releases the created resource; provider release failure remains recoverable", async t => {
  const rootDir = root(); t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  let releaseFails = true; let releases = 0;
  class FailedConnection extends BrowserbaseBrowserAdapter { protected override async attach(): Promise<Browser> { throw new Error("wss://secret?apiKey=PRIVATE-KEY"); } }
  const fetch: typeof globalThis.fetch = async url => {
    if (String(url).endsWith("/v1/sessions")) return Response.json({ id: "remote-id", connectUrl: "wss://connect.browserbase.com" });
    releases++; return new Response("", { status: releaseFails ? 503 : 200 });
  };
  const adapter = new FailedConnection(options(rootDir, fetch));
  await assert.rejects(adapter.open(), { code: "provider_unavailable" });
  assert.equal(adapter.pendingSessions()[0].providerSessionId, "remote-id"); assert.equal(releases, 1);
  await assert.rejects(adapter.open()); assert.equal(releases, 1);
  releaseFails = false; await adapter.reconcile(); assert.equal(releases, 2); await adapter.close();
});
test("persistent ownership refuses tenant/profile reassignment and concurrent controllers", async t => {
  const rootDir = root(); t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const settings = options(rootDir, async () => { throw new Error("unexpected request"); });
  const first = new SteelFixture(settings);
  assert.throws(() => new SteelFixture(settings), { code: "busy" }); await first.close();
  assert.throws(() => new SteelFixture({ ...settings, tenantId: "tenant-b" }), { code: "invalid_state" });
  assert.throws(() => new SteelFixture({ ...settings, profiles: { new: "grant" } }), { code: "invalid_state" });
});
test("provider connection URLs cannot redirect credentials to another host", async t => {
  const rootDir = root(); t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  let attached = false; let released = false;
  class Redirected extends BrowserbaseFixture { protected override async attach() { attached = true; return fakeBrowser(); } }
  const adapter = new Redirected(options(rootDir, async url => {
    if (String(url).endsWith("/v1/sessions")) return Response.json({ id: "session", connectUrl: "wss://attacker.invalid/?apiKey=PRIVATE-KEY" });
    released = true; return Response.json({});
  }));
  await assert.rejects(adapter.open(), { code: "provider_unavailable" }); assert.equal(attached, false); assert.equal(released, true); await adapter.close();
});
