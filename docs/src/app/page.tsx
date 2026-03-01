import Link from "next/link";
import { Code } from "./components/Code";
import { TowerIllustration } from "./components/TowerIcon";

function CronIcon() {
  return (
    <svg className="feature-icon" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="4" y="14" width="24" height="4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 16L16 6L28 16" stroke="currentColor" strokeWidth="1.5" />
      <line x1="16" y1="18" x2="16" y2="28" stroke="currentColor" strokeWidth="1.5" />
      <line x1="4" y1="28" x2="28" y2="28" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg className="feature-icon" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="16" cy="16" r="11" stroke="currentColor" strokeWidth="1.5" />
      <path d="M16 8V16L21 21" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="16" cy="16" r="2" fill="currentColor" />
    </svg>
  );
}

function RetryIcon() {
  return (
    <svg className="feature-icon" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 24L8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M16 24L16 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M24 24L24 18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M5 24H27" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 8C8 8 10 4 13 8C16 12 18 6 20 6C22 6 22 10 24 10" stroke="currentColor" strokeWidth="1.2" opacity="0.5" />
    </svg>
  );
}

function TypeSafeIcon() {
  return (
    <svg className="feature-icon" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M6 10C6 8 8 6 10 6H22C24 6 26 8 26 10V22C26 24 24 26 22 26H10C8 26 6 24 6 22V10Z" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 16L15 19L20 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ConcurrencyIcon() {
  return (
    <svg className="feature-icon" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M16 4L28 10V22L16 28L4 22V10L16 4Z" stroke="currentColor" strokeWidth="1.5" />
      <path d="M16 4L16 28" stroke="currentColor" strokeWidth="1" opacity="0.4" />
      <path d="M4 10L28 10" stroke="currentColor" strokeWidth="1" opacity="0.4" />
      <path d="M4 22L28 22" stroke="currentColor" strokeWidth="1" opacity="0.4" />
    </svg>
  );
}

function DagIcon() {
  return (
    <svg className="feature-icon" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="10" cy="10" r="4" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="22" cy="22" r="4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M14 10H18C20 10 22 12 22 14V18" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <rect x="0" y="0" width="5" height="5" fill="currentColor" opacity="0.6" />
      <rect x="7" y="0" width="5" height="5" fill="currentColor" />
      <rect x="0" y="7" width="5" height="5" fill="currentColor" />
      <rect x="7" y="7" width="5" height="5" fill="currentColor" opacity="0.6" />
    </svg>
  );
}

function HeartIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 14S1.5 9.5 1.5 5.5C1.5 3 3.5 1.5 5.5 1.5C6.8 1.5 7.6 2.2 8 2.8C8.4 2.2 9.2 1.5 10.5 1.5C12.5 1.5 14.5 3 14.5 5.5C14.5 9.5 8 14 8 14Z" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

const features = [
  {
    icon: CronIcon,
    name: "Scheduling & triggers",
    desc: "Interval-based scheduling with human-readable strings — '5m', '1h', '1d'. Trigger jobs on-demand with .trigger() or let them run on a schedule automatically.",
  },
  {
    icon: HistoryIcon,
    name: "Run history",
    desc: "Every execution recorded with input, output, errors, timing, and attempt count. Query through the adapter or browse with Station's monitoring dashboard.",
  },
  {
    icon: RetryIcon,
    name: "Automatic retries",
    desc: "Per-signal retry count with exponential backoff. .retries(3) gives 4 total attempts. Failed jobs re-enqueue automatically without intervention.",
  },
  {
    icon: TypeSafeIcon,
    name: "Type-safe inputs",
    desc: "Zod schemas validate every trigger payload before it enters the queue. TypeScript infers handler argument types from the schema. Invalid data never reaches your handler.",
  },
  {
    icon: ConcurrencyIcon,
    name: "Concurrency limits",
    desc: "Global concurrency cap via maxConcurrent. The runner limits how many signals execute in parallel and queues the overflow.",
  },
  {
    icon: DagIcon,
    name: "Workflow DAGs",
    desc: "Chain signals into directed acyclic graphs with broadcasts. Fan-out to parallel nodes, fan-in with data aggregation, conditional execution via guard functions.",
  },
];

export default function LandingPage() {
  return (
    <main>
      {/* ── Hero ── */}
      <section className="landing-hero">
        <div className="landing-hero-left">
          <div className="landing-hero-tag">For your AI agents, emails, payments, and more</div>
          <h1 className="landing-hero-title">
            A simple background<br />
            jobs framework.
          </h1>
          <p className="landing-hero-sub">
            Background jobs usually mean either a Redis cluster or another cloud
            bill. Station is an npm package. Install it, define your jobs in
            TypeScript, run them on your existing infrastructure. Retries,
            scheduling, and persistence included.
          </p>
          <div className="landing-hero-cta">
            <Link href="/docs/getting-started" className="btn-primary">
              <GridIcon />
              Get started
            </Link>
            <Link href="/docs/signals" className="btn-secondary">
              API reference &rarr;
            </Link>
          </div>
        </div>

        <div className="landing-hero-right">
          <div className="hatch-bg" style={{ position: "absolute", inset: 0 }} />
          <div className="landing-tower-container">
            <TowerIllustration />
          </div>
        </div>
      </section>

      {/* ── Love Letter ── */}
      <section className="landing-letter">
        <div className="letter-inner">
          <div className="letter-heading">
            <span className="section-number">// 00</span>
            <h2 className="section-heading">
              A love letter to<br />everything you automate.
            </h2>
          </div>

          <div className="letter-uses">
            <div className="letter-use">
              <HeartIcon className="letter-heart" />
              <span className="letter-use-label">Your AI agents</span>
              <span className="letter-use-desc">that run on a schedule, retry on failure, and report back when they&apos;re done.</span>
            </div>
            <div className="letter-use">
              <HeartIcon className="letter-heart" />
              <span className="letter-use-label">Your emails</span>
              <span className="letter-use-desc">that go out in the background without blocking your request handler.</span>
            </div>
            <div className="letter-use">
              <HeartIcon className="letter-heart" />
              <span className="letter-use-label">Your payments</span>
              <span className="letter-use-desc">that process reliably with retries, even when a provider hiccups.</span>
            </div>
            <div className="letter-use">
              <HeartIcon className="letter-heart" />
              <span className="letter-use-label">Your reports</span>
              <span className="letter-use-desc">that generate overnight and land in an inbox by morning.</span>
            </div>
            <div className="letter-use">
              <HeartIcon className="letter-heart" />
              <span className="letter-use-label">Your webhooks</span>
              <span className="letter-use-desc">that fan out to downstream services without you babysitting the queue.</span>
            </div>
          </div>

          <div className="letter-pillars">
            <div className="letter-pillar">
              <span className="letter-pillar-num">01</span>
              <span className="letter-pillar-label">Simple code</span>
              <span className="letter-pillar-desc">Define a signal in TypeScript. Schema in, handler out. That&apos;s it.</span>
            </div>
            <div className="letter-pillar">
              <span className="letter-pillar-num">02</span>
              <span className="letter-pillar-label">Simple deployment</span>
              <span className="letter-pillar-desc">Runs in your process, on your servers. No Redis. No separate service.</span>
            </div>
            <div className="letter-pillar">
              <span className="letter-pillar-num">03</span>
              <span className="letter-pillar-label">Simple monitoring</span>
              <span className="letter-pillar-desc">Every run recorded. Station dashboard included. One command to start.</span>
            </div>
          </div>
        </div>
      </section>

      <div className="field-divider" />

      {/* ── Features ── */}
      <section className="landing-features">
        <div className="section-header">
          <div>
            <span className="section-number">// 01</span>
            <h2 className="section-heading">
              What you get.
            </h2>
          </div>
          <p className="section-desc">
            Everything you need for production background jobs. Nothing you don&apos;t.
          </p>
        </div>

        <div className="features-grid">
          {features.map((f) => (
            <div key={f.name} className="feature-card">
              <f.icon />
              <h3 className="feature-name">{f.name}</h3>
              <p className="feature-desc">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="field-divider" />

      {/* ── Code section ── */}
      <section className="landing-code-section">
        <div className="landing-code-inner">
          <div className="landing-code-copy">
            <span className="section-number">// 02</span>
            <h2 className="section-heading">
              Define it in TypeScript.<br /><em>Run it anywhere.</em>
            </h2>
            <p>
              A signal is a background job definition &mdash; input schema, handler
              function, execution constraints. Define them in your codebase. The
              runner auto-discovers signal files, handles scheduling, retries,
              timeouts, and concurrency. No config files. No separate service.
            </p>
            <Link href="/docs/getting-started" className="btn-primary">
              View documentation &rarr;
            </Link>
          </div>

          <div className="landing-code-block">
            <div className="landing-code-block-tab">love-letter.ts</div>
            <pre>
              <Code bare>{`import { signal, z } from "station-signal"

export const loveLetter = signal("loveLetter")
  .input(z.object({ to: z.string() }))
  .every("1d")
  .retries(2)

  // Step 1: compose the letter
  .step("compose", async (input) => {
    const letter = await ai.generate(
      "To all the jobs I love..."
    )
    return { to: input.to, letter }
  })

  // Step 2: send it
  .step("send", async (prev) => {
    await mailer.send({ to: prev.to, body: prev.letter })
    return prev
  })

  // Step 3: tip a dollar
  .step("tip", async (prev) => {
    await wallet.send(prev.to, 1.00)
  })

  .build()`}</Code>
            </pre>
          </div>
        </div>
      </section>

      {/* ── Landscape / comparison section ── */}
      <section className="landing-landscape">
        <div className="section-header">
          <div>
            <span className="section-number">// 03</span>
            <h2 className="section-heading">
              Why another<br />background jobs library?
            </h2>
          </div>
          <p className="section-desc">
            Existing solutions work. They also come with trade-offs Station doesn&apos;t.
          </p>
        </div>

        <div className="landscape-grid">
          <div className="landscape-cell">
            <div className="landscape-label">Self-hosted queues</div>
            <div className="landscape-title">Bull, BullMQ, Agenda</div>
            <ul className="landscape-items">
              <li>Requires Redis or MongoDB</li>
              <li>Docker and ops overhead</li>
              <li>Complex configuration</li>
              <li>Full control over execution</li>
            </ul>
          </div>

          <div className="landscape-cell">
            <div className="landscape-label">Managed services</div>
            <div className="landscape-title">Trigger.dev, Inngest</div>
            <ul className="landscape-items">
              <li>Hosted infrastructure</li>
              <li>Additional cloud bill</li>
              <li>Data on third-party servers</li>
              <li>Vendor-specific APIs</li>
            </ul>
          </div>

          <div className="landscape-cell landscape-cell-signal">
            <div className="landscape-label">This library</div>
            <div className="landscape-title">Station</div>
            <ul className="landscape-items landscape-items-signal">
              <li>npm install, done</li>
              <li>SQLite persistence (or in-memory)</li>
              <li>Runs in your process, on your servers</li>
              <li>Zero external dependencies</li>
              <li>Full TypeScript with Zod validation</li>
              <li>Same reliability: retries, timeouts, concurrency</li>
            </ul>
          </div>
        </div>
      </section>

      <div className="field-divider" />

      {/* ── CTA section ── */}
      <section className="landing-cta">
        <span className="section-number">// Get started</span>
        <h2 className="section-heading">Five minutes to your first signal.</h2>
        <p>
          Install the package, define a signal, start the runner.
          That&apos;s the entire setup.
        </p>
        <div className="landing-cta-install">
          <code>pnpm add station-signal</code>
        </div>
        <Link href="/docs/getting-started" className="btn-primary">
          Read the guide
        </Link>
      </section>

      {/* ── Footer ── */}
      <footer className="landing-footer">
        <div className="landing-footer-logo">Station</div>
        <div className="landing-footer-copy">
          Open source background jobs for Node.js
        </div>
      </footer>
    </main>
  );
}
