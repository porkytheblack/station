import { open, rm, writeFile } from "node:fs/promises";
import type { StationClient } from "station-client";

export async function saveNewFile(path: string, bytes: Uint8Array) {
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  return { path, bytes: bytes.length };
}
export async function downloadSandboxFile(client: StationClient, stationId: string, id: string, remotePath: string, destination: string, maxBytes = 64 * 1024 * 1024) {
  const file = await open(destination, "wx", 0o600);
  let offset = 0, total: number | undefined, success = false;
  try {
    for (;;) {
      const chunk = await client.sandboxReadFile(stationId, id, remotePath, { offset, length: 1024 * 1024 });
      if (chunk.totalBytes > maxBytes || (total !== undefined && total !== chunk.totalBytes)) throw new Error("Sandbox file changed length or exceeds the download limit.");
      total = chunk.totalBytes;
      await file.writeFile(chunk.data);
      if (chunk.nextOffset === total) break;
      if (chunk.nextOffset <= offset) throw new Error("Sandbox file download made no progress.");
      offset = chunk.nextOffset;
    }
    success = true;
    return { path: destination, bytes: total };
  } finally {
    await file.close();
    if (!success) await rm(destination, { force: true });
  }
}
