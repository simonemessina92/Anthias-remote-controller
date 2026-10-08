#!/usr/bin/env python3
"""Anthias Rooms VPS v1.0.2-dev1 DEV. Standard-library backend; no Chrome or runtime pip dependencies."""
import concurrent.futures, uuid, shutil
import base64, hashlib, hmac, http.client, ipaddress, json, mimetypes, os, re, secrets, sqlite3, subprocess, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs, unquote, urlencode
from http.cookies import SimpleCookie
ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('AR_DATA', '/var/lib/anthias-rooms'))
DATA.mkdir(parents=True, exist_ok=True)
os.chmod(DATA, 0o700)
DB = DATA / 'rooms.sqlite3'
SETTINGS = Path(os.environ.get('AR_SETTINGS', '/etc/anthias-rooms/settings.json'))
TEST = os.environ.get('AR_TEST') == '1'
DB_LOCK = threading.RLock()
THUMB_LOCK = threading.BoundedSemaphore(1)
COOKIE = 'ar_session'
SCANS={}
SCAN_LOCK=threading.RLock()
DEFAULT = {'schema':4,'language':'en','setupComplete':False,'wizardDraft':None,'nextPlayerNumber':1,'autoCleanup':True,'defaultImageDuration':15,'discovery':{'address':'','subnet':'24','port':80,'protocol':'http'},'rooms':[]}

def connect():
    db = sqlite3.connect(DB, timeout=30)
    db.execute('PRAGMA journal_mode=WAL')
    return db
with connect() as db:
    db.executescript('CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY,v TEXT); CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,expires REAL); CREATE TABLE IF NOT EXISTS leases(name TEXT PRIMARY KEY,owner TEXT,expires REAL); CREATE TABLE IF NOT EXISTS player_access(room_id TEXT PRIMARY KEY,port INTEGER UNIQUE NOT NULL,base TEXT NOT NULL);')
    db.execute('INSERT OR IGNORE INTO kv VALUES(?,?)', ('hmrConfig',json.dumps(DEFAULT)))
with connect() as db:
    columns={row[1] for row in db.execute('PRAGMA table_info(sessions)')}
    if 'gui_hash' not in columns:
        db.execute('ALTER TABLE sessions ADD COLUMN gui_hash TEXT')
        db.execute('ALTER TABLE sessions ADD COLUMN last_seen REAL DEFAULT 0')
        db.execute('DELETE FROM sessions') # Invalidate legacy cookie-only sessions.
os.chmod(DB, 0o600)

def get(k, default=None):
    with connect() as db:
        row=db.execute('SELECT v FROM kv WHERE k=?',(k,)).fetchone()
    return json.loads(row[0]) if row else default

def put(k,v):
    with connect() as db: db.execute('INSERT OR REPLACE INTO kv VALUES(?,?)',(k,json.dumps(v)))

def settings(): return json.loads(SETTINGS.read_text())
def hash_password(password,salt): return hashlib.pbkdf2_hmac('sha256',password.encode(),bytes.fromhex(salt),600000).hex()
def check_password(password,auth): return isinstance(password,str) and len(password)<=128 and hmac.compare_digest(hash_password(password,auth['salt']),auth['hash'])
def subnet(value):
    net=ipaddress.ip_network(value,strict=False)
    private=[ipaddress.ip_network(x) for x in ('10.0.0.0/8','172.16.0.0/12','192.168.0.0/16')]
    if net.version!=4 or net.prefixlen<22 or not any(net.subnet_of(n) for n in private): raise ValueError('Use an RFC1918 IPv4 subnet from /22 to /32.')
    if net.overlaps(ipaddress.ip_network(settings()['tunnel'])): raise ValueError('Remote subnet overlaps the WireGuard tunnel.')
    return str(net)

def helper(action,value=None):
    if TEST:
        if action=='status': return {'handshake':get('remote') is not None,'age':1 if get('remote') else None}
        return {'profile':'[Interface]\nPrivateKey = TEST_ONLY\nAddress = 10.77.0.2/32\n[Peer]\nAllowedIPs = 10.77.0.1/32\n'}
    args=['sudo','-n','/usr/bin/python3','-I','/opt/anthias-rooms/wg-helper.py',action]
    p=subprocess.run(args,input=json.dumps(value or {}),text=True,capture_output=True,timeout=35)
    if p.returncode: raise ValueError('WireGuard operation failed. Check journalctl -u anthias-rooms and wg-quick@arwg0.')
    return json.loads(p.stdout)

