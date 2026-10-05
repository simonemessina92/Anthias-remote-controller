#!/usr/bin/env python3
"""Narrow privileged helper: fixed paths, fixed interface, validated private subnet."""
import fcntl, ipaddress, json, os, re, subprocess, sys, time
from pathlib import Path
ETC=Path('/etc/anthias-rooms'); WG=Path('/etc/wireguard/arwg0.conf')

def run(*args,input=None):return subprocess.check_output(args,input=input,text=True,stderr=subprocess.DEVNULL,timeout=25).strip()
def atom(path,text):
    tmp=path.with_suffix('.tmp');tmp.write_text(text);os.chmod(tmp,0o600);os.replace(tmp,path)
def settings():return json.loads((ETC/'settings.json').read_text())
def keys():
    path=ETC/'wg-keys.json'
    if path.exists():return json.loads(path.read_text())
    server=run('wg','genkey');router=run('wg','genkey');psk=run('wg','genpsk')
    data={'server':server,'serverPublic':run('wg','pubkey',input=server+'\n'),'router':router,'routerPublic':run('wg','pubkey',input=router+'\n'),'psk':psk}
    atom(path,json.dumps(data));return data

def validate(value):
    n=ipaddress.ip_network(value,strict=False);s=settings()
    if n.version!=4 or n.prefixlen<22 or not any(n.subnet_of(ipaddress.ip_network(p)) for p in ('10.0.0.0/8','172.16.0.0/12','192.168.0.0/16')):raise ValueError('Invalid private subnet.')
    if n.overlaps(ipaddress.ip_network(s['tunnel'])):raise ValueError('Overlapping subnet.')
    # Refuse collisions with an existing connected/remote route except our own.
    for r in json.loads(run('ip','-j','-4','route','show')):
        if r.get('dev')=='arwg0' or r.get('dst')=='default' or not r.get('dst'):continue
        if n.overlaps(ipaddress.ip_network(r['dst'],strict=False)):raise ValueError('Subnet overlaps a VPS route.')
    return str(n)

def main():
    if len(sys.argv)!=2 or sys.argv[1] not in ('init','configure','status','profile'):raise ValueError('Invalid action.')
    s=settings();action=sys.argv[1]
    if action=='status':
        try:
            rows=run('wg','show','arwg0','latest-handshakes').splitlines();stamp=max((int(x.split()[1]) for x in rows),default=0)
        except subprocess.CalledProcessError:stamp=0
        age=int(time.time()-stamp) if stamp else None
        return {'handshake':bool(stamp and 0<=age<180),'age':age}
    k=keys();server=str(ipaddress.ip_interface(s['serverAddress']).ip);router=str(ipaddress.ip_interface(s['routerAddress']).ip)
    if action=='profile':
        if not (ETC/'remote-subnet').exists():raise ValueError('Configure subnet first.')
        return {'profile':f'[Interface]\nPrivateKey = {k["router"]}\nAddress = {s["routerAddress"]}\nMTU = 1420\n\n[Peer]\nPublicKey = {k["serverPublic"]}\nPresharedKey = {k["psk"]}\nEndpoint = {s["endpoint"]}:443\nAllowedIPs = {server}/32\nPersistentKeepalive = 25\n'}
    n=validate(json.load(sys.stdin)['subnet']) if action=='configure' else None
    if action=='init' and WG.exists():return {'ok':True}
    conf=f'[Interface]\nAddress = {s["serverAddress"]}\nListenPort = 443\nPrivateKey = {k["server"]}\nMTU = 1420\n\n[Peer]\nPublicKey = {k["routerPublic"]}\nPresharedKey = {k["psk"]}\nAllowedIPs = {router}/32'+(f', {n}' if n else '')+'\n'
    old=WG.read_text() if WG.exists() else None
    if old==conf:return {'ok':True}
    atom(WG,conf)
    try:run('systemctl','restart','wg-quick@arwg0')
    except subprocess.CalledProcessError:
        if old is not None:
            atom(WG,old)
            run('systemctl','restart','wg-quick@arwg0')
        raise
    if n:atom(ETC/'remote-subnet',n)
    return {'ok':True}

if __name__=='__main__':
    try:
        with (ETC/'wg-helper.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX);print(json.dumps(main()))
    except Exception as e:
        print(type(e).__name__+': '+str(e),file=sys.stderr);sys.exit(1)
