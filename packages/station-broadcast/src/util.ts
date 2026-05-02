import type { BroadcastDefinition } from "./broadcast.js";
import { BroadcastCycleError } from "./errors.js";

export const BROADCAST_BRAND = Symbol.for("station-broadcast");

export function isBroadcast(value: unknown): value is BroadcastDefinition {
  if (typeof value !== "object" || value === null) return false;
  return (value as Record<symbol, unknown>)[BROADCAST_BRAND] === true;
}

/** Minimal shape the topological sort needs. */
export interface DagNode {
  readonly name: string;
  readonly dependsOn: readonly string[];
}

/**
 * Topological sort with cycle detection.
 * Returns nodes in dependency order (roots first).
 * Throws BroadcastCycleError if a cycle is found.
 */
export function topologicalSort<T extends DagNode>(
  broadcastName: string,
  nodes: readonly T[],
): T[] {
  const nodeMap = new Map(nodes.map((n) => [n.name, n]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const sorted: T[] = [];

  function visit(name: string, path: string[]): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      const cycleStart = path.indexOf(name);
      const cycle = [...path.slice(cycleStart), name];
      throw new BroadcastCycleError(broadcastName, cycle);
    }

    visiting.add(name);
    const node = nodeMap.get(name);
    if (!node) {
      // Unknown dependency — caller should have flagged this elsewhere; either way
      // we must clean up `visiting` so a sibling path that references the same
      // unknown name doesn't trip a false cycle error.
      visiting.delete(name);
      visited.add(name);
      return;
    }
    for (const dep of node.dependsOn) {
      visit(dep, [...path, name]);
    }
    visiting.delete(name);
    visited.add(name);
    sorted.push(node);
  }

  for (const node of nodes) {
    visit(node.name, []);
  }

  return sorted;
}
