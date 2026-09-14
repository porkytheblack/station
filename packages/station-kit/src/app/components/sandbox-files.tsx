"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FileList, FileRead } from "station-sandbox";
import { executionRequest, executionError } from "../hooks/use-execution";
import { ExecutionAlert } from "./execution-common";
const base64 = async (blob: Blob): Promise<string> => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(Error("Could not read file.")); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.readAsDataURL(blob); });
export function SandboxFiles({ owner, workspace, admit, reachable }: { owner: string; workspace: string; admit: boolean; reachable: boolean }) {
  const [path, setPath] = useState("."), [list, setList] = useState<FileList>({ entries: [] }), [offset, setOffset] = useState(0);
  const [filePath, setFilePath] = useState(""), [content, setContent] = useState(""), [download, setDownload] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const version = useRef(0);
  const rpc = useCallback(<T,>(body: Record<string, unknown>) => executionRequest<T>(owner, "sandbox", { id: workspace, ...body }), [owner, workspace]);
  const refresh = useCallback(async () => { const current = ++version.current; const value = await rpc<FileList>({ method: "listFiles", path, options: { offset, limit: 100 } }); if (version.current === current) setList(value); }, [rpc, path, offset]);
  useEffect(() => { if (reachable) void refresh().catch(e => setError(executionError(e))); return () => { version.current++; }; }, [refresh, reachable]);
  useEffect(() => () => { if (download) URL.revokeObjectURL(download); }, [download]);
  const act = async (operation: () => Promise<void>) => { setBusy(true); setError(""); try { await operation(); } catch (e) { setError(executionError(e)); } finally { setBusy(false); } };
  const read = async (name: string) => {
    const chunks: Uint8Array[] = [];
    let offset = 0;
    do {
      const result = await rpc<FileRead>({ method: "readFile", path: name, options: { offset } });
      if (result.totalBytes > 4 * 1024 * 1024) throw Error("This file exceeds the dashboard's 4 MiB preview/download limit. Read it in chunks through the API.");
      const chunk = Uint8Array.from(atob(result.base64), c => c.charCodeAt(0));
      if (offset + chunk.length > 4 * 1024 * 1024) throw Error("File grew beyond the 4 MiB limit while reading.");
      chunks.push(chunk);
      if (result.nextOffset === undefined || result.nextOffset >= result.totalBytes) break;
      if (result.nextOffset <= offset) throw Error("Worker returned an invalid file range.");
      offset = result.nextOffset;
    } while (true);
    const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let position = 0;
    for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
    setFilePath(name); setContent(new TextDecoder().decode(bytes)); setDownload(URL.createObjectURL(new Blob([bytes])));
  };
  return <section className="station-card execution-card" aria-label="Workspace files"><h2>Files</h2><ExecutionAlert error={error} />
    <div className="execution-toolbar"><label className="execution-field execution-grow"><span>Directory</span><input className="input-text" aria-label="File directory" value={path} onChange={e => { setOffset(0); setPath(e.target.value); }} /></label><button className="btn" disabled={!reachable || busy} onClick={() => void act(refresh)}>Refresh files</button><button className="btn" disabled={busy || path === "."} onClick={() => { setPath(path.split("/").slice(0, -1).join("/") || "."); setOffset(0); }}>Parent directory</button></div>
    <div className="execution-file-list">{list.entries.map(entry => <div className="execution-file-row" key={entry.path}><button className="btn btn--sm" disabled={busy || !reachable || entry.type === "symlink"} onClick={() => entry.type === "directory" ? (setPath(entry.path), setOffset(0)) : void act(() => read(entry.path))}>{entry.name}{entry.type === "directory" ? "/" : ""}</button><span className="execution-note">{entry.type} · {entry.size} B</span><button className="btn btn--sm" disabled={!admit || busy} onClick={() => { if (window.confirm(`Remove ${entry.path}?`)) void act(async () => { await rpc({ method: "removeFile", path: entry.path, options: { recursive: false } }); await refresh(); }); }}>Remove</button></div>)}</div>
    <div className="execution-toolbar"><button className="btn" disabled={!offset || busy} onClick={() => setOffset(Math.max(0, offset - 100))}>Previous files</button><button className="btn" disabled={list.nextOffset === undefined || busy} onClick={() => setOffset(list.nextOffset!)}>More files</button></div>
    <label className="execution-field"><span>File path</span><input className="input-text" aria-label="Workspace file path" value={filePath} onChange={e => { setFilePath(e.target.value); setDownload(""); }} placeholder="src/example.txt" /></label>
    <label className="execution-field"><span>Text content</span><textarea className="input-textarea" aria-label="Workspace file content" rows={6} value={content} onChange={e => setContent(e.target.value)} /></label>
    <div className="execution-toolbar"><button className="btn btn--primary" disabled={!admit || busy || !filePath} onClick={() => void act(async () => { const blob = new Blob([content]); if (blob.size > 4 * 1024 * 1024) throw Error("File exceeds 4 MiB."); await rpc({ method: "writeFile", path: filePath, options: { base64: await base64(blob), createParents: true } }); await refresh(); })}>Save text file</button>{download && <a className="btn" href={download} download={filePath.split("/").pop()}>Download file</a>}
      <label className="execution-field"><span>Upload file (worker limit applies)</span><input type="file" aria-label="Upload workspace file" disabled={!admit || busy} onChange={e => { const file = e.target.files?.[0]; if (!file) return; void act(async () => { if (file.size > 4 * 1024 * 1024) throw Error("File exceeds 4 MiB."); const target = `${path === "." ? "" : `${path}/`}${file.name}`; await rpc({ method: "writeFile", path: target, options: { base64: await base64(file) } }); await refresh(); }); e.target.value = ""; }} /></label>
    </div><p className="execution-note">Text saves replace the file. Download binary files without editing their contents. Directory removal requires it to be empty. Uploads and saves also respect the worker’s configured file size limit.</p>
  </section>;
}
