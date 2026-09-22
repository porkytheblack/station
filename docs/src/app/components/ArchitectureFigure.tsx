import type { ReactNode } from "react";

export interface ArchitectureNode {
  label: string;
  title: string;
  detail: string;
  accent?: boolean;
}

/** Semantic, responsive diagrams: the same reading order works without CSS or images. */
export function ArchitectureFigure({ title, nodes, caption, children }: {
  title: string;
  nodes: ArchitectureNode[];
  caption: string;
  children?: ReactNode;
}) {
  return <figure className="architecture-figure">
    <div className="architecture-title">{title}</div>
    <ol className="architecture-flow">
      {nodes.map((node) => <li key={node.title} className={node.accent ? "architecture-node architecture-node-accent" : "architecture-node"}>
        <span className="architecture-node-label">{node.label}</span>
        <strong>{node.title}</strong>
        <span className="architecture-node-detail">{node.detail}</span>
      </li>)}
    </ol>
    {children}
    <figcaption>{caption}</figcaption>
  </figure>;
}

export function SignalFigure() {
  return <ArchitectureFigure title="A signal, from request to result" nodes={[
    { label: "Trigger", title: "Validated input", detail: "An API call, a schedule or your application submits a job." },
    { label: "Execute", title: "One attempt", detail: "An eligible worker claims the run and starts its handler.", accent: true },
    { label: "Record", title: "Output or failure", detail: "Inspect the result, or retry within the configured budget." },
  ]} caption="Retries can repeat external effects. Make handlers idempotent when sending messages, charging cards or changing remote state." />;
}

export function BroadcastFigure() {
  return <ArchitectureFigure title="A broadcast follows dependencies" nodes={[
    { label: "Extract", title: "Fetch source", detail: "One signal produces the input for the next stage." },
    { label: "Fan out", title: "Normalize + enrich", detail: "Independent signal nodes can run in parallel.", accent: true },
    { label: "Fan in", title: "Publish report", detail: "The final node waits for its required predecessors." },
  ]} caption="A broadcast is the graph and its execution policy. The work inside each node is a signal." />;
}

export function BeaconFigure() {
  return <ArchitectureFigure title="A beacon follows desired state" nodes={[
    { label: "Start", title: "Launch + ready", detail: "The supervised process initializes and reports readiness." },
    { label: "Run", title: "Serve or listen", detail: "Keep a connection, poll a source or expose a service.", accent: true },
    { label: "Reconcile", title: "Restart or stop", detail: "Apply restart limits and backoff, or stop when requested." },
  ]} caption="A beacon is a supervised long-lived process. Its memory and open connections still disappear when that process exits." />;
}
