"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { executionError, executionRequest } from "../hooks/use-execution";
import { ExecutionAlert } from "./execution-common";

import type { BrowserRecording as Recording } from "station-browser-use";

interface FrameImage { recordingId: string; frameId: string; src: string }

export function BrowserRecordings({ owner, sessionId, reachable, admit, browserBusy, onBusy }: {
  owner: string; sessionId: string; reachable: boolean; admit: boolean;
  browserBusy: boolean; onBusy: (busy: boolean) => void;
}) {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [selected, setSelected] = useState("");
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [image, setImage] = useState<FrameImage | null>(null);
  const [frameLoading, setFrameLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [frameError, setFrameError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const revision = useRef(0);
  const alive = useRef(true);
  const mutating = useRef(false);
  const rpc = useCallback(<T,>(body: Record<string, unknown>) => executionRequest<T>(owner, "browser", body), [owner]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; revision.current++; };
  }, []);
  useEffect(() => { onBusy(busy); }, [busy, onBusy]);

  const refresh = useCallback(async () => {
    const version = ++revision.current;
    const list = await rpc<Recording[]>({ method: "recordings" });
    if (!alive.current || version !== revision.current || mutating.current) return;
    setRecordings(list);
    setSelected((previous) => list.some((item) => item.id === previous) ? previous : list[0]?.id ?? "");
    setLoaded(true);
    setLoadError("");
  }, [rpc]);
  useEffect(() => {
    if (!reachable) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { if (!mutating.current) await refresh(); }
      catch (e) { if (!stopped) { setLoadError(executionError(e)); setLoaded(true); } }
      if (!stopped) timer = setTimeout(poll, 2_000);
    };
    void poll();
    return () => { stopped = true; revision.current++; clearTimeout(timer); };
  }, [reachable, refresh]);

  const recording = recordings.find((item) => item.id === selected);
  const index = Math.min(frameIndex, Math.max(0, (recording?.frames.length ?? 0) - 1));
  const frame = recording?.frames[index];
  const nextFrame = recording?.frames[index + 1];
  const visibleImage = image?.recordingId === selected && image.frameId === frame?.id ? image : null;
  useEffect(() => { setPlaying(false); setFrameIndex(0); setImage(null); setFrameError(""); }, [selected]);
  useEffect(() => { if (!reachable) { setPlaying(false); setImage(null); } }, [reachable]);

  useEffect(() => {
    setImage(null); setFrameError("");
    if (!reachable || !selected || !frame) { setFrameLoading(false); return; }
    const controller = new AbortController();
    let cancelled = false;
    setFrameLoading(true);
    const load = async () => {
      try {
        const response = await fetch(`/api/v1/stations/${encodeURIComponent(owner)}/execution/browser`, {
          method: "POST", credentials: "include", signal: controller.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ method: "recordingFrame", id: selected, frameId: frame.id }),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.message ?? "This recorded frame is unavailable. Refresh recordings to check the owner.");
        if (payload?.data?.mimeType !== "image/png" || typeof payload.data.base64 !== "string") throw new Error("The worker returned an unsupported recording frame.");
        if (!cancelled) setImage({ recordingId: selected, frameId: frame.id, src: `data:image/png;base64,${payload.data.base64}` });
      } catch (e) {
        if (!cancelled) { setFrameError(executionError(e)); setPlaying(false); }
      } finally { if (!cancelled) setFrameLoading(false); }
    };
    void load();
    return () => { cancelled = true; controller.abort(); };
  }, [owner, selected, frame?.id, reachable]);

  useEffect(() => {
    if (!playing || !reachable || !recording || !frame || !visibleImage || frameLoading) return;
    if (!nextFrame) {
      if (recording.status !== "recording") setPlaying(false);
      return;
    }
    const elapsed = Date.parse(nextFrame.capturedAt) - Date.parse(frame.capturedAt);
    const delay = Math.min(2_147_483_647, Math.max(100, Number.isFinite(elapsed) && elapsed > 0 ? elapsed : recording.intervalMs) / speed);
    const timer = setTimeout(() => setFrameIndex(index + 1), delay);
    return () => clearTimeout(timer);
  // Metadata polls produce new objects; only frame identity/timing may reset playback.
  }, [playing, reachable, selected, recording?.status, recording?.intervalMs, frame?.id, frame?.capturedAt, nextFrame?.id, nextFrame?.capturedAt, visibleImage, frameLoading, index, speed]);

  const mutate = async (operation: () => Promise<void>) => {
    if (mutating.current) return;
    mutating.current = true; revision.current++;
    setBusy(true); setError(""); setPlaying(false);
    try { await operation(); }
    catch (e) { if (alive.current) setError(executionError(e)); }
    finally { mutating.current = false; if (alive.current) setBusy(false); }
  };
  const replace = (updated: Recording) => {
    if (!alive.current) return;
    setRecordings((items) => items.some((item) => item.id === updated.id)
      ? items.map((item) => item.id === updated.id ? updated : item)
      : [...items, updated]);
  };
  const alreadyRecording = recordings.some((item) => item.sessionId === sessionId && item.status === "recording");

  return <section className="station-card execution-card" aria-label="Browser recordings">
    <h2 style={{ fontSize: "1rem", fontWeight: 500 }}>Recordings</h2>
    <p className="execution-note">Capture a frame every 5 seconds by default, even with this dashboard closed. Recordings remain after a browser closes, until you delete them or the worker restarts. Busy frames are skipped; storage limits stop capture.</p>
    <ExecutionAlert error={error || loadError} />
    <div className="execution-toolbar">
      <button className="btn btn--primary" disabled={!admit || !sessionId || busy || browserBusy || alreadyRecording || !loaded} onClick={() => void mutate(async () => {
        const created = await rpc<Recording>({ method: "recordingStart", id: sessionId });
        replace(created); if (alive.current) setSelected(created.id);
      })}>Start recording</button>
      <button className="btn" disabled={!reachable || busy} onClick={() => void refresh().catch((e) => setLoadError(executionError(e)))}>Refresh recordings</button>
      <span className="execution-note">{recordings.length} recording{recordings.length === 1 ? "" : "s"}</span>
    </div>
    {recording ? <>
      <div className="execution-toolbar">
        <label className="execution-field execution-grow"><span>Recording</span>
          <select className="input-text" aria-label="Recording selector" value={selected} disabled={busy} onChange={(event) => { setPlaying(false); setFrameIndex(0); setSelected(event.target.value); }}>
            {recordings.map((item) => <option key={item.id} value={item.id}>{new Date(item.startedAt).toLocaleString()} · {item.backend} · {item.status} · {item.id.slice(0, 8)}</option>)}
          </select>
        </label>
        <button className="btn" disabled={!reachable || busy || recording.status !== "recording"} onClick={() => void mutate(async () => replace(await rpc<Recording>({ method: "recordingStop", id: selected })))}>Stop recording</button>
        <button className="btn btn--danger" disabled={!reachable || busy || recording.status === "recording"} onClick={() => {
          if (!window.confirm("Delete this recording and all of its frames?")) return;
          void mutate(async () => {
            await rpc({ method: "recordingDelete", id: selected });
            if (!alive.current) return;
            const remaining = recordings.filter((item) => item.id !== selected);
            setRecordings(remaining);
            setSelected(remaining[0]?.id ?? ""); setImage(null);
          });
        }}>Delete recording</button>
      </div>
      <div className="execution-toolbar">
        <span className={`status-badge status-${recording.status === "recording" ? "running" : recording.status === "error" ? "failed" : "completed"}`} aria-label="Recording status">{recording.status}</span>
        <span className="execution-note">{recording.frames.length} frames · {recording.intervalMs / 1000}s interval · {(recording.bytes / (1024 * 1024)).toFixed(1)} MiB · {recording.skipped} skipped</span>
      </div>
      {recording.error && <p className="execution-note">Capture ended with an error. Frames already captured are still available.</p>}
      <ExecutionAlert error={frameError} />
      {recording.frames.length > 0 ? <>
        <div className="execution-toolbar">
          <button className="btn" disabled={!reachable || busy || recording.frames.length < 2} onClick={() => {
            if (playing) { setPlaying(false); return; }
            if (index >= recording.frames.length - 1) setFrameIndex(0);
            setPlaying(true);
          }}>{playing ? "Pause recording" : "Play recording"}</button>
          <label className="execution-field"><span>Playback speed</span><select className="input-text" aria-label="Playback speed" value={speed} onChange={(event) => setSpeed(Number(event.target.value))}><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option></select></label>
          <span className="execution-note" aria-label="Recording frame position">Frame {index + 1} of {recording.frames.length}</span>
        </div>
        <label className="execution-field"><span>Recording frame</span><input aria-label="Recording frame" type="range" min="0" max={recording.frames.length - 1} step="1" value={index} disabled={!reachable || busy} onChange={(event) => { setPlaying(false); setFrameIndex(Number(event.target.value)); }} /></label>
        {frame && <p className="execution-note"><time aria-label="Recorded frame timestamp" dateTime={frame.capturedAt}>{new Date(frame.capturedAt).toLocaleString()}</time></p>}
        {frameLoading && <p className="execution-note" role="status">Loading recorded frame…</p>}
        {visibleImage && reachable && <figure className="execution-screenshot"><img src={visibleImage.src} alt="Recorded browser frame" /></figure>}
      </> : <p className="execution-note" role="status">{recording.status === "recording" ? "Waiting for the first captured frame…" : "This recording has no captured frames."}</p>}
    </> : <p className="execution-note">{!loaded && reachable ? "Loading recordings…" : "No recording selected. Start a recording from a live browser session."}</p>}
  </section>;
}
