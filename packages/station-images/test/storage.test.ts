import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ImageRegistry, FileImageRegistry, FileRegistryBlobAdapter, FileRegistryMetadataAdapter,
  MemoryRegistryBlobAdapter, MemoryRegistryMetadataAdapter, digestBytes, manifestDigest,
  importImage, type ImageManifest, type RegistryStorage,
} from "../src/index.js";

const bytes = Buffer.from("console.log('example')");
const manifest: ImageManifest = {
  format: "station.image/v1", protocol: "station.process/v1", name: "storage/example", version: "1.0.0",
  artifacts: [{ digest: digestBytes(bytes), size: bytes.length, entrypoint: "main.js", runtime: "node", runtimeMajor: 20, platform: { os: "any", arch: "any" } }],
  exports: [{ name: "example", kind: "signal" }],
};

for (const metadataKind of ["file", "memory"]) for (const blobKind of ["file", "memory"]) {
  test(`${metadataKind} metadata + ${blobKind} blobs: publication, shared clients, tags, immutable conflicts and import`, async t => {
    const root = await mkdtemp(join(tmpdir(), "station-registry-contract-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const metadataRoot = join(root, "metadata"), blobsRoot = join(root, "artifacts");
    const storage: RegistryStorage = {
      id: "contract-test",
      metadata: metadataKind === "file" ? new FileRegistryMetadataAdapter(metadataRoot) : new MemoryRegistryMetadataAdapter(),
      blobs: blobKind === "file" ? new FileRegistryBlobAdapter(blobsRoot) : new MemoryRegistryBlobAdapter(),
    };
    const writer = new ImageRegistry({ storage });
    // Filesystem clients use independent adapter instances sharing the same backing namespace.
    const reader = new ImageRegistry({ storage: { ...storage,
      metadata: metadataKind === "file" ? new FileRegistryMetadataAdapter(metadataRoot) : storage.metadata,
      blobs: blobKind === "file" ? new FileRegistryBlobAdapter(blobsRoot) : storage.blobs,
    } });
    await writer.putBlob(bytes);
    const competing = { ...manifest, exports: [{ name: "other", kind: "signal" as const }] };
    const attempts = await Promise.allSettled([writer.publish(manifest), reader.publish(competing)]);
    assert.equal(attempts.filter(value => value.status === "fulfilled").length, 1);
    assert.equal((attempts.find(value => value.status === "rejected") as PromiseRejectedResult).reason.code, "immutable_conflict");
    const winner = await reader.resolve("storage/example@1.0.0");
    const orphan = winner.digest === manifestDigest(manifest) ? competing : manifest;
    await assert.rejects(reader.getManifest(manifestDigest(orphan)), { code: "not_found" });
    await reader.setTag(manifest.name, "latest", winner.digest);
    assert.deepEqual(await writer.resolve("storage/example@latest"), winner);
    assert.deepEqual(await writer.list(), [winner]);
    const snapshot = await writer.getBlob(digestBytes(bytes)); snapshot.fill(0);
    assert.deepEqual(await reader.getBlob(digestBytes(bytes)), bytes);
    const cache = new FileImageRegistry(join(root, "cache"));
    assert.deepEqual(await importImage(cache, winner.digest, reader), winner);
    assert.deepEqual(await cache.getBlob(digestBytes(bytes)), bytes);
  });
}

test("shared in-memory blob admission is atomic and duplicate blobs do not consume quota twice", async () => {
  const storage = { id: "quota", metadata: new MemoryRegistryMetadataAdapter(), blobs: new MemoryRegistryBlobAdapter() };
  const a = new ImageRegistry({ storage, maxBlobBytes: 4, maxTotalBytes: 4 });
  const b = new ImageRegistry({ storage, maxBlobBytes: 4, maxTotalBytes: 4 });
  const attempts = await Promise.allSettled([a.putBlob(Buffer.from("aaaa")), b.putBlob(Buffer.from("bbbb"))]);
  assert.equal(attempts.filter(value => value.status === "fulfilled").length, 1);
  assert.equal((attempts.find(value => value.status === "rejected") as PromiseRejectedResult).reason.code, "registry_quota");
  const accepted = (attempts.find(value => value.status === "fulfilled") as PromiseFulfilledResult<{ digest: `sha256:${string}` }>).value;
  await b.putBlob(await a.getBlob(accepted.digest));
});

test("registry policy rejects corrupt or oversized adapter data and validates dependencies", async () => {
  const metadata = new MemoryRegistryMetadataAdapter(), blobs = new MemoryRegistryBlobAdapter();
  const registry = new ImageRegistry({ storage: { id: "corruption", metadata, blobs } });
  await registry.putBlob(bytes); const image = await registry.publish(manifest);
  await assert.rejects(registry.publish({ ...manifest, name: "storage/dependent", dependencies: { wrong: { image: `${manifest.name}@${image.digest}`, export: "missing", kind: "signal" } } }), { code: "invalid_dependency" });
  const readBlob = blobs.read.bind(blobs);
  blobs.read = async () => Buffer.from("wrong content");
  await assert.rejects(registry.getBlob(digestBytes(bytes)), { code: "digest_mismatch" });
  blobs.read = readBlob;
  const readMetadata = metadata.read.bind(metadata);
  metadata.read = async (collection, key, limit) => collection === "manifests" ? Buffer.alloc(limit + 1) : readMetadata(collection, key, limit);
  await assert.rejects(registry.getManifest(image.digest), { code: "corrupt_registry" });
  metadata.read = readMetadata;
  metadata.listVersions = async () => ["0".repeat(64)];
  metadata.read = async (collection, key, limit) => collection === "versions" && key === "0".repeat(64) ? Buffer.from(JSON.stringify({ name: manifest.name, version: manifest.version, digest: image.digest })) : readMetadata(collection, key, limit);
  await assert.rejects(registry.list(), { code: "corrupt_registry" });
});

test("upload owns its input bytes before asynchronous storage admission", async () => {
  const blobs = new MemoryRegistryBlobAdapter();
  const originalCreate = blobs.create.bind(blobs);
  blobs.create = async (...args) => { await new Promise(resolve => setImmediate(resolve)); return originalCreate(...args); };
  const registry = new ImageRegistry({ storage: { id: "snapshot", blobs, metadata: new MemoryRegistryMetadataAdapter() } });
  const input = Buffer.from(bytes), write = registry.putBlob(input);
  input.fill(0);
  const result = await write;
  assert.deepEqual(await registry.getBlob(result.digest), bytes);
});

test("metadata cannot redirect an immutable version to another committed version", async () => {
  const metadata = new MemoryRegistryMetadataAdapter();
  const registry = new ImageRegistry({ storage: { id: "versions", metadata, blobs: new MemoryRegistryBlobAdapter() } });
  await registry.putBlob(bytes);
  await registry.publish(manifest);
  const later = await registry.publish({ ...manifest, version: "2.0.0" });
  const read = metadata.read.bind(metadata);
  metadata.read = async (collection, key, limit) => collection === "versions" && key === digestBytes(`${manifest.name}@1.0.0`).slice(7)
    ? Buffer.from(JSON.stringify({ name: manifest.name, version: "1.0.0", digest: later.digest })) : read(collection, key, limit);
  await assert.rejects(registry.resolve(`${manifest.name}@1.0.0`), { code: "corrupt_registry" });
});
