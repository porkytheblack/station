import copy, importlib.util, pathlib, shlex, unittest
spec=importlib.util.spec_from_file_location('provision',pathlib.Path(__file__).with_name('provision.py'));p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)

class FirewallOrderTests(unittest.TestCase):
 def setUp(self):
  self.c=p.load(pathlib.Path(__file__).with_name('example.json'))
  self.rules=[['-A',chain,*args] for binary,chain,args in p.firewall_rules(self.c) if binary=='iptables' and chain=='DOCKER-USER']
 def test_generated_and_disjoint_other_tenant_rules(self):
  p.check_rule_order(self.c,self.rules,4)
  other=copy.deepcopy(self.c);other.update(tenantId='other',subnet='172.25.0.0/24',proxyIP='172.25.0.2')
  prefix=[['-A',chain,*args] for binary,chain,args in p.firewall_rules(other) if binary=='iptables' and chain=='DOCKER-USER']
  p.check_rule_order(self.c,prefix+self.rules,4)
 def test_earlier_accept_rejected(self):
  with self.assertRaises(RuntimeError):p.check_rule_order(self.c,[shlex.split('-A DOCKER-USER -j ACCEPT')]+self.rules,4)
 def test_negated_foreign_allow_rejected(self):
  bypass=shlex.split('-A DOCKER-USER ! -s 172.25.0.0/24 ! -d 172.25.0.0/24 -m comment --comment station-egress:other -j ACCEPT')
  with self.assertRaises(RuntimeError):p.check_rule_order(self.c,[bypass]+self.rules,4)
 def test_allow_after_drop_rejected(self):
  with self.assertRaises(RuntimeError):p.check_rule_order(self.c,[self.rules[2],*self.rules[:2],self.rules[3]],4)
 def test_yama_required_and_restrictive(self):
  for value in [None,'0','-1','unavailable']:
   with self.assertRaises(RuntimeError):p.check_ptrace_scope(value)
  for value in ['1','2','3','1\n']:p.check_ptrace_scope(value)

if __name__=='__main__':unittest.main()
