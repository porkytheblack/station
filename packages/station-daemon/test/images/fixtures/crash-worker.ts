import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteAdapter } from 'station-adapter-sqlite';
import { BroadcastSqliteAdapter } from 'station-adapter-sqlite/broadcast';
import { StationNetworkSqliteAdapter } from 'station-adapter-sqlite/network';
import { SignalRunner } from 'station-signal';
import { BroadcastRunner, type BroadcastNodeRunPatch } from 'station-broadcast';
import { FileImageRegistry } from 'station-images';
import { ImageController } from '../../../src/images/controller.js';
import { ImagePreparations } from '../../../src/images/preparation.js';
process.env.__STATION_TSX ??= fileURLToPath(import.meta.resolve('tsx'));
const config=JSON.parse(await readFile(process.argv[2]!,'utf8'));
const send=(value:unknown)=>process.send?.(value);
if(config.mode==='preparation'){
 const network=new StationNetworkSqliteAdapter({dbPath:join(config.root,'network.db')});
 const preparations=new ImagePreparations({adapter:network,networkId:'crash-test',stationId:'killed-worker',timeoutMs:1000});
 await preparations.request({id:'reserved-run',signalName:'reserved-image'},async owned=>{if(!await owned())throw Error('reservation not owned');send({type:'reserved'});await new Promise(()=>{});});
 setInterval(()=>{},1000);
}else{
 class CheckpointAdapter extends BroadcastSqliteAdapter {
  override async updateNodeRun(id:string,patch:BroadcastNodeRunPatch){await super.updateNodeRun(id,patch);if(config.pause&&patch.status==='completed'){send({type:'checkpoint'});await new Promise(()=>{});}}
 }
 const adapter=new SqliteAdapter({dbPath:join(config.root,'signals.db')}),broadcastAdapter=new CheckpointAdapter({dbPath:join(config.root,'broadcasts.db')});
 const signals=new SignalRunner({adapter,pollIntervalMs:10,leaseDurationMs:300}),runner=new BroadcastRunner({signalRunner:signals,adapter:broadcastAdapter,pollIntervalMs:10,reconcileEveryNTicks:1});
 const controller=new ImageController({registry:new FileImageRegistry(join(config.root,'registry')),signalRunner:signals,broadcastRunner:runner,stateDir:join(config.root,'runtime'),backend:config.backend,nativeSignals:config.grants});
 let id=config.runId;
 if(id)await controller.restore();else{await controller.install(config.digest);id=(await controller.run(config.digest,'workflow',{hello:'crash'})).id;send({type:'run',id});}
 const signalLoop=signals.start(),broadcastLoop=runner.start();
 if(config.pause)setInterval(()=>{},1000);else{
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){const run=await broadcastAdapter.getBroadcastRun(id);if(run&&['completed','failed'].includes(run.status)){send({type:'finished',run,nodes:await broadcastAdapter.getNodeRuns(id)});break;}await new Promise(resolve=>setTimeout(resolve,20));}
  await runner.stop();await broadcastLoop;await signals.stop({graceful:true});await signalLoop;process.disconnect?.();
 }
}
