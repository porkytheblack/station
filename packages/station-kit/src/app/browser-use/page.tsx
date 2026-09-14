"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useBreadcrumb } from "../hooks/use-breadcrumb";
import { executionError, executionRequest, useExecutionStations, type ExecutionStation } from "../hooks/use-execution";
import { ExecutionAlert, ExecutionOwner, OwnerNotice } from "../components/execution-common";
import type { BrowserHandle, BrowserAction } from "station-browser-use";

const actionLabels: Record<BrowserAction, string> = { navigate: "Navigate", click: "Click", type: "Type", press: "Press key", evaluate: "Evaluate JavaScript", screenshot: "Take screenshot" };
const hints: Record<BrowserAction, string> = {
  navigate: "https://example.com", click: "CSS selector, for example button[type=submit]", type: "Text to insert into the focused field", press: "Key, for example Enter", evaluate: "document.title", screenshot: "",
};
export default function BrowserUsePage() {
  useBreadcrumb([{ label: "Browser Use" }], "browser-use");
  const fleet = useExecutionStations("browser");
  const [busy, setBusy] = useState(false);
  return <div>
    <h1 className="page-title">Browser Use</h1>
    <p className="execution-intro">Control browser sessions and capture screenshots on a selected Station.</p>
    <ExecutionAlert error={fleet.error} />
    <ExecutionOwner label="Browser station" stations={fleet.stations} owner={fleet.owner} onChange={fleet.setOwner} busy={busy} refresh={fleet.refresh} />
    {fleet.loading ? <p className="execution-note">Loading stations…</p> : !fleet.owner ? <div className="empty-state"><p className="empty-state-text">No Browser Use workers are configured in this network.</p></div> : <BrowserWorkspace key={fleet.owner} owner={fleet.owner} station={fleet.station} onBusy={setBusy} />}
  </div>;
}
function BrowserWorkspace({ owner, station, onBusy }: { owner: string; station?: ExecutionStation; onBusy: (busy: boolean) => void }) {
  const [sessions, setSessions] = useState<BrowserHandle[]>([]);
  const [loading, setLoading] = useState(true);
  const listRevision = useRef(0);
  const [selected, setSelected] = useState("");
  const [action, setAction] = useState<BrowserAction>("navigate");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const closeRequested = useRef(new Set<string>());
  const locked = busy || closing;
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
      setSelected((previous) => list.some((item) => item.id === previous) ? previous : list[0]?.id ?? "");
    } finally { setLoading(false); }
  }, [rpc]);
  useEffect(() => { if (reachable) void refresh().catch((e) => setError(executionError(e))); }, [reachable, refresh]);
  useEffect(() => { setResult(""); setScreenshot(""); setError(""); }, [selected]);
  useEffect(() => { onBusy(locked); }, [locked, onBusy]);
  const act = async (operation: () => Promise<void>, isAction = false) => {
    const operationSession = selected;
    setBusy(true); setActionPending(isAction); setError("");
    try { await operation(); }
    catch (e) { if (!isAction || !closeRequested.current.has(operationSession)) setError(executionError(e)); }
    finally { setBusy(false); setActionPending(false); }
  };
  const closeBrowser = async () => {
    const id = selected;
    if (closing || !id || (busy && !actionPending)) return;
    closeRequested.current.add(id);
    setClosing(true); setError("");
    try {
      await rpc({ method: "close", id });
      setScreenshot(""); setResult("");
      await refresh();
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
    <p className="execution-note">Sessions remain on their owning worker. Restarting that worker ends its live browsers.</p>
    <ExecutionAlert error={error} />
    <div className="execution-toolbar">
      <button className="btn btn--primary" disabled={!admit || locked || loading} onClick={() => void act(async () => { const handle = await rpc<BrowserHandle>({ method: "open" }); listRevision.current++; setSessions((items) => [...items, handle]); setSelected(handle.id); })}>Open browser</button>
      <button className="btn" disabled={!reachable || locked} onClick={() => void act(refresh)}>Refresh sessions</button>
      <span className="execution-note">{sessions.length} session{sessions.length === 1 ? "" : "s"}</span>
    </div>
    {sessions.length > 0 ? <div className="station-card execution-card">
      <div className="execution-toolbar">
        <label className="execution-field execution-grow"><span>Browser session</span><select className="input-text" aria-label="Browser session" value={selected} disabled={locked} onChange={(event) => setSelected(event.target.value)}>
          {sessions.map((session) => <option key={session.id} value={session.id}>{session.id} · {session.backend}</option>)}
        </select></label>
        <button className="btn btn--danger" disabled={!reachable || !selected || closing || (busy && !actionPending)} onClick={() => void closeBrowser()}>Close browser</button>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); if (!admit || locked || !selected || (action !== "screenshot" && !value.trim())) return; void act(perform, true); }}>
        <label className="execution-field"><span>Browser action</span><select className="input-text" aria-label="Browser action" value={action} disabled={locked} onChange={(event) => { setAction(event.target.value as BrowserAction); setValue(""); }}>
          {(Object.keys(actionLabels) as BrowserAction[]).map((name) => <option key={name} value={name}>{actionLabels[name]}</option>)}
        </select></label>
        {action !== "screenshot" && <label className="execution-field"><span>Action value</span><textarea className="input-textarea" aria-label="Action value" rows={action === "evaluate" ? 5 : 2} placeholder={hints[action]} value={value} disabled={locked} onChange={(event) => setValue(event.target.value)} /></label>}
        <div className="execution-toolbar"><button className="btn btn--primary" type="submit" disabled={!admit || !selected || locked || (action !== "screenshot" && !value.trim())}>Run browser action</button>{locked && <span className="execution-note" role="status">{closing ? "Closing browser…" : "Browser operation in progress…"}</span>}</div>
      </form>
      {result && <div className="execution-result"><h2>Result</h2><pre className="execution-output" aria-label="Browser result">{result}</pre></div>}
      {screenshot && <figure className="execution-screenshot"><img src={screenshot} alt="Browser screenshot" /><figcaption className="execution-note">Captured from the selected browser session.</figcaption><a className="btn btn--sm" href={screenshot} download={`station-browser-${selected}.png`}>Download screenshot</a></figure>}
    </div> : <div className="empty-state"><p className="empty-state-text">{loading && reachable ? "Loading browser sessions…" : "No live browser sessions on this station. Open a browser to begin."}</p></div>}
  </section>;
}
