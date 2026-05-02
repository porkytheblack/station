import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, ExpressionEvalError, type ExprNode } from "../src/index.js";

const EMPTY_CTX = { input: {}, upstream: {} };

test("lit returns the value verbatim", () => {
  assert.equal(evaluate({ kind: "lit", value: 42 }, EMPTY_CTX), 42);
  assert.equal(evaluate({ kind: "lit", value: "hi" }, EMPTY_CTX), "hi");
  assert.equal(evaluate({ kind: "lit", value: null }, EMPTY_CTX), null);
});

test("ref resolves dot paths against input", () => {
  const node: ExprNode = { kind: "ref", path: ["input", "user", "name"] };
  assert.equal(evaluate(node, { input: { user: { name: "alice" } }, upstream: {} }), "alice");
});

test("ref returns undefined for missing paths (does not throw)", () => {
  const node: ExprNode = { kind: "ref", path: ["input", "missing", "deep"] };
  assert.equal(evaluate(node, EMPTY_CTX), undefined);
});

test("ref with `upstream` root resolves upstream node outputs", () => {
  const node: ExprNode = { kind: "ref", path: ["upstream", "fetch", "data"] };
  assert.equal(
    evaluate(node, { input: {}, upstream: { fetch: { data: 7 } } }),
    7,
  );
});

test("ref with bare node name is shorthand for upstream.<name>", () => {
  const node: ExprNode = { kind: "ref", path: ["fetch", "data"] };
  assert.equal(
    evaluate(node, { input: {}, upstream: { fetch: { data: 7 } } }),
    7,
  );
});

test("obj evaluates each entry", () => {
  const node: ExprNode = {
    kind: "obj",
    entries: {
      to: { kind: "ref", path: ["input", "email"] },
      subject: { kind: "lit", value: "Hi" },
    },
  };
  assert.deepEqual(
    evaluate(node, { input: { email: "a@b" }, upstream: {} }),
    { to: "a@b", subject: "Hi" },
  );
});

test("arr evaluates each item", () => {
  const node: ExprNode = {
    kind: "arr",
    items: [
      { kind: "lit", value: 1 },
      { kind: "ref", path: ["input", "x"] },
    ],
  };
  assert.deepEqual(evaluate(node, { input: { x: 2 }, upstream: {} }), [1, 2]);
});

test("tmpl interpolates", () => {
  const node: ExprNode = {
    kind: "tmpl",
    parts: ["Hello ", { kind: "ref", path: ["input", "name"] }, "!"],
  };
  assert.equal(evaluate(node, { input: { name: "Bob" }, upstream: {} }), "Hello Bob!");
});

test("tmpl renders undefined refs as empty string", () => {
  const node: ExprNode = {
    kind: "tmpl",
    parts: ["pre-", { kind: "ref", path: ["input", "missing"] }],
  };
  assert.equal(evaluate(node, EMPTY_CTX), "pre-");
});

test("comparison ops use strict equality", () => {
  const eq = (a: unknown, b: unknown): unknown =>
    evaluate(
      { kind: "op", op: "==", args: [{ kind: "lit", value: a }, { kind: "lit", value: b }] },
      EMPTY_CTX,
    );
  assert.equal(eq(1, 1), true);
  assert.equal(eq(1, "1"), false);
  assert.equal(eq(null, undefined), false);
});

test("&& short-circuits on falsy and returns it", () => {
  const node: ExprNode = {
    kind: "op",
    op: "&&",
    args: [
      { kind: "lit", value: 0 },
      { kind: "lit", value: "should not be evaluated" },
    ],
  };
  assert.equal(evaluate(node, EMPTY_CTX), 0);
});

test("&& with all truthy returns the last value (no double-eval)", () => {
  const node: ExprNode = {
    kind: "op",
    op: "&&",
    args: [
      { kind: "lit", value: 1 },
      { kind: "lit", value: "final" },
    ],
  };
  assert.equal(evaluate(node, EMPTY_CTX), "final");
});

test("|| returns first truthy value", () => {
  const node: ExprNode = {
    kind: "op",
    op: "||",
    args: [
      { kind: "lit", value: false },
      { kind: "lit", value: 42 },
      { kind: "lit", value: "fallback" },
    ],
  };
  assert.equal(evaluate(node, EMPTY_CTX), 42);
});

test("+ string-coerces when either operand is a string", () => {
  assert.equal(
    evaluate(
      {
        kind: "op",
        op: "+",
        args: [{ kind: "lit", value: "x=" }, { kind: "lit", value: 5 }],
      },
      EMPTY_CTX,
    ),
    "x=5",
  );
});

test("arithmetic over numbers", () => {
  assert.equal(
    evaluate(
      {
        kind: "op",
        op: "*",
        args: [{ kind: "lit", value: 6 }, { kind: "lit", value: 7 }],
      },
      EMPTY_CTX,
    ),
    42,
  );
});

test("! negates", () => {
  assert.equal(evaluate({ kind: "op", op: "!", args: [{ kind: "lit", value: 0 }] }, EMPTY_CTX), true);
  assert.equal(evaluate({ kind: "op", op: "!", args: [{ kind: "lit", value: 1 }] }, EMPTY_CTX), false);
});

test("evaluate throws on unknown kind (not silent undefined)", () => {
  const bogus = { kind: "bogus", value: 1 } as unknown as ExprNode;
  assert.throws(() => evaluate(bogus, EMPTY_CTX), ExpressionEvalError);
});

test("evaluate is bounded by MAX_NODES", () => {
  // Flat-wide array of literals — each item costs one node. 12k items
  // exceed the 10k budget without blowing the call stack.
  const items: ExprNode[] = [];
  for (let i = 0; i < 12_000; i++) {
    items.push({ kind: "lit", value: i });
  }
  const node: ExprNode = { kind: "arr", items };
  assert.throws(() => evaluate(node, EMPTY_CTX), ExpressionEvalError);
});
