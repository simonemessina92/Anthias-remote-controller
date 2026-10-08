#!/usr/bin/env python3
"""Track and purge packages added by the installer without removing baseline packages."""
import gzip,json,os,re,shlex,socket,subprocess,sys
from pathlib import Path
PACKAGE=re.compile(r'^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9-]*)?$')
DEPENDENCIES={'python3','wireguard-tools','nginx','openssl','sudo','nftables','iproute2','ffmpeg'}
def packages():
    result=subprocess.run(['dpkg-query','-W','-f=${Package}:${Architecture}\n'],check=True,capture_output=True,text=True)
    return {x for x in result.stdout.splitlines() if PACKAGE.fullmatch(x)}
def load(path):
    if not path.exists():return {'version':1,'packages':[],'sources':[]}
    data=json.loads(path.read_text())
    if data.get('version')!=1 or not isinstance(data.get('packages'),list) or any(not PACKAGE.fullmatch(x) for x in data['packages']):raise ValueError('Invalid package ownership receipt.')
    return data
def save(path,data):
    path.parent.mkdir(parents=True,exist_ok=True)
    temporary=path.with_suffix('.tmp');temporary.write_text(json.dumps(data,indent=2)+'\n');temporary.chmod(0o600);os.replace(temporary,path)
def history_packages(folder):
    owned=set();matched=False
    for path in sorted(folder.glob('history.log*')):
        try:
            raw=gzip.open(path,'rt').read() if path.suffix=='.gz' else path.read_text()
        except (OSError,UnicodeError):continue
        for block in raw.split('\n\n'):
            command=re.search(r'^Commandline: (.+)$',block,re.M)
            if not command:continue
            try:words=shlex.split(command[1])
            except ValueError:continue
            if len(words)<3 or Path(words[0]).name not in ('apt-get','apt') or words[1]!='install':continue
            names={w for w in words[2:] if not w.startswith('-')}
            if not {'python3','wireguard-tools','nginx','openssl','sudo','nftables','iproute2'}<=names or not names<=DEPENDENCIES:continue
            matched=True
            installs=re.search(r'^Install: (.+)$',block,re.M)
            if installs:owned.update(re.findall(r'(?:^|, )([a-z0-9][a-z0-9+.-]*:[a-z0-9-]+) \(',installs[1]))
    return matched,owned

def recover(path,folder,strict=False):
    if path.exists():return load(path)
    matched,owned=history_packages(folder)
    if strict and not matched:raise ValueError('Old installation has no package receipt and matching APT history is unavailable. Cannot identify its packages safely; nothing was removed.')
    data={'version':1,'packages':sorted(owned&packages()),'sources':['apt-history'] if matched else ['baseline']}
    save(path,data);return data

def record(snapshot,path):
    data=load(path);baseline=set(snapshot.read_text().splitlines())
    data['packages']=sorted(set(data['packages'])|(packages()-baseline));data['sources']=sorted(set(data.get('sources',[]))|{'snapshot'})
    save(path,data)

def plan(path):
    data=load(path);owned=sorted(set(data['packages'])&packages())
    if not owned:return []
    result=subprocess.run(['apt-get','-s','purge',*owned],check=True,capture_output=True,text=True,env={**os.environ,'LC_ALL':'C'})
    removed=set(re.findall(r'^(?:Remv|Purg) (\S+)',result.stdout,re.M));allowed={x.split(':')[0] for x in owned}
    extra={x for x in removed if x.split(':')[0] not in allowed}
    if extra:raise ValueError('Package purge would also remove packages outside this installation: '+', '.join(sorted(extra))+'. Nothing was removed.')
    return owned

def probe_ports():
    for port in range(8443,8544):
        with socket.socket() as connection:
            connection.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
            try:connection.bind(('0.0.0.0',port))
            except OSError as error:raise ValueError(f'Removal incomplete: cannot reuse TCP {port}: {error}')

def purge(path):
    owned=plan(path)
    if owned:subprocess.run(['apt-get','purge','-y',*owned],check=True,env={**os.environ,'DEBIAN_FRONTEND':'noninteractive'})
    remaining=set(load(path)['packages'])&packages()
    if remaining:raise ValueError('Package purge incomplete: '+', '.join(sorted(remaining)))
    names={x.split(':')[0] for x in load(path)['packages']}
    archives=Path('/var/cache/apt/archives')
    for folder in [archives,archives/'partial']:
        for cached in folder.glob('*.deb'):
            if cached.name.split('_',1)[0] in names:cached.unlink(missing_ok=True)
    path.unlink(missing_ok=True)

if __name__=='__main__':
    try:
        command=sys.argv[1];path=Path(sys.argv[2])
        if command=='snapshot':path.write_text('\n'.join(sorted(packages()))+'\n')
        elif command=='recover':recover(path,Path('/var/log/apt'),len(sys.argv)>3 and sys.argv[3]=='strict')
        elif command=='record':record(path,Path(sys.argv[3]))
        elif command=='plan':print('Installer-owned packages to purge: '+(', '.join(plan(path)) or 'none; packages were already present'))
        elif command=='purge':purge(path)
        elif command=='ports':probe_ports()
        else:raise ValueError('Unknown command')
    except (ValueError,OSError,subprocess.CalledProcessError) as error:raise SystemExit('ERROR: '+str(error))
