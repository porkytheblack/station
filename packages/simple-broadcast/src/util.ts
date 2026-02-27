import type { BroadcastDefinition, BroadcastNode } from "./broadcast.js";
import { BroadcastCycleError } from "./errors.js";

export const BROADCAST_BRAND = Symbol.for("simple-broadcast");

export function isBroadcast(value: unknown): value is BroadcastDefinition {
  if (typeof value !== "object" || value === null) return false;
  return (value as Record<symbol, unknown>)[BROADCAST_BRAND] === true;
}

/**
 * Topological sort with cycle detection.
 * Returns nodes in dependency order (roots first).
 * Throws BroadcastCycleError if a cycle is found.
 */
export function topologicalSort(
  broadcastName: string,
  nodes: readonly BroadcastNode[],
): BroadcastNode[] {
  const nodeMap = new Map(nodes.map((n) => [n.name, n]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const sorted: BroadcastNode[] = [];

  function visit(name: string, path: string[]): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      const cycleStart = path.indexOf(name);
      const cycle = [...path.slice(cycleStart), name];
      throw new BroadcastCycleError(broadcastName, cycle);
    }

    visiting.add(name);
    const node = nodeMap.get(name);
    if (!node) return; // Guard: skip unknown nodes (validated elsewhere)
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
