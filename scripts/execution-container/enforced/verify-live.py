#!/usr/bin/env python3
"""Real kernel/network regression. Uses only a newly provisioned disposable tenant."""
import importlib.util, json, os, pathlib, socket, subprocess, sys
spec=importlib.util.spec_from_file_location('provision',pathlib.Path(__file__).with_name('provision.py'));mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
c=mod.load(sys.argv[1]);mod.verify(c)
# A permissive FORWARD rule ahead of Docker must invalidate readiness.
mod.run('iptables','-w','-I','FORWARD','1','-m','comment','--comment','station-test-bypass','-j','ACCEPT')
try:
 try:mod.verify(c)
 except RuntimeError:pass
 else:raise RuntimeError('Verifier accepted earlier FORWARD bypass')
finally:mod.run('iptables','-w','-D','FORWARD','-m','comment','--comment','station-test-bypass','-j','ACCEPT')
drift=dict(c,allowedHosts=['*'])
try:mod.verify(drift)
except RuntimeError:pass
else:raise RuntimeError('Verifier accepted proxy allowlist drift')
print('PASS: readiness rejects earlier FORWARD accepts and changed proxy policy',flush=True)
image=sys.argv[2] # Pre-pulled Node image; no implicit image installation.
mod.run('docker','image','inspect',image)
args=['docker','run','--rm','--network',c['network'],'--dns','127.0.0.1','--cap-drop','ALL','--security-opt','no-new-privileges','--user',f"{c['uid']}:{c['gid']}",'--read-only','--memory','128m','--pids-limit','32','--sysctl','net.ipv6.conf.all.disable_ipv6=1',image,'node','-e']
# A real socket to the host bridge gateway, metadata, another container and a public IP must fail.
peer=mod.run('docker','run','-d','--network',c['network'],'--entrypoint','node',image,'-e','require("net").createServer(s=>s.end("peer")).listen(8765,"0.0.0.0")')
host_listener=socket.socket();host_listener.bind(('0.0.0.0',0));host_listener.listen(8)
host_port=host_listener.getsockname()[1]
with socket.create_connection(('127.0.0.1',host_port),timeout=2):pass
try:
 peerip=json.loads(mod.run('docker','inspect',peer))[0]['NetworkSettings']['Networks'][c['network']]['IPAddress']
 gateway=str(__import__('ipaddress').ip_network(c['subnet']).network_address+1)
 for host,port in [(gateway,host_port),('169.254.169.254',80),(peerip,8765),('1.1.1.1',443),('::1',443)]:
  script=f'''const net=require('net');const s=net.connect({{host:{json.dumps(host)},port:{port}}});s.on('connect',()=>{{console.error('BYPASS');process.exit(1)}});s.on('error',()=>process.exit(0));s.setTimeout(1500,()=>process.exit(0));'''
  mod.run(*args,script)
 print('PASS: direct public, peer, host gateway, metadata and IPv6 sockets denied',flush=True)
 # Explicit proxy refuses metadata, private/IPv6 authorities, non443 and unlisted hostnames.
 for authority in ['169.254.169.254:443','127.0.0.1:443','[::1]:443','example.com:80','unlisted.invalid:443']:
  script=f'''const s=require('net').connect(8080,{json.dumps(c['proxyIP'])},()=>s.write('CONNECT {authority} HTTP/1.1\\r\\nHost: {authority}\\r\\n\\r\\n'));s.setTimeout(3000,()=>process.exit(2));s.on('error',()=>process.exit(3));s.once('data',d=>process.exit(d.toString().startsWith('HTTP/1.1 403')?0:1));'''
  mod.run(*args,script)
 # Positive control: the permitted HTTPS destination actually works through the proxy.
 mod.run(*args,f'''const net=require('net'),tls=require('tls');const s=net.connect(8080,{json.dumps(c['proxyIP'])},()=>s.write('CONNECT example.com:443 HTTP/1.1\\r\\nHost: example.com:443\\r\\n\\r\\n'));s.setTimeout(15000,()=>process.exit(2));s.on('error',()=>process.exit(3));s.once('data',d=>{{if(!d.toString().startsWith('HTTP/1.1 200'))process.exit(1);const t=tls.connect({{socket:s,servername:'example.com'}},()=>t.write('GET / HTTP/1.1\\r\\nHost: example.com\\r\\nConnection: close\\r\\n\\r\\n'));t.on('error',()=>process.exit(4));t.once('data',b=>process.exit(/^HTTP\\/1\\.[01] [23]/.test(b.toString())?0:5));}});''')
 print('PASS: allowed HTTPS succeeds; private, unlisted and non443 CONNECT denied',flush=True)
 # Hostname query cannot bypass allowlists through Docker's resolver.
 mod.run(*args,"require('dns').resolve4('example.com',(e,a)=>process.exit(e?0:1));setTimeout(()=>process.exit(0),2000)")
 mod.run('docker','run','--rm','--network','none','--cap-drop','ALL','--user',f"{c['uid']}:{c['gid']}",'--entrypoint','/usr/local/bin/station-quota-guard',image,'--self-test')
 # The same project budget covers profile and controller roots; an actual allocation must hit EDQUOT.
 probe=pathlib.Path(c['storageRoot'])/'profiles'/'quota-probe';probe.mkdir(mode=0o700);os.chown(probe,c['uid'],c['gid'])
 available=os.statvfs(pathlib.Path(c['storageRoot']).parent)
 mod.require(available.f_bavail*available.f_frsize > c['diskMiB']*1048576*2, 'Test filesystem needs more than twice the quota free to distinguish quota exhaustion from a full host disk')
 quota_args=['docker','run','--rm','--network','none','--cap-drop','ALL','--user',f"{c['uid']}:{c['gid']}",'--read-only','--memory','128m','--mount',f'type=bind,src={probe},dst=/probe','--entrypoint','/usr/local/bin/station-quota-guard',image,'/usr/local/bin/node','-e']
 print(mod.run(*quota_args[:-2],'/usr/local/bin/station-quota-probe','/probe'),flush=True)
 script=f'''const fs=require('fs');const fd=fs.openSync('/probe/fill','w');const data=Buffer.alloc(1048576,42);let bytes=0;try{{for(let i=0;i<{c['diskMiB']+4};i++){{bytes+=fs.writeSync(fd,data);fs.fsyncSync(fd)}}process.exitCode=1}}catch(e){{if(!['EDQUOT','ENOSPC'].includes(e.code)||bytes>{c['diskMiB']}*1048576)throw e; console.log('quota-enforced',e.code,bytes)}}finally{{fs.closeSync(fd);fs.unlinkSync('/probe/fill')}}'''
 print(mod.run(*quota_args,script),flush=True);probe.rmdir()
 print('PASS: direct/peer/metadata/IPv6/DNS bypass denied, proxy restrictions enforced, real disk allocation bounded')
finally:
 host_listener.close()
 mod.run('docker','rm','-f',peer)
