"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ExecutionNavigation } from "./execution-navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useBreadcrumb } from "../hooks/use-breadcrumb";
import { executionError, executionRequest, useExecutionStations, type ExecutionStation } from "../hooks/use-execution";
import { ExecutionAlert, ExecutionOwner, OwnerNotice } from "./execution-common";
import { SandboxTerminal } from "./sandbox-terminal";
import { SandboxServices } from "./sandbox-services";
import { SandboxFiles } from "./sandbox-files";
import type { Sandbox, CommandRun } from "station-sandbox";

export default function SandboxesPage() {
  const router = useRouter();
  const [navigating, startNavigation] = useTransition();
  const { path = [] } = useParams<{ path?: string[] }>();
  const fleet = useExecutionStations("sandbox");
  const owner = path[0] || fleet.owner;
  const selected = path[1] || "";
  const tool = path[2] || "commands";
  const base = `/sandboxes/${encodeURIComponent(owner)}`;
  const station = fleet.stations.find(item => item.stationId === owner);
  const [busy, setBusy] = useState(false);
  useBreadcrumb([{ label: "Sandboxes", href: "/sandboxes" }, ...(owner ? [{ label: station?.name || owner, href: base }] : []), ...(selected ? [{ label: selected.slice(0, 8), href: `${base}/${encodeURIComponent(selected)}/commands` }, { label: tool }] : [])], "sandboxes");
  return <div>
    {selected && <Link className="execution-back" href={base}>← All workspaces</Link>}
    <h1 className="page-title">{selected ? "Workspace" : "Sandboxes"}</h1>
    <p className="execution-intro">{selected ? `${station?.name || owner} · ${selected}` : "Choose a workspace to manage its commands, terminal, services and files."}</p>
    <ExecutionAlert error={fleet.error} />
    {!selected && <ExecutionOwner label="Sandbox station" stations={fleet.stations} owner={owner} onChange={id => startNavigation(() => router.push(`/sandboxes/${encodeURIComponent(id)}`))} busy={busy || navigating} refresh={fleet.refresh} />}
    {fleet.loading || navigating ? <p className="execution-note">Loading stations…</p> : !owner ? <div className="empty-state"><p className="empty-state-text">No Sandbox workers are configured in this network.</p></div> : <SandboxWorkspace key={`${owner}:${selected}`} owner={owner} selected={selected} tool={tool} invalidPath={path.length > 3} station={station} onBusy={setBusy} />}
  </div>;
}
function SandboxWorkspace({ owner, selected, tool, invalidPath, station, onBusy }: { owner: string; selected: string; tool: string; invalidPath: boolean; station?: ExecutionStation; onBusy: (busy: boolean) => void }) {
  const router = useRouter();
  const base = `/sandboxes/${encodeURIComponent(owner)}`;
  const tools = ["commands", ...(station?.features?.sandbox?.pty ? ["terminal"] : []), ...(station?.features?.sandbox?.services ? ["services"] : []), ...(station?.features?.sandbox?.files ? ["files"] : [])];
  const [workspaces, setWorkspaces] = useState<Sandbox[]>([]);
  const [loading, setLoading] = useState(true);
  const listRevision = useRef(0);
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(30);
  const [run, setRun] = useState<CommandRun | null>(null);
  const runRevision = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const reachable = Boolean(station?.available);
  const admit = reachable && station?.status === "online";
  const rpc = useCallback(<T,>(body: Record<string, unknown>) => executionRequest<T>(owner, "sandbox", body), [owner]);
  const refresh = useCallback(async () => {
    const revision = ++listRevision.current;
    try {
      const list = await rpc<Sandbox[]>({ method: "list" });
      if (revision !== listRevision.current) return;
      setWorkspaces(list);
    } finally { setLoading(false); }
  }, [rpc]);
  useEffect(() => {
    if (reachable) void refresh().catch((e) => setError(executionError(e)));
  }, [reachable, refresh]);
  useEffect(() => {
    const revision = ++runRevision.current;
    setRun(null); setNotice(""); setError("");
    if (!selected || !reachable) return;
    let cancelled = false;
    try {
      const previous = sessionStorage.getItem(`station-command:${owner}:${selected}`);
      if (previous) void rpc<CommandRun>({ method: "command", id: selected, runId: previous })
        .then((value) => { if (!cancelled && revision === runRevision.current) setRun(value); })
        .catch((e) => { if (!cancelled && revision === runRevision.current) setError(executionError(e)); });
    } catch { /* The workspace remains usable when browser storage is unavailable. */ }
    return () => { cancelled = true; };
  }, [owner, selected, reachable, rpc]);
  useEffect(() => {
    if (!run || run.status !== "running" || !reachable) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await rpc<CommandRun>({ method: "command", id: run.sandboxId, runId: run.id });
        if (!stopped) {
          setRun((current) => current?.id === result.id && current.status === "running" ? result : current);
          if (result.status === "running") timer = setTimeout(poll, 750);
        }
      } catch (e) { if (!stopped) setError(`Command polling stopped. ${executionError(e)}`); }
    };
    timer = setTimeout(poll, 350);
    return () => { stopped = true; clearTimeout(timer); };
  }, [run?.id, run?.status, reachable, rpc]);
  const act = async (operation: () => Promise<void>) => {
    setBusy(true); onBusy(true); setError(""); setNotice("");
    try { await operation(); }
    catch (e) { setError(executionError(e)); }
    finally { setBusy(false); onBusy(false); }
  };
  const remember = (value: CommandRun) => {
    // A new command/cancellation supersedes any older restore request in flight.
    runRevision.current++;
    setRun(value);
    try { sessionStorage.setItem(`station-command:${owner}:${value.sandboxId}`, value.id); } catch {}
  };
  const current = workspaces.find((item) => item.id === selected);
  return <section className="execution-workbench" aria-label="Sandbox workspace manager">
    <OwnerNotice station={station} />
    {!selected && <p className="execution-note">{station?.features?.sandbox?.isolated ? "Container workspaces use the worker’s configured isolation and resource limits." : "Host-process workspaces run trusted code with the worker’s permissions."} Files persist with the worker’s storage; commands are bounded jobs. Install a workspace tool with npm install --global &lt;package&gt;, then run it by name.</p>}
    <ExecutionAlert error={error} />
    {notice && <p role="status" className="execution-note">{notice}</p>}
    {!selected && <><div className="execution-toolbar">
      <button className="btn btn--primary" disabled={!admit || busy || loading} onClick={() => void act(async () => {
        const workspace = await rpc<Sandbox>({ method: "create" });
        listRevision.current++;
        setWorkspaces((items) => [...items, workspace]); router.push(`${base}/${encodeURIComponent(workspace.id)}/commands`);
      })}>Create workspace</button>
      <button className="btn" disabled={!reachable || busy} onClick={() => void act(refresh)}>Refresh workspaces</button>
      <span className="execution-note">{workspaces.length} workspace{workspaces.length === 1 ? "" : "s"}</span>
    </div>
    <div className="execution-resource-list" aria-label="Workspaces">
      {workspaces.map(item => <Link className="execution-resource" key={item.id} href={`${base}/${encodeURIComponent(item.id)}/commands`} aria-label={`Open workspace ${item.id}`}>
        <span><strong className="mono">{item.id}</strong><span className="execution-note">{item.backend} · Created {new Date(item.createdAt).toLocaleString()}</span></span><span aria-hidden="true">→</span>
      </Link>)}
    </div>
    {!workspaces.length && <div className="empty-state"><p className="empty-state-text">{loading && reachable ? "Loading workspaces…" : "No workspaces on this station. Create one to run a command."}</p></div>}
    </>}
    {selected && <>
      <ExecutionNavigation label="Workspace tools" base={`${base}/${encodeURIComponent(selected)}`} current={tool} items={tools} />
      {invalidPath || !tools.includes(tool) ? <ExecutionAlert error="This workspace tool is not available on this station." /> : !current ? <p className="execution-note" role="status">{loading && reachable ? "Loading workspace…" : "This workspace could not be found on its owner. Return to the workspace list to refresh."}</p> : <>
      <div className="execution-detail-heading" data-workspace-id={selected}>
        <span className="execution-note">{current.backend} · Created {new Date(current.createdAt).toLocaleString()}</span>
        <button className="btn btn--danger btn--sm" disabled={!reachable || busy || run?.status === "running"} onClick={() => {
          if (!window.confirm("Delete this workspace and all of its files?")) return;
          void act(async () => { await rpc({ method: "destroy", id: selected }); router.push(base); });
        }}>Delete workspace</button>
      </div>
      {tool === "commands" && <div className="station-card execution-card">
      <form onSubmit={(event) => { event.preventDefault(); if (!admit || busy || !selected || !command.trim() || run?.status === "running") return; void act(async () => {
        const value = await rpc<CommandRun>({ method: "exec", id: selected, command, timeoutMs: timeoutSeconds * 1000, ...(cwd.trim() ? { cwd: cwd.trim() } : {}) }); remember(value);
      }); }}>
        <label className="execution-field"><span>Command</span>
          <textarea className="input-textarea" aria-label="Command" rows={4} value={command} onChange={(event) => setCommand(event.target.value)} placeholder="node --version && git --version" disabled={busy} />
        </label>
        <div className="execution-toolbar">
          <label className="execution-field execution-grow"><span>Working directory</span><input className="input-text" aria-label="Working directory" value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder=". (workspace root)" disabled={busy} /></label>
          <label className="execution-field"><span>Timeout (seconds)</span><input className="input-text" aria-label="Timeout (seconds)" type="number" min="1" max="2147483" step="1" required value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(Number(event.target.value))} disabled={busy} style={{ width: "110px" }} /></label>
          <button className="btn btn--primary" type="submit" disabled={!admit || busy || !command.trim() || run?.status === "running"}>Run command</button>
          <button className="btn" type="button" disabled={!reachable || busy || run?.status !== "running"} onClick={() => void act(async () => { if (run) remember(await rpc<CommandRun>({ method: "cancel", id: selected, runId: run.id })); })}>Cancel command</button>
        </div>
      </form>
      {run && <div className="execution-result">
        <div className="execution-toolbar"><h2>Latest command</h2><span role="status" aria-label="Command status" className={`status-badge status-${run.status === "completed" ? "completed" : run.status === "running" ? "running" : "failed"}`}>{run.status}</span>{run.exitCode !== null && <span className="execution-note">Exit {run.exitCode}</span>}
          <button className="btn btn--sm" disabled={busy || !reachable} onClick={() => void act(async () => { remember(await rpc<CommandRun>({ method: "command", id: selected, runId: run.id })); })}>Refresh command</button>
        </div>
        <pre className="execution-output" aria-label="Command output">{run.stdout || (!run.stderr ? "No output yet." : "")}{run.stderr ? `${run.stdout ? "\n" : ""}[stderr]\n${run.stderr}` : ""}</pre>
        {run.truncated && <p className="execution-note">Output reached the worker’s configured limit and was truncated.</p>}
      </div>}
      </div>}
    {current && tool === "terminal" && <SandboxTerminal key={selected} owner={owner} workspace={selected} admit={admit} reachable={reachable} />}
    {current && tool === "services" && <SandboxServices key={selected} owner={owner} workspace={selected} admit={admit} reachable={reachable} />}
    {current && tool === "files" && <SandboxFiles key={selected} owner={owner} workspace={selected} admit={admit} reachable={reachable} />}
      </>}
    </>}
  </section>;
}
