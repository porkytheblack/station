import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, stringify, ExpressionParseError } from "../src/index.js";

test("parses dot-paths into ref nodes", () => {
  assert.deepEqual(parse("input.user.name"), {
    kind: "ref",
    path: ["input", "user", "name"],
  });
});

test("parses string and numeric literals", () => {
  assert.deepEqual(parse(`"hello"`), { kind: "lit", value: "hello" });
  assert.deepEqual(parse("42"), { kind: "lit", value: 42 });
  assert.deepEqual(parse("3.14"), { kind: "lit", value: 3.14 });
});

test("parses booleans and null", () => {
  assert.deepEqual(parse("true"), { kind: "lit", value: true });
  assert.deepEqual(parse("false"), { kind: "lit", value: false });
  assert.deepEqual(parse("null"), { kind: "lit", value: null });
});

test("parses comparison ops with proper precedence", () => {
  assert.deepEqual(parse("1 + 2 == 3"), {
    kind: "op",
    op: "==",
    args: [
      {
        kind: "op",
        op: "+",
        args: [{ kind: "lit", value: 1 }, { kind: "lit", value: 2 }],
      },
      { kind: "lit", value: 3 },
    ],
  });
});

test("parses && / || with correct precedence", () => {
  // `a && b || c` should parse as `(a && b) || c`
  const ast = parse("a && b || c");
  assert.equal((ast as { kind: string }).kind, "op");
  assert.equal((ast as { op: string }).op, "||");
});

test("parses unary !", () => {
  assert.deepEqual(parse("!true"), {
    kind: "op",
    op: "!",
    args: [{ kind: "lit", value: true }],
  });
});

test("parses unary - as 0 - x", () => {
  const ast = parse("-5");
  assert.equal((ast as { kind: string }).kind, "op");
  assert.equal((ast as { op: string }).op, "-");
});

test("parses parenthesized expressions", () => {
  const ast = parse("(1 + 2) * 3");
  assert.equal((ast as { op: string }).op, "*");
});

test("escape sequences inside strings", () => {
  assert.equal(
    (parse(`"line1\\nline2"`) as { value: string }).value,
    "line1\nline2",
  );
});

test("rejects multiple decimal points", () => {
  assert.throws(() => parse("1.2.3"), ExpressionParseError);
});

test("rejects unterminated strings", () => {
  assert.throws(() => parse(`"oops`), ExpressionParseError);
});

test("rejects unexpected tokens", () => {
  assert.throws(() => parse("1 + + 2"), ExpressionParseError);
});

test("rejects trailing garbage", () => {
  assert.throws(() => parse("1 + 2 3"), ExpressionParseError);
});

test("stringify round-trips simple expressions", () => {
  const ast = parse("input.x > 5");
  assert.match(stringify(ast), /input\.x > 5/);
});
