"use client";
import { useCallback, useEffect, useState } from "react";
import type { SandboxService } from "station-sandbox";
import { executionRequest, executionError } from "../hooks/use-execution";
import { ExecutionAlert } from "./execution-common";
export function SandboxServices({ owner, workspace, admit, reachable }: { owner: string; workspace: string; admit: boolean; reachable: boolean }) {
  const [services, setServices] = useState<SandboxService[]>([]), [selected, setSelected] = useState("");
  const [name, setName] = useState(""), [command, setCommand] = useState(""), [policy, setPolicy] = useState("never");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const rpc = useCallback(<T,>(body: Record<string, unknown>) => executionRequest<T>(owner, "sandbox", { id: workspace, ...body }), [owner, workspace]);
  useEffect(() => {
    if (!reachable) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { try { const result = await rpc<SandboxService[]>({ method: "services" }); if (!cancelled) { setServices(result); setSelected(old => result.some(s => s.id === old) ? old : result[0]?.id ?? ""); } } catch (e) { if (!cancelled) setError(executionError(e)); } if (!cancelled) timer = setTimeout(poll, 1500); };
    void poll(); return () => { cancelled = true; clearTimeout(timer); };
  }, [rpc, reachable]);
  const act = async (method: string, extra: Record<string, unknown> = {}) => { setBusy(true); setError(""); try { const result = await rpc<SandboxService>({ method, ...extra }); if (result?.id) { setServices(old => [...old.filter(s => s.id !== result.id), result]); setSelected(result.id); } if (method === "removeService") setServices(old => old.filter(s => s.id !== selected)); } catch (e) { setError(executionError(e)); } finally { setBusy(false); } };
  const service = services.find(s => s.id === selected);
  return <section className="station-card execution-card" aria-label="Workspace services"><h2>Services</h2><p className="execution-note">Run long-lived processes independently of command timeouts. Automatic restarts require an explicit policy; stopped services stay stopped.</p><ExecutionAlert error={error} />
    <form onSubmit={e => { e.preventDefault(); if (admit && !busy && name.trim() && command.trim()) void act("startService", { options: { name, command, restart: { policy, maxRestarts: 5, delayMs: 1000 } } }); }}>
      <div className="execution-toolbar"><label className="execution-field execution-grow"><span>Service name</span><input className="input-text" aria-label="Service name" value={name} onChange={e => setName(e.target.value)} /></label><label className="execution-field"><span>Restart policy</span><select className="input-text" aria-label="Restart policy" value={policy} onChange={e => setPolicy(e.target.value)}><option value="never">Never</option><option value="on-failure">On failure</option><option value="always">Always</option></select></label></div>
      <label className="execution-field"><span>Service command</span><textarea className="input-textarea" aria-label="Service command" value={command} onChange={e => setCommand(e.target.value)} placeholder="npm run dev -- --host 0.0.0.0" /></label>
      <button className="btn btn--primary" disabled={!admit || busy || !name.trim() || !command.trim()}>Start service</button>
    </form>
    {services.length > 0 && <><div className="execution-toolbar"><select className="input-text execution-grow" aria-label="Workspace service" value={selected} disabled={busy} onChange={e => setSelected(e.target.value)}>{services.map(s => <option key={s.id} value={s.id}>{s.name} · {s.status}</option>)}</select><button className="btn" disabled={!admit || busy} onClick={() => void act("restartService", { serviceId: selected })}>Restart service</button><button className="btn" disabled={!reachable || busy} onClick={() => void act("stopService", { serviceId: selected })}>Stop service</button><button className="btn btn--danger" disabled={!reachable || busy || ["running", "restarting"].includes(service?.status ?? "")} onClick={() => void act("removeService", { serviceId: selected })}>Remove service</button></div>
      {service && <><p className="execution-note" aria-label="Service status">{service.status} · {service.restartCount} restarts · exit {service.exitCode ?? "—"}</p><pre className="execution-output" aria-label="Service output">{service.stdout}{service.stderr && `\n[stderr]\n${service.stderr}`}{service.truncated && "\n[Output truncated]"}</pre></>}
    </>}
  </section>;
}
