import { Metadata } from "next";
import Link from "next/link";
import { Code } from "../../../components/Code";

export const metadata: Metadata = {
  title: "With SQLite — Examples — Station",
};

export default function WithSqliteExamplePage() {
  return (
    <>
      <div className="eyebrow">Examples</div>
      <h2 style={{ marginTop: 0 }}>With SQLite</h2>
      <p>
        Persistent storage with separate trigger and runner processes. The pattern
        used by web applications: the API server enqueues jobs, a background worker
        processes them.
      </p>

      <h4>signals/send-email.ts</h4>
      <Code>{`import { signal, z } from "station-signal";

export const sendEmail = signal("sendEmail")
  .input(z.object({ to: z.string(), subject: z.string(), body: z.string() }))
  .timeout(10_000)
  .step("validate", async (input) => {
    console.log(\`[validate] Checking email to \${input.to}...\`);
    if (!input.to.includes("@")) throw new Error("Invalid email address");
    return input;
  })
  .step("send", async (email) => {
    console.log(\`[send] Sending "\${email.subject}" to \${email.to}...\`);
    await new Promise((r) => setTimeout(r, 500));
    const messageId = \`msg_\${Math.random().toString(36).slice(2, 10)}\`;
    console.log(\`[send] Sent! Message ID: \${messageId}\`);
    return { messageId };
  })
  .build();`}</Code>

      <h4>runner.ts</h4>
      <Code>{`import path from "node:path";
import { SignalRunner, ConsoleSubscriber } from "station-signal";
import { SqliteAdapter } from "station-adapter-sqlite";

const DB_PATH = path.join(import.meta.dirname, "jobs.db");

const runner = new SignalRunner({
  signalsDir: path.join(import.meta.dirname, "signals"),
  adapter: new SqliteAdapter({ dbPath: DB_PATH }),
  subscribers: [new ConsoleSubscriber()],
});

await runner.start();`}</Code>

      <h4>trigger.ts</h4>
      <Code>{`import path from "node:path";
import { configure } from "station-signal";
import { SqliteAdapter } from "station-adapter-sqlite";
import { sendEmail } from "./signals/send-email.js";

const DB_PATH = path.join(import.meta.dirname, "jobs.db");
configure({ adapter: new SqliteAdapter({ dbPath: DB_PATH }) });

const id = await sendEmail.trigger({
  to: "alice@example.com",
  subject: "Hello from station-signal",
  body: "This run was persisted to SQLite.",
});

console.log(\`Run triggered: \${id}\`);`}</Code>

      <div className="info-box">
        <p>
          <code>SqliteAdapter</code> persists runs to disk. <code>configure()</code>{" "}
          sets a global adapter so triggers from other processes write to the same
          database. Run the runner in one terminal, then trigger from another. The
          runner picks up the persisted job and executes it.
        </p>
      </div>

      <p>
        <strong>Run it:</strong>{" "}
        <code>pnpm --filter example-with-sqlite start</code>
      </p>

      <hr className="divider" />
      <p><Link href="/docs/examples">&larr; All examples</Link></p>
    </>
  );
}
