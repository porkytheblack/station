import { readFile, lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { StationApiError, type StationClient, type ImageUploadStatus } from "station-client";
import { digestBytes } from "station-images";
import { privateDirectory, writePrivate } from "./store.js";
interface Receipt { id: string; digest: string; size: number }
/** Explicit re-invocation reconciles server offsets. Ambiguous mutations are never retried automatically. */
export async function uploadImageArtifact(client: StationClient, digest: string, bytes: Uint8Array, options: { home: string; stationId?: string }) {
  if (digestBytes(bytes) !== digest) throw new Error("Artifact digest changed before upload.");
  await privateDirectory(options.home);
  const directory = join(options.home, "uploads"); await privateDirectory(directory);
  const key = createHash("sha256").update(JSON.stringify({ endpoint: client.url, expectedIdentity: client.connection.stationId, tenant: client.connection.tenant ?? false, station: options.stationId, digest, credential: createHash("sha256").update(client.connection.token ?? "").digest("hex") })).digest("hex");
  const path = join(directory, `${key}.json`);
  let receipt: Receipt | undefined, status: ImageUploadStatus | undefined;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || (process.platform !== "win32" && (stat.mode & 0o077))) throw new Error("Upload receipt must be a private regular file.");
    receipt = JSON.parse(await readFile(path, "utf8"));
    if (!receipt || typeof receipt.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(receipt.id) || receipt.digest !== digest || receipt.size !== bytes.length) throw new Error("Upload receipt does not match this artifact.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (receipt) {
    try { status = await client.imageUploadStatus(receipt.id, options.stationId); }
    catch (error) {
      if (!(error instanceof StationApiError) || ![404, 410].includes(error.status)) throw error;
      await rm(path, { force: true }); receipt = undefined;
    }
  }
  if (!status) {
    status = await client.createImageUpload(digest, bytes.length, options.stationId);
    receipt = { id: status.id, digest, size: bytes.length };
    await writePrivate(path, receipt);
  }
  const validate = (result: ImageUploadStatus) => {
    if (result.id !== receipt!.id || result.digest !== digest || result.size !== bytes.length || (result.state === "committed" && result.offset !== bytes.length)) throw new Error("Upload status does not match the receipt.");
  };
  validate(status);
  while (status.offset < bytes.length) {
    const offset = status.offset, chunk = bytes.subarray(offset, Math.min(bytes.length, offset + status.maxChunkBytes));
    status = await client.appendImageUpload(status.id, offset, chunk, digestBytes(chunk), options.stationId);
    validate(status);
    if (status.offset < offset + chunk.length) throw new Error("Upload did not advance through the accepted chunk.");
  }
  if (status.state !== "committed") { status = await client.commitImageUpload(status.id, options.stationId); validate(status); }
  if (status.state !== "committed") throw new Error("Registry did not commit the artifact.");
  // Keep the receipt when quota cleanup fails; another explicit invocation can finish cleanup.
  await client.cancelImageUpload(status.id, options.stationId);
  await rm(path, { force: true });
  return { digest, size: bytes.length };
}
