"use client";
import { useEffect, useState } from "react";
import type { BrowserInspection } from "station-browser-use";
import { executionError, executionRequest } from "../hooks/use-execution";
import { ExecutionAlert } from "./execution-common";
import { BrowserTargetFields, browserTarget, emptyLocator } from "./browser-target";
export function BrowserInspect({ owner, sessionId, admit, onBusy }: { owner: string; sessionId: string; admit: boolean; onBusy: (busy: boolean) => void }) {
  const [target, setTarget] = useState(emptyLocator), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [inspection, setInspection] = useState<BrowserInspection | null>(null), [snapshot, setSnapshot] = useState("");
  const [limit, setLimit] = useState(100);
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  const inspect = async (op: "inspect" | "accessibility") => {
    setBusy(true); setError("");
    try {
      const response = await executionRequest<BrowserInspection | { snapshot: string }>(owner, "browser", { method: "execute", id: sessionId, command: { op, ...(target.value || target.by === "role" ? { target: browserTarget(target) } : {}), ...(op === "inspect" ? { maxElements: limit, maxTextLength: 512 } : { depth: 10, boxes: true }) } });
      if (op === "inspect") { setInspection(response as BrowserInspection); setSnapshot(""); }
      else { setSnapshot((response as { snapshot: string }).snapshot); setInspection(null); }
    } catch (e) { setError(executionError(e)); } finally { setBusy(false); }
  };
  return <section className="station-card execution-card" aria-label="Browser inspection"><h2>Inspect page</h2><p className="execution-note">Read structured elements or an accessibility snapshot from the selected page. Leave the locator empty to inspect the page. Snapshots are captured on request.</p><ExecutionAlert error={error} />
    <BrowserTargetFields value={target} onChange={setTarget} optional disabled={busy} />
    <label className="execution-field"><span>Maximum elements</span><input className="input-text" aria-label="Inspection element limit" type="number" min={1} max={500} value={limit} disabled={busy} onChange={event => setLimit(Number(event.target.value))} /></label>
    <div className="execution-toolbar"><button className="btn btn--primary" disabled={!admit || busy || limit < 1 || limit > 500} onClick={() => void inspect("inspect")}>Inspect elements</button><button className="btn" disabled={!admit || busy} onClick={() => void inspect("accessibility")}>Accessibility snapshot</button></div>
    {inspection && <div aria-label="Inspected browser elements"><p className="execution-note">{inspection.title} · {inspection.url} · {inspection.elements.length} elements · Bounds use the {inspection.coordinateSpace === "frame-viewport" ? "selected frame" : "main page"} viewport{inspection.truncated ? " · Result truncated" : ""}</p><div className="execution-resource-list">{inspection.elements.map(element => <div className="execution-resource" key={element.index} style={{ display: "block" }}><strong className="mono">{element.index}. {element.role || element.tag}{element.label ? ` · ${element.label}` : ""}</strong><p style={{ overflowWrap: "anywhere" }}>{element.text}</p><p className="execution-note">{element.testId ? `Test ID: ${element.testId} · ` : ""}{element.disabled ? "Disabled · " : ""}{element.checked !== undefined ? `Checked: ${element.checked} · ` : ""}{element.box ? `Bounds: ${Math.round(element.box.x)}, ${Math.round(element.box.y)} · ${Math.round(element.box.width)}×${Math.round(element.box.height)}` : ""}</p></div>)}</div></div>}
    {snapshot && <pre className="execution-output" aria-label="Browser accessibility snapshot">{snapshot}</pre>}
  </section>;
}
