"use client";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { ExecutionAlert } from "./execution-common";
import { executionError } from "../hooks/use-execution";

type Lease = { token: string; expiresAt: string };
type Control = { mode: "automation" | "human"; expiresAt?: string };
type Frame = { mimeType: "image/png"; base64: string; capturedAt: string };
class LiveError extends Error { constructor(message: string, readonly status: number) { super(message); } }

export function BrowserLive({ owner, sessionId, reachable, admit, features, onBusy }: { owner: string; sessionId: string; reachable: boolean; admit: boolean; features: Record<string, boolean>; onBusy: (busy: boolean) => void }) {
  const [frame, setFrame] = useState<Frame | null>(null), [paused, setPaused] = useState(false);
  const [lease, setLease] = useState<Lease | null>(null), [control, setControl] = useState<Control>({ mode: "automation" });
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [frameError, setFrameError] = useState(""), [notice, setNotice] = useState("");
  const [text, setText] = useState(""), [key, setKey] = useState("Enter"), [now, setNow] = useState(Date.now());
  const held = useRef<Lease | null>(null), alive = useRef(true), image = useRef<HTMLImageElement>(null), acting = useRef(false), polling = useRef<Promise<void> | null>(null);
  const rpc = useCallback(async <T,>(body: Record<string, unknown>, signal?: AbortSignal, keepalive = false): Promise<T> => {
    const response = await fetch(`/api/v1/stations/${encodeURIComponent(owner)}/execution/browser`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: sessionId, ...body }), signal, keepalive });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new LiveError(result?.message ?? `Browser request failed (${response.status}).`, response.status);
    return result.data as T;
  }, [owner, sessionId]);
  const forget = useCallback((message: string) => { held.current = null; setLease(null); setNotice(message); }, []);
  useEffect(() => { onBusy(busy || control.mode === "human"); return () => onBusy(false); }, [busy, control.mode, onBusy]);
  useEffect(() => {
    alive.current = true;
    const relinquish = () => { const active = held.current; held.current = null; if (active) void rpc({ method: "controlRelease", controlToken: active.token }, undefined, true).catch(() => {}); };
    const restored = (event: PageTransitionEvent) => { if (event.persisted) { setLease(null); setControl({ mode: "automation" }); setNotice("Control ended when you left this page. Take control again to send input."); } };
    window.addEventListener("pagehide", relinquish);
    window.addEventListener("pageshow", restored);
    return () => { alive.current = false; window.removeEventListener("pagehide", relinquish); window.removeEventListener("pageshow", restored); relinquish(); };
  }, [rpc]);
  useEffect(() => {
    if (!reachable) return;
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    const poll = async () => {
      const token = held.current?.token;
      try {
        const status = await rpc<Control>({ method: "control" }, abort.signal);
        if (stopped) return;
        setControl(status);
        if (token && held.current?.token === token && status.mode !== "human") forget("Control ended. Take control again to send input.");
        if (!paused && !acting.current) {
          const next = await rpc<Frame>({ method: "liveFrame" }, abort.signal);
          if (stopped) return;
          if (next.mimeType !== "image/png" || typeof next.base64 !== "string") throw new Error("The browser returned an unsupported frame.");
          setFrame(next); setFrameError("");
        }
      } catch (e) { if (!stopped && !(e instanceof LiveError && e.status === 409)) setFrameError(executionError(e)); }
      finally { if (!stopped) timer = setTimeout(run, 1000); }
    };
    const run = () => { const task = poll(); polling.current = task; void task.finally(() => { if (polling.current === task) polling.current = null; }); };
    run();
    return () => { stopped = true; clearTimeout(timer); abort.abort(); };
  }, [rpc, reachable, paused, forget]);
  useEffect(() => {
    if (!lease) return;
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const renew = async () => {
      try {
        const next = await rpc<Lease>({ method: "controlRenew", controlToken: lease.token, ttlMs: 30_000 });
        if (!stopped && held.current?.token === lease.token) { held.current = { ...next, token: lease.token }; setLease(held.current); }
      } catch (e) { if (!stopped && held.current?.token === lease.token) forget(`Control renewal failed. ${executionError(e)}`); }
    };
    timer = setTimeout(() => { void renew(); }, 10_000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [lease, rpc, forget]);
  useEffect(() => {
    const timer = setInterval(() => { const time = Date.now(); setNow(time); if (held.current && Date.parse(held.current.expiresAt) <= time) forget("Your control lease expired. Take control again to send input."); }, 1000);
    return () => clearInterval(timer);
  }, [forget]);
  const mutate = async (operation: () => Promise<void>) => {
    if (acting.current) return;
    acting.current = true; setBusy(true); setError("");
    try { await polling.current; await operation(); } catch (e) { if (alive.current) setError(executionError(e)); }
    finally { acting.current = false; if (alive.current) setBusy(false); }
  };
  const acquire = () => mutate(async () => {
    const next = await rpc<Lease>({ method: "controlAcquire", ttlMs: 30_000 });
    if (!alive.current) { await rpc({ method: "controlRelease", controlToken: next.token }, undefined, true); return; }
    held.current = next; setLease(next); setControl({ mode: "human", expiresAt: next.expiresAt }); setNotice("You control this browser. Automation is paused until you release control or the lease expires.");
  });
  const release = () => mutate(async () => {
    const active = held.current; if (!active) return;
    await rpc({ method: "controlRelease", controlToken: active.token });
    if (alive.current) { forget("Control released to automation."); setControl({ mode: "automation" }); }
  });
  const input = (body: Record<string, unknown>) => mutate(async () => {
    const active = held.current;
    if (!active || Date.parse(active.expiresAt) <= Date.now()) { forget("Take control before sending input."); return; }
    await rpc({ ...body, controlToken: active.token });
  });
  const click = (event: MouseEvent<HTMLButtonElement>) => {
    const element = image.current; if (event.detail === 0 || !element || !element.naturalWidth || !lease) return;
    const bounds = element.getBoundingClientRect();
    const x = Math.max(0, Math.min(element.naturalWidth - 1, (event.clientX - bounds.left - element.clientLeft) * element.naturalWidth / element.clientWidth));
    const y = Math.max(0, Math.min(element.naturalHeight - 1, (event.clientY - bounds.top - element.clientTop) * element.naturalHeight / element.clientHeight));
    void input({ method: "execute", command: { op: "mouseClick", x, y } });
  };
  const controls = admit && !!lease && !busy && Date.parse(lease.expiresAt) > now;
  return <section className="station-card execution-card" aria-label="Live browser view">
    <h2>Live view</h2>
    <p className="execution-note">Refreshed screenshots, approximately once per second while this page is open. Busy frames are skipped. This view does not keep an idle browser alive.</p>
    <ExecutionAlert error={error || frameError} />
    <div className="execution-toolbar"><button className="btn" onClick={() => setPaused(value => !value)}>{paused ? "Resume live view" : "Pause live view"}</button>
      {features.humanControl && (lease ? <button className="btn btn--primary" disabled={!reachable || busy} onClick={() => void release()}>Release control</button> : <button className="btn btn--primary" disabled={!admit || busy || control.mode === "human"} onClick={() => void acquire()}>Take control</button>)}
      <span className="execution-note" role="status" aria-label="Browser control status">{lease ? `You have control · ${Math.max(0, Math.ceil((Date.parse(lease.expiresAt) - now) / 1000))}s lease` : control.mode === "human" ? "Another controller has control" : "Automation control"}</span>
    </div>
    {notice && <p className="execution-note" role="status">{notice}</p>}
    {frame ? <figure className="execution-screenshot"><button type="button" aria-label="Click live browser" disabled={!controls || !features.pointer} onClick={click} onKeyDown={event => { if (controls && ["Enter", " ", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape"].includes(event.key)) { event.preventDefault(); void input({ method: "action", action: "press", value: event.key === " " ? "Space" : event.key }); } }} style={{ display: "block", width: "100%", padding: 0, border: 0, background: "transparent", cursor: controls && features.pointer ? "crosshair" : "default" }}><img ref={image} src={`data:image/png;base64,${frame.base64}`} alt="Live browser screenshot" style={{ display: "block", width: "100%", height: "auto" }} /></button><figcaption className="execution-note">{paused ? "Paused frame" : "Last frame"} · {new Date(frame.capturedAt).toLocaleTimeString()}{lease && features.pointer ? " · Click the image to interact." : lease ? " · Use the text and key controls below." : " · Read-only preview."}</figcaption></figure> : <p className="execution-note">{paused ? "Live view is paused." : "Waiting for a browser frame…"}</p>}
    {features.humanControl && <><form onSubmit={event => { event.preventDefault(); if (controls && text) void input({ method: "action", action: "type", value: text }); }}><label className="execution-field"><span>Text for the focused field</span><textarea className="input-textarea" aria-label="Live browser text" value={text} maxLength={65_536} disabled={!controls} onChange={event => setText(event.target.value)} /></label><button className="btn" disabled={!controls || !text}>Send text</button></form>
      <form className="execution-toolbar" onSubmit={event => { event.preventDefault(); if (controls && key.trim()) void input({ method: "action", action: "press", value: key }); }}><label className="execution-field execution-grow"><span>Key or shortcut</span><input className="input-text" aria-label="Live browser key" value={key} disabled={!controls} onChange={event => setKey(event.target.value)} placeholder="Enter, Tab, Control+a" /></label><button className="btn" disabled={!controls || !key.trim()}>Send key</button></form><p className="execution-note">Control renews while this view is open and is released when you leave. A lost connection allows the lease to expire; it is never silently reacquired.</p></>}
  </section>;
}
