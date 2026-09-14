"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalOutput, TerminalSession } from "station-sandbox";
import { executionRequest, executionError } from "../hooks/use-execution";
import { ExecutionAlert } from "./execution-common";

export function SandboxTerminal({ owner, workspace, admit, reachable }: { owner: string; workspace: string; admit: boolean; reachable: boolean }) {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const rpc = useCallback(<T,>(body: Record<string, unknown>) => executionRequest<T>(owner, "sandbox", { id: workspace, ...body }), [owner, workspace]);
  const refresh = useCallback(async () => {
    const list = await rpc<TerminalSession[]>({ method: "terminals" });
    setSessions(list); setSelected(old => list.some(s => s.id === old) ? old : list.find(s => s.status === "running")?.id ?? list[0]?.id ?? "");
  }, [rpc]);
  useEffect(() => { if (reachable) void refresh().catch(e => setError(executionError(e))); }, [refresh, reachable]);
  useEffect(() => {
    if (!selected || !container.current || !reachable) return;
    let disposed = false;
    let cleanup = () => {};
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !container.current) return;
      const term = new Terminal({ cursorBlink: true, fontSize: 13, scrollback: 1000, disableStdin: !admit, theme: { background: "#101214", foreground: "#eeeae3" } });
      const fit = new FitAddon(); term.loadAddon(fit); term.open(container.current); fit.fit();
      term.textarea?.setAttribute("aria-label", "Sandbox terminal input");
      let offset = 0, inputBytes = 0, inputFailed = false;
      let queued = Promise.resolve();
      let timer: ReturnType<typeof setTimeout>;
      let resizeTimer: ReturnType<typeof setTimeout>;
      const input = term.onData(data => {
        if (!admit || inputFailed || disposed) return;
        const size = new TextEncoder().encode(data).length;
        if (inputBytes + size > 65_536) { setError("Terminal input queue is full. Reconnect before sending more input."); inputFailed = true; term.options.disableStdin = true; return; }
        inputBytes += size;
        queued = queued.then(async () => { if (!disposed && !inputFailed) await rpc({ method: "terminalInput", terminalId: selected, data }); })
          .catch(e => { inputFailed = true; term.options.disableStdin = true; if (!disposed) setError(`Input stopped: ${executionError(e)}`); })
          .finally(() => { inputBytes -= size; });
      });
      const resize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (disposed) return; fit.fit(); if (admit) void rpc({ method: "resizeTerminal", terminalId: selected, cols: Math.max(2, Math.min(500, term.cols)), rows: Math.max(1, Math.min(500, term.rows)) }).catch(e => { if (!disposed) setError(executionError(e)); }); }, 200); };
      const observer = new ResizeObserver(resize); observer.observe(container.current); resize();
      const poll = async () => {
        try {
          const output = await rpc<TerminalOutput>({ method: "terminal", terminalId: selected, offset });
          if (disposed) return;
          if (output.truncated && offset < output.startOffset) term.writeln("\r\n[Earlier output expired from the worker buffer]");
          if (output.data) term.write(output.data);
          offset = output.nextOffset;
          if (output.status !== "running") { term.options.disableStdin = true; term.writeln(`\r\n[Terminal ${output.status}]`); void refresh().catch(() => {}); return; }
          timer = setTimeout(poll, 200);
        } catch (e) { if (!disposed) { term.options.disableStdin = true; setError(`Terminal disconnected: ${executionError(e)}`); } }
      };
      cleanup = () => { clearTimeout(timer); clearTimeout(resizeTimer); observer.disconnect(); input.dispose(); term.dispose(); };
      void poll();
    })().catch(e => { if (!disposed) setError(executionError(e)); });
    return () => { disposed = true; cleanup(); };
  }, [selected, rpc, admit, reachable, revision, refresh]);
  const mutate = async (operation: () => Promise<void>) => { setBusy(true); setError(""); try { await operation(); } catch (e) { setError(executionError(e)); } finally { setBusy(false); } };
  return <section className="station-card execution-card" aria-label="Interactive terminals">
    <h2>Terminals</h2><p className="execution-note">Interactive shells remain on this worker when you leave the page. Reconnecting restores retained output; restarting the worker interrupts terminals.</p>
    <ExecutionAlert error={error} />
    <div className="execution-toolbar">
      <button className="btn btn--primary" disabled={!admit || busy} onClick={() => void mutate(async () => { const session = await rpc<TerminalSession>({ method: "openTerminal", options: { cols: 100, rows: 24 } }); await refresh(); setSelected(session.id); })}>Open terminal</button>
      <select className="input-text execution-grow" aria-label="Terminal session" disabled={busy} value={selected} onChange={e => { setSelected(e.target.value); setError(""); }}><option value="">Select terminal</option>{sessions.map(s => <option key={s.id} value={s.id}>{s.id.slice(0, 8)} · {s.status}</option>)}</select>
      <button className="btn" disabled={!selected || !reachable || busy} onClick={() => { setError(""); setRevision(n => n + 1); }}>Reconnect terminal</button>
      <button className="btn btn--danger" disabled={!selected || !reachable || busy} onClick={() => void mutate(async () => { await rpc({ method: "closeTerminal", terminalId: selected }); await refresh(); setRevision(n => n + 1); })}>Close terminal</button>
    </div>
    {selected && <div ref={container} className="sandbox-terminal" aria-label="Sandbox terminal" />}
  </section>;
}
