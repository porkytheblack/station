import { test } from "node:test";
import assert from "node:assert/strict";
import {
  materializeDynamic,
  validateDynamicSpec,
  type DynamicBroadcastSpec,
  type DynamicValidationContext,
} from "../src/dynamic.js";
import type { AnySignal } from "station-signal";

/**
 * Minimal stub — materializeDynamic only needs `name`, `timeout`, `maxAttempts`
 * to build a node, plus the shape Signal exposes. The handler is never called
 * by these tests.
 */
function makeSignal(name: string): AnySignal {
  return {
    name,
    timeout: 30_000,
    maxAttempts: 1,
    inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) },
    trigger: async () => "stub-run-id",
  } as unknown as AnySignal;
}

const noopRegistry = (...names: string[]): Map<string, AnySignal> => {
  const m = new Map<string, AnySignal>();
  for (const n of names) m.set(n, makeSignal(n));
  return m;
};

const validationCtx = (...names: string[]): DynamicValidationContext => ({
  signalSchemas: new Map(
    names.map((n) => [n, { inputSchema: { type: "any" }, outputSchema: { type: "any" } }] as const),
  ),
});

const baseSpec = (over: Partial<DynamicBroadcastSpec> = {}): DynamicBroadcastSpec => ({
  name: "b",
  version: 1,
  failurePolicy: "fail-fast",
  nodes: [
    { name: "first", signalName: "send", dependsOn: [] },
  ],
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

test("materializeDynamic builds a BroadcastDefinition with one node", () => {
  const { definition } = materializeDynamic(baseSpec(), noopRegistry("send"));
  assert.equal(definition.name, "b");
  assert.equal(definition.nodes.length, 1);
  assert.equal(definition.nodes[0].signalName, "send");
});

test("materializeDynamic throws when a referenced signal is missing", () => {
  assert.throws(() => materializeDynamic(baseSpec(), noopRegistry()), /unregistered signal/i);
});

test("materializeDynamic throws on a cycle", () => {
  const spec = baseSpec({
    nodes: [
      { name: "a", signalName: "send", dependsOn: ["b"] },
      { name: "b", signalName: "send", dependsOn: ["a"] },
    ],
  });
  assert.throws(() => materializeDynamic(spec, noopRegistry("send")));
});

test("materializeDynamic rejects malformed expression AST in input", () => {
  const spec = baseSpec({
    nodes: [
      {
        name: "first",
        signalName: "send",
        dependsOn: [],
        input: { kind: "bogus" } as unknown,
      },
    ],
  });
  assert.throws(() => materializeDynamic(spec, noopRegistry("send")), /unknown kind/i);
});

test("validateDynamicSpec detects duplicate node names", () => {
  const spec = baseSpec({
    nodes: [
      { name: "x", signalName: "send", dependsOn: [] },
      { name: "x", signalName: "send", dependsOn: [] },
    ],
  });
  const result = validateDynamicSpec(spec, validationCtx("send"));
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /Duplicate node name/);
});

test("validateDynamicSpec detects unknown signal references", () => {
  const spec = baseSpec({
    nodes: [{ name: "x", signalName: "ghost", dependsOn: [] }],
  });
  const result = validateDynamicSpec(spec, validationCtx());
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /not registered/.test(e.message)));
});

test("validateDynamicSpec detects unknown dependsOn references", () => {
  const spec = baseSpec({
    nodes: [{ name: "x", signalName: "send", dependsOn: ["ghost"] }],
  });
  const result = validateDynamicSpec(spec, validationCtx("send"));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /unknown node "ghost"/.test(e.message)));
});

test("validateDynamicSpec detects cycles", () => {
  const spec = baseSpec({
    nodes: [
      { name: "a", signalName: "send", dependsOn: ["b"] },
      { name: "b", signalName: "send", dependsOn: ["a"] },
    ],
  });
  const result = validateDynamicSpec(spec, validationCtx("send"));
  assert.equal(result.ok, false);
});

test("validateDynamicSpec validates expression structure on input/when", () => {
  const spec = baseSpec({
    nodes: [
      {
        name: "x",
        signalName: "send",
        dependsOn: [],
        when: { kind: "ref", path: ["upstream", "ghostNode"] } as unknown,
      },
    ],
  });
  const result = validateDynamicSpec(spec, validationCtx("send"));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /unknown upstream node/.test(e.message)));
});

test("validateDynamicSpec passes a clean spec", () => {
  const spec = baseSpec();
  const result = validateDynamicSpec(spec, validationCtx("send"));
  assert.equal(result.ok, true);
});
