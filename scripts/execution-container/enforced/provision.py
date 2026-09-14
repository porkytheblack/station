#!/usr/bin/env python3
"""Root-only, local Linux Docker + iptables + XFS deployment. No cloud provisioning."""
import argparse, hashlib, ipaddress, json, os, pathlib, re, shlex, subprocess, sys

def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()
def require(ok, message):
    if not ok: raise RuntimeError(message)
def check_ptrace_scope(value):
    require(value is not None and value.strip() in ['1','2','3'], 'Yama ptrace_scope must be at least 1 to protect the unguarded container init ancestor')
def load(path):
    c = json.loads(pathlib.Path(path).read_text())
    require(set(c) == {'tenantId','network','subnet','storageRoot','projectId','diskMiB','inodes','uid','gid','proxyImage','allowedHosts'}, 'Unexpected/missing configuration keys')
    require(re.fullmatch(r'[a-z][a-z0-9-]{0,39}', c['tenantId']) and re.fullmatch(r'station-[a-z0-9-]{1,40}', c['network']), 'Invalid tenant/network name')
    subnet = ipaddress.ip_network(c['subnet'], strict=True)
    require(subnet.version == 4 and subnet.prefixlen == 24 and subnet.subnet_of(ipaddress.ip_network('172.16.0.0/12')), 'Choose a dedicated RFC1918 /24 in 172.16/12')
    root = pathlib.Path(c['storageRoot'])
    require(root.is_absolute() and re.fullmatch(r'/[a-zA-Z0-9_./-]+', str(root)) and '..' not in root.parts and root.resolve() == root and str(root) != '/', 'Storage root must be a canonical absolute path without symlinks')
    for k in ['projectId','diskMiB','inodes','uid','gid']: require(type(c[k]) is int and 0 < c[k] < 2**31, 'Invalid numeric quota/identity setting')
    require(c['diskMiB'] >= 16, 'Quota must be at least 16MiB')
    require(isinstance(c['allowedHosts'],list) and c['allowedHosts'] and all(isinstance(h,str) and re.fullmatch(r'(\*|(?:\*\.)?[a-z0-9][a-z0-9.-]*)',h) for h in c['allowedHosts']), 'Invalid proxy allowlist')
    require(isinstance(c['proxyImage'],str) and not c['proxyImage'].startswith('-') and '\n' not in c['proxyImage'], 'Invalid image')
    c['bridge'] = 'stn' + hashlib.sha256(c['network'].encode()).hexdigest()[:10]
    c['proxyIP'] = str(subnet.network_address + 2)
    c['proxyName'] = c['network'] + '-proxy'
    return c

def preflight(c):
    require(sys.platform == 'linux' and os.geteuid() == 0, 'Requires a rootful Linux host; rootless engines/macOS are unsupported')
    ptrace=pathlib.Path('/proc/sys/kernel/yama/ptrace_scope')
    check_ptrace_scope(ptrace.read_text() if ptrace.exists() else None)
    require(not os.environ.get('DOCKER_HOST') or os.environ['DOCKER_HOST'].startswith('unix://'), 'Remote Docker hosts are unsupported')
    endpoint=json.loads(run('docker','context','inspect','--format','{{json .Endpoints.docker.Host}}'))
    require(endpoint.startswith('unix://'), 'A local Unix-socket Docker context is required')
    info=json.loads(run('docker','info','--format','{{json .}}'))
    require(info.get('OSType')=='linux' and not any('rootless' in s for s in info.get('SecurityOptions',[])), 'Requires rootful Linux Docker')
    run('iptables','-w','-S','DOCKER-USER')
    run('ip6tables','-w','-S','INPUT')
    require(pathlib.Path('/proc/sys/net/bridge/bridge-nf-call-iptables').read_text().strip()=='1', 'Enable br_netfilter and bridge-nf-call-iptables=1 before provisioning')
    require(pathlib.Path('/proc/sys/net/bridge/bridge-nf-call-ip6tables').read_text().strip()=='1', 'Enable bridge-nf-call-ip6tables=1 before provisioning')
    parent=pathlib.Path(c['storageRoot']).parent
    require(parent.is_dir(), 'Storage parent must already exist on mounted XFS')
    mount=json.loads(run('findmnt','-J','-T',str(parent),'-o','TARGET,FSTYPE,OPTIONS'))['filesystems'][0]
    require(mount['fstype']=='xfs' and any(flag in mount['options'].split(',') for flag in ['prjquota','pquota']), 'Storage must be XFS mounted with project quota enforcement')
    desired=ipaddress.ip_network(c['subnet'])
    for route in json.loads(run('ip','-j','route','show','table','all')):
      destination=route.get('dst','default')
      if destination!='default' and route.get('dev')!=c['bridge']:
        try: overlap=desired.overlaps(ipaddress.ip_network(destination,strict=False))
        except ValueError: overlap=False
        require(not overlap,'Requested workload subnet overlaps an existing host route')
    for identity in run('docker','network','ls','-q').splitlines():
      network=json.loads(run('docker','network','inspect',identity))[0]
      if network['Name']==c['network']: continue
      for item in network.get('IPAM',{}).get('Config',[]) or []:
        if item.get('Subnet'): require(not desired.overlaps(ipaddress.ip_network(item['Subnet'])),'Requested workload subnet overlaps another Docker network')
    c['mount']=mount['target']
    state=run('xfs_quota','-x','-c','state -p',c['mount'])
    require('Accounting: ON' in state and 'Enforcement: ON' in state, 'XFS project accounting AND enforcement must be ON')
    image=json.loads(run('docker','image','inspect',c['proxyImage']))[0]
    c['proxyImage']=image['Id']

