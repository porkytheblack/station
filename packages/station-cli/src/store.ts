import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { validateEndpoint, type StationConnection } from "station-client";
export interface ContextState { active?: string; contexts: Record<string, StationConnection> }
export const defaultHome = () => process.env.STATION_CLI_HOME ?? join(homedir(), ".station", "cli");
export function validateName(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) throw new Error("Names must contain 1–64 letters, digits, underscores or hyphens.");
  return value;
}
export async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Station state directory must be a real directory.");
  await chmod(path, 0o700);
}
export async function writePrivate(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" }); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
export class ContextStore {
  constructor(readonly home = defaultHome()) {}
  private get path() { return join(this.home, "contexts.json"); }
  async read(): Promise<ContextState> {
    await privateDirectory(this.home);
    try {
      const stat = await lstat(this.path);
      if (stat.isSymbolicLink() || !stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077))) throw new Error("Context credentials require a regular file with mode 0600.");
      const value = JSON.parse(await readFile(this.path, "utf8"));
      if (!value || typeof value.contexts !== "object" || Array.isArray(value.contexts)) throw new Error("Invalid context file.");
      for (const [name, context] of Object.entries(value.contexts as Record<string, StationConnection>)) {
        validateName(name); validateEndpoint(context.url);
        if (context.token !== undefined && (typeof context.token !== "string" || /[\r\n]/.test(context.token))) throw new Error("Invalid saved token.");
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { contexts: {} };
      throw error;
    }
  }
  async update(change: (state: ContextState) => void) {
    await privateDirectory(this.home);
    const lock = join(this.home, "contexts.lock");
    try { await mkdir(lock, { mode: 0o700 }); }
    catch { throw new Error("Context store is locked by another operation. Retry after it finishes."); }
    try { const state = await this.read(); change(state); await writePrivate(this.path, state); }
    finally { await rm(lock, { recursive: true, force: true }); }
  }
  async add(name: string, connection: StationConnection) {
    validateName(name); connection = { ...connection, url: validateEndpoint(connection.url) };
    if (connection.token && /[\r\n]/.test(connection.token)) throw new Error("Invalid API token.");
    await this.update((state) => {
      if (Object.hasOwn(state.contexts, name)) throw new Error("Context already exists. Remove it explicitly before replacing its endpoint or credentials.");
      Object.defineProperty(state.contexts, name, { value: connection, enumerable: true, writable: true, configurable: true });
      state.active ??= name;
    });
  }
  async resolve(name?: string): Promise<{ name: string; connection: StationConnection }> {
    const state = await this.read(); const selected = name ?? state.active;
    if (!selected || !Object.hasOwn(state.contexts, selected)) throw new Error("No saved context selected. Use station context add NAME --url URL, then station context use NAME.");
    return { name: selected, connection: state.contexts[selected] };
  }
  async use(name: string) { await this.update((state) => { if (!Object.hasOwn(state.contexts, name)) throw new Error("Unknown context."); state.active = name; }); }
  async remove(name: string) { await this.update((state) => { delete state.contexts[name]; if (state.active === name) delete state.active; }); }
  async list() {
    const state = await this.read();
    return Object.entries(state.contexts).map(([name, c]) => ({ name, active: state.active === name, url: c.url, stationId: c.stationId, tenant: c.tenant ?? false, authenticated: Boolean(c.token) }));
  }
}
