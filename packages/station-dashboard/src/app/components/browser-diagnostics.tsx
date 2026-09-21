"use client";
import { useCallback, useEffect, useState } from "react";
import type { BrowserArtifact, BrowserDiagnostics as Diagnostics, BrowserAuditEntry } from "station-browser-use";
import { executionError, executionRequest } from "../hooks/use-execution";
import { ExecutionAlert } from "./execution-common";
export function BrowserDiagnostics({ owner, sessionId, reachable, admit, features, onBusy }: { owner: string; sessionId?: string; reachable: boolean; admit: boolean; features: Record<string, boolean>; onBusy: (busy: boolean) => void }) {
  const [data, setData] = useState<Diagnostics | null>(null), [audit, setAudit] = useState<BrowserAuditEntry[]>([]);
  const [busy, setBusy] = useState(true), [error, setError] = useState(""), [artifact, setArtifact] = useState<BrowserArtifact | null>(null), [download, setDownload] = useState("");
  const rpc = useCallback(<T,>(body: Record<string, unknown>) => executionRequest<T>(owner, "browser", body), [owner]);
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  useEffect(() => () => { if (download) URL.revokeObjectURL(download); }, [download]);
  const refresh = useCallback(async () => {
    const entries = await rpc<BrowserAuditEntry[]>({ method: "audit" });
    setAudit(sessionId ? entries.filter(entry => entry.sessionId === sessionId) : entries);
    if (sessionId && features.diagnostics) setData(await rpc<Diagnostics>({ method: "execute", id: sessionId, command: { op: "diagnostics" } }));
  }, [rpc, sessionId, features.diagnostics]);
  useEffect(() => { if (!reachable) { setBusy(false); return; } let cancelled = false; setBusy(true); void refresh().catch(e => { if (!cancelled) setError(executionError(e)); }).finally(() => { if (!cancelled) setBusy(false); }); return () => { cancelled = true; }; }, [refresh, reachable]);
  const act = async (operation: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await operation(); } catch (e) { setError(executionError(e)); } finally { setBusy(false); }
  };
  const command = <T,>(value: Record<string, unknown>) => rpc<T>({ method: "execute", id: sessionId, command: value });
  return <section className="station-card execution-card" aria-label="Browser diagnostics"><h2>Diagnostics</h2><ExecutionAlert error={error} />
    {data?.reliability && <div className="execution-result" role="status" aria-label="Browser access status">
      <strong>Page access: {data.reliability.status}</strong>
      {data.reliability.reason && <p className="execution-note">{data.reliability.reason}</p>}
      {data.reliability.retryAfterMs !== undefined && <p className="execution-note">Wait at least {Math.ceil(data.reliability.retryAfterMs / 1000)} seconds, then refresh diagnostics.</p>}
      {["challenge", "blocked"].includes(data.reliability.status) && <p className="execution-note">Pause agent actions and use the Live page to take control. Release control after reviewing the page so the agent can continue.</p>}
    </div>}
    <div className="execution-toolbar"><button className="btn" disabled={!reachable || busy} onClick={() => void act(refresh)}>Refresh diagnostics</button><span className="execution-note">{features.durableAudit ? "Worker activity is persisted on the configured storage." : "Worker activity is retained in memory."}</span></div>
    {sessionId && features.diagnostics && <><label className="execution-note"><input type="checkbox" aria-label="Capture browser console text" checked={data?.consoleText ?? false} disabled={!admit || busy} onChange={event => { const enabled = event.target.checked, previous = data?.consoleText ?? false; setData(old => old ? { ...old, consoleText: enabled } : { events: [], consoleText: enabled, trace: { status: "idle" } }); void act(async () => { try { setData(await command<Diagnostics>({ op: "diagnostics", consoleText: enabled })); } catch (e) { setData(old => old ? { ...old, consoleText: previous } : old); throw e; } }); }} /> Capture console text for future events</label><p className="execution-note">Console text can contain page data. Network events are metadata; capture is bounded by the worker.</p><button className="btn" disabled={!admit || busy} onClick={() => void act(async () => { setData(await command<Diagnostics>({ op: "diagnostics", clear: true })); })}>Clear browser events</button>
      <div className="execution-resource-list" aria-label="Browser diagnostic events">{data?.events.map((event, index) => <div className="execution-resource" style={{ display: "block" }} key={`${event.at}:${index}`}><strong>{event.kind}{event.level ? ` · ${event.level}` : ""}{event.status ? ` · ${event.status}` : ""}</strong><span className="execution-note">{new Date(event.at).toLocaleTimeString()} {event.method || ""} {event.url || ""} {event.action || ""}</span>{event.message && <pre className="execution-output">{event.message}</pre>}</div>)}{!data?.events.length && <p className="execution-note">No browser events captured.</p>}</div>
    </>}
    {sessionId && features.tracing && <div className="execution-result"><h3>Playwright trace</h3><p className="execution-note">Tracing is opt-in and can capture page content and sensitive data. Download the ZIP before closing this browser; trace files belong to the live session.</p><div className="execution-toolbar"><span className="execution-note" aria-label="Browser trace status">{data?.trace.status ?? "idle"}</span><button className="btn" disabled={!admit || busy || data?.trace.status === "recording"} onClick={() => void act(async () => { await command({ op: "traceStart" }); await refresh(); })}>Start trace</button><button className="btn" disabled={!admit || busy || data?.trace.status !== "recording"} onClick={() => void act(async () => { setArtifact(await command<BrowserArtifact>({ op: "traceStop" })); setDownload(""); await refresh(); })}>Stop trace</button></div>
      {artifact && <div className="execution-toolbar"><span className="execution-note">{artifact.name} · {artifact.bytes} bytes</span><button className="btn" disabled={!reachable || busy} onClick={() => void act(async () => { const value = await command<{ base64: string }>({ op: "downloadRead", artifactId: artifact.id }); setDownload(URL.createObjectURL(new Blob([Uint8Array.from(atob(value.base64), char => char.charCodeAt(0))], { type: "application/zip" }))); })}>Retrieve trace</button>{download && <a className="btn" href={download} download={artifact.name}>Download trace</a>}<button className="btn btn--danger" disabled={!reachable || busy} onClick={() => void act(async () => { await command({ op: "downloadDelete", artifactId: artifact.id }); setArtifact(null); setDownload(""); })}>Delete trace</button></div>}
    </div>}
    <div className="execution-result"><h3>Worker activity</h3><p className="execution-note">A bounded timeline of operations and outcomes. An operation started without a finish entry may have been interrupted.</p><div className="execution-resource-list" aria-label="Browser activity timeline">{audit.slice().reverse().map((entry, index) => <div className="execution-resource" key={`${entry.at}:${index}`} style={{ display: "block" }}><strong>{entry.operation || entry.event}{"phase" in entry && entry.phase ? ` · ${entry.phase}` : ""}{entry.outcome ? ` · ${entry.outcome}` : ""}</strong><span className="execution-note">{new Date(entry.at).toLocaleString()} · {entry.sessionId.slice(0, 8)} · {entry.backend}</span></div>)}{!audit.length && <p className="execution-note">No activity retained.</p>}</div></div>
  </section>;
}
