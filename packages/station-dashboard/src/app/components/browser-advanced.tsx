"use client";
import { useCallback, useEffect, useState } from "react";
import type { BrowserCommand, BrowserPage, BrowserArtifact, BrowserProfile } from "station-browser-use";
import { executionRequest, executionError } from "../hooks/use-execution";
import { ExecutionAlert } from "./execution-common";
import { BrowserTargetFields, browserTarget, emptyLocator } from "./browser-target";
export function BrowserAdvanced({ view, owner, sessionId, admit, reachable, features, onBusy, profile, onProfile }: { view: "profiles" | "pages" | "tools"; owner: string; sessionId: string; admit: boolean; reachable: boolean; features: Record<string, boolean>; onBusy: (value: boolean) => void; profile: string; onProfile: (value: string) => void }) {
  const [pages, setPages] = useState<BrowserPage[]>([]), [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [url, setUrl] = useState(""), [op, setOp] = useState("fill"), [value, setValue] = useState(""), [checked, setChecked] = useState(true);
  const [locator, setLocator] = useState(emptyLocator), [destination, setDestination] = useState(""), [dialogAction, setDialogAction] = useState<"accept" | "dismiss">("dismiss");
  const selector = locator.value;
  const element = features.locators ? { target: browserTarget(locator) } : { selector };
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [result, setResult] = useState("");
  const [artifact, setArtifact] = useState<BrowserArtifact | null>(null), [download, setDownload] = useState("");
  const rpc = useCallback(<T,>(body: Record<string, unknown>) => executionRequest<T>(owner, "browser", body), [owner]);
  useEffect(() => { onBusy(busy); }, [busy, onBusy]);
  useEffect(() => () => { if (download) URL.revokeObjectURL(download); }, [download]);
  useEffect(() => { setPages([]); setResult(""); setArtifact(null); setDownload(""); setError(""); }, [sessionId]);
  useEffect(() => {
    if (!reachable || !features.profiles || view !== "profiles") return;
    let cancelled = false;
    void rpc<BrowserProfile[]>({ method: "profiles" }).then(list => { if (!cancelled) setProfiles(list); }).catch(e => { if (!cancelled) setError(executionError(e)); });
    return () => { cancelled = true; };
  }, [rpc, reachable, features.profiles, sessionId, view]);
  useEffect(() => {
    if (view !== "pages" || !reachable || !features.pages || !sessionId) return;
    let cancelled = false;
    void rpc<BrowserPage[]>({ method: "execute", id: sessionId, command: { op: "pages" } }).then(list => { if (!cancelled) setPages(list); }).catch(e => { if (!cancelled) setError(executionError(e)); });
    return () => { cancelled = true; };
  }, [view, reachable, features.pages, sessionId, rpc]);
  const run = async (command: BrowserCommand) => {
    setBusy(true); setError("");
    try { const response = await rpc<unknown>({ method: "execute", id: sessionId, command });
      if (command.op === "pages") setPages(response as BrowserPage[]);
      else if (command.op === "download") { setArtifact(response as BrowserArtifact); setDownload(""); }
      else if (command.op === "downloadRead") { const file = response as { base64: string }; setDownload(URL.createObjectURL(new Blob([Uint8Array.from(atob(file.base64), c => c.charCodeAt(0))]))); }
      else if (command.op === "downloadDelete") { setArtifact(null); setDownload(""); }
      else setResult(typeof response === "string" ? response.slice(0, 40_000) : JSON.stringify(response ?? { completed: command.op }, null, 2).slice(0, 40_000));
      if (["newPage", "selectPage", "closePage"].includes(command.op)) setPages(await rpc<BrowserPage[]>({ method: "execute", id: sessionId, command: { op: "pages" } }));
    } catch (e) { setError(executionError(e)); } finally { setBusy(false); }
  };
  const perform = () => {
    const command: BrowserCommand = op === "fill" ? { op, ...element, value } : op === "select" ? { op, ...element, values: value.split(",") } : op === "check" ? { op, ...element, checked } : ["hover", "click", "focus"].includes(op) ? { op: op as "hover" | "click" | "focus", ...element } : op === "press" ? { op, ...element, key: value } : op === "waitFor" ? { op, ...element, state: "visible" } : op === "scroll" ? { op, x: 0, y: Number(value) } : op === "download" ? { op, ...element } : op === "drag" ? { op, source: browserTarget(locator), destination: { by: "selector", value: destination, ...(browserTarget(locator).frame ? { frame: browserTarget(locator).frame } : {}) } } : op === "dialog" ? { op, action: dialogAction, ...(value ? { promptText: value } : {}), expiresInMs: 30_000 } : { op: op as "content" | "back" | "forward" | "reload" };
    void run(command);
  };
  return <section className="station-card execution-card" aria-label="Advanced browser controls"><h2>{view === "profiles" ? "Saved profiles" : view === "pages" ? "Browser pages" : "Browser tools"}</h2><ExecutionAlert error={error} />
    {view === "profiles" && features.profiles && <><label className="execution-field"><span>Saved profiles</span><select className="input-text" aria-label="Saved browser profile" value={profile} disabled={busy} onChange={e => onProfile(e.target.value)}><option value="">Ephemeral session</option>{profiles.map(p => <option key={p.id} value={p.id}>{p.id}{p.inUse ? " · in use" : ""}</option>)}</select></label><button className="btn btn--danger" disabled={!admit || busy || !profile || profiles.find(p => p.id === profile)?.inUse} onClick={() => { if (!window.confirm(`Delete saved profile ${profile}?`)) return; setBusy(true); void rpc({ method: "profileDelete", id: profile }).then(() => { setProfiles(old => old.filter(p => p.id !== profile)); onProfile(""); }).catch(e => setError(executionError(e))).finally(() => setBusy(false)); }}>Delete profile</button></>}
    {view === "pages" && features.pages && sessionId && <><div className="execution-toolbar"><input className="input-text execution-grow" aria-label="New page URL" placeholder="https://example.com" value={url} onChange={e => setUrl(e.target.value)} /><button className="btn" disabled={!admit || busy} onClick={() => void run({ op: "newPage", ...(url ? { url } : {}) })}>New page</button><button className="btn" disabled={!admit || busy} onClick={() => void run({ op: "pages" })}>Refresh pages</button></div>
      {pages.map(p => <div className="execution-file-row" key={p.id}><button className="btn btn--sm" disabled={!admit || busy || p.selected} onClick={() => void run({ op: "selectPage", pageId: p.id })}>{p.selected ? "Selected: " : ""}{p.title || p.url}</button><button className="btn btn--sm" disabled={!admit || busy || pages.length < 2} onClick={() => void run({ op: "closePage", pageId: p.id })}>Close page</button></div>)}
    </>}
    {view === "tools" && sessionId && <><form onSubmit={e => { e.preventDefault(); if (admit && !busy) perform(); }}><label className="execution-field"><span>Page operation</span><select className="input-text" aria-label="Page operation" value={op} onChange={e => setOp(e.target.value)}>{["fill", "select", "check", "hover", "waitFor", ...(features.locators ? ["click", "focus", "press", "drag"] : []), "scroll", "content", "back", "forward", "reload", ...(features.downloads ? ["download"] : []), ...(features.dialogs ? ["dialog"] : [])].map(name => <option key={name} value={name}>{name}</option>)}</select></label>
      {["fill", "select", "check", "hover", "click", "focus", "press", "waitFor", "download", "drag"].includes(op) && (features.locators ? <BrowserTargetFields value={locator} onChange={setLocator} disabled={busy} /> : <label className="execution-field"><span>Element selector</span><input className="input-text" aria-label="Element selector" value={selector} onChange={e => setLocator({ ...locator, value: e.target.value })} /></label>)}
      {op === "drag" && <label className="execution-field"><span>Destination selector (in the same frame)</span><input className="input-text" aria-label="Drag destination selector" value={destination} onChange={event => setDestination(event.target.value)} /></label>}
      {op === "dialog" && <><label className="execution-field"><span>Next dialog action</span><select className="input-text" aria-label="Dialog action" value={dialogAction} onChange={event => setDialogAction(event.target.value as "accept" | "dismiss")}><option value="dismiss">Dismiss</option><option value="accept">Accept</option></select></label><p className="execution-note">Arms the next dialog on this page for 30 seconds. Other dialogs are dismissed automatically.</p></>}
      {["fill", "select", "scroll", "press", "dialog"].includes(op) && <label className="execution-field"><span>{op === "select" ? "Values separated by commas" : op === "scroll" ? "Vertical pixels" : op === "press" ? "Key or shortcut" : op === "dialog" ? "Prompt response (optional)" : "Value"}</span><input className="input-text" aria-label="Page operation value" value={value} onChange={e => setValue(e.target.value)} /></label>}
      {op === "check" && <label><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} /> Checked</label>}
      <div className="execution-toolbar"><button className="btn btn--primary" disabled={!admit || busy}>Run page operation</button></div></form>
      {features.uploads && <label className="execution-field"><span>Upload to the element selector (up to 4 MiB)</span><input type="file" aria-label="Browser upload file" disabled={!admit || busy || !(selector || features.locators && locator.by === "role")} onChange={e => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 4 * 1024 * 1024) { setError("Upload exceeds 4 MiB."); return; } const reader = new FileReader(); reader.onerror = () => setError("Could not read file."); reader.onload = () => void run({ op: "upload", ...element, files: [{ name: file.name, mimeType: file.type || "application/octet-stream", base64: String(reader.result).split(",")[1] }] }); reader.readAsDataURL(file); e.target.value = ""; }} /></label>}
      {artifact && <div className="execution-toolbar"><span className="execution-note">{artifact.name} · {artifact.bytes} bytes</span><button className="btn" disabled={!reachable || busy} onClick={() => void run({ op: "downloadRead", artifactId: artifact.id })}>Retrieve download</button>{download && <a className="btn" href={download} download={artifact.name}>Save download</a>}<button className="btn" disabled={!reachable || busy} onClick={() => void run({ op: "downloadDelete", artifactId: artifact.id })}>Delete download</button></div>}
      {result && <pre className="execution-output" aria-label="Page operation result">{result}</pre>}
    </>}
  </section>;
}
