import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createEgressProxy, publicIPv4 } from './proxy.mjs';
const listen = server => new Promise(resolve => server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const connect = (port, target) => new Promise((resolve,reject) => { const socket=net.connect(port,'127.0.0.1',()=>socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));socket.once('error',reject);socket.once('data',data=>resolve({socket,text:data.toString()})); });
test('public IPv4 policy excludes private, metadata, reserved, mapped IPv6 and ambiguous literals', () => {
  for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','100.100.100.200','172.16.2.1','192.168.1.1','192.0.2.1','198.18.0.1','203.0.113.1','224.0.0.1','240.0.0.1','::1','::ffff:8.8.8.8','2130706433','0177.0.0.1']) assert.equal(publicIPv4(ip),false,ip);
  for(const ip of ['1.1.1.1','8.8.8.8','93.184.216.34']) assert.equal(publicIPv4(ip),true,ip);
});
test('CONNECT pins the validated IP and rejects private DNS answers, rebinding, ports and unlisted hosts', async t => {
  const upstream=net.createServer(socket=>socket.on('data',data=>socket.write(data)));
  const upstreamPort=await listen(upstream);t.after(()=>new Promise(resolve=>upstream.close(resolve)));
  const seen=[];
  const proxy=createEgressProxy({allowedHosts:['example.test','private.test','mixed.test'],resolver:async host=>host==='private.test'?[{address:'127.0.0.1'}]:host==='mixed.test'?[{address:'1.1.1.1'},{address:'169.254.169.254'}]:[{address:'1.1.1.1'}],dial:options=>{seen.push(options);return net.connect(upstreamPort,'127.0.0.1');}});
  const port=await listen(proxy.server);t.after(()=>proxy.close());
  for(const target of ['private.test:443','mixed.test:443','127.0.0.1:443','[::1]:443','example.test:80','other.test:443','example.test:443/path']) {const {socket,text}=await connect(port,target);assert.match(text,/403/);socket.destroy();}
  assert.equal(seen.length,0);
  const first=await connect(port,'example.test:443');assert.match(first.text,/200/);assert.deepEqual(seen,[{host:'1.1.1.1',port:443,family:4}]);
  const echoed=new Promise(resolve=>first.socket.once('data',data=>resolve(data.toString())));first.socket.write('tls-fixture');assert.equal(await echoed,'tls-fixture');first.socket.destroy();
  // A fresh connection must validate again; no hostname->IP decision cache survives DNS changes.
  const rebinding=createEgressProxy({allowedHosts:['example.test'],resolver:async()=>[{address:'169.254.169.254'}],dial:()=>{throw Error('must not dial');}});
  const reboundPort=await listen(rebinding.server);const denied=await connect(reboundPort,'example.test:443');assert.match(denied.text,/403/);denied.socket.destroy();await rebinding.close();
});
test('proxy enforces tunnel concurrency and byte budget', async t => {
  const upstream=net.createServer(socket=>socket.on('data',data=>socket.write(data)));const upstreamPort=await listen(upstream);t.after(()=>new Promise(resolve=>upstream.close(resolve)));
  const proxy=createEgressProxy({allowedHosts:['*'],maxConnections:1,maxTunnelBytes:8,resolver:async()=>[{address:'1.1.1.1'}],dial:()=>net.connect(upstreamPort,'127.0.0.1')});const port=await listen(proxy.server);t.after(()=>proxy.close());
  const first=await connect(port,'example.test:443');const second=await connect(port,'example.test:443');assert.match(second.text,/429/);second.socket.destroy();
  const closed=new Promise(resolve=>first.socket.once('close',resolve));first.socket.write('longer-than-limit');await closed;
});
test('timed-out DNS reservations remain bounded until the OS lookup settles', async t => {
  let calls=0;
  const proxy=createEgressProxy({allowedHosts:['*'],maxConnections:1,connectTimeoutMs:25,resolver:()=>{calls++;return new Promise(()=>{});}});
  const port=await listen(proxy.server);t.after(()=>proxy.close());
  const first=await connect(port,'slow.test:443');assert.match(first.text,/403/);first.socket.destroy();
  const second=await connect(port,'another.test:443');assert.match(second.text,/403/);second.socket.destroy();
  assert.equal(calls,1);
});
