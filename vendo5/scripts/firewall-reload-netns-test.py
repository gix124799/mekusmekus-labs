#!/usr/bin/env python3
# Run in a private network namespace, e.g. sudo unshare -n python3 scripts/firewall-reload-netns-test.py
import json,pathlib,subprocess,tempfile
source=pathlib.Path(__file__).resolve().parent.parent/'etc-overlay/etc/vendo5-firewall.nft'
def nft(*args):return subprocess.check_output(['nft',*args],text=True)
def state():return json.loads(nft('-j','list','table','inet','vendo5'))['nftables']
nft('-f',str(source))
nft('add','element','inet','vendo5','allowed','{ aa:bb:cc:dd:ee:01 }')
nft('add','element','inet','vendo5','walled','{ 10.9.0.2 }')
nft('add','rule','inet','vendo5','bwlimit','counter','comment','reload-regression')
before=state();count=sum('rule' in item for item in before)
nft('-f',str(source));after=state()
assert sum('rule' in item for item in after)==count,'reload duplicated firewall rules'
for name in ['allowed','walled']:
 old=next(i['set'].get('elem') for i in before if i.get('set',{}).get('name')==name)
 new=next(i['set'].get('elem') for i in after if i.get('set',{}).get('name')==name)
 assert old==new,f'reload lost {name} entries'
assert any(i.get('rule',{}).get('comment')=='reload-regression' for i in after),'reload lost bandwidth rules'
with tempfile.TemporaryDirectory() as tmp:
 p=pathlib.Path(tmp)/'new-wan.nft';p.write_text(source.read_text().replace('define WAN = "eth0"','define WAN = "eth9"'))
 nft('-f',str(p))
text=json.dumps(state())
assert 'eth0' not in text,'old WAN rules survive reload'
assert 'eth9' in text,'new WAN rules missing'
assert sum('rule' in item for item in state())==count,'WAN change duplicated rules'
print('PASS: reload preserves live sets and bandwidth rules, never duplicates rules, and removes old WAN rules')
