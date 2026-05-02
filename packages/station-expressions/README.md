# station-expressions

Pure, deterministic expression AST + evaluator + validator + parser used by Station's dynamic broadcast `input` mappings and `when` guards.

This package is a leaf — it has no dependencies on the rest of Station, so it's safe to use anywhere a small, side-effect-free expression language is needed.

## Why a separate language?

Dynamic broadcasts need user-supplied logic that can be persisted, validated server-side, round-tripped through JSON, and run inside Station's reconcile loop without giving users a JS sandbox. The expression language has:

- **No I/O, no time, no randomness** — pure functions of input.
- **No loops, no recursion, no user-defined functions** — bounded complexity, no DoS surface.
- **JSON-serializable AST** — the persisted form is the AST. A string syntax exists for the UI / playground, compiled to AST.
- **Static type checking** — validate expressions against signal `inputSchema` / `outputSchema` before save.

If you can't express something in this language, write a code-defined signal that does the logic in TypeScript and reference it from your broadcast graph. The signal is the unit of arbitrary code; expressions just connect them.

## Install

```bash
pnpm add station-expressions
```

## API

```ts
import {
  evaluate,
  validate,
  parse,
  stringify,
  type ExprNode,
  type SchemaField,
} from "station-expressions";
```

### Evaluate an AST against a context

```ts
const node: ExprNode = {
  kind: "op",
  op: ">",
  args: [
    { kind: "ref", path: ["input", "amount"] },
    { kind: "lit", value: 100 },
  ],
};

evaluate(node, { input: { amount: 250 }, upstream: {} });
// → true
```

### Validate against schemas

```ts
validate(node, {
  inputSchema: {
    type: "object",
    properties: { amount: { type: "number" } },
  },
  upstreamSchemas: {},
  expectedSchema: { type: "boolean" },
});
// → { ok: true, errors: [] }
```

### Parse string syntax

```ts
parse(`input.amount > 100 && input.user.tier == "premium"`);
// → { kind: "op", op: "&&", args: [...] }
```

### Stringify back

```ts
stringify(node);
// → '(input.amount > 100)'
```

## ExprNode shape

```ts
type ExprNode =
  | { kind: "ref"; path: string[] }
  | { kind: "lit"; value: unknown }
  | { kind: "tmpl"; parts: (string | ExprNode)[] }
  | { kind: "op"; op: BinaryOp | UnaryOp; args: ExprNode[] }
  | { kind: "obj"; entries: Record<string, ExprNode> }
  | { kind: "arr"; items: ExprNode[] };
```

### Reference paths

| Path                         | Resolves to                                  |
|------------------------------|----------------------------------------------|
| `input.foo`                  | The broadcast's trigger input, field `foo`   |
| `upstream.nodeName.field`    | An upstream node's output                    |
| `nodeName.field`             | Shorthand for `upstream.nodeName.field`      |

Missing paths return `undefined` rather than throwing. Use `validate` to catch missing-property errors at save time.

### Operators

`==`, `!=`, `>`, `<`, `>=`, `<=`, `&&`, `||`, `!`, `+`, `-`, `*`, `/`.

`+` is overloaded: if either operand is a string, the result is a string concatenation; otherwise numeric addition. Comparison operators use strict equality (`===`).

## Determinism guarantees

- `evaluate` is total over well-typed inputs that pass `validate` — it never throws on type mismatches at runtime if the validator passed against the real schemas.
- Bounded by `MAX_NODES = 10_000` — runaway expressions throw `ExpressionEvalError` rather than spinning.
- No closures, no captured state, no global access.

## License

MIT