ALLOWED_PATH = re.compile(r'^/api/v2/(?:info|integrations|device_settings|reboot|file_asset|assets(?:/(?:order|[A-Za-z0-9_-]{1,128}(?:/content)?|control/asset&[A-Za-z0-9_-]{1,128}))?)/?$|^/assets/[A-Za-z0-9_-]{1,128}/preview/$')

def target(base):
    u=urlsplit(base)
    if u.scheme not in ('http','https') or u.username or u.password or u.path not in ('','/') or u.query or u.fragment: raise ValueError('Invalid player address.')
    ip=ipaddress.ip_address(u.hostname)
    remote=get('remote')
    if not remote: raise ValueError('Configure Connect remote router first.')
    if not (TEST and ip.is_loopback) and ip not in ipaddress.ip_network(remote['subnet']): raise ValueError('Player is outside the configured remote subnet.')
    ports=remote.get('ports',[80,443])
    if not TEST and (u.port or (443 if u.scheme=='https' else 80)) not in ports: raise ValueError('Player port is not allowed.')
    return u

GUI_FIRST=8444
GUI_LAST=8543

def sync_player_access(db,config):
    rooms=[r for r in config['rooms'] if r.get('base')]
    ids=[r['id'] for r in rooms]
    rows=db.execute('SELECT room_id,port FROM player_access').fetchall()
    for id,_ in rows:
        if id not in ids:db.execute('DELETE FROM player_access WHERE room_id=?',(id,))
    assigned=dict(db.execute('SELECT room_id,port FROM player_access').fetchall())
    used=set(assigned.values())
    for room in rooms:
        port=assigned.get(room['id'])
        if port is None:
            port=next((n for n in range(GUI_FIRST,GUI_LAST+1) if n not in used),None)
            if port is None:raise ValueError('No free player GUI ports available.')
            used.add(port)
        db.execute('INSERT OR REPLACE INTO player_access VALUES(?,?,?)',(room['id'],port,room['base'].rstrip('/')))

def validate_config(config):
    if not isinstance(config,dict) or config.get('schema')!=4 or not isinstance(config.get('rooms'),list) or len(config['rooms'])>100:raise ValueError('Invalid configuration.')
    ids=set();bases=set()
    for room in config['rooms']:
        if not isinstance(room,dict) or not isinstance(room.get('id'),str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,96}',room['id']) or room['id'] in ids:raise ValueError('Invalid or duplicate player identifier.')
        ids.add(room['id'])
        if room.get('base'):
            target(room['base']);base=room['base'].rstrip('/')
            if base in bases:raise ValueError('Address already assigned to another player.')
            bases.add(base)


def lease_owned(name,owner):
    with connect() as db: row=db.execute('SELECT owner,expires FROM leases WHERE name=?',(name,)).fetchone()
    return bool(row and row[0]==owner and row[1]>time.time())

with DB_LOCK,connect() as db:
    sync_player_access(db,get('hmrConfig',DEFAULT))

def network_diagnostics():
    state=helper('status'); cfg=settings(); router=str(ipaddress.ip_interface(cfg['routerAddress']).ip)
    remote=get('remote'); out={'remote':remote,'routerIp':router,**state,'route':None,'routerHttp':False}
    if TEST:
        return {**out,'route':{'dev':'arwg0','src':'10.77.0.1'},'routerHttp':bool(remote)}
    if remote:
        first=str(next(ipaddress.ip_network(remote['subnet']).hosts()))
        p=subprocess.run([shutil.which('ip') or '/usr/sbin/ip','-j','route','get',first],capture_output=True,text=True,timeout=5)
        try:out['route']=json.loads(p.stdout)[0]
        except (ValueError,IndexError):out['route']={'error':'No route returned'}
    conn=http.client.HTTPConnection(router,80,timeout=3)
    try:
        conn.request('GET','/');r=conn.getresponse();out['routerHttp']=r.status<500;out['routerHttpStatus']=r.status
    except (OSError,http.client.HTTPException):pass
    finally:conn.close()
    return out

