"use client";

import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { RegistryLink as Link, RegistryScope, useRegistry } from "./registry-context";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useBreadcrumb } from "../hooks/use-breadcrumb";
import { useApi, type StationNode } from "../hooks/use-api";
import DeploymentScreen from "./deployment-screen";
import { preparePublication, publishPrepared } from "./registry-api.mjs";

interface Artifact { entrypoint: string; digest: string; size: number; runtime: string; runtimeMajor?: number; platform: { os: string; arch: string; abi?: string } }
interface ImageExport { name: string; kind: "signal" | "broadcast" | "beacon"; inputSchema?: unknown; configSchema?: unknown; outputSchema?: unknown; requiredEnv?: string[]; timeoutMs?: number }
interface ImageRecord { digest: string; manifest: { name: string; version: string; format: string; protocol: string; artifacts: Artifact[]; exports: ImageExport[]; dependencies?: Record<string, { image: string; export: string; kind: string }>; env?: Record<string, string> } }
interface RunResult { kind: string; id: string; image: string; registeredName: string }
const enc = encodeURIComponent;
const imagePath = (name: string) => `/registry/images/${enc(name)}`;
const versionPath = (image: ImageRecord) => `${imagePath(image.manifest.name)}/versions/${enc(image.manifest.version)}`;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const json = (value: unknown) => JSON.stringify(value, null, 2);
function ErrorNotice({ error }: { error: string | null }) { return error ? <div className="execution-error" role="alert">{error}</div> : null; }
function Panel({ children }: { children: ReactNode }) { return <section className="card execution-card registry-panel">{children}</section>; }
function JsonDetails({ title, value }: { title: string; value: unknown }) { return <details className="registry-details"><summary>{title}</summary><pre className="execution-output">{json(value)}</pre></details>; }