def firewall_rules(c):
    # Rules precede Docker's accepts. Same-bridge traffic must cross br_netfilter too.
    tag='station-egress:'+c['tenantId']; subnet=c['subnet']; ip=c['proxyIP']
    return [
      ('iptables','DOCKER-USER',['-s',subnet,'-d',ip,'-p','tcp','--dport','8080','-m','comment','--comment',tag,'-j','ACCEPT']),
      ('iptables','DOCKER-USER',['-d',subnet,'-s',ip,'-p','tcp','--sport','8080','-m','conntrack','--ctstate','ESTABLISHED','-m','comment','--comment',tag,'-j','ACCEPT']),
      ('iptables','DOCKER-USER',['-s',subnet,'-m','comment','--comment',tag,'-j','DROP']),
      ('iptables','DOCKER-USER',['-d',subnet,'-m','comment','--comment',tag,'-j','DROP']),
      ('iptables','INPUT',['-s',subnet,'-m','comment','--comment',tag,'-j','DROP']),
      ('ip6tables','INPUT',['-i',c['bridge'],'-m','comment','--comment',tag,'-j','DROP']),
      ('ip6tables','FORWARD',['-i',c['bridge'],'-m','comment','--comment',tag,'-j','DROP']),
      ('ip6tables','FORWARD',['-o',c['bridge'],'-m','comment','--comment',tag,'-j','DROP']),
    ]

def verify(c):
    preflight(c)
    root=pathlib.Path(c['storageRoot'])
    marker=json.loads((root/'.station-deployment.json').read_text())
    require(all(marker.get(k)==c[k] for k in ['tenantId','network','subnet','projectId','diskMiB','inodes','uid','gid','allowedHosts']), 'Deployment identity/settings changed; stop workers and migrate explicitly')
    net=json.loads(run('docker','network','inspect',c['network']))[0]
    require(net['Internal'] and not net.get('EnableIPv6') and net['Options'].get('com.docker.network.bridge.name')==c['bridge'], 'Invalid internal network')
    require(net['IPAM']['Config']==[{'Subnet':c['subnet']} ] or (len(net['IPAM']['Config'])==1 and net['IPAM']['Config'][0]['Subnet']==c['subnet']), 'Network subnet mismatch')
    for binary,chain,args in firewall_rules(c): run(binary,'-w','-C',chain,*args)
    verify_rule_order(c)
    tree=run('xfs_quota','-x','-c',f"project -c -p {root} {c['projectId']}",c['mount'])
    require(not any(word in tree.lower() for word in ['not set','does not','mismatch','failed','error']), 'Quota project inheritance validation failed')
    quota=run('xfs_quota','-x','-c',f"dump -p -L {c['projectId']} -U {c['projectId']}",c['mount'])
    rows=[line.split() for line in quota.splitlines() if line.split() and line.split()[0]==str(c['projectId'])]
    require(len(rows)==1 and len(rows[0])>=5, 'Cannot verify stored project limits')
    # dump rows use 512-byte basic blocks (unlike report's KiB).
    require(int(rows[0][2])==c['diskMiB']*2048 and int(rows[0][4])==c['inodes'], 'Hard block/inode quota differs from configured limits')
    proxy=json.loads(run('docker','inspect',c['proxyName']))[0]
    require(proxy['State']['Running'] and proxy['Config']['Image']==c['proxyImage'] and proxy['NetworkSettings']['Networks'][c['network']]['IPAddress']==c['proxyIP'], 'Proxy is unavailable or changed')
    proxy_env=[value[len('STATION_EGRESS_CONFIG='):] for value in proxy['Config'].get('Env',[]) if value.startswith('STATION_EGRESS_CONFIG=')]
    require(len(proxy_env)==1 and json.loads(proxy_env[0])=={'allowedHosts':c['allowedHosts']}, 'Running proxy policy differs from configured allowlist')
    return c

