#!/bin/bash
# Real-kernel check of the bandwidth limits, no hardware needed: a private network namespace (unprivileged) with a
# fake LAN client and WAN host, the real vendo5 nft ruleset, and the shaper. Prints a 3 MB download unlimited, then
# with an 8 Mbit/s (1 MB/s) limit, and the byte counters.   Run: unshare -Urn bash scripts/shaper-netns-test.sh
set -e
trap 'kill $(jobs -p) 2>/dev/null; true' EXIT
R=$(cd "$(dirname "$0")/.." && pwd); J=$(mktemp -d)
ip link set lo up
unshare -n sleep 600 >/dev/null 2>&1 & CP=$!
unshare -n sleep 600 >/dev/null 2>&1 & WP=$!
sleep 0.5
ip link add br-lan type veth peer name c0; ip link set c0 netns $CP
ip link add eth0 type veth peer name w0; ip link set w0 netns $WP
ip addr add 10.0.0.1/24 dev br-lan; ip link set br-lan up
ip addr add 10.9.0.1/24 dev eth0; ip link set eth0 up
nsenter -t $CP -n sh -c "ip link set c0 address aa:bb:cc:dd:ee:01; ip addr add 10.0.0.5/24 dev c0; ip link set c0 up; ip link set lo up; ip route add default via 10.0.0.1"
nsenter -t $WP -n sh -c "ip addr add 10.9.0.2/24 dev w0; ip link set w0 up; ip link set lo up; ip route add default via 10.9.0.1"
sysctl -qw net.ipv4.ip_forward=1
nft -f $R/etc-overlay/etc/vendo5-firewall.nft
nft add element inet vendo5 allowed '{ aa:bb:cc:dd:ee:01 }'
head -c 3000000 /dev/zero > $J/blob
(cd $J && nsenter -t $WP -n python3 -m http.server 8088 >/dev/null 2>&1 &) ; sleep 1
ping -c1 -W1 10.0.0.5 >/dev/null || true
echo "--- no limit"
nsenter -t $CP -n python3 - <<PY
import time,urllib.request
t=time.time(); n=len(urllib.request.urlopen('http://10.9.0.2:8088/blob',timeout=30).read()); print('download', n, 'bytes in %.1fs'%(time.time()-t))
PY
echo "--- with 8M download limit (1,000,000 B/s)"
node -e "
const {execFileSync}=require('child_process');const {createShaper}=require('$R/lib/system/shaper');
const A='aa:bb:cc:dd:ee:01';const sess={[A]:{expiresAt:Date.now()+9e5,upload:'8M',download:'8M',max_data_limit:'1M'}};
global.sh=createShaper({runCommand:(a)=>execFileSync(a[0],a.slice(1),{encoding:'utf8'}),sessions:{all:()=>sess,getSession:(m)=>sess[m]},arp:{neighbors:()=>({[A]:{ip:'10.0.0.5'}})},file:'$J/e2e-limits.nft',onCap:(m)=>console.log('CAP reached for',m)});
sh.tick();
"
nsenter -t $CP -n python3 - <<PY
import time,urllib.request
t=time.time(); n=len(urllib.request.urlopen('http://10.9.0.2:8088/blob',timeout=60).read()); print('download', n, 'bytes in %.1fs'%(time.time()-t))
PY
echo "--- after revoke (not allowed): the same download must fail"
nft delete element inet vendo5 allowed '{ aa:bb:cc:dd:ee:01 }'
nsenter -t $CP -n python3 - <<PY
import urllib.request
try:
    urllib.request.urlopen('http://10.9.0.2:8088/blob', timeout=3).read(); print('FAIL: revoked client still got through')
except Exception as e:
    print('PASS: revoked client blocked (%s)' % type(e).__name__)
PY
nft list chain inet vendo5 bwlimit | grep -o 'comment.*\|bytes [0-9]*' | head -6
