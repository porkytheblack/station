import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerSandboxAdapter } from '../src/container.js';
import { engineCall } from '../src/container-engine.js';
const executable = process.env.STATION_CONTAINER_ENGINE;
const pause = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
async function finished(adapter: ContainerSandboxAdapter, sandbox: string, id: string) {
  for (let n=0; n<100; n++) { const run=await adapter.command(sandbox,id); if(run.finishedAt) return run; await pause(); }
  throw new Error('Command did not settle');
}
test('container cancellation contains PID-marker tampering and escaped sessions, interrupts siblings and recovers persistent workspace', { skip: !executable, timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'station-container-security-'));
  const adapter = new ContainerSandboxAdapter({ rootDir: root, executable, image: process.env.STATION_CONTAINER_IMAGE ?? 'node:22-bookworm-slim', seccompProfile: process.env.STATION_CONTAINER_SECCOMP, maxConcurrent: 4, enablePty: false });
  let id: string | undefined;
  try {
    await adapter.ready(); id=(await adapter.create()).id;
    const service = await adapter.startService(id,{name:'sibling',command:'sleep 120',restart:{policy:'always',maxRestarts:3,delayMs:100}});
    const other = await adapter.exec(id,{command:'sleep 120',timeoutMs:120000});
    const run = await adapter.exec(id,{command:`rm -f /tmp/station-*.pid; /usr/bin/setsid /bin/bash -c 'while true; do printf x >> escaped-marker; sleep .05; done' & echo ready; sleep 120`,timeoutMs:120000});
    for(let n=0;n<50;n++){if((await adapter.command(id,run.id)).stdout.includes('ready'))break;await pause();}
    assert.match((await adapter.command(id,run.id)).stdout,/ready/);
    assert.equal((await adapter.cancel(id,run.id)).status,'cancelled');
    assert.equal((await finished(adapter,id,other.id)).status,'interrupted');
    for(let n=0;n<50 && (await adapter.service(id,service.id)).status==='running';n++)await pause();
    assert.equal((await adapter.service(id,service.id)).status,'interrupted');
    const meta=JSON.parse(readFileSync(join(root,id,'workspace.json'),'utf8'));
    assert.equal(JSON.parse(await engineCall(executable!,['inspect',meta.container]))[0].State.Running,false);
    const before=(await adapter.readFile(id,'escaped-marker')).totalBytes;
    await pause(300);
    assert.equal((await adapter.readFile(id,'escaped-marker')).totalBytes,before);
    const next=await adapter.exec(id,{command:'printf recovered'});
    assert.equal((await finished(adapter,id,next.id)).stdout,'recovered');
    const timeout=await adapter.exec(id,{command:'rm -f /tmp/station-*.pid; sleep 30',timeoutMs:200});
    assert.equal((await finished(adapter,id,timeout.id)).status,'timed_out');
    const recovered=await adapter.exec(id,{command:'printf again'});
    assert.equal((await finished(adapter,id,recovered.id)).stdout,'again');
  } finally { if(id) {for(const service of await adapter.services(id))await adapter.removeService(id,service.id); await adapter.destroy(id);}await adapter.close();rmSync(root,{recursive:true,force:true}); }
});

test('one transient docker run failure preserves safe diagnostic and does not poison adapter', { skip: !executable, timeout: 60_000 }, async () => {
  const root=mkdtempSync(join(tmpdir(),'station-container-launch-'));
  const wrapper=join(root,'engine'); const marker=join(root,'failed-once');
  writeFileSync(wrapper,`#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');const args=process.argv.slice(2);if(args[0]==='run'&&!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'1');process.stderr.write('permission denied /private/DO-NOT-EXPOSE');process.exit(125)}const child=cp.spawn(${JSON.stringify(executable)},args,{stdio:'inherit'});child.on('exit',code=>process.exit(code??1));`,{mode:0o700});
  const adapter=new ContainerSandboxAdapter({rootDir:join(root,'state'),executable:wrapper,image:process.env.STATION_CONTAINER_IMAGE??'node:22-bookworm-slim',seccompProfile:process.env.STATION_CONTAINER_SECCOMP,enablePty:false});
  let id:string|undefined;
  try {
    await adapter.ready();await assert.rejects(adapter.create(),error=>error instanceof Error&&error.message.includes('permission_denied')&&!error.message.includes('DO-NOT-EXPOSE'));
    assert.equal((await adapter.list()).length,0);
    id=(await adapter.create()).id;
    const run=await adapter.exec(id,{command:'printf usable'});
    assert.equal((await finished(adapter,id,run.id)).stdout,'usable');
  } finally {if(id)await adapter.destroy(id);await adapter.close();rmSync(root,{recursive:true,force:true});}
});
