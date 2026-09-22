"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { BrowserHandle } from "station-browser-use";
import { executionError, executionRequest } from "../hooks/use-execution";
import { ExecutionAlert } from "./execution-common";
type Checkpoint = { id: string; sessionId: string; createdAt: string; backend: string; options: { profileId?: string }; urls: string[]; selectedPage: number };
export function BrowserRecovery({ owner, sessionId, reachable, admit, onBusy }: { owner: string; sessionId?: string; reachable: boolean; admit: boolean; onBusy: (busy: boolean) => void }) {
  const router = useRouter();
  const [items, setItems] = useState<Checkpoint[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const rpc = useCallback(<T,>(body: Record<string, unknown>) => executionRequest<T>(owner, "browser", body), [owner]);
  const refresh = useCallback(async () => setItems(await rpc<Checkpoint[]>({ method: "checkpoints" })), [rpc]);
  useEffect(() => { if (reachable) void refresh().catch(e => setError(executionError(e))); }, [refresh, reachable]);
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  const act = async (operation: () => Promise<void>) => { setBusy(true); setError(""); try { await operation(); } catch (e) { setError(executionError(e)); } finally { setBusy(false); } };
  return <section className="station-card execution-card" aria-label="Browser recovery"><h2>Recovery checkpoints</h2><p className="execution-note">Save page addresses and the selected profile, then explicitly open a new browser from that checkpoint. Live JavaScript, open connections and commands are not restored or replayed. Saved addresses omit credentials, query strings and fragments.</p><ExecutionAlert error={error} />
    <div className="execution-toolbar">{sessionId && <button className="btn btn--primary" disabled={!admit || busy} onClick={() => void act(async () => { await rpc({ method: "checkpoint", id: sessionId }); await refresh(); })}>Save browser checkpoint</button>}<button className="btn" disabled={!reachable || busy} onClick={() => void act(refresh)}>Refresh checkpoints</button></div>
    <div className="execution-resource-list" aria-label="Browser checkpoints">{items.map(item => <div className="execution-resource" key={item.id} style={{ display: "block" }}><strong className="mono">{item.id}</strong><p className="execution-note">{new Date(item.createdAt).toLocaleString()} · {item.backend} · {item.options.profileId ? `Profile: ${item.options.profileId}` : "Ephemeral profile"}</p><ul>{item.urls.map((url, index) => <li key={index} style={{ overflowWrap: "anywhere" }}>{url}{index === item.selectedPage ? " · Selected page" : ""}</li>)}</ul><div className="execution-toolbar"><button className="btn" disabled={!admit || busy} onClick={() => { if (!window.confirm("Open a new browser and load this checkpoint's saved addresses?")) return; void act(async () => { const handle = await rpc<BrowserHandle>({ method: "checkpointResume", id: item.id }); router.push(`/browser-use/${encodeURIComponent(owner)}/sessions/${encodeURIComponent(handle.id)}/control`); }); }}>Restore checkpoint</button><button className="btn btn--danger" disabled={!reachable || busy} onClick={() => { if (!window.confirm("Delete this recovery checkpoint?")) return; void act(async () => { await rpc({ method: "checkpointDelete", id: item.id }); await refresh(); }); }}>Delete checkpoint</button></div></div>)}{!items.length && <p className="execution-note">No recovery checkpoints saved.</p>}</div>
  </section>;
}
