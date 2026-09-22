import { open, mkdir, writeFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { validateManifest, validateArtifactBytes, digestBytes, manifestDigest, type ImageManifest } from "station-images";

/** Read only explicit regular files; never follow a last-component symlink or read a device. */
export async function boundedFile(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error(`Expected a regular file no larger than ${limit} bytes.`);
    const chunks: Buffer[] = []; let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit - total + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit) throw new Error("File grew beyond the allowed size.");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}
export async function readImage(manifestPath: string, artifactsDirectory: string, build = false) {
  const manifest: unknown = JSON.parse((await boundedFile(manifestPath, 1024 * 1024)).toString("utf8"));
  if (!manifest || typeof manifest !== "object" || !Array.isArray((manifest as ImageManifest).artifacts)) throw new Error("Expected an image manifest with explicit artifacts.");
  if ((manifest as ImageManifest).artifacts.length < 1 || (manifest as ImageManifest).artifacts.length > 32) throw new Error("Image requires 1–32 artifacts.");
  const blobs = new Map<string, Buffer>();
  let total = 0;
  for (const artifact of (manifest as ImageManifest).artifacts) {
    if (!artifact || typeof artifact.entrypoint !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(artifact.entrypoint)) throw new Error("Artifact entrypoint must be a basename.");
    const bytes = await boundedFile(join(resolve(artifactsDirectory), artifact.entrypoint), 128 * 1024 * 1024);
    total += bytes.length;
    if (total > 256 * 1024 * 1024) throw new Error("Image artifacts exceed the 256 MiB CLI limit.");
    if (build) { artifact.digest = digestBytes(bytes); artifact.size = bytes.length; }
    if (blobs.has(artifact.entrypoint) && !blobs.get(artifact.entrypoint)!.equals(bytes)) throw new Error("Conflicting artifact basenames.");
    blobs.set(artifact.entrypoint, bytes);
  }
  validateManifest(manifest);
  for (const artifact of manifest.artifacts) validateArtifactBytes(artifact, blobs.get(artifact.entrypoint)!);
  return { manifest, digest: manifestDigest(manifest), blobs };
}
/** Materialize a checked directory bundle; build hashes precompiled inputs, never executes a build script. */
export async function packImage(manifestPath: string, artifactsDirectory: string, outputDirectory: string, build = false) {
  const image = await readImage(manifestPath, artifactsDirectory, build);
  const directory = resolve(outputDirectory);
  await mkdir(directory, { mode: 0o700 }); // Existing output is never replaced.
  try {
    const artifactDir = join(directory, "artifacts"); await mkdir(artifactDir, { mode: 0o700 });
    for (const artifact of image.manifest.artifacts) {
      if (image.manifest.artifacts.find(item => item.entrypoint === artifact.entrypoint) !== artifact) continue;
      await writeFile(join(artifactDir, artifact.entrypoint), image.blobs.get(artifact.entrypoint)!, { flag: "wx", mode: artifact.runtime === "native" ? 0o700 : 0o600 });
    }
    await writeFile(join(directory, "manifest.json"), JSON.stringify(image.manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return { directory, manifest: join(directory, "manifest.json"), artifactsDirectory: artifactDir, digest: image.digest };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
