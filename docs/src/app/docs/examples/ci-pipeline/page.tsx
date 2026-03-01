import { Metadata } from "next";
import Link from "next/link";
import { Code } from "../../../components/Code";

export const metadata: Metadata = {
  title: "CI Pipeline — Examples — Station",
};

export default function CiPipelineExamplePage() {
  return (
    <>
      <div className="eyebrow">Examples</div>
      <h2 style={{ marginTop: 0 }}>CI Pipeline</h2>
      <p>
        Simulated CI/CD workflow with fan-out, branch guards, and result fallback.
        The most complex DAG in the examples.
      </p>

      <Code>{`checkout
  |---> lint              (parallel)
  |---> test-unit         (parallel, 2 retries)
  |---> test-integration  (parallel, 1 retry)
           |
        build-app         (waits for all above)
           |
      deploy-staging
           |
      deploy-prod         (guard: only on "main" branch)
           |
        notify            (fallback: uses staging output if prod skipped)`}</Code>

      <h4>broadcasts/ci-pipeline.ts</h4>
      <Code>{`import { broadcast } from "station-broadcast";
import { checkout } from "../signals/checkout.js";
import { lint } from "../signals/lint.js";
import { testUnit } from "../signals/test-unit.js";
import { testIntegration } from "../signals/test-integration.js";
import { buildApp } from "../signals/build-app.js";
import { deployStaging } from "../signals/deploy-staging.js";
import { deployProd } from "../signals/deploy-prod.js";
import { notify } from "../signals/notify.js";

export const ciPipeline = broadcast("ci-pipeline")
  .input(checkout)
  .then(lint, testUnit, testIntegration) // fan-out: all run in parallel
  .then(buildApp, {
    // Wait for all tests AND checkout; pass checkout output as build input
    after: ["lint", "test-unit", "test-integration", "checkout"],
    map: (upstream) => upstream["checkout"],
  })
  .then(deployStaging)
  .then(deployProd, {
    // Need checkout data for the branch guard
    after: ["deploy-staging", "checkout"],
    map: (upstream) => upstream["deploy-staging"],
    when: (upstream) => {
      const co = upstream["checkout"] as { branch: string } | undefined;
      return co?.branch === "main";
    },
  })
  .then(notify, {
    // If deploy-prod was skipped (non-main branch), fall back to staging output
    after: ["deploy-prod", "deploy-staging"],
    map: (upstream) => upstream["deploy-prod"] ?? upstream["deploy-staging"],
  })
  .onFailure("fail-fast")
  .timeout(120_000)
  .build();`}</Code>

      <h4>signals/checkout.ts</h4>
      <Code>{`import { signal, z } from "station-signal";

export const checkout = signal("checkout")
  .input(z.object({ repo: z.string(), branch: z.string(), commitSha: z.string() }))
  .output(z.object({
    repo: z.string(),
    branch: z.string(),
    commitSha: z.string(),
    workdir: z.string(),
  }))
  .timeout(10_000)
  .run(async (input) => {
    console.log(\`[checkout] Cloning \${input.repo}@\${input.branch} (\${input.commitSha.slice(0, 7)})...\`);
    await new Promise((r) => setTimeout(r, 600));
    const workdir = \`/tmp/ci/\${input.commitSha.slice(0, 7)}\`;
    console.log(\`[checkout] Workspace ready at \${workdir}\`);
    return { ...input, workdir };
  });`}</Code>

      <h4>runner.ts</h4>
      <Code>{`import path from "node:path";
import { SignalRunner, ConsoleSubscriber } from "station-signal";
import { BroadcastRunner, ConsoleBroadcastSubscriber } from "station-broadcast";
import { SqliteAdapter } from "station-adapter-sqlite";
import { BroadcastSqliteAdapter } from "station-adapter-sqlite/broadcast";
import { ciPipeline } from "./broadcasts/ci-pipeline.js";

const DB_PATH = path.join(import.meta.dirname, "jobs.db");

const signalRunner = new SignalRunner({
  signalsDir: path.join(import.meta.dirname, "signals"),
  adapter: new SqliteAdapter({ dbPath: DB_PATH }),
  subscribers: [new ConsoleSubscriber()],
  maxConcurrent: 4,
  retryBackoffMs: 500,
});

const broadcastRunner = new BroadcastRunner({
  signalRunner,
  adapter: new BroadcastSqliteAdapter({ dbPath: DB_PATH }),
  subscribers: [new ConsoleBroadcastSubscriber()],
});

broadcastRunner.register(ciPipeline);

const branch = process.argv[2] || "main";
const sha = Math.random().toString(36).slice(2, 10)
  + Math.random().toString(36).slice(2, 6);

setTimeout(async () => {
  const id = await ciPipeline.trigger({
    repo: "acme/web-app",
    branch,
    commitSha: sha,
  });

  console.log(\`\\nTriggered CI pipeline: \${id}\`);
  console.log(\`  repo:   acme/web-app\`);
  console.log(\`  branch: \${branch}\`);
  console.log(\`  commit: \${sha.slice(0, 7)}\`);
  console.log(\`\\nProd deploy \${branch === "main" ? "enabled" : "skipped"} (branch guard).\`);
}, 500);

signalRunner.start();
broadcastRunner.start();`}</Code>

      <div className="info-box">
        <p>
          <code>after</code> overrides implicit dependencies so <code>build-app</code>{" "}
          waits for all three parallel steps. <code>map</code> transforms upstream
          outputs into the shape the next signal expects. <code>when</code>{" "}
          conditionally skips nodes — here it gates prod deployment on the{" "}
          <code>&quot;main&quot;</code> branch. The <code>??</code> in notify&apos;s map provides a
          fallback when <code>deploy-prod</code> was skipped and returned undefined.{" "}
          <code>onFailure(&quot;fail-fast&quot;)</code> stops the entire pipeline on the first
          failure.
        </p>
      </div>

      <div className="warn-box">
        <p>
          Pass a branch name as a CLI argument to test the guard:{" "}
          <code>pnpm --filter example-ci-pipeline start -- feature/xyz</code>{" "}
          skips the prod deploy step.
        </p>
      </div>

      <p>
        <strong>Run it:</strong>{" "}
        <code>pnpm --filter example-ci-pipeline start</code>
      </p>

      <hr className="divider" />
      <p><Link href="/docs/examples">&larr; All examples</Link></p>
    </>
  );
}
