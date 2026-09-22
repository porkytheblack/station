import { open, mkdir, writeFile, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { isSignal, type AnySignal } from "station-signal";
import { ImageError, assertDigest, digestBytes, type Digest, type NativeSignalDependency } from "station-images";

/** Trusted operator configuration, never accepted from a registry request. */
export interface NativeSignalGrant extends NativeSignalDependency {
  file: string;
  /** Operator asserts all application dependencies are bundled; only station-signal is external. */
  selfContained: true;
}
export interface NativeSignalSnapshot { path: string; digest: Digest; name: string; qualifiedName: string }
export function nativeSignalName(dependency: NativeSignalDependency): string {
  assertDigest(dependency.revision);
  return `native_${dependency.revision.slice(7)}_${createHash("sha256").update(dependency.name).digest("hex").slice(0,32)}`;
}
export function validateNativeSignalGrants(grants: readonly NativeSignalGrant[]): void {
  if (!Array.isArray(grants) || grants.length > 128) throw new ImageError("native_grant_denied", "Invalid native signal grants");
  const names=new Set<string>();
  for(const grant of grants){
    if(!grant || typeof grant!=="object" || Object.keys(grant).some(key=>!["name","file","revision","selfContained"].includes(key)) || typeof grant.name!=="string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(grant.name) || typeof grant.file!=="string" || !grant.file || grant.selfContained!==true)throw new ImageError("native_grant_denied","Native grants require a named self-contained operator bundle");
    assertDigest(grant.revision);const key=`${grant.name}:${grant.revision}`;if(names.has(key))throw new ImageError("native_grant_denied","Duplicate native grant");names.add(key);
  }
}
async function verifiedRead(path:string,digest:Digest):Promise<Buffer>{
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const stat=await file.stat();if(!stat.isFile()||stat.size>8*1024*1024)throw new ImageError("native_grant_denied","Native bundle must be a bounded regular file");const bytes=await file.readFile();if(bytes.length>8*1024*1024||digestBytes(bytes)!==digest)throw new ImageError("digest_mismatch","Native signal bundle revision changed");return bytes;}finally{await file.close();}
}
/** Only operator-owned verified code is imported. Uploaded binaries never enter this path. */
export async function loadNativeSignal(snapshot:NativeSignalSnapshot):Promise<AnySignal>{
  const bytes=await verifiedRead(snapshot.path,snapshot.digest);
  const module=await import(`data:text/javascript;base64,${bytes.toString("base64")}`);
  if(!isSignal(module.default)||module.default.name!==snapshot.name)throw new ImageError("native_grant_denied","Native bundle default export does not match the granted Station signal");
  return {...module.default,name:snapshot.qualifiedName,trigger:async()=>{throw new Error("Use the immutable registered native signal name to trigger this grant");}};
}
export async function prepareNativeSignal(grant:NativeSignalGrant,root:string):Promise<{definition:AnySignal;snapshot:NativeSignalSnapshot}>{
  const source=await verifiedRead(resolve(grant.file),grant.revision);
  const compiled=await build({stdin:{contents:source.toString("utf8"),loader:"js",sourcefile:"operator-native.mjs"},write:false,bundle:true,format:"esm",platform:"node",target:"node22",logLevel:"silent",plugins:[{name:"native-platform-only",setup(builder){builder.onResolve({filter:/.*/},args=>args.path==="station-signal"?{path:import.meta.resolve("station-signal"),external:true}:{errors:[{text:"Native grant must be prebundled; only station-signal may be imported"}]});}}]});
  if(compiled.warnings.length)throw new ImageError("native_grant_denied","Native bundle must not contain unresolved dynamic imports");
  const bytes=compiled.outputFiles[0]!.contents,digest=digestBytes(bytes),directory=join(root,"native-bundles");await mkdir(directory,{recursive:true,mode:0o700});const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new ImageError("invalid_state","Native cache must be a real private directory");
  const path=join(directory,`${digest.slice(7)}.mjs`);
  try{await writeFile(path,bytes,{flag:"wx",mode:0o400});}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;await verifiedRead(path,digest);}
  const snapshot={path,digest,name:grant.name,qualifiedName:nativeSignalName(grant)};
  return {definition:await loadNativeSignal(snapshot),snapshot};
}
