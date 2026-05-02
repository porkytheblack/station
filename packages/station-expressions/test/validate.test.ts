import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, type ExprNode, type SchemaField } from "../src/index.js";

const ANY: SchemaField = { type: "any" };

test("ref into known schema validates fields", () => {
  const result = validate(
    { kind: "ref", path: ["input", "amount"] },
    {
      inputSchema: {
        type: "object",
        properties: { amount: { type: "number" } },
      },
      upstreamSchemas: {},
      expectedSchema: { type: "number" },
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("ref into known schema flags missing properties", () => {
  const result = validate(
    { kind: "ref", path: ["input", "missing"] },
    {
      inputSchema: {
        type: "object",
        properties: { present: { type: "string" } },
      },
      upstreamSchemas: {},
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /Property "missing" not found/);
});

test("ref to unknown upstream node is flagged", () => {
  const result = validate(
    { kind: "ref", path: ["upstream", "unknownNode", "x"] },
    {
      inputSchema: ANY,
      upstreamSchemas: { realNode: { type: "object" } },
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /unknown upstream node/);
});

test("ref shorthand to unknown root is flagged", () => {
  const result = validate(
    { kind: "ref", path: ["bogus", "x"] },
    {
      inputSchema: ANY,
      upstreamSchemas: { realNode: { type: "object" } },
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /not "input" or a known upstream node/);
});

test("expected: any short-circuits OK", () => {
  const result = validate(
    { kind: "lit", value: { whatever: 1 } },
    {
      inputSchema: ANY,
      upstreamSchemas: {},
      expectedSchema: ANY,
    },
  );
  assert.equal(result.ok, true);
});

test("type mismatch is flagged", () => {
  const result = validate(
    { kind: "lit", value: "string" },
    {
      inputSchema: ANY,
      upstreamSchemas: {},
      expectedSchema: { type: "number" },
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /expected "number", got "string"/);
});

test("walking through `any` returns `unknown`, not silent any-passes", () => {
  // Broadcast input schema is `any` (caller didn't declare one). A ref through
  // it should NOT silently match a strictly-typed expected slot.
  const result = validate(
    { kind: "ref", path: ["input", "anything"] },
    {
      inputSchema: ANY,
      upstreamSchemas: {},
      expectedSchema: { type: "number" },
    },
  );
  assert.equal(result.ok, false);
  assert.match(
    result.errors[0].message,
    /unknown \/ unconstrained schema/,
  );
});

test("object expected schema requires all properties", () => {
  const result = validate(
    {
      kind: "obj",
      entries: { a: { kind: "lit", value: 1 } },
    },
    {
      inputSchema: ANY,
      upstreamSchemas: {},
      expectedSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "string" } },
      },
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /Missing required property "b"/);
});

test("union expected: passes when any branch matches", () => {
  const result = validate(
    { kind: "lit", value: 42 },
    {
      inputSchema: ANY,
      upstreamSchemas: {},
      expectedSchema: {
        type: "union",
        options: [{ type: "string" }, { type: "number" }],
      },
    },
  );
  assert.equal(result.ok, true);
});

test("union expected: fails when no branch matches", () => {
  const result = validate(
    { kind: "lit", value: true },
    {
      inputSchema: ANY,
      upstreamSchemas: {},
      expectedSchema: {
        type: "union",
        options: [{ type: "string" }, { type: "number" }],
      },
    },
  );
  assert.equal(result.ok, false);
});

test("comparison op infers boolean", () => {
  const result = validate(
    {
      kind: "op",
      op: "==",
      args: [{ kind: "lit", value: 1 }, { kind: "lit", value: 1 }],
    },
    {
      inputSchema: ANY,
      upstreamSchemas: {},
      expectedSchema: { type: "boolean" },
    },
  );
  assert.equal(result.ok, true);
});

test("collects multiple errors, doesn't stop at first", () => {
  const result = validate(
    {
      kind: "obj",
      entries: {
        a: { kind: "ref", path: ["input", "missingA"] },
        b: { kind: "ref", path: ["input", "missingB"] },
      },
    },
    {
      inputSchema: { type: "object", properties: {} },
      upstreamSchemas: {},
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 2);
});
