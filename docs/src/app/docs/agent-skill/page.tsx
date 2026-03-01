import { Metadata } from "next";
import { Code } from "../../components/Code";

export const metadata: Metadata = {
  title: "Agent Skill — Station",
};

export default function AgentSkillPage() {
  return (
    <>
      <div className="eyebrow">Guide</div>
      <h2 style={{ marginTop: 0 }}>Agent skill</h2>
      <p>
        Station ships with a Claude Code skill that teaches the AI assistant how
        to build with every Station package. Once installed, Claude knows how to
        create signals, broadcasts, adapters, runners, subscribers, and dashboard
        configs without you having to explain the API.
      </p>

      <hr className="divider" />

      {/* ── What is a skill ── */}

      <h3>What is a skill?</h3>
      <p>
        A Claude Code skill is a set of markdown files that get injected into
        Claude&rsquo;s context when relevant. Skills contain API references,
        code patterns, and rules that guide the assistant&rsquo;s output. The
        Station skill covers all seven packages and the REST API.
      </p>

      <hr className="divider" />

      {/* ── Install ── */}

      <h3>Install</h3>
      <Code>{`npx skills add porkytheblack/station`}</Code>

      <p>
        The skill directory contains three files:
      </p>
      <table className="api-table">
        <thead>
          <tr>
            <th>File</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>SKILL.md</code></td>
            <td>
              Main skill file. Contains critical rules, code patterns, builder
              method tables, subscriber events, and design principles. This is
              what Claude reads first.
            </td>
          </tr>
          <tr>
            <td><code>api-reference.md</code></td>
            <td>
              Exhaustive API reference for all seven packages: station-signal,
              station-broadcast, station-adapter-sqlite, station-adapter-postgres,
              station-adapter-mysql, station-adapter-redis, and station-kit. Also
              covers the Station v1 REST API.
            </td>
          </tr>
          <tr>
            <td><code>examples.md</code></td>
            <td>
              Seventeen complete, copy-pasteable examples covering basic signals,
              multi-step pipelines, recurring jobs, broadcasts, remote triggers,
              all four adapter backends, and a full project structure template.
            </td>
          </tr>
        </tbody>
      </table>

      <hr className="divider" />

      {/* ── Usage ── */}

      <h3>Usage</h3>
      <p>
        Once installed, the skill activates automatically when you ask Claude
        about Station topics. You can also invoke it explicitly:
      </p>
      <Code>{`/station`}</Code>
      <p>
        Example prompts that trigger the skill:
      </p>
      <ul>
        <li>&ldquo;Create a signal that sends welcome emails with retry&rdquo;</li>
        <li>&ldquo;Set up a broadcast DAG for my CI pipeline&rdquo;</li>
        <li>&ldquo;Configure PostgreSQL adapters for signals and broadcasts&rdquo;</li>
        <li>&ldquo;Add a runner with SQLite persistence and graceful shutdown&rdquo;</li>
        <li>&ldquo;Write a subscriber that posts failures to Slack&rdquo;</li>
      </ul>

      <hr className="divider" />

      {/* ── What the skill knows ── */}

      <h3>What the skill knows</h3>
      <table className="api-table">
        <thead>
          <tr>
            <th>Topic</th>
            <th>Coverage</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Signals</td>
            <td>
              Builder chain (<code>.input()</code>, <code>.output()</code>,{" "}
              <code>.timeout()</code>, <code>.retries()</code>,{" "}
              <code>.every()</code>, <code>.onComplete()</code>,{" "}
              <code>.run()</code>), multi-step pipelines (<code>.step()</code> +{" "}
              <code>.build()</code>), triggering, validation
            </td>
          </tr>
          <tr>
            <td>Broadcasts</td>
            <td>
              DAG builder (<code>.node()</code>, <code>.then()</code>),
              conditional nodes (<code>when</code>), failure policies, input/output
              mapping, fan-out and fan-in patterns
            </td>
          </tr>
          <tr>
            <td>Adapters</td>
            <td>
              All four backends (SQLite, PostgreSQL, MySQL, Redis) for both signals
              and broadcasts. Constructor patterns, connection options, subpath
              imports
            </td>
          </tr>
          <tr>
            <td>Runners</td>
            <td>
              <code>SignalRunner</code> and <code>BroadcastRunner</code> setup,
              auto-discovery, manual registration, graceful shutdown, poll
              intervals
            </td>
          </tr>
          <tr>
            <td>Subscribers</td>
            <td>
              All lifecycle events for both signal and broadcast runners.
              Custom subscriber patterns for logging, metrics, and alerting
            </td>
          </tr>
          <tr>
            <td>Remote triggers</td>
            <td>
              <code>configure({"{ endpoint, apiKey }"})</code>,{" "}
              <code>HttpTriggerAdapter</code>, environment variables,
              Station REST API endpoints
            </td>
          </tr>
          <tr>
            <td>Dashboard</td>
            <td>
              <code>station.config.ts</code> options, CLI usage, auth
              configuration
            </td>
          </tr>
        </tbody>
      </table>

      <hr className="divider" />

      {/* ── Updating ── */}

      <h3>Updating</h3>
      <p>
        Re-run the install command to pull the latest version:
      </p>
      <Code>{`npx skills add porkytheblack/station`}</Code>
    </>
  );
}
