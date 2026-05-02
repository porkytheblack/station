import { Metadata } from "next";
import Link from "next/link";
import { Code } from "../../components/Code";

export const metadata: Metadata = {
  title: "Dynamic broadcasts — Station",
};

export default function DynamicBroadcastsPage() {
  return (
    <>
      <div className="eyebrow">Guide</div>
      <h2 style={{ marginTop: 0 }}>Dynamic broadcasts</h2>
      <p>
        Dynamic broadcasts are broadcast definitions that live in your storage
        backend instead of in source files. They&apos;re built, edited, versioned
        and deleted over the API (or from the dashboard&apos;s graph builder),
        and they can reference any signal that&apos;s already registered with
        the runner. The DAG shape, per-node <code>input</code> mappings, and{" "}
        <code>when</code> guards are all expressed as a JSON-serialisable spec.
      </p>
      <p>
        File-defined broadcasts (the ones you build with{" "}
        <Link href="/docs/broadcasts">
          <code>broadcast(...)</code>
        </Link>
        ) keep working unchanged. Dynamic broadcasts live in a separate registry
        and are purely additive — a name in one registry never collides with a
        name in the other.
      </p>

      <hr className="divider" />

      {/* ── When to use which ── */}

      <h3>When to use which</h3>
      <p>
        Reach for a file-defined broadcast when the DAG is part of your
        application&apos;s contract: it ships with the codebase, it&apos;s
        reviewed in PRs, and changes are deployed. Reach for a dynamic broadcast
        when the DAG is content rather than code — when you want operators to
        wire flows together without redeploying, or when the shape of a
        workflow is decided at runtime.
      </p>
      <p>
        The two coexist deliberately: signals are still the unit of arbitrary
        TypeScript. Dynamic broadcasts only let you compose them into different
        DAGs at runtime. If you need new code, write a signal; if you need a
        new wiring of existing signals, edit a dynamic broadcast.
      </p>

      <hr className="divider" />

      {/* ── DynamicBroadcastSpec shape ── */}

      <h3>The spec</h3>
      <p>
        A dynamic broadcast is a <code>DynamicBroadcastSpec</code>. It&apos;s
        plain JSON — the runner round-trips it through the adapter without
        modification.
      </p>
      <Code>{`interface DynamicBroadcastSpec {
  name: string;
  version: number;
  failurePolicy: "fail-fast" | "skip-downstream" | "continue";
  timeout?: number;
  nodes: DynamicNodeSpec[];
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  deletedAt?: Date;
}

interface DynamicNodeSpec {
  name: string;
  signalName: string;
  dependsOn: string[];
  /** ExprNode JSON; absent = pass-through (single-dep) or upstream object (multi-dep). */
  input?: ExprNode;
  /** ExprNode JSON returning boolean; absent = always run. */
  when?: ExprNode;
}`}</Code>
      <p>
        Per-node <code>input</code> and <code>when</code> are{" "}
        <Link href="/docs/expressions">expressions</Link> — a small,
        deterministic AST that can reference the broadcast&apos;s trigger input
        and any upstream node&apos;s output. They&apos;re stored as JSON, which
        is how the spec stays serialisable.
      </p>

      <h4>A concrete example</h4>
      <Code>{`{
  "name": "order-fulfillment",
  "version": 3,
  "failurePolicy": "skip-downstream",
  "nodes": [
    {
      "name": "validate",
      "signalName": "validateOrder",
      "dependsOn": []
    },
    {
      "name": "charge",
      "signalName": "chargeCard",
      "dependsOn": ["validate"],
      "input": {
        "kind": "obj",
        "entries": {
          "amount": { "kind": "ref", "path": ["validate", "total"] },
          "currency": { "kind": "lit", "value": "USD" }
        }
      }
    },
    {
      "name": "ship",
      "signalName": "shipOrder",
      "dependsOn": ["charge"],
      "when": {
        "kind": "op", "op": "==",
        "args": [
          { "kind": "ref", "path": ["charge", "status"] },
          { "kind": "lit", "value": "paid" }
        ]
      }
    }
  ],
  "createdAt": "2026-04-12T08:11:02.000Z",
  "updatedAt": "2026-04-30T14:02:11.000Z"
}`}</Code>

      <hr className="divider" />

      {/* ── HTTP API ── */}

      <h3>HTTP API</h3>
      <p>
        Dynamic broadcasts live under <code>/api/v1/broadcast-definitions</code>.
        All endpoints accept and return JSON; auth is the same API key flow used
        for <Link href="/docs/remote-triggers">remote triggers</Link>.
      </p>

      <h4>Save a definition</h4>
      <Code>{`curl -X POST http://localhost:4400/api/v1/broadcast-definitions \\
  -H "Authorization: Bearer $STATION_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "order-fulfillment",
    "failurePolicy": "skip-downstream",
    "nodes": [
      { "name": "validate", "signalName": "validateOrder", "dependsOn": [] },
      { "name": "charge",   "signalName": "chargeCard",    "dependsOn": ["validate"] }
    ]
  }'`}</Code>
      <p>
        The server validates the spec (signal names exist, no cycles,
        expressions type-check against signal schemas), bumps{" "}
        <code>version</code> by one, and writes the new version. Re-saving the
        same name is how you edit it; there&apos;s no separate{" "}
        <code>PATCH</code> endpoint. The response is the saved spec, including
        the assigned version number.
      </p>

      <h4>Validate without saving</h4>
      <p>
        The dashboard&apos;s graph builder uses this endpoint to surface errors
        as you edit:
      </p>
      <Code>{`POST /api/v1/broadcast-definitions/validate
{ "name": "...", "failurePolicy": "...", "nodes": [...] }

// 200 OK
{
  "ok": false,
  "errors": [
    { "node": "charge", "field": "input", "message": "$.amount: expected number, got string" }
  ]
}`}</Code>

      <h4>Read</h4>
      <table className="api-table">
        <thead>
          <tr>
            <th>Endpoint</th>
            <th>Returns</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>GET /api/v1/broadcast-definitions</code></td>
            <td>Latest non-deleted version of each definition.</td>
          </tr>
          <tr>
            <td><code>GET /api/v1/broadcast-definitions/:name</code></td>
            <td>Latest version of a single definition.</td>
          </tr>
          <tr>
            <td><code>GET /api/v1/broadcast-definitions/:name/versions</code></td>
            <td>List of all versions, oldest first. Includes soft-deleted entries.</td>
          </tr>
          <tr>
            <td><code>GET /api/v1/broadcast-definitions/:name/versions/:n</code></td>
            <td>A specific historical version. The dashboard deep-links to these.</td>
          </tr>
        </tbody>
      </table>

      <h4>Delete</h4>
      <Code>{`curl -X DELETE http://localhost:4400/api/v1/broadcast-definitions/order-fulfillment \\
  -H "Authorization: Bearer $STATION_KEY"`}</Code>
      <p>
        Deletes are soft. The most recent version is marked with{" "}
        <code>deletedAt</code>; previous versions stay queryable so existing
        broadcast runs can still be inspected. If you create another definition
        with the same name later, version numbering continues from where it
        left off — a recreated <code>order-fulfillment</code> after three
        deleted versions becomes <code>v4</code>, not <code>v1</code>. This
        keeps run-history references stable.
      </p>

      <h4>Trigger</h4>
      <p>
        Static broadcasts use <code>/api/v1/broadcasts/:name/trigger</code>.
        Dynamic broadcasts have a dedicated endpoint that distinguishes the
        registry:
      </p>
      <Code>{`curl -X POST http://localhost:4400/api/v1/trigger-dynamic-broadcast \\
  -H "Authorization: Bearer $STATION_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "name": "order-fulfillment", "input": { "orderId": "ORD-123" } }'`}</Code>

      <hr className="divider" />

      {/* ── Snapshot semantics ── */}

      <h3>Snapshot on trigger</h3>
      <p>
        When a dynamic broadcast is triggered, the runner serialises the
        current spec into the broadcast run&apos;s{" "}
        <code>definitionSnapshot</code> field. The advance loop reads from the
        snapshot, never the live registry. This means:
      </p>
      <ul>
        <li>
          Editing a definition while a run is in flight does not change the DAG
          that run is executing.
        </li>
        <li>
          Re-triggering after a save uses the new spec; older runs continue on
          their snapshot.
        </li>
        <li>
          The dashboard&apos;s run-detail view reconstructs the DAG from the
          snapshot, so historical runs render correctly even after the
          definition has been edited or deleted.
        </li>
      </ul>
      <Code>{`interface BroadcastRun {
  // ...
  /** JSON-serialised DynamicBroadcastSpec captured at trigger time. */
  definitionSnapshot?: string;
}`}</Code>

      <hr className="divider" />

      {/* ── Reconciliation ── */}

      <h3>Reconciliation</h3>
      <p>
        The broadcast runner keeps an in-memory map of materialised dynamic
        broadcasts (parsed spec + compiled DAG). On a configurable cadence
        (default: every 5 ticks of the broadcast poll loop) it asks the adapter
        for the current set of definitions and reconciles:
      </p>
      <ul>
        <li>New names are materialised and added to the registry.</li>
        <li>Bumped <code>version</code>s replace the in-memory entry.</li>
        <li>Soft-deleted names are removed from the registry.</li>
      </ul>
      <p>
        Materialisation is what catches mid-flight schema drift — if a node
        references a signal that&apos;s no longer registered, the entry is
        dropped from the registry with a warning rather than poisoning future
        triggers.
      </p>

      <hr className="divider" />

      {/* ── Adapter requirements ── */}

      <h3>Adapter requirements</h3>
      <p>
        Storage for dynamic definitions lives on the same{" "}
        <code>BroadcastQueueAdapter</code> you already use for broadcast runs,
        via four optional methods:
      </p>
      <Code>{`interface BroadcastQueueAdapter {
  // ...existing run/node methods omitted...

  saveDefinition?(spec: DynamicBroadcastSpec): Promise<DynamicBroadcastSpec>;
  getDefinition?(name: string, version?: number): Promise<DynamicBroadcastSpec | null>;
  listDefinitions?(): Promise<DynamicBroadcastSpec[]>;
  listDefinitionVersions?(name: string): Promise<DynamicBroadcastSpec[]>;
  deleteDefinition?(name: string): Promise<boolean>;
}`}</Code>
      <p>
        All four built-in adapters (<code>sqlite</code>, <code>postgres</code>,{" "}
        <code>mysql</code>, <code>redis</code>) implement these methods. If
        you&apos;re using <code>BroadcastMemoryAdapter</code>, dynamic
        broadcasts work in-process but disappear on restart.
      </p>
      <p>
        If you ship a custom adapter and don&apos;t implement these methods,
        the dynamic-broadcast endpoints return <code>501 Not Implemented</code>{" "}
        and the rest of the broadcast surface keeps working.
      </p>

      <hr className="divider" />

      {/* ── Dashboard ── */}

      <h3>Dashboard builder</h3>
      <p>
        The Station dashboard exposes a graphical builder for dynamic
        broadcasts under <code>/broadcasts/dyn</code>. It uses exactly the API
        documented above: each save round-trips through{" "}
        <code>POST /broadcast-definitions</code>, edits live-validate against{" "}
        <code>/validate</code>, and the version drawer is backed by{" "}
        <code>/versions/:n</code>. Anything you can do in the dashboard is
        scriptable from <code>curl</code>; anything you save with{" "}
        <code>curl</code> shows up in the dashboard immediately.
      </p>
      <div className="info-box">
        Triggers issued from the dashboard land at the same{" "}
        <code>/api/v1/trigger-dynamic-broadcast</code> endpoint, so the
        snapshot-on-trigger semantics apply uniformly whether the trigger came
        from a human or an integration.
      </div>
    </>
  );
}