def scan_worker(job,targets,timeout):
    start=time.monotonic()
    def probe(base):
        if job['stop'].is_set():return
        u=target(base);conn=(http.client.HTTPSConnection if u.scheme=='https' else http.client.HTTPConnection)(u.hostname,u.port,timeout=timeout)
        result=None;error=None
        try:
            conn.request('GET','/api/v2/info',headers={'Accept':'application/json'})
            r=conn.getresponse();raw=r.read(1024*1024)
            if r.status!=200:error=f'HTTP {r.status}'
            else:
                info=json.loads(raw)
                if isinstance(info,dict) and isinstance(info.get('anthias_version'),str) and isinstance(info.get('device_model'),str):result={'base':base,'identity':'','info':info}
                else:error='Not an Anthias player'
        except TimeoutError:error='Timeout'
        except ConnectionRefusedError:error='Connection refused'
        except (OSError,http.client.HTTPException):error='Network connection failed'
        except ValueError:error='Invalid JSON response'
        finally:conn.close()
        with SCAN_LOCK:
            job['checked']+=1;job['elapsedMs']=int((time.monotonic()-start)*1000)
            if result:job['results'].append(result)
            elif error:
                job['unresolved'].append(base);job['errors'][error]=job['errors'].get(error,0)+1
                if len(job['examples'])<5:job['examples'].append({'base':base,'error':error})
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=32) as pool:
            pending=set();iterator=iter(targets);exhausted=False
            while not exhausted or pending:
                while not exhausted and len(pending)<32 and not job['stop'].is_set():
                    try:pending.add(pool.submit(probe,next(iterator)))
                    except StopIteration:exhausted=True
                if job['stop'].is_set():exhausted=True
                if pending:
                    done,pending=concurrent.futures.wait(pending,return_when=concurrent.futures.FIRST_COMPLETED)
                    for future in done:future.result()
    except Exception as e:
        with SCAN_LOCK:job['fatal']=type(e).__name__+': '+str(e)
    finally:
        with SCAN_LOCK:job['done']=True;job['stopped']=job['stop'].is_set();job['elapsedMs']=int((time.monotonic()-start)*1000)

