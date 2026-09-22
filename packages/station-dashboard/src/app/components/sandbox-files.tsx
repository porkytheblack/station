"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FileList, FileRead } from "station-sandbox";
import { executionRequest, executionError } from "../hooks/use-execution";
import { ExecutionAlert } from "./execution-common";

const MAX_BYTES = 4 * 1024 * 1024;
const base64 = async (blob: Blob): Promise<string> => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(Error("Could not read file.")); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.readAsDataURL(blob); });
function sizeLabel(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`; }
function FileIcon({ folder = false }: { folder?: boolean }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">{folder ? <path d="M3 7V5h6l2 2h10v13H3V7Z" /> : <><path d="M5 3h9l5 5v13H5Z" /><path d="M14 3v6h5M8 13h8M8 17h6" /></>}</svg>;
}

export function SandboxFiles({ owner, workspace, admit, reachable }: { owner: string; workspace: string; admit: boolean; reachable: boolean }) {
  const [path, setPath] = useState("."), [directoryInput, setDirectoryInput] = useState(".");
  const [list, setList] = useState<FileList>({ entries: [] }), [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState(""), [showHidden, setShowHidden] = useState(true), [loading, setLoading] = useState(true);
  const [filePath, setFilePath] = useState(""), [content, setContent] = useState(""), [download, setDownload] = useState("");
  const [saved, setSaved] = useState({ path: "", content: "" }), [binary, setBinary] = useState(false), [fileBytes, setFileBytes] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const version = useRef(0);
  const dirty = !binary && (content !== saved.content || filePath !== saved.path);
  const rpc = useCallback(<T,>(body: Record<string, unknown>) => executionRequest<T>(owner, "sandbox", { id: workspace, ...body }), [owner, workspace]);
  const refresh = useCallback(async () => {
    const current = ++version.current;
    setLoading(true);
    try {
      const value = await rpc<FileList>({ method: "listFiles", path, options: { offset, limit: 100 } });
      if (version.current === current) { setList(value); setError(""); }
    } catch (e) { if (version.current === current) { setList({ entries: [] }); setError(executionError(e)); } }
    finally { if (version.current === current) setLoading(false); }
  }, [rpc, path, offset]);
  useEffect(() => { if (reachable) void refresh(); return () => { version.current++; }; }, [refresh, reachable]);
  useEffect(() => () => { if (download) URL.revokeObjectURL(download); }, [download]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    // Next's links do not unload the document. Protect them as well as reload/close.
    const leave = (event: MouseEvent) => {
      const link = (event.target as Element).closest?.("a[href]");
      if (!link || link.hasAttribute("download") || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!window.confirm("Discard unsaved file changes?")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", leave, true);
    return () => { window.removeEventListener("beforeunload", warn); document.removeEventListener("click", leave, true); };
  }, [dirty]);
  const discard = () => !dirty || window.confirm("Discard unsaved file changes?");
  const navigate = (directory: string) => {
    const next = directory || ".";
    setDirectoryInput(next); setFilter(""); setError("");
    if (next === path && offset === 0) { void refresh(); return; }
    version.current++; setList({ entries: [] }); setPath(next); setOffset(0);
  };
  const act = async (operation: () => Promise<void>) => { setBusy(true); setError(""); setNotice(""); try { await operation(); } catch (e) { setError(executionError(e)); } finally { setBusy(false); } };
  const read = async (name: string) => {
    const chunks: Uint8Array[] = [];
    let offset = 0;
    do {
      const result = await rpc<FileRead>({ method: "readFile", path: name, options: { offset } });
      if (result.totalBytes > MAX_BYTES) throw Error("This file exceeds the dashboard’s 4 MiB preview/download limit. Use the terminal or the file API to read larger files.");
      const chunk = Uint8Array.from(atob(result.base64), c => c.charCodeAt(0));
      if (offset + chunk.length > MAX_BYTES) throw Error("File grew beyond the 4 MiB limit while reading.");
      chunks.push(chunk);
      if (result.nextOffset === undefined || result.nextOffset >= result.totalBytes) break;
      if (result.nextOffset <= offset) throw Error("Worker returned an invalid file range.");
      offset = result.nextOffset;
    } while (true);
    const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let position = 0;
    for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
    let text = "", isBinary = bytes.includes(0);
    try { if (!isBinary) text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { isBinary = true; }
    setFilePath(name); setContent(text); setSaved({ path: name, content: text }); setBinary(isBinary); setFileBytes(bytes.length);
    setDownload(URL.createObjectURL(new Blob([bytes])));
  };
  const entries = list.entries.filter(entry => (showHidden || !entry.name.startsWith(".")) && entry.name.toLowerCase().includes(filter.toLowerCase())).sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const parts = path.split("/").filter(part => part && part !== ".");
  const selectedEntry = list.entries.find(entry => entry.path === filePath);

  return <section className="station-card execution-card sandbox-explorer" aria-label="Workspace files">
    <div className="explorer-heading"><h2>Files</h2><div className="explorer-actions">
      <button className="btn btn--sm" disabled={!admit || busy} onClick={() => { if (!discard()) return; setFilePath(path === "." ? "" : `${path}/`); setContent(""); setSaved({ path: "", content: "" }); setBinary(false); setDownload(""); setFileBytes(0); setNotice("Enter a file path and save to create it. Missing parent folders are created automatically."); }}>New file</button>
      <label className={`btn btn--sm explorer-upload ${!admit || busy ? "is-disabled" : ""}`}>Upload file<input type="file" aria-label="Upload workspace file" disabled={!admit || busy} onChange={e => {
        const file = e.target.files?.[0]; if (!file) return;
        const target = `${path === "." ? "" : `${path}/`}${file.name}`;
        if (list.entries.some(entry => entry.name === file.name) && !window.confirm(`Replace ${target}?`)) { e.target.value = ""; return; }
        if (target === filePath && !discard()) { e.target.value = ""; return; }
        void act(async () => { if (file.size > MAX_BYTES) throw Error("File exceeds 4 MiB."); await rpc({ method: "writeFile", path: target, options: { base64: await base64(file) } }); if (target === filePath) await read(target); await refresh(); setNotice(`Uploaded ${target}.`); }); e.target.value = "";
      }} /></label>
      <button className="btn btn--sm" disabled={!reachable || busy || loading} onClick={() => void refresh()}>Refresh files</button>
    </div></div>
    <ExecutionAlert error={error} />
    {notice && <p className="execution-note" role="status">{notice}</p>}
    <nav className="explorer-breadcrumbs" aria-label="Directory breadcrumbs">
      <button disabled={busy || !reachable} onClick={() => navigate(".")}>Workspace</button>
      {parts.map((part, index) => <span key={index}><span aria-hidden="true">/</span><button disabled={busy || !reachable} onClick={() => navigate(parts.slice(0, index + 1).join("/"))}>{part}</button></span>)}
    </nav>
    <div className="explorer-panes">
      <aside className="explorer-directory" aria-label="File explorer">
        <form className="explorer-directory-form" onSubmit={event => { event.preventDefault(); if (!busy && reachable) { if (directoryInput === path) void refresh(); else navigate(directoryInput.trim()); } }}>
          <input className="input-text" aria-label="File directory" value={directoryInput} onChange={e => setDirectoryInput(e.target.value)} disabled={busy || !reachable} /><button className="btn btn--sm" disabled={busy || !reachable}>Go</button>
        </form>
        <input className="input-text" type="search" aria-label="Filter files" placeholder="Filter this page…" value={filter} onChange={e => setFilter(e.target.value)} />
        <div className="explorer-directory-options"><button className="explorer-text-button" disabled={busy || !reachable || path === "."} onClick={() => navigate(parts.slice(0, -1).join("/") || ".")}>Parent directory</button><label><input type="checkbox" checked={showHidden} onChange={e => setShowHidden(e.target.checked)} /> Hidden files</label></div>
        <ul className="explorer-entries" aria-label="Directory entries" aria-busy={loading}>
          {entries.map(entry => <li key={entry.path} data-selected={filePath === entry.path}>
            <button className="explorer-entry" aria-label={`${entry.name}${entry.type === "directory" ? "/" : ""}`} aria-current={filePath === entry.path ? "true" : undefined} disabled={busy || loading || !reachable || entry.type === "symlink"} title={entry.type === "symlink" ? "Symbolic links cannot be opened" : `${entry.path} · Modified ${new Date(entry.modifiedAt).toLocaleString()}`} onClick={() => {
              if (entry.type === "directory") navigate(entry.path);
              else if (discard()) void act(() => read(entry.path));
            }}><FileIcon folder={entry.type === "directory"} /><span className="explorer-entry-name">{entry.name}</span><span className="explorer-entry-size">{entry.type === "directory" ? "/" : entry.type === "symlink" ? "link" : sizeLabel(entry.size)}</span></button>
            <button className="explorer-remove" aria-label={`Remove ${entry.name}`} title={`Remove ${entry.name}`} disabled={!admit || busy || loading} onClick={() => {
              if (!window.confirm(`Remove ${entry.path}?${entry.type === "directory" ? " The folder must be empty." : ""}`)) return;
              if (filePath === entry.path && !discard()) return;
              void act(async () => { await rpc({ method: "removeFile", path: entry.path, options: { recursive: false } }); if (filePath === entry.path) { setFilePath(""); setContent(""); setSaved({ path: "", content: "" }); setBinary(false); setDownload(""); } await refresh(); setNotice(`Removed ${entry.path}.`); });
            }}>×</button>
          </li>)}
        </ul>
        {!entries.length && <p className="explorer-empty">{loading && reachable ? "Loading files…" : !reachable ? "This worker is unavailable." : filter ? "No files match this filter." : "No files to show in this folder."}</p>}
        <div className="explorer-pagination"><button className="btn btn--sm" disabled={!offset || busy || loading || !reachable} onClick={() => setOffset(Math.max(0, offset - 100))}>Previous files</button><span className="execution-note">Page {Math.floor(offset / 100) + 1}</span><button className="btn btn--sm" disabled={list.nextOffset === undefined || busy || loading || !reachable} onClick={() => setOffset(list.nextOffset!)}>More files</button></div>
      </aside>
      <div className="explorer-editor">
        <div className="explorer-editor-heading"><span>{filePath.split("/").pop() || "New text file"}</span><span className="execution-note" role="status">{dirty ? "Unsaved changes" : saved.path ? "Saved file" : "Choose a file to open"}</span></div>
        <label className="execution-field"><span>File path</span><input className="input-text" aria-label="Workspace file path" value={filePath} disabled={busy || binary} onChange={e => { setFilePath(e.target.value); setDownload(""); }} placeholder="src/example.txt" /></label>
        {binary ? <div className="explorer-binary"><FileIcon /><h3>Binary file</h3><p>{sizeLabel(fileBytes)} · Download this file to open it. Text editing is disabled to preserve its contents.</p></div> : <label className="execution-field explorer-content"><span>Text content</span><textarea className="input-textarea" aria-label="Workspace file content" rows={20} wrap="off" spellCheck={false} value={content} disabled={busy || !admit} onChange={e => setContent(e.target.value)} placeholder="Select a file from the explorer, or write a new one here." /></label>}
        <div className="explorer-editor-meta"><span>{binary ? "Binary" : `${content.split("\n").length.toLocaleString()} lines · UTF-8`}</span>{selectedEntry && <span>Modified {new Date(selectedEntry.modifiedAt).toLocaleString()}</span>}</div>
        <div className="execution-toolbar">
          {!binary && <button className="btn btn--primary" disabled={!admit || busy || !filePath || filePath.endsWith("/")} onClick={() => void act(async () => { const blob = new Blob([content]); if (blob.size > MAX_BYTES) throw Error("File exceeds 4 MiB."); await rpc({ method: "writeFile", path: filePath, options: { base64: await base64(blob), createParents: true } }); setSaved({ path: filePath, content }); setDownload(URL.createObjectURL(blob)); setFileBytes(blob.size); await refresh(); setNotice(`Saved ${filePath}.`); })}>Save text file</button>}
          {download && <a className="btn" href={download} download={saved.path.split("/").pop() || filePath.split("/").pop()}>Download file</a>}
          {dirty && saved.path && <button className="btn" disabled={busy} onClick={() => { if (discard()) { setContent(saved.content); setFilePath(saved.path); setDownload(URL.createObjectURL(new Blob([saved.content]))); } }}>Discard changes</button>}
        </div>
        <p className="execution-note">{dirty && download ? "Download contains the saved version. " : ""}Previews and uploads support files up to 4 MiB; your worker may set a smaller limit.</p>
      </div>
    </div>
  </section>;
}