def check_rule_order(c, chain_rules, expected_count):
    tag='station-egress:'+c['tenantId']; subnet=ipaddress.ip_network(c['subnet'])
    owned=[i for i,tokens in enumerate(chain_rules) if '--comment' in tokens and tokens[tokens.index('--comment')+1]==tag]
    require(len(owned)==expected_count, 'Unexpected/missing Station firewall rules')
    # Other tenant profiles may precede this profile. Only disjoint, constrained
    # Station allows or unconditional drops are safe before our final deny rule.
    for tokens in chain_rules[:owned[-1]+1]:
      target=tokens[tokens.index('-j')+1] if '-j' in tokens else ''
      if '--comment' in tokens and tokens[tokens.index('--comment')+1]==tag: continue
      require(target=='DROP' or (target=='ACCEPT' and '!' not in tokens and '--comment' in tokens and tokens[tokens.index('--comment')+1].startswith('station-egress:') and all(flag in tokens and not subnet.overlaps(ipaddress.ip_network(tokens[tokens.index(flag)+1],strict=False)) for flag in ['-s','-d'])), 'Earlier firewall rule can bypass the Station boundary')
    targets=[chain_rules[i][chain_rules[i].index('-j')+1] for i in owned]
    require(targets==(['ACCEPT','ACCEPT','DROP','DROP'] if expected_count==4 else ['DROP']*expected_count), 'Station allow/deny rule order changed')

def verify_rule_order(c):
    forwarding=[shlex.split(line) for line in run('iptables','-w','-S','FORWARD').splitlines() if line.startswith('-A ')]
    dispatch=['-A','FORWARD','-j','DOCKER-USER']
    require(dispatch in forwarding, 'FORWARD must unconditionally dispatch to DOCKER-USER')
    require(all('-j' in rule and rule[rule.index('-j')+1]=='DROP' for rule in forwarding[:forwarding.index(dispatch)]), 'Earlier FORWARD rule can bypass DOCKER-USER')
    groups={}
    for binary,chain,_args in firewall_rules(c): groups[(binary,chain)]=groups.get((binary,chain),0)+1
    for (binary,chain),count in groups.items():
      lines=[shlex.split(line) for line in run(binary,'-w','-S',chain).splitlines() if line.startswith('-A ')]
      check_rule_order(c,lines,count)

def apply(c):
    preflight(c)
    root=pathlib.Path(c['storageRoot'])
    require(not root.exists(), 'Refusing existing storage root; use verify for an existing deployment')
    # No mutation before all prerequisites succeed. Identity reservation never reassigns an existing project.
    dump=run('xfs_quota','-x','-c','report -p -b -N -n',c['mount'])
    require(not any(line.split() and line.split()[0].lstrip('#')==str(c['projectId']) for line in dump.splitlines()), 'Project ID already has limits; allocate a new project ID')
    root.mkdir(mode=0o700)
    run('xfs_quota','-x','-c',f"project -s -p {root} {c['projectId']}",c['mount'])
    run('xfs_quota','-x','-c',f"limit -p bhard={c['diskMiB']}m ihard={c['inodes']} {c['projectId']}",c['mount'])
    for name in ['profiles','browser','recordings','state','station']:
      path=root/name; path.mkdir(mode=0o700); os.chown(path,c['uid'],c['gid'])
    os.chown(root,c['uid'],c['gid'])
    (root/'.station-deployment.json').write_text(json.dumps(c))
    # Install deny rules before creating/attaching any workload network.
    for binary,chain,args in reversed(firewall_rules(c)): run(binary,'-w','-I',chain,'1',*args)
    run('docker','network','create','--internal','--subnet',c['subnet'],'--opt','com.docker.network.bridge.name='+c['bridge'],'--label','station.egress.tenant='+c['tenantId'],c['network'])
    run('docker','create','--name',c['proxyName'],'--network','bridge','--restart','unless-stopped','--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','128m','--cpus','0.5','--pids-limit','64','--log-driver','none','--env','STATION_EGRESS_CONFIG='+json.dumps({'allowedHosts':c['allowedHosts']}),c['proxyImage'])
    run('docker','network','connect','--ip',c['proxyIP'],c['network'],c['proxyName'])
    run('docker','start',c['proxyName'])
    verify(c)
    print(json.dumps({'network':c['network'],'networkRestricted':True,'proxy':{'server':f"http://{c['proxyIP']}:8080"},'profileStorageRoot':str(root/'profiles'),'rootDir':str(root/'browser'),'recordingRootDir':str(root/'recordings'),'stateRootDir':str(root/'state'),'stationDir':str(root/'station')}))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['preflight','apply','verify']);parser.add_argument('config');args=parser.parse_args()
    try:
      config=load(args.config)
      if args.action=='apply': apply(config)
      elif args.action=='verify': verify(config);print('Verified egress rules, proxy, ownership and hard XFS quotas')
      else: preflight(config);print('Linux Docker/XFS prerequisites available')
    except Exception as e:
      print('Refusing deployment: '+str(e),file=sys.stderr);sys.exit(1)
