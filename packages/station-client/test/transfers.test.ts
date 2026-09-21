import test from "node:test";
import assert from "node:assert/strict";
import { StationClient, decodeFileBytes } from "../src/index.js";
const reply = (data: unknown) => new Response(JSON.stringify({ data }));
test("binary transfer helpers preserve bytes, tenant owner routing and browser control token", async () => {
  const bytes = Buffer.from([0, 255, 128, 10]); const requests: Record<string, any>[] = [];
  const client = new StationClient({ url: "https://hq.example", tenant: true }, { fetch: async (url, options) => {
    assert.match(String(url), /\/tenant\/stations\/owner\/execution\//);
    const input = JSON.parse(String(options?.body)); requests.push(input);
    if (input.method === "readFile") return reply({ path: "bin", base64: bytes.toString("base64"), bytes: 4, totalBytes: 4, nextOffset: 4 });
    if (input.method === "action") return reply({ mimeType: "image/png", base64: bytes.toString("base64") });
    if (input.command?.op === "downloadRead") return reply({ id: "file", bytes: 4, name: "binary", mimeType: "application/octet-stream", base64: bytes.toString("base64") });
    return reply(null);
  } });
  await client.sandboxWriteFile("owner", "sandbox", "bin", bytes, { createParents: true });
  assert.deepEqual((await client.sandboxReadFile("owner", "sandbox", "bin")).data, bytes);
  await client.browserUpload("owner", "session", { selector: "input" }, [{ name: "binary", mimeType: "application/octet-stream", bytes }], "control");
  assert.equal(requests[2].controlToken, "control"); assert.equal(requests[2].command.files[0].base64, bytes.toString("base64"));
  assert.deepEqual(await client.browserScreenshot("owner", "session"), bytes);
  assert.deepEqual((await client.browserReadDownload("owner", "session", "file")).data, bytes);
});
test("corrupt base64, inconsistent offsets and oversized uploads fail closed", async () => {
  for (const input of ["abc", "AB==", "####", "AAAA===="]) assert.throws(() => decodeFileBytes(input));
  assert.throws(() => decodeFileBytes("AAAA", 1));
  let calls = 0;
  const client = new StationClient({ url: "https://hq.example" }, { fetch: async () => { calls++; return reply({ path: "x", base64: "AA==", bytes: 1, totalBytes: 1, nextOffset: 2 }); } });
  assert.throws(() => client.sandboxWriteFile("a", "b", "x", new Uint8Array(4 * 1024 * 1024 + 1)));
  assert.throws(() => client.browserUpload("a", "b", { selector: "input" }, [{ name: "../secret", mimeType: "text/plain", bytes: new Uint8Array() }]));
  assert.equal(calls, 0);
  await assert.rejects(client.sandboxReadFile("a", "b", "x"), /Inconsistent/);
});
test("binary image publication can target a private station registry without changing bytes", async () => {
  const bytes = new Uint8Array([0, 255]);
  const client = new StationClient({ url: "https://hq.example" }, { fetch: async (url, options) => {
    assert.equal(new URL(String(url)).pathname, `/api/v1/stations/worker%2Fone/registry/blobs/sha256%3A${"a".repeat(64)}`);
    assert.equal(options?.body, bytes); return reply({ size: 2 });
  } });
  assert.equal((await client.putBlob(`sha256:${"a".repeat(64)}`, bytes, "worker/one")).size, 2);
});
