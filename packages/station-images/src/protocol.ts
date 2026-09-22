import { EXPORT_PATTERN } from "./manifest.js";
import { assertJson, isRecord, validateValue } from "./schema.js";
import { fail, PROCESS_PROTOCOL, type ImageManifest } from "./types.js";
export interface BroadcastPlanNode { name: string; signalName: string; dependsOn: string[]; input?: unknown; when?: unknown }
export interface BroadcastPlan { nodes: BroadcastPlanNode[]; failurePolicy?: "fail-fast" | "skip-downstream" | "continue"; timeout?: number }
function knownKeys(value: Record<string, unknown>, allowed: string[]): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) fail("invalid_protocol", `Unexpected protocol field: ${key}`); }
/** Structural expression validation; schema/ref validation still runs in BroadcastRunner before dispatch. */
function expression(value: unknown, dependencies: Set<string>, depth = 0): void {
  if (!isRecord(value) || depth > 16) fail("invalid_plan", "Malformed or deeply nested expression");
  switch (value.kind) {
    case "ref":
      knownKeys(value, ["kind", "path"]);
      if (!Array.isArray(value.path) || value.path.length < 1 || value.path.some(p => typeof p !== "string" || ["__proto__", "prototype", "constructor"].includes(p)) || value.path[0] !== "input" && (value.path[0] !== "upstream" || !dependencies.has(value.path[1]))) fail("invalid_plan", "Expression reference is outside its input/dependency scope");
      break;
    case "lit": knownKeys(value, ["kind", "value"]); assertJson(value.value); break;
    case "arr": knownKeys(value, ["kind", "items"]); if (!Array.isArray(value.items)) fail("invalid_plan", "Expression items required"); value.items.forEach(v => expression(v, dependencies, depth + 1)); break;
    case "obj": knownKeys(value, ["kind", "entries"]); if (!isRecord(value.entries)) fail("invalid_plan", "Expression entries required"); for (const [key, v] of Object.entries(value.entries)) { if (["__proto__", "constructor", "prototype"].includes(key)) fail("invalid_plan", "Unsafe expression property"); expression(v, dependencies, depth + 1); } break;
    case "tmpl": knownKeys(value, ["kind", "parts"]); if (!Array.isArray(value.parts)) fail("invalid_plan", "Expression parts required"); value.parts.forEach(v => { if (typeof v !== "string") expression(v, dependencies, depth + 1); }); break;
    case "op": knownKeys(value, ["kind", "op", "args"]); if (!["!", "==", "!=", ">", "<", ">=", "<=", "&&", "||", "+", "-", "*", "/"].includes(String(value.op)) || !Array.isArray(value.args) || value.args.length !== (value.op === "!" ? 1 : 2)) fail("invalid_plan", "Invalid expression operator"); value.args.forEach(v => expression(v, dependencies, depth + 1)); break;
    default: fail("invalid_plan", "Unknown expression kind");
  }
}
export function validateBroadcastPlan(value: unknown, manifest: ImageManifest): asserts value is BroadcastPlan {
  assertJson(value);
  if (!isRecord(value) || Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) fail("invalid_plan", "Plan exceeds bounds");
  knownKeys(value, ["nodes", "failurePolicy", "timeout"]);
  if (!Array.isArray(value.nodes) || value.nodes.length < 1 || value.nodes.length > 256) fail("invalid_plan", "Plan requires 1–256 nodes");
  if (value.failurePolicy !== undefined && !["fail-fast", "skip-downstream", "continue"].includes(String(value.failurePolicy))) fail("invalid_plan", "Invalid failure policy");
  if (value.timeout !== undefined && (!Number.isSafeInteger(value.timeout) || (value.timeout as number) < 1 || (value.timeout as number) > 86400000)) fail("invalid_plan", "Invalid plan timeout");
  const signals = new Set(manifest.exports.filter(e => e.kind === "signal").map(e => e.name));
  for (const [alias, dep] of Object.entries(manifest.dependencies ?? {})) if (dep.kind === "signal") signals.add(alias);
  for (const alias of Object.keys(manifest.nativeSignals ?? {})) signals.add(alias);
  const nodes = new Map<string, BroadcastPlanNode>();
  for (const node of value.nodes) {
    if (!isRecord(node)) fail("invalid_plan", "Invalid node");
    knownKeys(node, ["name", "signalName", "dependsOn", "input", "when"]);
    if (typeof node.name !== "string" || !EXPORT_PATTERN.test(node.name) || nodes.has(node.name)) fail("invalid_plan", "Invalid or duplicate node name");
    if (typeof node.signalName !== "string" || !signals.has(node.signalName)) fail("invalid_plan", "Node signal is not an image export or declared signal dependency");
    if (!Array.isArray(node.dependsOn) || node.dependsOn.some(d => typeof d !== "string") || new Set(node.dependsOn).size !== node.dependsOn.length) fail("invalid_plan", "Invalid node dependencies");
    const dependencies = new Set<string>(node.dependsOn);
    if (node.input !== undefined) expression(node.input, dependencies);
    if (node.when !== undefined) expression(node.when, dependencies);
    nodes.set(node.name, node as unknown as BroadcastPlanNode);
  }
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) fail("invalid_plan", "Plan contains a cycle");
    const node = nodes.get(name); if (!node) fail("invalid_plan", "Plan references an unknown node");
    visiting.add(name); node.dependsOn.forEach(visit); visiting.delete(name); visited.add(name);
  };
  nodes.forEach(n => visit(n.name));
}
export type TerminalFrame = { protocol: typeof PROCESS_PROTOCOL; type: "result"; output: unknown } | { protocol: typeof PROCESS_PROTOCOL; type: "error"; error: { code: string; message: string } };
export function validateTerminalFrame(value: unknown): asserts value is TerminalFrame {
  if (!isRecord(value) || value.protocol !== PROCESS_PROTOCOL) fail("incompatible_protocol", "Unsupported process protocol");
  if (value.type === "result") { knownKeys(value, ["protocol", "type", "output"]); assertJson(value.output); }
  else if (value.type === "error") {
    knownKeys(value, ["protocol", "type", "error"]);
    if (!isRecord(value.error)) fail("invalid_protocol", "Malformed process error");
    knownKeys(value.error, ["code", "message"]);
    if (typeof value.error.code !== "string" || !EXPORT_PATTERN.test(value.error.code) || typeof value.error.message !== "string" || value.error.message.length > 4096) fail("invalid_protocol", "Malformed process error");
  } else fail("invalid_protocol", "Expected exactly one terminal result or error");
}
/** A fence for one beacon incarnation; durable scheduling/trigger admission belongs to its supervisor. */
export class BeaconProtocolState {
  private started = false;
  private ready = false;
  private stopped = false;
  private stopping = false;
  private pollId?: string;
  constructor(readonly manifest: ImageManifest, readonly exportName: string) {
    if (!manifest.exports.some(e => e.name === exportName && e.kind === "beacon")) fail("unknown_export", "Beacon export not found");
  }
  beginPoll(id: string): void {
    const exp = this.manifest.exports.find(e => e.name === this.exportName)!;
    if (!this.ready || this.stopping || this.stopped || this.pollId || exp.mode !== "poll" || !EXPORT_PATTERN.test(id)) fail("invalid_beacon_state", "Beacon cannot begin this poll");
    this.pollId = id;
  }
  beginStop(): void { if (this.stopped || this.stopping) fail("invalid_beacon_state", "Beacon already stopping/stopped"); this.stopping = true; }
  accept(value: unknown): Record<string, unknown> {
    assertJson(value);
    if (!isRecord(value) || value.protocol !== PROCESS_PROTOCOL || this.stopped || Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) fail("invalid_protocol", "Invalid beacon frame or stopped incarnation");
    if (value.type === "beacon:started") { knownKeys(value, ["protocol", "type"]); if (this.started) fail("invalid_beacon_state", "Duplicate start"); this.started = true; }
    else if (value.type === "beacon:ready") { knownKeys(value, ["protocol", "type"]); if (!this.started || this.ready || this.stopping) fail("invalid_beacon_state", "Unexpected readiness"); this.ready = true; }
    else if (value.type === "beacon:heartbeat") { knownKeys(value, ["protocol", "type"]); if (!this.started) fail("invalid_beacon_state", "Heartbeat before start"); }
    else if (value.type === "beacon:stopped") { knownKeys(value, ["protocol", "type"]); if (!this.stopping) fail("invalid_beacon_state", "Unrequested stop"); this.stopped = true; }
    else if (value.type === "beacon:poll-completed" || value.type === "beacon:poll-failed") {
      knownKeys(value, ["protocol", "type", "invocationId", "error"]);
      if (!this.pollId || value.invocationId !== this.pollId) fail("invalid_beacon_state", "Mismatched poll completion");
      if (value.type === "beacon:poll-failed" && (typeof value.error !== "string" || value.error.length > 4096)) fail("invalid_protocol", "Invalid poll error");
      this.pollId = undefined;
    } else if (value.type === "trigger") {
      knownKeys(value, ["protocol", "type", "id", "dependency", "input"]);
      if (!this.ready || this.stopping || typeof value.id !== "string" || !EXPORT_PATTERN.test(value.id) || typeof value.dependency !== "string" || !Object.hasOwn(this.manifest.dependencies ?? {}, value.dependency) || !Object.hasOwn(value, "input")) fail("dependency_denied", "Beacon trigger is not permitted");
    } else fail("invalid_protocol", "Unsupported beacon event");
    return value;
  }
  validateConfig(config: unknown): void { validateValue(this.manifest.exports.find(e => e.name === this.exportName)!.configSchema, config); }
}
