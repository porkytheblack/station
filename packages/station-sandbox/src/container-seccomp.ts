import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

interface EngineInfo { SecurityOptions?: unknown; host?: { security?: { seccompEnabled?: boolean; seccompProfilePath?: string } } }
export interface ContainerSeccompPolicy { path?: string; fingerprint: string }
/** Operator input only; never read profile paths from a tenant or executable manifest. */
export function prepareContainerSeccomp(root: string, profilePath: string | undefined, info: EngineInfo, engine: "docker" | "podman"): ContainerSeccompPolicy {
  const options = Array.isArray(info.SecurityOptions) ? info.SecurityOptions.filter((value): value is string => typeof value === "string") : [];
  const supported = engine === "podman" ? info.host?.security?.seccompEnabled === true : options.some(option => option.includes("name=seccomp"));
  const builtin = engine === "podman" ? supported && Boolean(info.host?.security?.seccompProfilePath && info.host.security.seccompProfilePath !== "unconfined") : options.some(option => option.includes("name=seccomp") && option.includes("profile=builtin"));
  if (!supported) throw new Error("Container engine must report seccomp support");
  if (!profilePath) {
    if (!builtin) throw new Error("Container engine default is unconfined or unverifiable; configure an explicit seccompProfile");
    return { fingerprint: "builtin" };
  }
  if (!isAbsolute(profilePath) || /[\r\n\0]/.test(profilePath)) throw new Error("Seccomp profile must be an absolute operator file path");
  const stat = lstatSync(profilePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || (stat.mode & 0o022) !== 0) throw new Error("Seccomp profile must be a bounded regular file without group/world write access");
  const bytes = readFileSync(profilePath);
  const profile = JSON.parse(bytes.toString("utf8"));
  if (!profile || !["SCMP_ACT_ERRNO", "SCMP_ACT_KILL", "SCMP_ACT_KILL_PROCESS", "SCMP_ACT_TRAP"].includes(profile.defaultAction) || !Array.isArray(profile.syscalls) || profile.syscalls.some((rule: { names?: unknown }) => !rule || !Array.isArray(rule.names) || rule.names.some(name => typeof name !== "string" || !/^[a-zA-Z0-9_]+$/.test(name)))) throw new Error("Seccomp profile must deny by default and use explicit syscall names");
  const fingerprint = createHash("sha256").update(bytes).digest("hex");
  const path = join(root, `seccomp-${fingerprint}.json`);
  try { writeFileSync(path, bytes, { mode: 0o600, flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = lstatSync(path);
    if (!existing.isFile() || existing.isSymbolicLink() || !readFileSync(path).equals(bytes)) throw new Error("Stored seccomp policy integrity mismatch");
  }
  return { path, fingerprint };
}
