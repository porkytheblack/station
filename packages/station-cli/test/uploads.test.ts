import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StationClient } from "station-client";
import { digestBytes } from "station-images";
import { uploadImageArtifact } from "../src/uploads.js";
test("resumable publication reconciles a lost chunk response without resending accepted bytes", async t => {
  const home = await mkdtemp(join(tmpdir(), "station-upload-")); t.after(() => rm(home, { recursive: true, force: true }));
  const bytes = Buffer.from([0, 255, 12, 99]), digest = digestBytes(bytes), offsets: number[] = [];
  let lostResponse = true, creates = 0, commits = 0, deletes = 0;
  const status = { id: "upload-one", digest, size: bytes.length, offset: 0, state: "open", createdAt: 1, expiresAt: Date.now() + 10000 };
  const client = new StationClient({ url: "https://hq.example", token: "private-token" }, { fetch: async (url, options) => {
    const path = new URL(String(url)).pathname;
    assert.match(path, /^\/api\/v1\/stations\/worker\/registry\/uploads/);
    if (options?.method === "POST" && path.endsWith("/uploads")) creates++;
    if (options?.method === "PATCH") {
      const headers = new Headers(options.headers), offset = Number(headers.get("Upload-Offset"));
      offsets.push(offset); const chunk = options.body as Uint8Array;
      assert.equal(headers.get("X-Chunk-SHA256"), digestBytes(chunk));
      assert.equal(offset, status.offset); status.offset += chunk.length;
      if (lostResponse) { lostResponse = false; throw new Error("lost response after server acceptance"); }
    }
    if (path.endsWith("/commit")) { commits++; status.state = "committed"; }
    if (options?.method === "DELETE") { deletes++; return new Response(null, { status: 204 }); }
    return new Response(JSON.stringify({ data: status }), { headers: { "Upload-Max-Chunk-Bytes": "2" } });
  } });
  await assert.rejects(uploadImageArtifact(client, digest, bytes, { home, stationId: "worker" }), /unavailable/);
  assert.deepEqual(offsets, [0]); assert.equal(creates, 1);
  const receipts = await readdir(join(home, "uploads")); assert.equal(receipts.length, 1);
  assert.equal((await readFile(join(home, "uploads", receipts[0]), "utf8")).includes("private-token"), false);
  await uploadImageArtifact(client, digest, bytes, { home, stationId: "worker" });
  assert.deepEqual(offsets, [0, 2]); assert.equal(creates, 1); assert.equal(commits, 1); assert.equal(deletes, 1);
  assert.deepEqual(await readdir(join(home, "uploads")), []);
});
test("tenant upload namespace is server-selected and unavailable staging never falls back to operator upload", async t => {
  const home = await mkdtemp(join(tmpdir(), "station-upload-")); t.after(() => rm(home, { recursive: true, force: true }));
  const bytes = Buffer.from("data"), methods: string[] = [];
  const client = new StationClient({ url: "https://hq.example", tenant: true }, { fetch: async (url, options) => {
    assert.equal(new URL(String(url)).pathname, "/api/v1/tenant/registry/uploads"); methods.push(options?.method ?? "GET");
    return new Response(JSON.stringify({ error: "uploads_not_configured" }), { status: 409 });
  } });
  await assert.rejects(uploadImageArtifact(client, digestBytes(bytes), bytes, { home }), /uploads_not_configured/);
  assert.deepEqual(methods, ["POST"]);
  assert.throws(() => client.registryPath("worker"), /operator context/);
});
