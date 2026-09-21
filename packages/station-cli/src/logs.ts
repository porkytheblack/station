import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { setTimeout } from "node:timers/promises";

/** Poll by filename so rotation and truncation do not strand a follower on an old inode. */
export async function* followLog(path: string, options: { signal: AbortSignal; pollMs?: number; follow?: boolean }): AsyncGenerator<Buffer> {
  let offset = 0, identity = "";
  while (!options.signal.aborted) {
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error("Log path must be a regular file.");
      const current = `${stat.dev}:${stat.ino}`;
      if (current !== identity || stat.size < offset) { offset = 0; identity = current; }
      const end = stat.size;
      while (offset < end && !options.signal.aborted) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, end - offset));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        yield buffer.subarray(0, bytesRead);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !options.follow) throw error;
    } finally { await file?.close(); }
    if (!options.follow) return;
    try { await setTimeout(options.pollMs ?? 200, undefined, { signal: options.signal }); }
    catch (error) { if (!options.signal.aborted) throw error; }
  }
}
