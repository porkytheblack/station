import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlaywrightBrowserAdapter } from "../dist/playwright.js";
import { BrowserSessionManager } from "../dist/manager.js";
import type { BrowserArtifact, BrowserPage } from "../src/commands.js";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read: () => boolean) { const end = Date.now() + 5000; while (!read()) { if (Date.now() >= end) throw new Error("Timed out waiting for recording"); await wait(20); } }

test("Playwright profiles, pages, structured actions, safe file artifacts and durable recordings", { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "station-browser-production-"));
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/download")) {
      response.setHeader("content-disposition", 'attachment; filename="fixture.txt"');
      response.end("downloaded file content"); return;
    }
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><title>${request.url}</title><input id="text"><select id="select"><option value="a">A</option><option value="b">B</option></select><input type="checkbox" id="check"><span id="hover" onmouseover="this.textContent='hovered'">Hover me</span><input type="file" id="upload" onchange="this.files[0].text().then(t=>document.querySelector('#uploaded').textContent=t)"><p id="uploaded"></p><a href="/download" id="download">Download</a><div style="height:2000px">page content fixture</div>`);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const profiles = join(root, "profiles"); const recordings = join(root, "recordings");
  const executablePath = process.env.STATION_TEST_CHROMIUM;
  const firstAdapter = new PlaywrightBrowserAdapter({ executablePath, profileRootDir: profiles, maxPages: 2 });
  const first = new BrowserSessionManager(firstAdapter, 4, { recordingRootDir: recordings, intervalMs: 100 });
  let second: BrowserSessionManager | undefined;
  let limited: BrowserSessionManager | undefined;
  try {
    const session = await first.open({ profileId: "persistent", viewport: { width: 640, height: 480 } });
    await first.perform(session.id, "navigate", `${base}/first`);
    await first.perform(session.id, "evaluate", "document.cookie='station=remembered; max-age=3600; path=/'");
    await assert.rejects(new PlaywrightBrowserAdapter({ executablePath, profileRootDir: profiles }).open({ profileId: "persistent" }), { code: "busy" });
    await assert.rejects(first.deleteProfile("persistent"), { code: "busy" });
    assert.equal((await first.listProfiles())[0].inUse, true);
    await first.execute(session.id, { op: "fill", selector: "#text", value: "filled" });
    assert.equal(await first.perform(session.id, "evaluate", "document.querySelector('#text').value"), "filled");
    assert.deepEqual(await first.execute(session.id, { op: "select", selector: "#select", values: ["b"] }), ["b"]);
    await first.execute(session.id, { op: "check", selector: "#check", checked: true });
    await first.execute(session.id, { op: "hover", selector: "#hover" });
    await first.execute(session.id, { op: "waitFor", selector: "#hover", state: "visible" });
    assert.equal(await first.perform(session.id, "evaluate", "document.querySelector('#check').checked"), true);
    assert.equal(await first.perform(session.id, "evaluate", "document.querySelector('#hover').textContent"), "hovered");
    assert.match(await first.execute(session.id, { op: "content" }) as string, /page content fixture/);
    await first.execute(session.id, { op: "scroll", x: 0, y: 200 });
    await first.execute(session.id, { op: "upload", selector: "#upload", files: [{ name: "fixture.txt", mimeType: "text/plain", base64: Buffer.from("uploaded file content").toString("base64") }] });
    await first.perform(session.id, "evaluate", "new Promise(resolve => { const poll = () => document.querySelector('#uploaded').textContent ? resolve(true) : setTimeout(poll, 10); poll(); })");
    assert.equal(await first.perform(session.id, "evaluate", "document.querySelector('#uploaded').textContent"), "uploaded file content");
    const artifact = await first.execute(session.id, { op: "download", selector: "#download" }) as BrowserArtifact;
    assert.equal(artifact.bytes, Buffer.byteLength("downloaded file content"));
    assert.equal(artifact.name, "fixture.txt");
    const file = await first.execute(session.id, { op: "downloadRead", artifactId: artifact.id }) as { base64: string };
    assert.equal(Buffer.from(file.base64, "base64").toString(), "downloaded file content");
    await first.execute(session.id, { op: "downloadDelete", artifactId: artifact.id });
    await assert.rejects(first.execute(session.id, { op: "downloadRead", artifactId: artifact.id }), { code: "not_found" });
    const original = (await first.execute(session.id, { op: "pages" }) as BrowserPage[])[0];
    const page = await first.execute(session.id, { op: "newPage", url: `${base}/second` }) as BrowserPage;
    assert.equal((await first.execute(session.id, { op: "pages" }) as BrowserPage[]).length, 2);
    await assert.rejects(first.execute(session.id, { op: "newPage" }), { code: "capacity" });
    await first.execute(session.id, { op: "selectPage", pageId: original.id });
    assert.equal(await first.perform(session.id, "evaluate", "document.title"), "/first");
    await first.perform(session.id, "navigate", `${base}/third`);
    await first.execute(session.id, { op: "back" }); assert.equal(await first.perform(session.id, "evaluate", "document.title"), "/first");
    await first.execute(session.id, { op: "forward" }); assert.equal(await first.perform(session.id, "evaluate", "document.title"), "/third");
    await first.execute(session.id, { op: "reload" });
    await first.execute(session.id, { op: "closePage", pageId: page.id });
    const recording = first.startRecording(session.id);
    await until(() => first.getRecording(recording.id).frames.length >= 2);
    await first.close();
    const secondAdapter = new PlaywrightBrowserAdapter({ executablePath, profileRootDir: profiles });
    second = new BrowserSessionManager(secondAdapter, 4, { recordingRootDir: recordings });
    const recovered = second.getRecording(recording.id);
    assert.equal(recovered.status, "stopped");
    assert.match(second.recordingFrame(recording.id, recovered.frames[0].id).base64, /^iVBOR/);
    const reopened = await second.open({ profileId: "persistent" });
    await second.perform(reopened.id, "navigate", `${base}/first`);
    assert.equal(await second.perform(reopened.id, "evaluate", "document.cookie"), "station=remembered");
    await second.closeSession(reopened.id);
    assert.equal((await second.listProfiles())[0].inUse, false);
    await second.deleteProfile("persistent"); assert.deepEqual(await second.listProfiles(), []);
    await second.deleteRecording(recording.id); assert.deepEqual(second.listRecordings(), []);
    limited = new BrowserSessionManager(new PlaywrightBrowserAdapter({ executablePath, maxArtifactBytes: 8 }));
    const short = await limited.open(); await limited.perform(short.id, "navigate", `${base}/first`);
    await assert.rejects(limited.execute(short.id, { op: "download", selector: "#download" }));
  } finally {
    await Promise.allSettled([first.close(), second?.close(), limited?.close()]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