class Handler(BaseHTTPRequestHandler):
    server_version='AnthiasRooms'
    def log_message(self, fmt,*args):
        # No credentials, bodies, profile keys or session tokens in logs.
        print(f'{self.client_address[0]} {self.command} {urlsplit(self.path).path} {args[1] if len(args)>1 else ""}',flush=True)
    def send(self,value,status=200,headers=None):
        raw=json.dumps(value).encode(); self.send_response(status)
        self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(raw)))
        self.send_header('Cache-Control','no-store'); self.send_header('X-Content-Type-Options','nosniff')
        for k,v in (headers or {}).items(): self.send_header(k,v)
        self.end_headers(); self.wfile.write(raw)
    def body(self):
        n=int(self.headers.get('Content-Length','0'))
        if n<0 or n>2*1024*1024: raise ValueError('JSON request too large.')
        return json.loads(self.rfile.read(n) or b'{}')
    def cookie_token(self):
        cookies=dict(x.strip().split('=',1) for x in self.headers.get('Cookie','').split(';') if '=' in x)
        return cookies.get(COOKIE,'')
    def token(self):return self.headers.get('X-AR-Tab','')
    def gui_context(self):
        p=urlsplit(self.path)
        if self.command!='GET':return False
        if p.path in ('/ar/router-auth','/ar/player-auth'):return True
        return p.path=='/ar/proxy' and bool(re.fullmatch(r'/assets/[A-Za-z0-9_-]{1,128}/preview/',parse_qs(p.query).get('path',[''])[0]))
    def authenticated(self):
        now=time.time()
        with connect() as db:
            if self.gui_context() and (not self.token() or urlsplit(self.path).path in ('/ar/router-auth','/ar/player-auth')):
                cookie=hashlib.sha256(self.cookie_token().encode()).hexdigest()
                row=db.execute('SELECT expires FROM sessions WHERE gui_hash=?',(cookie,)).fetchone()
                live=db.execute('SELECT 1 FROM sessions WHERE expires>? AND last_seen>? LIMIT 1',(now,now-90)).fetchone()
                return bool(row and row[0]>now and live)
            tok=self.token()
            if not re.fullmatch(r'[A-Za-z0-9_-]{40,128}',tok):return False
            key=hashlib.sha256(tok.encode()).hexdigest()
            row=db.execute('SELECT expires FROM sessions WHERE token=?',(key,)).fetchone()
            if not row or row[0]<=now:return False
            db.execute('UPDATE sessions SET last_seen=? WHERE token=?',(now,key))
            return True
    def owner(self):
        client=self.headers.get('X-AR-Client','')
        if not re.fullmatch(r'[a-f0-9-]{36}',client): raise ValueError('Invalid client identifier.')
        return hashlib.sha256((self.token()+client).encode()).hexdigest()
    def gui_cookie(self,tok):
        secure='' if TEST else '; Secure'
        return {'Set-Cookie':f'{COOKIE}={tok}; HttpOnly; SameSite=Strict; Path=/{secure}'}
    def ensure_gui_cookie(self):
        now=time.time()
        with connect() as db:
            existing=db.execute('SELECT expires FROM sessions WHERE gui_hash=?',(hashlib.sha256(self.cookie_token().encode()).hexdigest(),)).fetchone()
            if existing and existing[0]>now:return {}
            gui=secrets.token_urlsafe(32)
            db.execute('UPDATE sessions SET gui_hash=? WHERE token=?',(hashlib.sha256(gui.encode()).hexdigest(),hashlib.sha256(self.token().encode()).hexdigest()))
        return self.gui_cookie(gui)
    def session_reply(self,value):
        tok=secrets.token_urlsafe(32);gui=secrets.token_urlsafe(32);now=time.time()
        with connect() as db:
            db.execute('DELETE FROM sessions WHERE expires<?',(now,))
            db.execute('INSERT INTO sessions(token,expires,gui_hash,last_seen) VALUES(?,?,?,?)',(hashlib.sha256(tok.encode()).hexdigest(),now+12*3600,hashlib.sha256(gui.encode()).hexdigest(),now))
        return self.send({**value,'tabToken':tok},headers=self.gui_cookie(gui))
    def same_origin(self):
        origin=self.headers.get('Origin')
        if origin and origin != ('http' if TEST else 'https')+'://'+self.headers.get('Host',''): raise ValueError('Cross-origin request denied.')
        if self.headers.get('Sec-Fetch-Site')=='cross-site': raise ValueError('Cross-site request denied.')
    def do_GET(self): self.dispatch()
    def do_POST(self): self.dispatch()
    def do_PATCH(self): self.dispatch()
    def do_DELETE(self): self.dispatch()
    def dispatch(self):
        try:
            self.same_origin()
            p=urlsplit(self.path)
            if p.path=='/health': return self.send({'ok':True,'version':'1.0.2-dev1'})
            if p.path.startswith('/ar/'): return self.api(p)
            if self.command!='GET': return self.send({'error':'Method not allowed'},405)
            name='panel.html' if p.path=='/' else unquote(p.path).lstrip('/')
            file=(ROOT/'web'/name).resolve()
            if not file.is_relative_to((ROOT/'web').resolve()) or not file.is_file() or file.suffix not in ('.html','.js','.css','.png'): return self.send({'error':'Not found'},404)
            raw=file.read_bytes();self.send_response(200)
            self.send_header('Content-Type',mimetypes.guess_type(file)[0] or 'application/octet-stream');self.send_header('Content-Length',str(len(raw)))
            self.send_header('Cache-Control','no-cache');self.send_header('X-Content-Type-Options','nosniff')
            self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
            self.end_headers();self.wfile.write(raw)
        except (ValueError,KeyError,json.JSONDecodeError) as e: self.send({'error':str(e)},400)
        except (BrokenPipeError,ConnectionResetError): pass
        except Exception as e:
            print(type(e).__name__,str(e)[:200],flush=True)
            try:self.send({'error':'Server operation failed. Check service logs.'},500)
            except (BrokenPipeError,ConnectionResetError):pass
    def api(self,p):
        auth=get('auth')
        if p.path=='/ar/auth/status':
            active=self.authenticated()
            return self.send({'enabled':bool(auth),'authenticated':active,'revision':auth.get('revision','') if auth else ''},headers=self.ensure_gui_cookie() if active else {})
        if p.path=='/ar/auth/password' and self.command=='POST':
            data=self.body();password=data.get('password','')
            if not isinstance(password,str) or not 8<=len(password)<=128 or password!=data.get('confirmation'): raise ValueError('Use matching passwords of 8–128 characters.')
            with DB_LOCK:
                auth=get('auth')
                if auth:
                    if not self.authenticated():return self.send({'error':'Login required'},401)
                    if not check_password(data.get('current',''),auth):raise ValueError('Incorrect current password.')
                elif not hmac.compare_digest(str(data.get('bootstrap','')),settings()['bootstrap']):
                    return self.send({'error':'Enter the installation setup key printed by the installer.'},403)
                salt=secrets.token_hex(16);revision=secrets.token_hex(16)
                put('auth',{'salt':salt,'hash':hash_password(password,salt),'revision':revision})
                with connect() as db: db.execute('DELETE FROM sessions')
            return self.session_reply({'enabled':True,'authenticated':True,'revision':revision})
        if p.path=='/ar/auth/login' and self.command=='POST':
            data=self.body()
            with DB_LOCK:
                auth=get('auth'); now=time.time(); fail=get('loginFailures',{'n':0,'until':0})
                if fail['until']>now:return self.send({'error':'Too many attempts. Try again later.'},429)
                if not auth or not check_password(data.get('password',''),auth):
                    fail['n']+=1;fail['until']=now+min(300,30*2**min(4,fail['n']-5)) if fail['n']>=5 else 0;put('loginFailures',fail)
                    return self.send({'error':'Incorrect password.'},401)
                put('loginFailures',{'n':0,'until':0})
            return self.session_reply({'enabled':True,'authenticated':True,'revision':auth['revision']})
        # The existing welcome screen may read ONLY a blank config before login.
        if p.path=='/ar/storage/get' and self.command=='POST' and not self.authenticated():
            data=self.body()
            return self.send({'hmrConfig':DEFAULT} if data.get('keys') in ('hmrConfig',None) else {})
        if not self.authenticated(): return self.send({'error':'Login required'},401)
        if p.path=='/ar/router-auth' and self.command=='GET':return self.send({'ok':True})
        if p.path=='/ar/player-access' and self.command=='GET':
            id=parse_qs(p.query).get('id',[''])[0]
            with connect() as db:row=db.execute('SELECT port,base FROM player_access WHERE room_id=?',(id,)).fetchone()
            if not row:return self.send({'error':'Player access not found'},404)
            return self.send({'port':row[0],'base':row[1]})
        if p.path=='/ar/player-auth' and self.command=='GET':
            # Nginx supplies its listening port, never a user-selected upstream.
            try:port=int(self.headers.get('X-AR-Gui-Port','0'))
            except ValueError:port=0
            with connect() as db:row=db.execute('SELECT room_id,base FROM player_access WHERE port=?',(port,)).fetchone()
            if not row:return self.send({'error':'Player access removed or not configured'},403)
            config=get('hmrConfig',DEFAULT)
            if not any(r.get('id')==row[0] and r.get('base','').rstrip('/')==row[1] for r in config['rooms']):return self.send({'error':'Player access removed'},403)
            u=target(row[1]);cookies=SimpleCookie();cookies.load(self.headers.get('Cookie',''))
            for name in list(cookies):
                if name==COOKIE:del cookies[name]
            forwarded='; '.join(m.OutputString() for m in cookies.values())
            return self.send({'ok':True},headers={'X-AR-Upstream':row[1],'X-AR-Upstream-Host':u.netloc,'X-AR-Upstream-Cookie':forwarded})

        if p.path=='/ar/network' and self.command=='GET':return self.send(network_diagnostics())
        if p.path=='/ar/scan' and self.command=='POST':
            data=self.body();targets=data.get('targets');owner=self.owner()
            if not isinstance(targets,list) or not 1<=len(targets)<=1024 or any(not isinstance(x,str) for x in targets) or len(set(targets))!=len(targets):raise ValueError('Invalid scan targets.')
            for base in targets:target(base)
            diag=network_diagnostics()
            if not diag.get('handshake'):return self.send({'error':'WireGuard has no recent handshake. Connect the remote router first.'},409)
            if (diag.get('route') or {}).get('dev')!='arwg0':return self.send({'error':'Remote subnet is not routed through arwg0. Check Connect remote router.'},409)
            with SCAN_LOCK:
                for key in list(SCANS):
                    if SCANS[key]['done'] and SCANS[key]['created']<time.time()-600:del SCANS[key]
                if any(j['owner']==owner and not j['done'] for j in SCANS.values()):return self.send({'error':'A scan is already running. Stop it first.'},409)
                if sum(not j['done'] for j in SCANS.values())>=2:return self.send({'error':'Another scan is running. Try again shortly.'},409)
                id=uuid.uuid4().hex;job={'owner':owner,'created':time.time(),'stop':threading.Event(),'checked':0,'total':len(targets),'results':[],'unresolved':[],'errors':{},'examples':[],'elapsedMs':0,'done':False,'stopped':False};SCANS[id]=job
            threading.Thread(target=scan_worker,args=(job,targets,4 if data.get('deep') else 1.4),daemon=True).start()
            return self.send({'id':id,'origin':'VPS through arwg0'})
        if p.path=='/ar/scan' and self.command=='GET':
            id=parse_qs(p.query).get('id',[''])[0]
            with SCAN_LOCK:
                job=SCANS.get(id)
                if not job or job['owner']!=self.owner():return self.send({'error':'Scan not found'},404)
                return self.send({k:v for k,v in job.items() if k not in ('owner','stop','created')})
        if p.path=='/ar/scan/stop' and self.command=='POST':
            data=self.body()
            with SCAN_LOCK:
                job=SCANS.get(data.get('id'))
                if job and job['owner']==self.owner():job['stop'].set()
            return self.send({'ok':True})
        if p.path=='/ar/auth/suspend' and self.command=='POST':
            with connect() as db:db.execute('UPDATE sessions SET last_seen=0 WHERE token=?',(hashlib.sha256(self.token().encode()).hexdigest(),))
            return self.send({'ok':True})
        if p.path=='/ar/auth/logout' and self.command=='POST':
            with connect() as db:db.execute('DELETE FROM sessions WHERE token=?',(hashlib.sha256(self.token().encode()).hexdigest(),))
            return self.send({'ok':True},headers={'Set-Cookie':f'{COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict'})
        if p.path.startswith('/ar/storage/') and self.command=='POST':
            data=self.body();action=p.path.rsplit('/',1)[1]
            if action=='get':
                keys=data.get('keys')
                with connect() as db: rows=db.execute('SELECT k,v FROM kv WHERE k LIKE "hmr%"').fetchall()
                allitems={k:json.loads(v) for k,v in rows}
                if keys is None:return self.send(allitems)
                if isinstance(keys,str):keys=[keys]
                if isinstance(keys,dict):return self.send({k:allitems.get(k,v) for k,v in keys.items()})
                return self.send({k:allitems[k] for k in keys if k in allitems})
            if action in ('set','remove'):
                items=data.get('items',{}) if action=='set' else dict.fromkeys(data.get('keys',[]))
                if not isinstance(items,dict) or any(not re.fullmatch(r'hmr(?:Config(?:BeforeImport|BeforeV5)?|Journal:[A-Za-z0-9_-]+|Upload:[A-Za-z0-9_:-]+)',k) for k in items):raise ValueError('Invalid storage keys.')
                if 'hmrConfig' in items and not lease_owned('hmr-config-v3',self.owner()):return self.send({'error':'Configuration lock required'},409)
                if 'hmrConfig' in items:
                    if action=='set':validate_config(items['hmrConfig'])
                    else:raise ValueError('Use an empty configuration to remove players.')
                with DB_LOCK,connect() as db:
                    db.execute('BEGIN IMMEDIATE')
                    for k,v in items.items():
                        if k=='hmrConfig':sync_player_access(db,v)
                        if action=='set':db.execute('INSERT OR REPLACE INTO kv VALUES(?,?)',(k,json.dumps(v)))
                        else:db.execute('DELETE FROM kv WHERE k=?',(k,))
                return self.send({'ok':True})
        if p.path=='/ar/locks' and self.command=='POST':
            data=self.body();name=data.get('name','');owner=self.owner()
            if not re.fullmatch(r'hmr-(?:config-v3|auth-v4|player-v3:.{1,255})',name):raise ValueError('Invalid lock.')
            action=data.get('action')
            with DB_LOCK,connect() as db:
                row=db.execute('SELECT owner,expires FROM leases WHERE name=?',(name,)).fetchone();held=bool(row and row[1]>time.time())
                if action=='acquire':
                    if held:return self.send({'acquired':False})
                    db.execute('INSERT OR REPLACE INTO leases VALUES(?,?,?)',(name,owner,time.time()+90));return self.send({'acquired':True})
                if action=='renew':
                    if not held or row[0]!=owner:return self.send({'error':'Operation lock lost. Verify player before retrying.'},409)
                    db.execute('UPDATE leases SET expires=? WHERE name=?',(time.time()+90,name));return self.send({'ok':True})
                if action=='release':db.execute('DELETE FROM leases WHERE name=? AND owner=?',(name,owner));return self.send({'ok':True})
        if p.path=='/ar/remote' and self.command=='GET':
            remote=get('remote');status=helper('status')
            return self.send({'remote':remote,**status})
        if p.path=='/ar/remote' and self.command=='POST':
            data=self.body();cidr=subnet(data['subnet']);ports=data.get('ports',[80,443])
            if not isinstance(ports,list) or not 1<=len(ports)<=4 or any(type(x)!=int or not 1<=x<=65535 for x in ports):raise ValueError('Invalid player ports.')
            previous=get('remote')
            if previous and previous['subnet']!=cidr and get('hmrConfig')['rooms']:raise ValueError('Remove configured players before changing the remote subnet.')
            helper('configure',{'subnet':cidr})
            put('remote',{'subnet':cidr,'ports':ports})
            return self.send({'ok':True,'subnet':cidr})
        if p.path=='/ar/remote/profile' and self.command=='GET':return self.send(helper('profile'))
        if p.path=='/ar/thumbnail' and self.command=='GET':return self.thumbnail(p)
        if p.path=='/ar/proxy':return self.proxy(p)
        return self.send({'error':'Not found'},404)
    def thumbnail(self,p):
        q=parse_qs(p.query);base=q.get('base',[''])[0];id=q.get('asset',[''])[0]
        u=target(base)
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',id):raise ValueError('Invalid asset identifier.')
        if not any(r.get('base','').rstrip('/')==base for r in get('hmrConfig',DEFAULT)['rooms']):
            return self.send({'error':'Player is not enrolled'},404)
        if not THUMB_LOCK.acquire(blocking=False):return self.send({'error':'Thumbnail worker busy'},429)
        try:
            conn=(http.client.HTTPSConnection if u.scheme=='https' else http.client.HTTPConnection)(u.hostname,u.port,timeout=10)
            try:
                conn.request('GET','/api/v2/assets/'+id,headers={'Accept':'application/json'})
                response=conn.getresponse();raw=response.read(131073)
                if response.status!=200 or len(raw)>131072:raise ValueError('Asset metadata unavailable.')
                asset=json.loads(raw)
            finally:conn.close()
            kind=asset.get('mimetype','')
            if not (kind=='video' or kind.startswith('video/')) or asset.get('is_processing') or not str(asset.get('uri','')).startswith('/'):
                raise ValueError('Ready local video required.')
            key=hashlib.sha256((base+'|'+id+'|'+str(asset.get('uri'))+'|'+str(asset.get('metadata',{}))).encode()).hexdigest()
            folder=DATA/'thumbnails';folder.mkdir(exist_ok=True);cache=folder/(key+'.jpg')
            if cache.exists():raw=cache.read_bytes();os.utime(cache,None)
            else:
                # Read through the existing authenticated, validated player proxy.
                # FFmpeg seeks using HTTP Range instead of buffering a video in RAM.
                address='http://127.0.0.1:'+str(self.server.server_port)+'/ar/proxy?'+urlencode({'base':base,'path':'/assets/'+id+'/preview/'})
                args=['ffmpeg','-nostdin','-hide_banner','-loglevel','error','-threads','1','-filter_threads','1',
                      '-protocol_whitelist','http,tcp','-format_whitelist','mov,matroska,webm,avi',
                      '-rw_timeout','15000000','-probesize','8000000','-analyzeduration','5000000',
                      '-headers','X-AR-Tab: '+self.token()+'\r\n','-ss','0.1','-i',address,
                      '-an','-sn','-dn','-vf','scale=640:640:force_original_aspect_ratio=decrease',
                      '-frames:v','1','-f','image2pipe','-vcodec','mjpeg','-threads','1','pipe:1']
                try:result=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=40)
                except (FileNotFoundError,subprocess.TimeoutExpired):return self.send({'error':'Video thumbnail unavailable'},502)
                raw=result.stdout
                if result.returncode or not raw.startswith(b'\xff\xd8') or len(raw)>1024*1024:
                    return self.send({'error':'Video thumbnail unavailable'},502)
                cache.write_bytes(raw)
                for old in sorted(folder.glob('*.jpg'),key=lambda f:f.stat().st_mtime,reverse=True)[100:]:old.unlink(missing_ok=True)
            self.send_response(200);self.send_header('Content-Type','image/jpeg');self.send_header('Content-Length',str(len(raw)))
            self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.end_headers();self.wfile.write(raw)
        finally:THUMB_LOCK.release()
    def proxy(self,p):
        q=parse_qs(p.query);base=q.get('base',[''])[0];path=q.get('path',[''])[0];u=target(base)
        if not ALLOWED_PATH.fullmatch(path):raise ValueError('Unsupported player API path.')
        write=self.command!='GET' or '/assets/control/' in path
        if write and not lease_owned('hmr-player-v3:'+base,self.owner()):return self.send({'error':'Player operation lock required'},409)
        if self.command not in ('GET','POST','PATCH','DELETE'):return self.send({'error':'Method not allowed'},405)
        conn=(http.client.HTTPSConnection if u.scheme=='https' else http.client.HTTPConnection)(u.hostname,u.port,timeout=900 if path.endswith('file_asset') else max(.2,min(30,int(q.get('timeout',['20000'])[0])/1000)))
        length=int(self.headers.get('Content-Length','0'))
        if length<0 or length>4*1024**3:raise ValueError('Upload limit is 4 GiB.')
        headers={'Accept':self.headers.get('Accept','application/json')}
        for key in ('Content-Type','Range','If-Range'):
            if key in self.headers:headers[key]=self.headers[key]
        if length:headers['Content-Length']=str(length)
        sent=False
        try:
            conn.putrequest(self.command,path)
            for k,v in headers.items():conn.putheader(k,v)
            conn.endheaders()
            remain=length
            while remain:
                part=self.rfile.read(min(65536,remain))
                if not part:raise ValueError('Upload interrupted.')
                conn.send(part);remain-=len(part)
            response=conn.getresponse()
            if 300<=response.status<400:raise ValueError('Player redirect refused.')
            sent=True
            self.send_response(response.status)
            for k in ('Content-Type','Content-Length','Content-Range','Accept-Ranges'):
                value=response.getheader(k)
                if value:self.send_header(k,value)
            self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.end_headers()
            while True:
                part=response.read(65536)
                if not part:break
                self.wfile.write(part)
        except (TimeoutError,ConnectionRefusedError,OSError,http.client.HTTPException):
            # Do not retry a write: its result may already exist on the player.
            if not sent:return self.send({'error':'Player unreachable or transfer interrupted; verify result before retrying.'},502)
            raise
        finally:conn.close()

if __name__=='__main__':
    addr=os.environ.get('AR_BIND','127.0.0.1');port=int(os.environ.get('AR_PORT','8787'))
    print(f'Anthias Rooms VPS 1.0.2-dev1 listening on {addr}:{port}',flush=True)
    ThreadingHTTPServer((addr,port),Handler).serve_forever()
