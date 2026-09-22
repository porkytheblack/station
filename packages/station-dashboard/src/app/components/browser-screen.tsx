"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ExecutionNavigation } from "./execution-navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useBreadcrumb } from "../hooks/use-breadcrumb";
import { executionError, executionRequest, useExecutionStations, type ExecutionStation } from "../hooks/use-execution";
import { BrowserLive } from "./browser-live";
import { BrowserInspect } from "./browser-inspect";
import { BrowserDiagnostics } from "./browser-diagnostics";
import { BrowserRecovery } from "./browser-recovery";
import { BrowserAdvanced } from "./browser-advanced";
import { BrowserRecordings } from "./browser-recordings";
import { ExecutionAlert, ExecutionOwner, OwnerNotice } from "./execution-common";
import type { BrowserHandle, BrowserAction } from "station-browser-use";

const actionLabels: Record<BrowserAction, string> = { navigate: "Navigate", click: "Click", type: "Type", press: "Press key", evaluate: "Evaluate JavaScript", screenshot: "Take screenshot" };
const hints: Record<BrowserAction, string> = {
  navigate: "https://example.com", click: "CSS selector, for example button[type=submit]", type: "Text to insert into the focused field", press: "Key, for example Enter", evaluate: "document.title", screenshot: "",
};
export default function BrowserUsePage() {
  const router = useRouter();
  const [navigating, startNavigation] = useTransition();
  const { path = [] } = useParams<{ path?: string[] }>();
  const fleet = useExecutionStations("browser");
  const owner = path[0] || fleet.owner;
  const selected = path[1] === "sessions" ? path[2] || "" : "";
  const view = selected ? path[3] || "control" : path[1] || "sessions";
  const base = `/browser-use/${encodeURIComponent(owner)}`;
  const station = fleet.stations.find(item => item.stationId === owner);
  const [busy, setBusy] = useState(false);
  useBreadcrumb([{ label: "Browser Use", href: "/browser-use" }, ...(owner ? [{ label: station?.name || owner, href: base }] : []), ...(selected ? [{ label: selected.slice(0, 8), href: `${base}/sessions/${encodeURIComponent(selected)}/control` }] : []), { label: view }], "browser-use");
  return <div>
    {selected && <Link className="execution-back" href={base}>← All browser sessions</Link>}
    <h1 className="page-title">{selected ? "Browser session" : "Browser Use"}</h1>
    <p className="execution-intro">{selected ? `${station?.name || owner} · ${selected}` : "Manage live sessions, saved profiles and recordings on each Station."}</p>
    <ExecutionAlert error={fleet.error} />
    {!selected && <ExecutionOwner label="Browser station" stations={fleet.stations} owner={owner} onChange={id => startNavigation(() => router.push(`/browser-use/${encodeURIComponent(id)}`))} busy={busy || navigating} refresh={fleet.refresh} />}
    {fleet.loading || navigating ? <p className="execution-note">Loading stations…</p> : !owner ? <div className="empty-state"><p className="empty-state-text">No Browser Use workers are configured in this network.</p></div> : <BrowserWorkspace key={`${owner}:${selected}:${view}`} owner={owner} selected={selected} view={view} invalidPath={path.length > (selected ? 4 : 2)} station={station} onBusy={setBusy} />}
  </div>;
}
function BrowserWorkspace({ owner, selected, view, invalidPath, station, onBusy }: { owner: string; selected: string; view: string; invalidPath: boolean; station?: ExecutionStation; onBusy: (busy: boolean) => void }) {
  const router = useRouter();
  const base = `/browser-use/${encodeURIComponent(owner)}`;
  const features = station?.features?.browser || {};
  const views = selected ? ["control", ...(features.liveView ? ["live"] : []), ...(features.pages ? ["pages"] : []), ...(features.commands ? ["tools"] : []), ...(features.inspection ? ["inspect"] : []), "diagnostics", ...(features.checkpoints ? ["recovery"] : []), "recordings"] : ["sessions", ...(features.profiles ? ["profiles"] : []), "diagnostics", ...(features.checkpoints ? ["recovery"] : []), "recordings"];
  const [sessions, setSessions] = useState<BrowserHandle[]>([]);
  const [loading, setLoading] = useState(true);
  const listRevision = useRef(0);
  const [action, setAction] = useState<BrowserAction>("navigate");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [advancedBusy, setAdvancedBusy] = useState(false);
  const [profile, setProfile] = useState("");
  const [actionPending, setActionPending] = useState(false);
  const closeRequested = useRef(new Set<string>());
  const locked = busy || closing || recordingBusy || advancedBusy;
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [screenshot, setScreenshot] = useState("");
  const reachable = Boolean(station?.available);
  const admit = reachable && station?.status === "online";
  const rpc = useCallback(<T,>(body: Record<string, unknown>) => executionRequest<T>(owner, "browser", body), [owner]);
  const refresh = useCallback(async () => {
    const revision = ++listRevision.current;
    try {
      const list = await rpc<BrowserHandle[]>({ method: "list" });
      if (revision !== listRevision.current) return;
      setSessions(list);
    } finally { setLoading(false); }
  }, [rpc]);
  useEffect(() => { if (reachable) void refresh().catch((e) => setError(executionError(e))); }, [reachable, refresh]);
  useEffect(() => { setResult(""); setScreenshot(""); setError(""); }, [selected]);
  useEffect(() => { onBusy(locked); return () => onBusy(false); }, [locked, onBusy]);
  const act = async (operation: () => Promise<void>, isAction = false) => {
    const operationSession = selected;
    setBusy(true); setActionPending(isAction); setError("");
    try { await operation(); }
    catch (e) { if (!isAction || !closeRequested.current.has(operationSession)) setError(executionError(e)); }
    finally { setBusy(false); setActionPending(false); }
  };
  const openBrowser = () => act(async () => {
    const handle = await rpc<BrowserHandle>({ method: "open", ...(profile && station?.features?.browser?.profiles ? { options: { profileId: profile } } : {}) });
    listRevision.current++;
    router.push(`${base}/sessions/${encodeURIComponent(handle.id)}/control`);
  });
  const closeBrowser = async () => {
    const id = selected;
    if (closing || recordingBusy || !id || (busy && !actionPending)) return;
    closeRequested.current.add(id);
    setClosing(true); setError("");
    try {
      await rpc({ method: "close", id });
      setScreenshot(""); setResult("");
      router.push(base);
    } catch (e) {
      closeRequested.current.delete(id);
      setError(executionError(e));
    } finally { setClosing(false); }
  };
  const perform = async () => {
    const response = await rpc<unknown>({ method: "action", id: selected, action, ...(action === "screenshot" ? {} : { value }) });
    if (closeRequested.current.has(selected)) return;
    if (action === "screenshot") {
      const image = response as { mimeType?: string; base64?: string } | null;
      if (!image || image.mimeType !== "image/png" || typeof image.base64 !== "string") throw new Error("The browser returned an unsupported screenshot format.");
      setScreenshot(`data:image/png;base64,${image.base64}`);
      setResult("Screenshot captured.");
    } else {
      setScreenshot("");
      const text = response === null || response === undefined ? `${actionLabels[action]} completed.` : typeof response === "string" ? response : JSON.stringify(response, null, 2);
      setResult(text.length > 40_000 ? `${text.slice(0, 40_000)}\n… Result display truncated.` : text);
    }
  };
  return <section className="execution-workbench" aria-label="Browser session manager">
    <OwnerNotice station={station} />
    <ExecutionNavigation label={selected ? "Browser session tools" : "Browser collections"} base={selected ? `${base}/sessions/${encodeURIComponent(selected)}` : base} current={view} items={views} />
    <ExecutionAlert error={error} />
    {invalidPath || !views.includes(view) ? <ExecutionAlert error="This browser page is not available on this station." /> : <>
    {!selected && view === "sessions" && <>
    {station?.features?.browser?.profiles && <label className="execution-field"><span>Persistent profile for next browser (optional)</span><input className="input-text" aria-label="Browser profile" placeholder="agent-workspace" value={profile} disabled={locked} onChange={e => setProfile(e.target.value)} /></label>}
    <div className="execution-toolbar">
      <button className="btn btn--primary" disabled={!admit || locked || loading} onClick={() => void openBrowser()}>Open browser</button>
      <button className="btn" disabled={!reachable || locked} onClick={() => void act(refresh)}>Refresh sessions</button>
      <span className="execution-note">{sessions.length} session{sessions.length === 1 ? "" : "s"}</span>
    </div>
    <div className="execution-resource-list" aria-label="Browser sessions">
      {sessions.map(session => <Link className="execution-resource" key={session.id} href={`${base}/sessions/${encodeURIComponent(session.id)}/control`} aria-label={`Open session ${session.id}`}>
        <span><strong className="mono">{session.id}</strong><span className="execution-note">{session.backend} · Live session</span></span><span aria-hidden="true">→</span>
      </Link>)}
    </div>
    {!sessions.length && <div className="empty-state"><p className="empty-state-text">{loading && reachable ? "Loading browser sessions…" : "No live browser sessions on this station. Open a browser to begin."}</p></div>}
    </>}
    {selected && <>
      {sessions.some(session => session.id === selected) ? <div className="execution-detail-heading" data-browser-session-id={selected}>
        <span className="execution-note">Sessions remain on their owning worker. Restarting that worker ends its live browsers.</span>
        <button className="btn btn--danger btn--sm" disabled={!reachable || closing || recordingBusy || advancedBusy || (busy && !actionPending)} onClick={() => void closeBrowser()}>Close browser</button>
      </div> : <p className="execution-note" role="status">{loading && reachable ? "Loading browser session…" : "This browser session is no longer available. Its recordings remain accessible from the station’s Recordings page."}</p>}
    </>}
    {selected && sessions.some(session => session.id === selected) && view === "control" && <div className="station-card execution-card">
      <form onSubmit={(event) => { event.preventDefault(); if (!admit || locked || !selected || (action !== "screenshot" && !value.trim())) return; void act(perform, true); }}>
        <label className="execution-field"><span>Browser action</span><select className="input-text" aria-label="Browser action" value={action} disabled={locked} onChange={(event) => { setAction(event.target.value as BrowserAction); setValue(""); }}>
          {(Object.keys(actionLabels) as BrowserAction[]).map((name) => <option key={name} value={name}>{actionLabels[name]}</option>)}
        </select></label>
        {action !== "screenshot" && <label className="execution-field"><span>Action value</span><textarea className="input-textarea" aria-label="Action value" rows={action === "evaluate" ? 5 : 2} placeholder={hints[action]} value={value} disabled={locked} onChange={(event) => setValue(event.target.value)} /></label>}
        <div className="execution-toolbar"><button className="btn btn--primary" type="submit" disabled={!admit || !selected || locked || (action !== "screenshot" && !value.trim())}>Run browser action</button>{locked && <span className="execution-note" role="status">{closing ? "Closing browser…" : "Browser operation in progress…"}</span>}</div>
      </form>
      {result && <div className="execution-result"><h2>Result</h2><pre className="execution-output" aria-label="Browser result">{result}</pre></div>}
      {screenshot && <figure className="execution-screenshot"><img src={screenshot} alt="Browser screenshot" /><figcaption className="execution-note">Captured from the selected browser session.</figcaption><a className="btn btn--sm" href={screenshot} download={`station-browser-${selected}.png`}>Download screenshot</a></figure>}
    </div>}
    {(view === "profiles" || (selected && sessions.some(session => session.id === selected) && (view === "pages" || view === "tools"))) && <BrowserAdvanced view={view as "profiles" | "pages" | "tools"} owner={owner} sessionId={selected} reachable={reachable} admit={admit && !busy && !closing && !recordingBusy} features={station?.features?.browser || {}} onBusy={setAdvancedBusy} profile={profile} onProfile={setProfile} />}
    {selected && sessions.some(session => session.id === selected) && view === "live" && features.liveView && <BrowserLive owner={owner} sessionId={selected} reachable={reachable} admit={admit && !busy && !closing && !recordingBusy} features={features} onBusy={setAdvancedBusy} />}
    {selected && sessions.some(session => session.id === selected) && view === "inspect" && features.inspection && <BrowserInspect owner={owner} sessionId={selected} admit={admit && !busy && !closing && !recordingBusy} onBusy={setAdvancedBusy} />}
    {view === "diagnostics" && <BrowserDiagnostics owner={owner} sessionId={selected || undefined} reachable={reachable} admit={admit && (!selected || sessions.some(session => session.id === selected)) && !busy && !closing && !recordingBusy} features={features} onBusy={setAdvancedBusy} />}
    {view === "recovery" && features.checkpoints && <BrowserRecovery owner={owner} sessionId={sessions.some(session => session.id === selected) ? selected : undefined} reachable={reachable} admit={admit && !busy && !closing && !recordingBusy} onBusy={setAdvancedBusy} />}
    {view === "profiles" && <button className="btn btn--primary" disabled={!admit || locked || !profile} onClick={() => void openBrowser()}>Open browser with profile</button>}
    {view === "recordings" && <BrowserRecordings owner={owner} sessionId={selected} reachable={reachable} admit={admit && sessions.some(session => session.id === selected)} browserBusy={busy || closing || advancedBusy} durable={station?.features?.browser?.durableRecordings} onBusy={setRecordingBusy} />}
    </>}
  </section>;
}
