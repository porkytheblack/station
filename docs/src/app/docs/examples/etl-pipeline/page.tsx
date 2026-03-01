import { Metadata } from "next";
import Link from "next/link";
import { Code } from "../../../components/Code";

export const metadata: Metadata = {
  title: "ETL Pipeline — Examples — Station",
};

export default function EtlPipelineExamplePage() {
  return (
    <>
      <div className="eyebrow">Examples</div>
      <h2 style={{ marginTop: 0 }}>ETL Pipeline</h2>
      <p>
        Extract-transform-load workflow with multi-step signals. A linear
        broadcast chain: extract, transform, load, report. Each signal&apos;s output
        becomes the next signal&apos;s input.
      </p>

      <h4>broadcasts/etl-pipeline.ts</h4>
      <Code>{`import { broadcast } from "station-broadcast";
import { extractUsers } from "../signals/extract-users.js";
import { transformUsers } from "../signals/transform-users.js";
import { loadUsers } from "../signals/load-users.js";
import { generateReport } from "../signals/generate-report.js";

export const etlPipeline = broadcast("etl-pipeline")
  .input(extractUsers)
  .then(transformUsers)
  .then(loadUsers)
  .then(generateReport)
  .timeout(60_000)
  .build();`}</Code>

      <h4>signals/extract-users.ts</h4>
      <Code>{`import { signal, z } from "station-signal";

export const extractUsers = signal("extract-users")
  .input(z.object({ source: z.string(), batchSize: z.number() }))
  .output(
    z.object({
      records: z.array(z.object({ id: z.number(), name: z.string(), email: z.string() })),
      source: z.string(),
    }),
  )
  .timeout(15_000)
  .step("connect", async (input) => {
    console.log(\`[extract] Connecting to \${input.source}...\`);
    await new Promise((r) => setTimeout(r, 400));
    return { ...input, connected: true };
  })
  .step("query", async (prev) => {
    console.log(\`[extract] Querying \${prev.batchSize} records from \${prev.source}...\`);
    await new Promise((r) => setTimeout(r, 800));

    const records = Array.from({ length: prev.batchSize }, (_, i) => ({
      id: i + 1,
      name: \`User \${i + 1}\`,
      email: \`user\${i + 1}@\${prev.source}\`,
      raw_signup: \`2024-0\${(i % 9) + 1}-15\`,
      status_code: i % 3 === 0 ? "A" : i % 3 === 1 ? "I" : "P",
    }));
    console.log(\`[extract] Fetched \${records.length} records.\`);
    return { records, source: prev.source };
  })
  .step("validate", async (prev) => {
    console.log(\`[extract] Validating \${prev.records.length} records...\`);
    const valid = prev.records.filter((r: { email: string }) => r.email.includes("@"));
    const dropped = prev.records.length - valid.length;
    if (dropped > 0) console.log(\`[extract] Dropped \${dropped} invalid records.\`);
    return {
      records: valid.map((r: { id: number; name: string; email: string }) => ({
        id: r.id,
        name: r.name,
        email: r.email,
      })),
      source: prev.source,
    };
  })
  .build();`}</Code>

      <h4>signals/load-users.ts</h4>
      <Code>{`import { signal, z } from "station-signal";

const userRecord = z.object({ id: z.number(), name: z.string(), email: z.string() });

export const loadUsers = signal("load-users")
  .input(
    z.object({
      records: z.array(userRecord),
      source: z.string(),
      transformedAt: z.string(),
    }),
  )
  .output(z.object({ inserted: z.number(), updated: z.number(), source: z.string() }))
  .timeout(20_000)
  .retries(2)
  .step("upsert", async (input) => {
    console.log(\`[load] Upserting \${input.records.length} records into target database...\`);
    await new Promise((r) => setTimeout(r, 600));

    if (Math.random() < 0.1) {
      throw new Error("Connection to target database lost");
    }

    const inserted = Math.floor(input.records.length * 0.7);
    const updated = input.records.length - inserted;
    console.log(\`[load] Inserted \${inserted}, updated \${updated}.\`);
    return { inserted, updated, source: input.source };
  })
  .step("verify", async (prev) => {
    console.log(\`[load] Verifying load integrity...\`);
    await new Promise((r) => setTimeout(r, 300));
    const total = prev.inserted + prev.updated;
    console.log(\`[load] Verified \${total} records in target.\`);
    return prev;
  })
  .build();`}</Code>

      <div className="info-box">
        <p>
          The extract signal uses three steps (connect, query, validate) to
          demonstrate multi-step signals within a broadcast. The load signal has{" "}
          <code>.retries(2)</code> to handle transient database failures. Each
          signal&apos;s final output shape must match the next signal&apos;s input schema.
        </p>
      </div>

      <p>
        <strong>Run it:</strong>{" "}
        <code>pnpm --filter example-etl-pipeline start</code>
      </p>

      <hr className="divider" />
      <p><Link href="/docs/examples">&larr; All examples</Link></p>
    </>
  );
}
