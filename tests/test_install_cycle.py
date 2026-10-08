"""Full installer lifecycle with real APT, systemd, Nginx and WireGuard in a disposable VM/container."""
import importlib.util,json,os,shutil,socket,ssl,subprocess,tempfile,time
from pathlib import Path
from urllib.request import urlopen
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('ownership',ROOT/'package-ownership.py');ownership=importlib.util.module_from_spec(spec);spec.loader.exec_module(ownership)
RECEIPT=Path('/var/lib/anthias-rooms-packages.json')
def call(script,answer):
    subprocess.run(['bash',str(script)],input=answer,text=True,check=True,timeout=360)
def install(script):
    call(script,'1\nexample.com\n\n')
    with urlopen('http://127.0.0.1:8787/health',timeout=5) as response:assert json.load(response)['ok']
    assert subprocess.run(['systemctl','is-active','--quiet','nginx']).returncode==0
    assert subprocess.run(['ip','link','show','arwg0'],stdout=subprocess.DEVNULL).returncode==0

def remove():
    cache=Path('/var/lib/anthias-rooms/thumbnails/test.jpg');cache.parent.mkdir(exist_ok=True);cache.write_bytes(b'synthetic cached frame')
    # Leave a real player-port TLS connection pending while Remove all runs.
    peer=ssl._create_unverified_context().wrap_socket(socket.create_connection(('127.0.0.1',8444),timeout=5),server_hostname='localhost')
    try:
        peer.sendall(b'GET / HTTP/1.1\r\nHost: localhost\r\n')
        call(ROOT/'install.sh','2\nREMOVE ALL\n')
        try:assert peer.recv(1)==b''
        except (ConnectionResetError,ssl.SSLEOFError):pass
    finally:peer.close()
    for name in ['/opt/anthias-rooms','/etc/anthias-rooms','/var/lib/anthias-rooms','/var/lib/anthias-rooms-packages.json','/etc/wireguard/arwg0.conf','/etc/nginx/sites-enabled/anthias-rooms','/etc/nginx/sites-available/anthias-rooms','/root/anthias-rooms-setup.txt']:
        assert not Path(name).exists(),name+' remains'
    assert subprocess.run(['id','anthias-rooms'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode!=0
    assert subprocess.run(['ip','link','show','arwg0'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode!=0
    ownership.probe_ports()

baseline=ownership.packages()
kind=os.environ.get('AR_CYCLE_KIND','fresh')
if kind=='legacy':
    with tempfile.TemporaryDirectory() as folder:
        legacy=Path(folder)
        for name in ['server.py','wg-helper.py','nginx-config.py','web']:
            source=ROOT/name
            if source.is_dir():shutil.copytree(source,legacy/name)
            else:shutil.copyfile(source,legacy/name)
        shutil.copyfile(ROOT/'tests/fixtures/legacy-install.sh',legacy/'install.sh')
        install(legacy/'install.sh')
    current=ownership.packages();matched,history=ownership.history_packages(Path('/var/log/apt'));assert matched
    # Reproduce the broken DEV4 receipt: architecture-all identities were lost.
    broken=history&current
    missing=ownership.canonical(history,current)-broken
    assert any(name.endswith(':all') for name in missing),'Legacy case did not reproduce architecture-all mismatch'
    ownership.save(RECEIPT,{'version':1,'packages':sorted(broken),'sources':['apt-history','snapshot']})
    ownership.recover(RECEIPT,Path('/var/log/apt'),strict=True)
    assert set(ownership.load(RECEIPT)['packages'])==current-baseline,'Legacy repair did not recover the full added package set'
else:
    install(ROOT/'install.sh')
    assert set(ownership.load(RECEIPT)['packages'])==ownership.packages()-baseline
remove()
assert ownership.packages()==baseline,'First purge did not restore the package baseline'
install(ROOT/'install.sh')
assert set(ownership.load(RECEIPT)['packages'])==ownership.packages()-baseline
remove()
assert ownership.packages()==baseline,'Reinstallation purge did not restore the package baseline'
print(json.dumps({'os':Path('/etc/os-release').read_text(),'cycle':kind,'installRemoveReinstallRemove':True,'baselinePackagesPreserved':True,'pendingPlayerConnectionClosed':True}))
