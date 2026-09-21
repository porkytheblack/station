import { spawn } from "node:child_process";
import { SandboxError } from "./index.js";

export async function engineCall(executable: string, args: string[], options: { input?: string; timeoutMs?: number; maxBytes?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let diagnostic = "";
    let failed = false;
    const max = options.maxBytes ?? 2 * 1024 * 1024;
    const timer = setTimeout(() => { failed = true; child.kill("SIGKILL"); }, options.timeoutMs ?? 30_000);
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > max) { failed = true; child.kill("SIGKILL"); } else chunks.push(chunk); });
    // Engine stderr often includes host paths or registry credentials; never return it to workloads.
    child.stderr.on("data", (chunk: Buffer) => {
      if (diagnostic.length < 8192) diagnostic += chunk.toString("utf8").slice(0, 8192 - diagnostic.length);
    });
    child.on("error", () => { clearTimeout(timer); reject(new SandboxError("unavailable", "The container engine could not be started.")); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed || code !== 0) {
        // Classify bounded stderr; never echo arbitrary engine output, argv, credentials or paths.
        const reason = failed ? "operation_limit" : /permission denied|access denied|unauthorized|denied:/.test(diagnostic.toLowerCase()) ? "permission_denied"
          : /no space left|out of memory|cannot allocate|resource temporarily unavailable/.test(diagnostic.toLowerCase()) ? "resource_exhausted"
          : /no such image|manifest unknown|pull access denied/.test(diagnostic.toLowerCase()) ? "image_unavailable"
          : /cannot connect|connection refused|daemon is not running/.test(diagnostic.toLowerCase()) ? "engine_unreachable"
          : /already in use|conflict/.test(diagnostic.toLowerCase()) ? "resource_conflict" : "engine_error";
        reject(new SandboxError("unavailable", `Container engine operation failed (exit ${code ?? "unknown"}: ${reason}).`));
      }
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}

/** Executed inside the container. Every user value is an argv value, never shell source. */
export const FILE_SCRIPT = String.raw`
const fs=require('node:fs'),p=require('node:path');
function fail(code='invalid_input'){const e=new Error();e.stationCode=code;throw e;}
try {
 const input=JSON.parse(fs.readFileSync(0,'utf8'));
 const root='/home/node/workspace';
 const rootStat=fs.lstatSync(root);if(rootStat.isSymbolicLink()||!rootStat.isDirectory())fail();
 function target(name){
  if(typeof name!=='string'||name.includes('\0')||p.isAbsolute(name))fail();
  const pieces=name.split('/').filter(Boolean);if(pieces.includes('..'))fail();
  const path=p.resolve(root,name||'.');
  if(path!==root&&!path.startsWith(root+'/'))fail();
  let cursor=root;
  for(const piece of p.relative(root,path).split('/').filter(Boolean)){
   cursor=p.join(cursor,piece);
   try{if(fs.lstatSync(cursor).isSymbolicLink())fail();}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  return path;
 }
 function entry(path){const s=fs.lstatSync(path);return {name:p.basename(path),path:p.relative(root,path),type:s.isDirectory()?'directory':s.isSymbolicLink()?'symlink':'file',size:s.size,modifiedAt:s.mtime.toISOString()};}
 let result;const path=target(input.path||'.');
 switch(input.method){
  case 'list': {const names=fs.readdirSync(path).sort();const offset=input.offset||0,limit=input.limit||100;result={entries:names.slice(offset,offset+limit).map(n=>entry(p.join(path,n))),...(offset+limit<names.length?{nextOffset:offset+limit}:{})};break;}
  case 'read': {const stat=fs.statSync(path);if(!stat.isFile())fail();const offset=input.offset||0;if(offset>stat.size)fail();const length=Math.min(input.length||65536,stat.size-offset);const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let data=Buffer.alloc(length),bytes;try{bytes=fs.readSync(fd,data,0,length,offset);}finally{fs.closeSync(fd);}result={path:input.path,base64:data.subarray(0,bytes).toString('base64'),bytes,totalBytes:stat.size,nextOffset:offset+bytes};break;}
  case 'write': {if(path===root)fail();if(input.createParents)fs.mkdirSync(p.dirname(path),{recursive:true});const tmp=path+'.station-'+require('node:crypto').randomUUID();try{fs.writeFileSync(tmp,Buffer.from(input.base64,'base64'),{mode:0o600,flag:'wx'});fs.renameSync(tmp,path);}finally{try{fs.unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}result=entry(path);break;}
  case 'remove': {if(path===root)fail();fs.rmSync(path,{recursive:!!input.recursive});result=null;break;}
  default:fail();
 }
 process.stdout.write(JSON.stringify({data:result}));
} catch(e) {
 const codes={ENOENT:'not_found',ENOTDIR:'invalid_input',EISDIR:'invalid_input',ELOOP:'invalid_input',EINVAL:'invalid_input',EACCES:'invalid_input',EPERM:'invalid_input',ENOTEMPTY:'invalid_input',ENOSPC:'capacity',EDQUOT:'capacity',EFBIG:'capacity',EMFILE:'capacity',ENFILE:'capacity'};
 const code=e.stationCode||codes[e.code]||(e instanceof SyntaxError?'invalid_input':'unavailable');
 process.stdout.write(JSON.stringify({error:{code}}));
}
`;

export const STOP_SCRIPT = String.raw`
const fs=require('node:fs');const leader=Number(process.argv[1]);
if(!Number.isSafeInteger(leader)||leader<=1)throw new Error('Invalid process session');
function stop(signal){for(const name of fs.readdirSync('/proc')){if(!/^\d+$/.test(name))continue;try{const stat=fs.readFileSync('/proc/'+name+'/stat','utf8');const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');if(Number(fields[3])===leader)process.kill(Number(name),signal);}catch(e){if(!['ESRCH','ENOENT'].includes(e.code))throw e;}}}
stop('SIGTERM');setTimeout(()=>stop('SIGKILL'),150);
`;