export default function RegistryScreen() { return <Suspense fallback={<p role="status">Loading registry…</p>}><RegistryRoot/></Suspense>; }
function RegistryRoot() {
  const search=useSearchParams(); const stationId=search.get("registryStation")??"";
  return <RegistryScope key={stationId} stationId={stationId}><RegistryContent/></RegistryScope>;
}
function RegistryContent() {
  const {stationId: registryStation,request,working,href}=useRegistry(); const router=useRouter();
  const api=useApi(); const [registryStations,setRegistryStations]=useState<StationNode[]>([]); const [targetError,setTargetError]=useState<string|null>(null);
  useEffect(()=>{let live=true;api.getStations().then(result=>{if(live)setRegistryStations(result.data);}).catch(()=>{if(live)setTargetError("Worker list unavailable. Existing selected target is retained.");});return()=>{live=false;};},[]);
  const params = useParams<{ path?: string[] }>();
  const path = (params.path ?? []).map(segment => { try { return decodeURIComponent(segment); } catch { return segment; } });
  const route = path.join("/");
  const name = path[0] === "images" ? path[1] : undefined;
  const version = path[2] === "versions" ? path[3] : undefined;
  const section = path[4];
  const exportName = section === "exports" ? path[5] : undefined;
  const [images, setImages] = useState<ImageRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [daemon, setDaemon] = useState("");
  const selected = images.find(image => image.manifest.name === name && image.manifest.version === version);
  useBreadcrumb([{ label: "Registry", href: "/registry" }, ...(path[0] === "deployments" ? [{ label: "Deployments", href: "/registry/deployments" }] : []), ...(name ? [{ label: name, href: imagePath(name) }] : []), ...(version ? [{ label: version, href: `${imagePath(name!)}/versions/${enc(version)}` }] : []), ...(section ? [{ label: section }] : []), ...(exportName ? [{ label: exportName }] : []), ...(path[0] === "publish" ? [{ label: "Publish" }] : [])].map(item=>"href" in item&&typeof item.href==="string"?{...item,href:href(item.href)}:item), "registry");
  useEffect(() => { let live = true; fetch("/api/dashboard/context", { credentials: "include" }).then(r => r.ok ? r.json() : null).then(value => { if (live && typeof value?.data?.daemonURL === "string") setDaemon(value.data.daemonURL); }).catch(() => {}); return () => { live = false; }; }, []);
  useEffect(() => {
    let live = true; setLoading(true); setError(null);
    request("/images").then((value: ImageRecord[]) => { if (live) setImages(value); }).catch((e: unknown) => { if (live) setError(message(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [revision, route, registryStation]);
  const valid = path[0] === "deployments" || !path.length || route === "publish" || (name && (path.length === 2 || version && (path.length === 4 || path.length === 5 && ["exports", "install", "tags"].includes(section) || path.length === 6 && section === "exports")));
  return <div className="registry-screen">
    <div className="registry-context"><span className="mono">Registry context</span><strong>{daemon||"Loading configured daemon…"}</strong><label className="execution-field"><span>Registry Station</span><select className="input-text" aria-label="Registry Station" value={registryStation} disabled={working} onChange={event=>{const target=event.target.value;router.push(target?`/registry?registryStation=${enc(target)}`:"/registry");}}><option value="">Connected daemon registry</option>{registryStations.filter(station=>station.role!=="headquarters").map(station=><option key={station.id} value={station.id}>{station.name} · {station.status} ({station.id})</option>)}{registryStation&&!registryStations.some(station=>station.id===registryStation)&&<option value={registryStation}>{registryStation} · selected private registry</option>}</select></label><span>{registryStation?`Private registry: ${registryStation}. Headquarters must configure this fixed target; its credentials remain server-side.`:"Publication and installation use the connected daemon. Execution placement is selected separately."}{targetError&&` ${targetError}`}</span></div>
    {!valid ? <><h1 className="page-title">Page not found</h1><Link href="/registry">Back to registry</Link></> : path[0] === "deployments" ? <DeploymentScreen path={path.slice(1)} /> : route === "publish" ? <PublishPage daemon={daemon} /> : <>
      <div className="registry-heading"><h1 className="page-title">{exportName ?? (version ? `${name} · ${version}` : name ?? "Registry")}</h1><button className="btn" disabled={loading} onClick={() => setRevision(v => v + 1)}>Refresh</button></div>
      <ErrorNotice error={error} />
      {loading ? <p role="status" className="execution-note">Loading registry…</p> : error ? <p className="execution-note">Retry after checking access and registry configuration on {daemon}.</p> : !name ? <RegistryIndex images={images} /> : !version ? <ImageVersions name={name} images={images.filter(image => image.manifest.name === name)} /> : !selected ? <Panel><p>This version is not present in this registry.</p><Link href={imagePath(name)}>Browse image versions</Link></Panel> : <VersionPage key={route} image={selected} section={section} exportName={exportName} />}
    </>}
  </div>;
}

function RegistryIndex({ images }: { images: ImageRecord[] }) {
  const names = [...new Set(images.map(image => image.manifest.name))].sort();
  return <><p className="execution-intro">Immutable compiled programs, ready to compose into signals, broadcasts and beacons.</p><div className="execution-toolbar"><Link className="btn btn-primary" href="/registry/publish">Publish image</Link><Link className="btn" href="/registry/deployments">Deployments</Link></div>
    {!names.length ? <Panel><h2>No images published</h2><p className="execution-note">Publish a manifest with its compiled artifacts to make an image available in this registry.</p></Panel> : <div className="registry-list">{names.map(name => { const versions = images.filter(image => image.manifest.name === name); const kinds = [...new Set(versions.flatMap(image => image.manifest.exports.map(item => item.kind)))]; return <Link className="registry-row" key={name} href={imagePath(name)}><strong>{name}</strong><span>{versions.length} version{versions.length === 1 ? "" : "s"}</span><span className="mono">{kinds.join(" · ")}</span><span aria-hidden="true">→</span></Link>; })}</div>}
    <PullImage />
  </>;
}
function PullImage() {
  const {post,href}=useRegistry();
  const [reference, setReference] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const router = useRouter();
  return <details className="registry-details"><summary>Import from configured upstream</summary><p className="execution-note">Pull a reference from this daemon’s configured Headquarters registry.</p><form onSubmit={async event => { event.preventDefault(); setBusy(true); setError(null); try { const image = await post("/pull", { reference }); router.push(href(versionPath(image))); router.refresh(); } catch (e) { setError(message(e)); } finally { setBusy(false); } }}><label className="execution-field"><span>Image reference</span><input className="input-text" required value={reference} placeholder="acme/tools@1.0.0" onChange={e => setReference(e.target.value)} /></label><button className="btn" disabled={busy}>{busy ? "Importing…" : "Import image"}</button><ErrorNotice error={error} /></form></details>;
}
function ImageVersions({ name, images }: { name: string; images: ImageRecord[] }) {
  return <><p className="execution-intro">Select an immutable version to inspect its artifacts and exports.</p>{!images.length ? <Panel><p>No versions found for {name}.</p></Panel> : <div className="registry-list">{[...images].sort((a,b) => b.manifest.version.localeCompare(a.manifest.version, undefined, { numeric:true })).map(image => <Link className="registry-row" key={image.digest} href={versionPath(image)}><strong className="mono">{image.manifest.version}</strong><span>{image.manifest.exports.length} exports</span><span className="registry-digest mono">{image.digest}</span><span aria-hidden="true">→</span></Link>)}</div>}</>;
}
function VersionPage({ image, section, exportName }: { image: ImageRecord; section?: string; exportName?: string }) {
  const base = versionPath(image);
  const selected = image.manifest.exports.find(item => item.name === exportName);
  return <><nav className="registry-tabs" aria-label="Image version"><Link aria-current={!section ? "page" : undefined} href={base}>Overview</Link><Link aria-current={section === "exports" ? "page" : undefined} href={`${base}/exports`}>Exports</Link><Link aria-current={section === "install" ? "page" : undefined} href={`${base}/install`}>Install</Link><Link aria-current={section === "tags" ? "page" : undefined} href={`${base}/tags`}>Tags</Link></nav>
    <p className="registry-digest mono">{image.digest}</p>
    {section === "exports" ? exportName ? selected ? <InvokeExport image={image} definition={selected} /> : <Panel><p>Export not found in this version.</p><Link href={`${base}/exports`}>Browse exports</Link></Panel> : <div className="registry-list">{image.manifest.exports.map(item => <Link className="registry-row" key={item.name} href={`${base}/exports/${enc(item.name)}`}><strong>{item.name}</strong><span className="mono">{item.kind}</span><span>{item.requiredEnv?.length ?? 0} environment grants</span><span aria-hidden="true">→</span></Link>)}</div> : section === "install" ? <InstallImage image={image} /> : section === "tags" ? <TagImage image={image} /> : <>
      <Panel><h2>Compiled artifacts</h2><div className="registry-artifacts">{image.manifest.artifacts.map((artifact,i) => <article key={`${artifact.digest}-${i}`}><strong className="mono">{artifact.entrypoint}</strong><p className="execution-note">{artifact.runtime}{artifact.runtimeMajor ? ` ${artifact.runtimeMajor}+` : ""} · {artifact.platform.os}/{artifact.platform.arch}{artifact.platform.abi ? ` · ${artifact.platform.abi}` : ""} · {artifact.size.toLocaleString()} bytes</p><p className="registry-digest mono">{artifact.digest}</p></article>)}</div></Panel>
      <Panel><h2>Dependencies</h2>{Object.entries(image.manifest.dependencies ?? {}).length ? Object.entries(image.manifest.dependencies!).map(([alias,dep]) => <div key={alias} className="registry-dependency"><strong>{alias}</strong><span className="mono">{dep.kind} · {dep.export}</span><span className="registry-digest mono">{dep.image}</span></div>) : <p className="execution-note">This image declares no dependencies.</p>}</Panel><JsonDetails title="View manifest" value={image.manifest} />
    </>}
  </>;
}
function InstallImage({ image }: { image: ImageRecord }) {
  const {post}=useRegistry();
  const [busy,setBusy] = useState(false); const [result,setResult] = useState<unknown>(); const [error,setError] = useState<string|null>(null);
  return <Panel><h2>Install this version</h2><p className="execution-note">Validate the target, dependencies and environment grants, then register immutable exports on this daemon. Installation does not invoke an export.</p><button className="btn btn-primary" disabled={busy} onClick={async () => { setBusy(true); setError(null); try { setResult(await post("/install", { reference:image.digest })); } catch(e) { setError(message(e)); } finally { setBusy(false); } }}>{busy ? "Installing…" : "Install version"}</button><ErrorNotice error={error} />{result !== undefined && <div role="status"><p>Version installed.</p><JsonDetails title="Registered exports" value={result} /></div>}</Panel>;
}
function TagImage({ image }: { image:ImageRecord }) {
  const {request}=useRegistry();
  const [tag,setTag] = useState(""); const [busy,setBusy] = useState(false); const [saved,setSaved] = useState(""); const [error,setError] = useState<string|null>(null);
  return <Panel><h2>Point a tag to this version</h2><p className="execution-note">A tag selects this digest for future requests. Moving a tag does not modify queued runs or restart existing beacons.</p><form onSubmit={async event => { event.preventDefault(); setBusy(true); setError(null); setSaved(""); try { await request("/tags", {method:"PUT",body:JSON.stringify({name:image.manifest.name,tag,digest:image.digest})}); setSaved(`${image.manifest.name}@${tag} now points to ${image.manifest.version}.`); } catch(e) { setError(message(e)); } finally { setBusy(false); } }}><label className="execution-field"><span>Tag</span><input className="input-text" required value={tag} onChange={e=>setTag(e.target.value)} placeholder="stable" /></label><button className="btn btn-primary" disabled={busy}>{busy ? "Updating…" : "Set tag"}</button></form><ErrorNotice error={error} />{saved && <p role="status">{saved}</p>}</Panel>;
}
function InvokeExport({ image, definition }: { image:ImageRecord; definition:ImageExport }) {
  const {post,stationId: registryStation}=useRegistry();
  const api=useApi(); const [stations,setStations]=useState<StationNode[]>([]); const [stationError,setStationError]=useState<string|null>(null); const [stationId,setStationId]=useState(registryStation); const [input,setInput]=useState("{}"); const [busy,setBusy]=useState(false); const [error,setError]=useState<string|null>(null); const [result,setResult]=useState<RunResult|null>(null);
  useEffect(()=>{ let live=true; api.getStations().then(r=>{if(live)setStations(r.data);}).catch(e=>{if(live)setStationError(message(e));}); return()=>{live=false;}; },[]);
  return <Panel><div className="registry-export-title"><h2>{definition.name}</h2><span className="status-badge">{definition.kind}</span></div><p className="execution-note">Invoke this immutable export with JSON {definition.kind === "beacon" ? "configuration" : "input"}. Station returns an ID while execution continues independently.</p>
    <form onSubmit={async event=>{event.preventDefault();setBusy(true);setError(null);setResult(null);try { const value=JSON.parse(input); setResult(await post("/run",{reference:image.digest,export:definition.name,input:value,...(stationId?{stationId}:{})})); } catch(e){setError(message(e));} finally{setBusy(false);} }}>
      <label className="execution-field"><span>{definition.kind === "beacon" ? "Configuration JSON" : "Input JSON"}</span><textarea className="input-textarea" rows={8} spellCheck={false} value={input} onChange={e=>setInput(e.target.value)} /></label>
      <label className="execution-field"><span>Execution placement</span><select className="input-text" value={stationId} disabled={Boolean(registryStation)} onChange={e=>setStationId(e.target.value)}>{registryStation?<option value={registryStation}>{registryStation} · selected private registry worker</option>:<option value="">Any eligible worker</option>}{stations.filter(s=>s.role!=="headquarters"&&s.id!==registryStation).map(station=><option key={station.id} value={station.id} disabled={station.status!=="online"}>{station.name} · {station.status} ({station.id})</option>)}</select></label>
      {stationError && <p className="execution-note">Worker list unavailable: {stationError} Automatic placement remains available.</p>}
      {definition.kind==="beacon" && <p className="execution-note">Headquarters records shared instance intent; an eligible worker runs the beacon. A worker pin is retained through restart and prevents another worker from taking over.</p>}
      {Boolean(definition.requiredEnv?.length) && <p className="execution-note">Required environment grants: <span className="mono">{definition.requiredEnv!.join(", ")}</span>. Configure these on the worker; secrets are not entered here.</p>}
      <button className="btn btn-primary" disabled={busy}>{busy ? "Submitting…" : definition.kind==="beacon" ? "Create beacon instance" : "Run export"}</button>
    </form><ErrorNotice error={error} />{result && <div role="status" className="execution-result"><h2>{result.kind==="beacon"?"Instance created":"Run queued"}</h2><p className="mono">{result.id}</p><Link className="btn" href={result.kind==="signal"?`/runs/${enc(result.id)}`:result.kind==="broadcast"?`/broadcasts/${enc(result.id)}`:`/beacons/${enc(result.registeredName)}`}>View {result.kind==="beacon"?"beacon":"run"}</Link></div>}
    {(definition.inputSchema ?? definition.configSchema) !== undefined && <JsonDetails title="Accepted input schema" value={definition.inputSchema ?? definition.configSchema} />}
    {definition.outputSchema !== undefined && <JsonDetails title="Output schema" value={definition.outputSchema} />}
  </Panel>;
}
function PublishPage({ daemon }: { daemon:string }) {
  const {stationId,href,setWorking}=useRegistry(); const transfer=useRef<AbortController|null>(null); const [attempted,setAttempted]=useState(false);
  useEffect(()=>()=>{transfer.current?.abort();},[]);
  const router=useRouter(); const [manifest,setManifest]=useState<ImageRecord["manifest"]|null>(null); const [files,setFiles]=useState<File[]>([]); const [busy,setBusy]=useState(false); const [progress,setProgress]=useState(""); const [error,setError]=useState<string|null>(null);
  return <><h1 className="page-title">Publish image</h1><p className="execution-intro">Add a compiled version to {stationId?`${stationId} via ${daemon}`:daemon}. Artifact digests and sizes are checked before any upload.</p><Panel><form onSubmit={async event=>{event.preventDefault();setBusy(true);setError(null);setProgress("Verifying artifacts");setWorking(true);transfer.current=new AbortController();try { const prepared=await preparePublication(manifest,files);setAttempted(true); const image=await publishPrepared(manifest,prepared,setProgress,{stationId:stationId||undefined,receiptScope:daemon,signal:transfer.current.signal}); router.push(href(versionPath(image))); router.refresh(); } catch(e){setError(transfer.current?.signal.aborted?"Upload paused. Select Resume to reconcile accepted bytes before continuing.":message(e));setProgress("");}finally{setBusy(false);setWorking(false);transfer.current=null;} }}>
    <label className="execution-field"><span>Manifest (.json)</span><input type="file" accept=".json,application/json" disabled={busy} onChange={async e=>{setManifest(null);setError(null);const file=e.target.files?.[0];if(!file)return;try{if(file.size>1024*1024)throw new Error("Manifest exceeds 1 MiB.");setManifest(JSON.parse(await file.text()));}catch(error){setError(message(error));}}} /></label>
    <label className="execution-field"><span>Compiled artifacts</span><input type="file" multiple disabled={busy} onChange={e=>setFiles(Array.from(e.target.files??[]))} /></label>
    <p className="execution-note">Select only the files declared by the manifest. Maximum 128 MiB per file, 256 MiB total; your daemon may enforce a smaller limit. No source compilation or dependency installation runs here.</p>
    <button className="btn btn-primary" disabled={busy||!manifest||!files.length||!daemon}>{busy?"Publishing…":attempted?"Resume / publish":"Verify and publish"}</button>{busy&&<button type="button" className="btn" onClick={()=>transfer.current?.abort()}>Pause upload</button>}<Link className="btn" href="/registry">Cancel</Link>
    {progress&&<p role="status">{progress}</p>}<ErrorNotice error={error} />
    {manifest&&<JsonDetails title="Review selected manifest" value={manifest} />}
  </form></Panel><p className="execution-note">Publishing verifies storage only. Install and invoke the image separately. Upload receipts persist in this tab. After a pause or lost connection, select Resume; the daemon reports the accepted offset before another chunk is sent. After reloading, reselect the same manifest and artifacts to resume. Expired uploads start again. A lost manifest response still requires checking the registry before republishing.</p></>;
}
