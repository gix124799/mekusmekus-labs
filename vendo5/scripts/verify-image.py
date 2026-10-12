#!/usr/bin/env python3
"""Read-only release gate: original boot bytes plus exact shipped app/config files."""
import argparse, hashlib, json, pathlib, struct, subprocess, tempfile, zlib

def digest(data): return hashlib.sha256(data).hexdigest()
def fat_files(part):
    bps=struct.unpack_from('<H',part,11)[0];spc=part[13]
    reserved=struct.unpack_from('<H',part,14)[0];nf=part[16]
    roots=struct.unpack_from('<H',part,17)[0];spf=struct.unpack_from('<H',part,22)[0]
    root=(reserved+nf*spf)*bps;data=root+((roots*32+bps-1)//bps)*bps
    result={}
    for i in range(roots):
        e=part[root+32*i:root+32*(i+1)]
        if not e[0]:break
        if e[0]==229 or e[11]==15 or e[11]&24:continue
        name=e[:8].decode().strip();ext=e[8:11].decode().strip()
        name=name+('.'+ext if ext else '')
        c=struct.unpack_from('<H',e,26)[0];size=struct.unpack_from('<I',e,28)[0];out=b'';seen=set()
        while 2<=c<65528:
            assert c not in seen,'FAT cluster loop';seen.add(c)
            out+=part[data+(c-2)*spc*bps:data+(c-1)*spc*bps]
            c=struct.unpack_from('<H',part,reserved*bps+c*2)[0]
        assert len(out)>=size,'truncated FAT file'
        result[name]=out[:size]
    return result

def legacy_image(blob,kind):
    header=blob[:64];assert len(header)==64
    fields=struct.unpack('>7I4B32s',header)
    assert fields[0]==0x27051956,'bad U-Boot magic'
    assert fields[1]==zlib.crc32(header[:4]+b'\0'*4+header[8:])&0xffffffff,'bad header CRC'
    assert len(blob)==64+fields[3],'bad U-Boot payload size'
    assert fields[6]==zlib.crc32(blob[64:])&0xffffffff,'bad payload CRC'
    assert fields[9]==kind,'wrong U-Boot image type'

ROOT_OFFSET={'arm':69206016,'x86':67371008}

def main():
    ap=argparse.ArgumentParser();ap.add_argument('base');ap.add_argument('candidate')
    ap.add_argument('--target',choices=['arm','x86'],default='arm')
    args=ap.parse_args()
    base=pathlib.Path(args.base);candidate=pathlib.Path(args.candidate)
    assert base.stat().st_size==candidate.stat().st_size,'image size changed'
    rootstart=ROOT_OFFSET[args.target]//512
    with base.open('rb') as bf,candidate.open('rb') as cf:
        if args.target=='arm':
            bm=bf.read(512);cm=cf.read(512);assert bm==cm and cm[510:]==b'\x55\xaa','MBR mismatch'
            parts=[struct.unpack_from('<II',cm,446+i*16+8) for i in range(4)]
            bootstart,bootlen=parts[0];rootstart2,rootlen=parts[1]
            assert rootstart2==rootstart,'unexpected root offset'
            rootend=(rootstart+rootlen)*512
            bf.seek(0);cf.seek(0);before=cf.read(rootstart*512)
            assert before==bf.read(rootstart*512),'bootloader/boot partition changed'
            bf.seek(rootend);cf.seek(rootend);assert bf.read()==cf.read(),'source trailer changed'
            cf.seek(bootstart*512);fat=fat_files(cf.read(bootlen*512))
        else:
            # x86/64 image: GPT + grub/PARTUUID boot, no FAT/U-Boot/DTB parsing to do — just make sure
            # we never touched anything outside the ext4 root partition (ESP, BIOS-boot, GPT tables,
            # and the backup GPT header/entries this base image keeps at the very end of the disk).
            rootend=rootstart*512+3096576*512  # root partition length, sectors, from this base image's GPT
            bf.seek(0);cf.seek(0);before=cf.read(rootstart*512)
            assert before==bf.read(rootstart*512),'boot region (GPT/ESP/grub) changed'
            bf.seek(rootend);cf.seek(rootend);assert bf.read()==cf.read(),'backup GPT/trailer changed'
    if args.target=='arm':
        for name,kind in [('BOOT.SCR',6),('UIMAGE',2)]:legacy_image(fat[name],kind)
        assert fat['DTB'][:4]==b'\xd0\x0d\xfe\xed' and b'xunlong,orangepi-one\0' in fat['DTB'],'wrong board DTB'
        assert b'root=PARTUUID=${uuid}' in fat['BOOT.SCR'],'boot root reference changed'
    offset=f'{candidate}?offset={rootstart*512}'
    subprocess.run(['e2fsck','-fn',offset],check=True)
    with tempfile.TemporaryDirectory(prefix='vendo5-image-verify-') as tmp:
        def dump(image,src,dest):
            result=subprocess.run(['debugfs','-R',f'dump {src} {dest}',f'{image}?offset={rootstart*512}'],capture_output=True,text=True)
            assert pathlib.Path(dest).is_file(),f'missing {src}: {result.stderr}'
        for i,src in enumerate(['/sbin/init','/sbin/procd','/usr/bin/node','/etc/inittab','/etc/rc.common','/etc/init.d/boot','/etc/init.d/led','/etc/config/system']):
            a=pathlib.Path(tmp)/f'base-{i}';b=pathlib.Path(tmp)/f'candidate-{i}'
            dump(base,src,a);dump(candidate,src,b);assert a.read_bytes()==b.read_bytes(),f'protected file changed: {src}'
        # root's password is intentionally set (see build-image.sh ROOT_HASH); check it's that known value,
        # not that it's unchanged from the pristine base (which has no password at all).
        shadow=pathlib.Path(tmp)/'shadow-check';dump(candidate,'/etc/shadow',shadow)
        assert b"root:$1$aea0e17d$hzl8eRnGB0ol/NUm5RmNa.:" in shadow.read_bytes(),'root password is not the expected one'
        subprocess.run(['debugfs','-R',f'rdump /opt/vendo5 {tmp}',offset],check=True,capture_output=True)
        entries=json.loads(subprocess.check_output(['node','-e',"console.log(JSON.stringify(require('./scripts/image-commands').entriesFor(process.cwd())))"],text=True))
        for item in entries:
            actual=pathlib.Path(tmp)/item['dest'].removeprefix('/opt/')
            assert actual.is_file() and actual.read_bytes()==pathlib.Path(item['src']).read_bytes(),f'bad shipped file: {item["dest"]}'
        shared=[('etc/init.d/vendo5','/etc/init.d/vendo5'),('etc-overlay/etc/vendo5-firewall.nft','/etc/vendo5-firewall.nft'),('etc-overlay/etc/vendo5-nginx.locations','/soft/config/nginx.locations'),('etc-overlay/etc/init.d/firewall','/etc/init.d/firewall')]+[(f'etc-overlay/etc/config/{n}',f'/etc/config/{n}') for n in ['dhcp','firewall']]
        if args.target=='arm':
            shared+=[('etc-overlay/etc/vendo5-netdetect.sh','/etc/vendo5-netdetect.sh'),('etc-overlay/etc/config/network','/etc/config/network')]
        for src,imagepath in shared:
            target=pathlib.Path(tmp)/'config-check';target.unlink(missing_ok=True);dump(candidate,imagepath,target)
            assert target.read_bytes()==pathlib.Path(src).read_bytes(),f'bad config: {imagepath}'
        network=pathlib.Path(tmp)/'config-check';network.unlink(missing_ok=True);dump(candidate,'/etc/config/network',network)
        assert b"option name 'br-lan'" in network.read_bytes() and b"option ipaddr '10.0.0.1'" in network.read_bytes(),'LAN is not br-lan at 10.0.0.1'
        if args.target=='arm':
            assert b'vlan' not in network.read_bytes().lower(),'VLAN config remains in the main network config'
        else:
            # x86 target is the vendor's own switch-equipped box: network is deliberately left as
            # shipped (VLAN ports into br-lan), not overwritten — just confirm we didn't touch it.
            base_network=pathlib.Path(tmp)/'base-network';dump(base,'/etc/config/network',base_network)
            assert network.read_bytes()==base_network.read_bytes(),'network config changed from the vendor original'
        service=subprocess.check_output(['debugfs','-R','stat /etc/init.d/vendo5',offset],stderr=subprocess.DEVNULL,text=True)
        assert '0755' in service,'service not executable'
        rc=subprocess.check_output(['debugfs','-R','stat /etc/rc.d/S95vendo5',offset],stderr=subprocess.DEVNULL,text=True)
        assert '../init.d/vendo5' in rc,'missing autostart'
        nginx=subprocess.check_output(['debugfs','-R','stat /etc/rc.d/S80nginx',offset],stderr=subprocess.DEVNULL,text=True)
        assert '../init.d/nginx' in nginx,'nginx port-80 proxy is not enabled at boot'
    print(json.dumps({'status':'PASS','shipped_files':len(entries),'boot_region_sha256':digest(before),'image_bytes':candidate.stat().st_size,'hardware_boot':'NOT YET VERIFIED'},indent=2))
if __name__=='__main__':main()
