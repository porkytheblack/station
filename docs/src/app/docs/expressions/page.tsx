import { Metadata } from "next";
import Link from "next/link";
import { Code } from "../../components/Code";

export const metadata: Metadata = {
  title: "Expressions API — Station",
};

export default function ExpressionsPage() {
  return (
    <>
      <div className="eyebrow">API Reference</div>
      <h2 style={{ marginTop: 0 }}>Expressions</h2>
      <p>
        Expressions are Station&apos;s small, deterministic, side-effect-free
        language for the <code>input</code> mappings and <code>when</code>{" "}
        guards in <Link href="/docs/dynamic-broadcasts">dynamic broadcasts</Link>.
        They&apos;re pure functions of the broadcast&apos;s trigger input and
        upstream node outputs — no I/O, no time, no randomness, no loops, no
        user-defined functions. The persisted form is a JSON AST; a familiar
        string syntax exists for the dashboard and playground and compiles to
        the same AST.
      </p>
      <p>
        Expressions ship in the <code>station-expressions</code> package. It
        has no dependencies on the rest of Station and is safe to use anywhere
        a small, sandboxable expression language is useful.
      </p>

      <hr className="divider" />

      {/* ── ExprNode AST ── */}

      <h3>ExprNode</h3>
      <p>
        Six kinds of node make up the AST:
      </p>
      <Code>{`type ExprNode =
  | { kind: "ref"; path: string[] }
  | { kind: "lit"; value: unknown }
  | { kind: "tmpl"; parts: (string | ExprNode)[] }
  | { kind: "op"; op: BinaryOp | UnaryOp; args: ExprNode[] }
  | { kind: "obj"; entries: Record<string, ExprNode> }
  | { kind: "arr"; items: ExprNode[] };`}</Code>
      <table className="api-table">
        <thead>
          <tr>
            <th>Kind</th>
            <th>Shape</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>ref</code></td>
            <td><code>{`{ path: string[] }`}</code></td>
            <td>
              A path lookup against the evaluation context. See{" "}
              <a href="#reference-paths">Reference paths</a>.
            </td>
          </tr>
          <tr>
            <td><code>lit</code></td>
            <td><code>{`{ value: unknown }`}</code></td>
            <td>
              A constant. Any JSON-serialisable value: number, string, boolean,
              null, array, or plain object.
            </td>
          </tr>
          <tr>
            <td><code>tmpl</code></td>
            <td><code>{`{ parts: (string | ExprNode)[] }`}</code></td>
            <td>
              Template literal. Interleaves string fragments with embedded
              expressions and concatenates them — every embedded value is
              coerced to its string form.
            </td>
          </tr>
          <tr>
            <td><code>op</code></td>
            <td><code>{`{ op: string; args: ExprNode[] }`}</code></td>
            <td>
              Operator application. Unary ops have a single arg; binary ops
              have two.
            </td>
          </tr>
          <tr>
            <td><code>obj</code></td>
            <td><code>{`{ entries: Record<string, ExprNode> }`}</code></td>
            <td>
              Object construction. Each value is an expression that evaluates
              into the corresponding key.
            </td>
          </tr>
          <tr>
            <td><code>arr</code></td>
            <td><code>{`{ items: ExprNode[] }`}</code></td>
            <td>Array construction.</td>
          </tr>
        </tbody>
      </table>

      <hr className="divider" />

      {/* ── Reference paths ── */}

      <h3 id="reference-paths">Reference paths</h3>
      <p>
        A <code>ref</code> resolves against an evaluation context with two
        roots: <code>input</code> (the broadcast&apos;s trigger input) and{" "}
        <code>upstream</code> (an object keyed by upstream node name).
      </p>
      <table className="api-table">
        <thead>
          <tr>
            <th>Path</th>
            <th>Resolves to</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>[&quot;input&quot;, &quot;orderId&quot;]</code></td>
            <td>The broadcast trigger input&apos;s <code>orderId</code> field.</td>
          </tr>
          <tr>
            <td><code>[&quot;upstream&quot;, &quot;validate&quot;, &quot;total&quot;]</code></td>
            <td>The <code>validate</code> node&apos;s output, field <code>total</code>.</td>
          </tr>
          <tr>
            <td><code>[&quot;validate&quot;, &quot;total&quot;]</code></td>
            <td>
              Shorthand — any first segment that is not <code>input</code> is
              treated as <code>upstream.&lt;name&gt;</code>.
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        Missing paths return <code>undefined</code> rather than throwing — the
        evaluator never panics on a typo at runtime. The validator catches
        missing-property errors at save time, against the signal schemas.
      </p>

      <hr className="divider" />

      {/* ── Operators ── */}

      <h3>Operators</h3>
      <table className="api-table">
        <thead>
          <tr>
            <th>Operator</th>
            <th>Arity</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr><td><code>==</code> <code>!=</code></td><td>binary</td><td>Strict equality (<code>===</code> / <code>!==</code> in JS terms).</td></tr>
          <tr><td><code>&lt;</code> <code>&gt;</code> <code>&lt;=</code> <code>&gt;=</code></td><td>binary</td><td>Numeric or string comparison.</td></tr>
          <tr><td><code>&amp;&amp;</code> <code>||</code></td><td>binary</td><td>Short-circuit boolean logic.</td></tr>
          <tr><td><code>!</code></td><td>unary</td><td>Boolean negation.</td></tr>
          <tr>
            <td><code>+</code></td>
            <td>binary</td>
            <td>
              Overloaded: if either operand is a string, the result is a string
              concatenation; otherwise numeric addition.
            </td>
          </tr>
          <tr><td><code>-</code> <code>*</code> <code>/</code></td><td>binary</td><td>Numeric.</td></tr>
        </tbody>
      </table>
      <p>
        That&apos;s the full operator set. There are no bitwise operators, no
        modulo, no ternary, no spread. If you need them, push the logic into a
        signal.
      </p>

      <hr className="divider" />

      {/* ── String syntax ── */}

      <h3>String syntax</h3>
      <p>
        The parser accepts a familiar string form and compiles to the same AST.
        It&apos;s what the dashboard&apos;s expression editor produces and what
        the <code>POST /expressions/parse</code> endpoint exposes.
      </p>
      <Code>{`import { parse, stringify } from "station-expressions";

parse('input.amount > 100 && input.user.tier == "premium"');
// → { kind: "op", op: "&&", args: [...] }

stringify(node);
// → '(input.amount > 100)'`}</Code>
      <p>
        Parsing is lossless against the AST: <code>parse(stringify(n))</code>{" "}
        produces a structurally identical node.
      </p>

      <hr className="divider" />

      {/* ── Evaluation ── */}

      <h3>Evaluation</h3>
      <Code>{`import { evaluate } from "station-expressions";

const node = {
  kind: "op", op: ">",
  args: [
    { kind: "ref", path: ["input", "amount"] },
    { kind: "lit", value: 100 },
  ],
};

evaluate(node, { input: { amount: 250 }, upstream: {} });
// → true`}</Code>
      <p>
        Evaluation is bounded by <code>MAX_NODES = 10_000</code> — a runaway
        expression throws <code>ExpressionEvalError</code> rather than spinning.
        There are no closures, no captured state, no global access.
      </p>

      <hr className="divider" />

      {/* ── Validation ── */}

      <h3>Validation</h3>
      <p>
        <code>validate</code> type-checks an expression against the schemas
        derived from a signal&apos;s Zod input/output types. It&apos;s what the
        broadcast-definition save endpoint runs before it accepts a spec.
      </p>
      <Code>{`import { validate } from "station-expressions";

validate(node, {
  inputSchema: {
    type: "object",
    properties: { amount: { type: "number" } },
  },
  upstreamSchemas: {},
  expectedSchema: { type: "boolean" },
});
// → { ok: true, errors: [] }`}</Code>

      <h4>Behaviour around unknown and any</h4>
      <p>
        Schema fields with <code>type: &quot;any&quot;</code> opt out of
        type-checking — refs into them are treated as compatible with anything,
        and operator type rules are relaxed when either side is <code>any</code>.
        This is what lets you write expressions against signals whose schemas
        haven&apos;t been narrowed (or against the broadcast trigger input
        when you haven&apos;t declared an explicit schema).
      </p>
      <p>
        Schema fields with <code>type: &quot;unknown&quot;</code>, by contrast,
        propagate as errors when used in operator positions that require a
        concrete type. Use <code>any</code> when you genuinely don&apos;t want
        the validator to check; use <code>unknown</code> when you want it to
        force an upstream type narrowing.
      </p>

      <hr className="divider" />

      {/* ── HTTP API ── */}

      <h3>HTTP API</h3>
      <p>
        The Station server exposes the expression toolkit under{" "}
        <code>/api/v1/expressions</code> for clients (mainly the dashboard) to
        parse, evaluate and validate without re-implementing the language.
      </p>
      <table className="api-table">
        <thead>
          <tr>
            <th>Endpoint</th>
            <th>Body</th>
            <th>Returns</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>POST /api/v1/expressions/parse</code></td>
            <td><code>{`{ "source": "input.x > 0" }`}</code></td>
            <td>
              <code>{`{ "node": ExprNode }`}</code> on success;{" "}
              <code>400</code> with parse error details on failure.
            </td>
          </tr>
          <tr>
            <td><code>POST /api/v1/expressions/evaluate</code></td>
            <td><code>{`{ "node": ExprNode, "context": { input, upstream } }`}</code></td>
            <td><code>{`{ "value": unknown }`}</code></td>
          </tr>
          <tr>
            <td><code>POST /api/v1/expressions/validate</code></td>
            <td><code>{`{ "node": ExprNode, "inputSchema": SchemaField, "upstreamSchemas": {...}, "expectedSchema": SchemaField }`}</code></td>
            <td><code>{`{ "ok": boolean, "errors": [...] }`}</code></td>
          </tr>
        </tbody>
      </table>

      <hr className="divider" />

      {/* ── Determinism ── */}

      <h3>Determinism guarantees</h3>
      <ul>
        <li>
          <code>evaluate</code> is total over inputs that pass{" "}
          <code>validate</code> against the real schemas — it never throws on
          type mismatches at runtime if the validator passed.
        </li>
        <li>
          Bounded by <code>MAX_NODES = 10_000</code>. Larger expressions throw
          rather than running.
        </li>
        <li>
          No closures, no captured state, no access to the host environment.
          Two evaluations with the same AST and context return the same value.
        </li>
      </ul>

      <hr className="divider" />

      {/* ── Escape hatch ── */}

      <h3>The escape hatch</h3>
      <p>
        If you can&apos;t express something in this language — you need a loop,
        a regex, an HTTP call, a clever transform — write a code-defined{" "}
        <Link href="/docs/signals">signal</Link> that does the logic in
        TypeScript and reference it from your broadcast graph. The signal is
        Station&apos;s unit of arbitrary code; expressions are for connecting
        signals together. Don&apos;t fight the language to embed logic that
        belongs in a signal.
      </p>
    </>
  );
}
