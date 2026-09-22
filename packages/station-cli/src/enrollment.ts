import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { StationClient, validateEndpoint } from "station-client";

const identity = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
interface Invitation { format: "station.enrollment/v1"; url: string; token: string; stationId: string; networkId: string; expiresAt: string }
interface WorkerConfig { role: "station"; network: { id: string; stationId: string; enrollment: { url: string; credential: string } } }
function parse(text: string): any {
  try { const value: unknown = JSON.parse(text); if (value && typeof value === "object" && !Array.isArray(value)) return value; } catch {}
  throw new Error("Enrollment input must contain a JSON object.");
}
/** Secret-bearing inputs must be bounded regular files, never links or group/world readable. */
export async function readEnrollmentFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64 * 1024 || (process.platform !== "win32" && (stat.mode & 0o077))) throw new Error("Enrollment credentials require a regular file with mode 0600, at most 64 KiB.");
    const bytes = Buffer.alloc(64 * 1024 + 1); const result = await file.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead > 64 * 1024) throw new Error("Enrollment input exceeds 64 KiB.");
    return bytes.subarray(0, result.bytesRead).toString("utf8");
  } finally { await file.close(); }
}
/** Reserve a new private file before consuming any one-time credential. */
async function saveResult<T>(path: string, operation: () => Promise<{ secret: unknown; summary: T }>): Promise<T & { path: string }> {
  path = resolve(path);
  const file = await open(path, "wx", 0o600); let saved = false;
  try {
    const result = await operation();
    await file.writeFile(JSON.stringify(result.secret, null, 2) + "\n"); await file.sync(); saved = true;
    return { ...result.summary, path };
  } finally { await file.close(); if (!saved) await rm(path, { force: true }); }
}
export async function inviteWorker(client: StationClient, stationId: string, out: string, ttlMs?: number) {
  if (client.connection.tenant) throw new Error("Network invitations require an operator context.");
  if (!identity(stationId) || (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 900_000))) throw new Error("Invalid station identity or invitation TTL (1000–900000 ms).");
  return saveResult(out, async () => {
    const data = await client.request<Omit<Invitation, "format" | "url">>("POST", "/network/enrollments", { stationId, ...(ttlMs === undefined ? {} : { ttlMs }) });
    if (data.stationId !== stationId || !identity(data.networkId) || !/^sti_[a-zA-Z0-9_-]{43}$/.test(data.token) || typeof data.expiresAt !== "string" || !Number.isFinite(Date.parse(data.expiresAt))) throw new Error("Invalid enrollment invitation response.");
    return { secret: { format: "station.enrollment/v1", url: client.url, token: data.token, stationId, networkId: data.networkId, expiresAt: data.expiresAt }, summary: { stationId, networkId: data.networkId, expiresAt: data.expiresAt } };
  });
}
export async function joinWorker(text: string, out: string) {
  const invitation = parse(text) as Invitation;
  if (invitation.format !== "station.enrollment/v1" || !identity(invitation.stationId) || !identity(invitation.networkId) || !/^sti_[a-zA-Z0-9_-]{43}$/.test(invitation.token) || typeof invitation.expiresAt !== "string" || !Number.isFinite(Date.parse(invitation.expiresAt)) || Date.parse(invitation.expiresAt) <= Date.now()) throw new Error("Invalid or expired Station enrollment invitation.");
  const url = validateEndpoint(invitation.url), client = new StationClient({ url });
  return saveResult(out, async () => {
    const data = await client.request<{ credential: string; stationId: string; networkId: string; generation: string }>("POST", "/network/join", { token: invitation.token, stationId: invitation.stationId, networkId: invitation.networkId });
    if (data.stationId !== invitation.stationId || data.networkId !== invitation.networkId || typeof data.generation !== "string" || !/^stw_[a-zA-Z0-9_-]{43}$/.test(data.credential)) throw new Error("Enrollment response does not match the invited worker and network. Ask the operator to revoke and issue a new invitation.");
    const secret: WorkerConfig = { role: "station", network: { id: data.networkId, stationId: data.stationId, enrollment: { url, credential: data.credential } } };
    return { secret, summary: { stationId: data.stationId, networkId: data.networkId, generation: data.generation, note: "Merge this private JSON into your worker configuration; provision shared durable adapters separately." } };
  });
}
export async function leaveWorker(text: string) {
  const config = parse(text) as WorkerConfig, network = config.network;
  if (config.role !== "station" || !network || !identity(network.id) || !identity(network.stationId) || !network.enrollment || !/^stw_[a-zA-Z0-9_-]{43}$/.test(network.enrollment.credential)) throw new Error("Invalid worker enrollment configuration.");
  const client = new StationClient({ url: network.enrollment.url, token: network.enrollment.credential });
  await client.request("POST", "/network/leave", { stationId: network.stationId, networkId: network.id });
  return { stationId: network.stationId, networkId: network.id, left: true };
}
