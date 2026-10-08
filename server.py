#!/usr/bin/env python3
"""Anthias Rooms VPS v1.0.1 GOLDEN. Standard-library backend; no Chrome or runtime pip dependencies."""
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
            if p.path=='/health': return self.send({'ok':True,'version':'1.0.1'})
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
        if p.path.startswith('/ar/stor…14645 tokens truncated…R] ${role==='home'?'Home':'Event'} - ${crypto.randomUUID().slice(0,8)} - ${file.name.slice(0,180)}`;
  await chrome.storage.local.set({[pendingKey]:{name,uri:response.uri,ext:response.ext,role,draftKey:item.key,time:new Date().toISOString(),base:r.base}});
  progress(t('Registering file…'));let asset;
  try{asset=await api.create({name,uri:response.uri,ext:response.ext,mimetype:kind,duration:kind==='video'?0:item.duration||config.defaultImageDuration,is_enabled:false,...MANUAL_SCHEDULE,play_order:0,skip_asset_check:false,skip_ssl_verify:false});}
  catch(error){const matches=await api.assets().then(all=>all.filter(a=>a.name===name)).catch(()=>[]);if(matches.length===1)asset=matches[0];else throw new Error(`${t('File transferred, registration not confirmed. Check player memory before uploading it again.')} ${error.message}`);}
  if(!asset?.asset_id)throw new Error(t('The player did not return an asset identifier.'));
  item.id=asset.asset_id;r.uploadedIds=unique([...r.uploadedIds,asset.asset_id]);if(role==='event')r.managedEventIds=unique([...r.managedEventIds,asset.asset_id]);await persist();await chrome.storage.local.remove(pendingKey);
  const deadline=Date.now()+300000;
  while(asset.is_processing&&Date.now()<deadline){progress(t('Processing…'));await pause(1500);asset=await api.get(asset.asset_id);}
  if(asset.is_processing)throw new Error(t('Processing is taking longer than expected. The upload is retained; retry from this editor when ready.'));
  assertReady(asset);void cacheUploadedPreview(r.base,asset,file);return asset;
}
async function saveEditor(publish){
  const draft=editor;if(!draft||draft.busy)return;
  try{
    if(publish&&!draft.items.length)throw new Error(t('Choose at least one file.'));
    for(const item of draft.items)if(item.kind!=='video'&&(!Number.isInteger(item.duration)||item.duration<1||item.duration>86400))throw new Error(t('Image duration must be between 1 and 86400 seconds.'));
    const r=byId(draft.roomId);
    if(publish&&draft.role==='home'&&mode(r).role==='event'&&!await confirmAction(t('Switch to Home?'),t('The player returns to its own Home playlist. Temporary event uploads are removed only when automatic cleanup is enabled.'),t('Show home')))return;
    setEditorBusy(true);$('editor-error').textContent='';
    const result=await withRoom(draft.roomId,async ctx=>{
      await ctx.ensure();
      if(JSON.stringify(ctx.r.playlists[draft.role])!==draft.original)throw new Error(t('A different tab changed this playlist. Reopen the editor before saving.'));
      if(publish&&draft.role==='event'){
        if(!ctx.r.playlists.home.length)throw new Error(t('Set a ready Home playlist before showing an event.'));
        const existing=await ctx.api.assets();for(const item of ctx.r.playlists.home)assertReady(existing.find(a=>a.asset_id===item.id));
      }
      for(const item of draft.items)await uploadAssetOrCheck(ctx,draft.role,item);
      const assets=await ctx.api.assets();
      const items=draft.items.map(item=>({id:item.id,duration:mediaKind(assets.find(a=>a.asset_id===item.id))==='image'?item.duration:null}));
      await mapPlaylist(ctx.r,draft.role,items,assets,ctx.persist);draft.original=JSON.stringify(items);draft.baseline=editorSnapshot(draft.items);
      if(publish)return activate(ctx,draft.role);return {warning:'',unchanged:false};
    });
    if(result.ok){closeDialog('editor-dialog');editor=null;toast(result.value?.warning||t(publish?'Playlist published.':'Playlist saved; playback unchanged.'),result.value?.warning?'warning':'success');}
    else{$('editor-error').textContent=result.error||'';setEditorBusy(false);}
  }catch(error){$('editor-error').textContent=error.message;setEditorBusy(false);}
  finally{if(editor===draft){setEditorBusy(false);$('editor-progress').hidden=true;$('editor-progress-text').textContent='';}}
}
async function uploadAssetOrCheck(ctx,role,item){if(item.id){const a=await ctx.api.get(item.id);assertReady(a);return a;}return uploadAsset(ctx,role,item);}
async function openLibrary(id=infoRoomId,{pickForHome=false}={}){
  const r=byId(id);if(!r?.base)return;
  // Reuse is available only from the Home editor. Event remains upload-only.
  const draft=pickForHome?editor:null;
  if(pickForHome&&(!draft||draft.role!=='home'||draft.roomId!==id||draft.busy))return;
  library={roomId:r.id,assets:[],editor:draft,selected:new Set(),loaded:false};
  $('library-title').textContent=`${label(r)} · ${t(pickForHome?'Add from player media':'Player media')}`;
  $('library-search').value='';$('library-error').textContent='';$('library-list').replaceChildren(node('p','muted',t('Loading…')));
  $('library-note').textContent=t(pickForHome?'Select files to add to Home. Playback changes only when you publish.':'You can delete any file, including live Home/Event media. Deletion is permanent and may interrupt playback.');
  $('library-use').hidden=!pickForHome;$('library-use').disabled=true;$('library-dialog').showModal();
  const ref=library;try{ref.assets=await apiFor(r).assets();if(library===ref){ref.loaded=true;state(r.id).assets=ref.assets;renderLibrary();}}
  catch(error){if(library===ref)$('library-list').replaceChildren(node('p','inline-error',error.message));}
}
function renderLibrary(){
  if(!library||!library.loaded)return;const r=byId(library.roomId);if(!r)return;
  const ref=library,picking=Boolean(ref.editor),term=$('library-search').value.toLowerCase();$('library-list').replaceChildren();
  $('library-title').textContent=`${label(r)} · ${t(picking?'Add from player media':'Player media')}`;
  $('library-note').textContent=t(picking?'Select files to add to Home. Playback changes only when you publish.':'You can delete any file, including live Home/Event media. Deletion is permanent and may interrupt playback.');
  const assets=ref.assets.filter(a=>isLocalMedia(a)&&`${titleOf(a)} ${a.asset_id}`.toLowerCase().includes(term));
  if(!assets.length)$('library-list').append(node('p','muted',t('No matching files.')));
  for(const asset of assets){
    const row=node('div','library-row'),text=node('div','row-label'),name=node('strong','',titleOf(asset));name.title=name.textContent;row.dataset.asset=asset.asset_id;
    const block=picking?homeSelectionBlock(asset,r,ref.editor.items):deletionBlock(asset,ref.assets,r);
    if(picking){
      const check=node('input');check.type='checkbox';check.disabled=Boolean(block);check.checked=ref.selected.has(asset.asset_id);check.setAttribute('aria-label',titleOf(asset));
      action(check,()=>{if(library!==ref)return;$('library-error').textContent='';if(check.checked)ref.selected.add(asset.asset_id);else ref.selected.delete(asset.asset_id);$('library-use').disabled=!ref.selected.size;},'change');row.append(checkboxHit(check));
    }else row.append(node('span','room-num',mediaKind(asset)==='video'?'▶':'▧'));
    text.append(name,node('small','',describe(asset)));if(block)text.append(node('small','file-protection',block));row.append(text);
    if(!picking){const b=button(t('Delete'),'btn danger',()=>deleteLibraryAsset(asset.asset_id));b.disabled=operations.has(ref.roomId);b.title=t('Delete this file permanently, even if it is live or assigned.');row.append(b);}
    $('library-list').append(row);
  }
  $('library-use').disabled=!picking||!ref.selected.size;
}
function useHomeMedia(){
  const ref=library,draft=ref?.editor;
  if(!draft||editor!==draft||draft.role!=='home'||draft.busy)return;
  try{
    const r=byId(ref.roomId),assets=ref.assets.filter(a=>ref.selected.has(a.asset_id));
    if(!r||!assets.length)return;
    if(draft.items.length+assets.length>100)throw new Error(t('A playlist can contain up to 100 items.'));
    // Validate the complete selection before changing the draft. This never writes to a player.
    const additions=assets.map(asset=>{const block=homeSelectionBlock(asset,r,draft.items);if(block)throw new Error(block);return homeMediaDraft(asset,config.defaultImageDuration);});
    draft.items.push(...additions);closeDialog('library-dialog');renderEditor();
  }catch(error){$('library-error').textContent=error.message;}
}
async function deleteLibraryAsset(id){
  const ref=library;if(!ref||!await confirmAction(t('Delete file?'),t('This permanently deletes the file from the player and removes it from Home/Event. If it is live, playback may stop. Continue?'),t('Delete'),true))return;
  const result=await withRoom(ref.roomId,async ctx=>{await ctx.ensure();await deleteMediaManually(ctx.api,ctx.r,id,ctx.persist);void forgetPreview(ctx.r.base,id);if(editor?.roomId===ref.roomId){editor.items=editor.items.filter(item=>item.id!==id);renderEditor();}});
  if(result.ok&&library===ref){ref.assets=state(ref.roomId).assets;renderLibrary();}
}
function openLargePreview(role){stopPreview($(`${role}-preview`));const r=room();if(!r)return;const {items}=getShown(r,role),index=previewIndexes.get(`${r.id}:${role}`)||0,asset=state(r.id).assets.find(a=>a.asset_id===items[index]?.id);if(!asset)return;$('preview-title').textContent=titleOf(asset);showAssetPreview($('large-preview'),r.base,asset);$('preview-dialog').showModal();}
function renderSettings(){
  $('language').value=config.language;$('auto-cleanup').checked=config.autoCleanup;if(document.activeElement!==$('image-duration'))$('image-duration').value=config.defaultImageDuration;
  $('security-status').textContent=t(security?.enabled?'Password enabled':'Password disabled');$('change-password').textContent=t(security?.enabled?'Change password':'Set password');$('disable-password').hidden=true;
  const signature=JSON.stringify([getLanguage(),config.rooms.map(r=>[r.id,r.number,r.name,r.base])]);
  if(signature!==settingsSignature){settingsSignature=signature;$('settings-rooms').replaceChildren();
    for(const r of config.rooms){const row=node('div','settings-row');row.dataset.room=r.id;const text=node('div','row-label');text.append(node('strong','',r.name),node('small','',`${t('Player {number}',{number:r.number})} · ${r.base?new URL(r.base).host:t('Not configured')}`));const actions=node('div','row-actions');actions.append(button(t('Access player'),'text-btn',()=>openPlayerAccess(r.id)),button(t('Edit'),'text-btn',()=>openPlayer(r.id)),button(t('Screen orientation'),'text-btn',()=>openOrientation(r.id)),button(t('Info'),'text-btn',()=>openInfo(r.id)),button(t('Remove'),'text-btn',()=>removePlayer(r.id)));row.append(text,actions);$('settings-rooms').append(row);}
    if(!config.rooms.length)$('settings-rooms').append(node('p','muted',t('No players yet')));
  }
  for(const row of $('settings-rooms').children){if(!row.dataset.room)continue;row.querySelectorAll('button').forEach(b=>{b.disabled=operations.has(row.dataset.room);});}
}
function openPlayer(id=null){
  if(id&&operations.has(id))throw new Error(t('Finish the current operation first.'));editingId=id;const r=id?byId(id):null;
  $('player-title').textContent=r?`${t('Edit player')} · ${t('Player {number}',{number:r.number})}`:`${t('Add player')} · ${config.nextPlayerNumber}`;
  $('player-name').value=r?.name||'';$('player-base').value=r?.base||'';$('player-error').textContent='';updateNameCount();$('player-dialog').showModal();$('player-name').focus();
}
function updateNameCount(){$('name-count').textContent=`${Array.from($('player-name').value).length} / 40`;}
async function savePlayer(e){
  e.preventDefault();if(savingPlayer)return;const id=editingId;
  try{
    const name=normalizeName($('player-name').value),base=normalizeBase($('player-base').value);if(!base)throw new Error(t('Player is not configured.'));
    if(config.rooms.some(r=>r.id!==id&&r.base===base))throw new Error(t('Address already assigned to another player.'));
    savingPlayer=true;$('save-player').disabled=true;
    // Chrome permission requests begin in the user gesture, before network or storage waits.
    if(!await chrome.permissions.request({origins:[originPermission(base)]}))throw new Error(t('Permission not granted. No changes saved.'));
    await requireUnlocked();const old=id?byId(id):null;
    if(old&&old.base!==base&&!await confirmAction(t('Change player address?'),t('An unverified address change clears content associations. Files on the old device are not modified. Use discovery to recognise a device with a changed IP.')))return;
    const commit=async()=>{
      if(id&&await readJournal(id))throw new Error(t('Complete playlist recovery before other changes.'));
      config=await updateConfig(latest=>{
        if(latest.rooms.some(r=>r.id!==id&&r.base===base))throw new Error(t('Address already assigned to another player.'));
        const target=latest.rooms.find(r=>r.id===id);
        if(id&&!target)throw new Error(t('Player configuration changed. Reopen it and try again.'));
        if(target&&target.base!==base){Object.assign(target,newRoom(name,base,target.number),{id});runtime.delete(id);}
        else if(target){target.name=name;target.base=base;}
        else selectedId=appendPlayer(latest,name,base).id;
      });
    };
    if(old)await navigator.locks.request(roomLock(old),{ifAvailable:true},async lock=>{if(!lock)throw new Error(t('Another tab is changing this player.'));await commit();});else await commit();
    if(id)selectedId=id;closeDialog('player-dialog');render();toast(t('Player saved.'));void refreshRoom(selectedId);void rememberIdentity(selectedId);
  }catch(error){$('player-error').textContent=error.message;}
  finally{savingPlayer=false;$('save-player').disabled=false;}
}
async function rememberIdentity(id){
  const r=byId(id);if(!r?.base||r.identity||!admitted)return;
  try{const found=await identifyPlayer(r.base,{timeout:20000});if(found.identity&&byId(id)?.base===r.base)config=await updateConfig(latest=>{const target=latest.rooms.find(x=>x.id===id);if(target?.base===r.base&&!target.identity)target.identity=found.identity;});}catch{/* Identity is optional; normal control does not wait for it. */}
}
async function removePlayer(id){
  const r=byId(id);if(!r||operations.has(id))return;
  if(!await confirmAction(`${t('Remove this player?')} · ${label(r)}`,t('Only the panel association is removed. Files and playback are unchanged.'),t('Remove'),true))return;
  await requireUnlocked();await navigator.locks.request(roomLock(r),{ifAvailable:true},async lock=>{if(!lock)throw new Error(t('Another tab is changing this player.'));if(await readJournal(id))throw new Error(t('Complete playlist recovery before other changes.'));config=await updateConfig(latest=>{latest.rooms=latest.rooms.filter(x=>x.id!==id);});});runtime.delete(id);render();toast(t('Player removed from this panel.'));
}
async function grantAccess(){
  const origins=permissionsFor(config.rooms.filter(r=>r.base).map(r=>r.base));if(!origins.length)return;
  if(!await chrome.permissions.request({origins}))throw new Error(t('Permission not granted. No changes saved.'));
  toast(t('Network access granted.'));void refreshAll();for(const r of config.rooms)void rememberIdentity(r.id);
}
async function changeLanguage(value){
  if(!security){config.language=value==='it'?'it':'en';}else config=await updateConfig(latest=>{latest.language=value==='it'?'it':'en';});setLanguage(config.language);translateDOM();settingsSignature='';
  if(!admitted)renderGate();else{render();if(editor&&!editor.busy)renderEditor();if(library)renderLibrary();if(fleet&&!fleet.running)updateFleetRows();}
}
async function openFleet(){
  fleet={rows:new Map(),running:false,done:false};$('fleet-rooms').replaceChildren();$('fleet-result').textContent='';$('fleet-select-all').checked=false;$('fleet-select-all').disabled=false;$('fleet-go').hidden=false;
  for(const r of config.rooms){const row=node('div','fleet-row');row.dataset.id=r.id;const check=node('input');check.type='checkbox';check.checked=r.id===selectedId;check.setAttribute('aria-label',label(r));const text=node('div','row-label');text.append(node('strong','',label(r)),node('small'));const status=node('span','hint');row.append(checkboxHit(check),text,status);$('fleet-rooms').append(row);fleet.rows.set(r.id,{row,check,text,status});action(check,updateFleetSelection,'change');}
  updateFleetRows();$('fleet-dialog').showModal();void refreshAll();
}
function restoreReady(r){return online(r)&&r.playlists.home.length>0&&r.playlists.home.every(item=>ready(state(r.id).assets.find(a=>a.asset_id===item.id)))&&!operations.has(r.id);}
function updateFleetRows(){
  if(!fleet||fleet.running||fleet.done)return;
  for(const [id,item]of fleet.rows){const r=byId(id);if(!r){item.check.disabled=true;item.check.checked=false;item.status.textContent=t('Excluded');continue;}
    const usable=restoreReady(r);item.check.disabled=!usable;if(!usable)item.check.checked=false;
    item.text.querySelector('small').textContent=t('{count} items',{count:r.playlists.home.length});
    item.status.textContent=t(usable?(mode(r).role==='home'?'Home is already active':'Ready to restore'):!online(r)?'Offline':'Home playlist missing or not ready');
  }updateFleetSelection();
}
function updateFleetSelection(){if(!fleet||fleet.running||fleet.done)return;const entries=[...fleet.rows.values()].filter(x=>!x.check.disabled),selected=entries.filter(x=>x.check.checked);$('fleet-go').disabled=!selected.length;$('fleet-select-all').checked=entries.length>0&&selected.length===entries.length;$('fleet-select-all').indeterminate=selected.length>0&&selected.length<entries.length;}
async function runFleet(){
  const ref=fleet;if(!ref||ref.running)return;
  const ids=[...ref.rows.entries()].filter(([,r])=>r.check.checked&&!r.check.disabled).map(([id])=>id);if(!ids.length)return;
  ref.running=true;$('fleet-go').disabled=true;$('fleet-select-all').disabled=true;$('fleet-dialog').querySelectorAll('[data-close]').forEach(b=>{b.disabled=true;});ref.rows.forEach(r=>{r.check.disabled=true;});
  let cursor=0,ok=0,failed=0;
  try{
    await Promise.all(Array.from({length:Math.min(2,ids.length)},async()=>{
      while(cursor<ids.length){const id=ids[cursor++],row=ref.rows.get(id);row.status.textContent=t('Publishing playlist…');
        const result=await withRoom(id,ctx=>activate(ctx,'home'),{silent:true});
        if(!result.ok){failed++;row.status.textContent=result.error||t('Offline');continue;}
        ok++;let tail='';
        if(result.value?.warning)tail=result.value.warning;
        else if(config.autoCleanup&&byId(id)?.cleanup.length){await pause(3400);if(!operations.has(id))await cleanRoom(id,true);tail=t(byId(id)?.cleanup.length?'Cleanup pending':'Cleaned up');}
        else if(!config.autoCleanup)tail=t('Cleanup disabled');
        row.status.textContent=[t('Home restored'),tail].filter(Boolean).join(' · ');
      }
    }));
  }finally{ref.running=false;ref.done=true;$('fleet-go').hidden=true;$('fleet-dialog').querySelectorAll('[data-close]').forEach(b=>{b.disabled=false;});$('fleet-result').textContent=t('{ok} restored · {failed} incomplete · {skipped} not selected',{ok,failed,skipped:ref.rows.size-ids.length});render();}
}
async function openOrientation(id){
  const r=byId(id);if(!r?.base||orientationBusy)return;
  orientationRoomId=id;const read=++orientationRead;
  $('orientation-title').textContent=label(r)+' · '+t('Screen orientation');
  $('orientation-error').textContent='';$('orientation-status').textContent=t('Loading…');
  $('orientation-select').disabled=$('orientation-save').disabled=true;
  $('orientation-dialog').showModal();
  try{
    const value=await readOrientation(apiFor(r));
    if(read!==orientationRead||orientationRoomId!==id||!$('orientation-dialog').open)return;
    $('orientation-select').value=String(value);$('orientation-select').disabled=$('orientation-save').disabled=false;
    $('orientation-status').textContent=t('Changing orientation reloads the player display and may briefly interrupt playback.');
  }catch(error){if(read===orientationRead)$('orientation-error').textContent=error.message;}
}
async function saveOrientation(){
  if(orientationBusy||$('orientation-save').disabled)return;
  const id=orientationRoomId,value=Number($('orientation-select').value);orientationBusy=true;
  $('orientation-dialog').querySelectorAll('[data-close]').forEach(b=>b.disabled=true);
  $('orientation-select').disabled=$('orientation-save').disabled=true;$('orientation-error').textContent='';
  try{
    const result=await withRoom(id,async({api,ensure})=>{await ensure();return writeOrientation(api,value);});
    if(result.ok){closeDialog('orientation-dialog');toast(t('Screen orientation saved.'));}
    else $('orientation-error').textContent=result.error;
  }finally{orientationBusy=false;$('orientation-dialog').querySelectorAll('[data-close]').forEach(b=>b.disabled=false);$('orientation-select').disabled=$('orientation-save').disabled=false;}
}
async function openInfo(id){
  const r=byId(id);if(!r?.base)return;infoRoomId=id;$('open-anthias').disabled=!r.base;$('info-title').textContent=label(r);$('info-data').replaceChildren(node('dt','',t('Loading…')));$('info-dialog').showModal();
  try{const info=await apiFor(r).info();state(id).info=info;if(infoRoomId!==id||!$('info-dialog').open)return;$('info-data').replaceChildren();const values=[['Model',info.device_model],['Anthias',info.anthias_version],['Address',r.base],['Free space',info.free_space],['Storage',info.storage?.status],['Display',info.display_power]];values.forEach(([key,value])=>$('info-data').append(node('dt','',t(key)),node('dd','',value||'—')));void rememberIdentity(id);}catch(error){if(infoRoomId===id)$('info-data').replaceChildren(node('dd','inline-error',error.message));}
}
async function rebootPlayer(id){
  const r=byId(id);if(!r||state(id).reboot||!await confirmAction(`${t('Reboot this player?')} · ${label(r)}`,t('Playback will stop while the player reboots.'),t('Reboot player'),true))return;
  if(infoRoomId===id)closeDialog('info-dialog');
  const result=await withRoom(id,async ctx=>{
    await ctx.ensure();await ctx.api.reboot();
    const now=Date.now(),s=state(id);s.reboot={requestedAt:now,notBefore:now+2500,deadline:now+120000,sawOffline:false,previousUptime:uptimeSeconds(s.info)};s.error='';s.operationError='';
  },{refreshAfter:false});
  if(result.ok){toast(`${label(r)}: ${t('Reboot requested.')}`);setTimeout(()=>void refreshRoom(id),3000);}
}
async function recover(){
  const id=selectedId;if(!await confirmAction(t('Recover previous playlist'),t('Restore settings from the interrupted operation? Later manual changes to the same assets may be overwritten.')))return;
  const result=await withRoom(id,async ctx=>{const journal=await readJournal(id);if(!journal||journal.base!==ctx.r.base)throw new Error(t('Invalid recovery record.'));const errors=await restoreJournal(ctx.api,journal,ctx.progress);if(errors.length)throw new Error(`${t('Recovery incomplete. A recovery record has been kept.')} ${errors.join(' · ')}`);await clearJournal(id);});if(result.ok)toast(t('Recovery completed.'));
}
function downloadJson(name,data){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=node('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
async function importConfigFile(file){
  if(!file||file.size>2*1024**2)throw new Error(t('Choose a panel configuration JSON file up to 2 MB.'));
  if(operations.size)throw new Error(t('Finish the current operation first.'));
  const incoming=migrateConfig(JSON.parse(await file.text()));
  if(!await confirmAction(t('Import configuration?'),t('This replaces the local player configuration, not files on the players. Your local password is unchanged.')))return;
  const origins=permissionsFor(incoming.rooms.filter(r=>r.base).map(r=>r.base));
  const allowed=!origins.length||await chrome.permissions.request({origins});
  for(const r of config.rooms)if(await readJournal(r.id))throw new Error(t('Complete playlist recovery before other changes.'));
  const locks=[...new Set(config.rooms.filter(r=>r.base).map(roomLock))].sort();
  const commit=async index=>{
    if(index<locks.length)return navigator.locks.request(locks[index],{ifAvailable:true},async held=>{if(!held)throw new Error(t('Another tab is changing this player.'));return commit(index+1);});
    for(const r of config.rooms)if(await readJournal(r.id))throw new Error(t('Complete playlist recovery before other changes.'));
    config=await updateConfig(async latest=>{await chrome.storage.local.set({hmrConfigBeforeImport:latest});incoming.rooms.forEach(r=>{r.cleanup=[];});incoming.setupComplete=true;incoming.wizardDraft=null;Object.assign(latest,incoming);});
  };
  await commit(0);
  runtime.clear();selectedId=config.rooms[0]?.id||'';settingsSignature='';setLanguage(config.language);translateDOM();security=await authRecord();
  if(!security)showGate('security');else await routeGate();
  toast(t(allowed?'Configuration imported.':'Your network permissions were not granted. You can authorise the imported players in Settings.'),allowed?'success':'warning');
}
function openSecurity(mode='change'){
  if(operations.size)throw new Error(t('Cannot change security while a player operation is running.'));securityMode=mode;
  $('security-title').textContent=t(mode==='disable'?'Disable password':security?.enabled?'Change password':'Set password');$('current-password-label').hidden=!security?.enabled;$('current-password').required=Boolean(security?.enabled);
  $('new-password-fields').hidden=mode==='disable';$('new-password').required=$('confirm-password').required=mode!=='disable';
  for(const id of ['current-password','new-password','confirm-password'])$(id).value='';$('security-error').textContent='';$('security-save').textContent=t(mode==='disable'?'Confirm disable':'Save password');$('security-dialog').showModal();
}
async function saveSecurity(e){
  e.preventDefault();$('security-save').disabled=true;
  try{await requireUnlocked();if(operations.size)throw new Error(t('Cannot change security while a player operation is running.'));
    security=securityMode==='disable'?await disablePassword($('current-password').value):await setPassword($('new-password').value,$('confirm-password').value,$('current-password').value);
    closeDialog('security-dialog');for(const id of ['current-password','new-password','confirm-password'])$(id).value='';render();toast(t(securityMode==='disable'?'Password disabled.':'Password updated.'));
  }catch(error){$('security-error').textContent=error.message;}finally{$('security-save').disabled=false;}
}
function discoveryPlayers(){
  if(admitted)return config.rooms;
  return wizardRows.flatMap((r,i)=>{try{return r.base?[{...r,id:`wizard-${i}`,number:config.nextPlayerNumber+i,base:normalizeBase(r.base)}]:[];}catch{return [];}});
}
function updateDiscoveryNetwork(){
  const ref=discovery;if(!ref)return;
  const hasCidr=$('scan-address').value.includes('/');$('scan-subnet').disabled=ref.running||ref.adding||hasCidr;
  try{
    const spec=networkSpec({address:$('scan-address').value,subnet:$('scan-subnet').value,port:$('scan-port').value,protocol:$('scan-protocol').value});
    $('scan-network').textContent=t('{network} · {count} addresses',{network:spec.cidr,count:spec.count});
    if(ref.signature&&ref.signature!==`${spec.cidr}|${spec.protocol}|${spec.port}`)$('scan-deep').hidden=true;
  }catch{$('scan-network').textContent=t('Enter an IP and subnet, or a network such as 192.168.1.0/24.');$('scan-deep').hidden=true;}
}
function setDiscoveryBusy(ref){
  if(discovery!==ref)return;
  for(const id of ['scan-address','scan-subnet','scan-port','scan-protocol'])$(id).disabled=ref.running||ref.adding;
  $('scan-go').disabled=ref.running||ref.adding;$('scan-stop').disabled=!ref.running||ref.adding;
  $('scan-deep').disabled=ref.running||ref.adding;$('scan-add').disabled=ref.adding||!ref.selected.size;
  $('scan-add').textContent=t(ref.adding?'Adding players…':'Add selected');
  $('discovery-close').disabled=$('discovery-done').disabled=ref.adding;
  if(!ref.running&&!ref.adding)updateDiscoveryNetwork();
}
function openDiscovery(){
  if(discovery?.running||discovery?.adding)return;
  discovery={running:false,adding:false,controller:null,found:[],selected:new Set(),nodes:new Map(),wizard:!admitted,unresolved:[],identityQueue:[],identityActive:0,scanDone:null};
  const saved=config.discovery;let address=saved.address||'',subnet=saved.subnet||'24',port=saved.port||80,protocol=saved.protocol||'http';
  if(!address){
    const known=discoveryPlayers().find(r=>r.base);
    if(known)try{const url=new URL(known.base);address=ipString(ipv4(url.hostname));port=Number(url.port)|| (url.protocol==='https:'?443:80);protocol=url.protocol.slice(0,-1);}catch{}
  }
  $('scan-address').value=address;$('scan-subnet').value=subnet;$('scan-port').value=port;$('scan-protocol').value=protocol;
  $('scan-results').replaceChildren();$('scan-status').textContent='';$('scan-error').textContent='';$('scan-progress').value=0;
  $('scan-deep').hidden=true;$('scan-advanced').open=false;setDiscoveryBusy(discovery);updateDiscoveryNetwork();$('discovery-dialog').showModal();
}
function queueDiscoveryIdentity(ref,found){
  ref.identityQueue.push({found,controller:ref.controller});drainDiscoveryIdentities(ref);
}
function drainDiscoveryIdentities(ref){
  if(discovery!==ref||ref.adding)return;
  while(ref.identityActive<4&&ref.identityQueue.length){
    const {found,controller}=ref.identityQueue.shift();if(controller.signal.aborted)continue;
    ref.identityActive++;
    void playerIdentity(found.base,{signal:controller.signal,timeout:1800}).then(identity=>{
      if(discovery!==ref||ref.controller!==controller||controller.signal.aborted||ref.adding)return;
      found.identity=identity;found.identityVerified=true;renderDiscoveryResult(found);
    }).finally(()=>{ref.identityActive--;drainDiscoveryIdentities(ref);});
  }
}
async function startDiscovery(deep=false){
  const ref=discovery;if(!ref||ref.running||ref.adding)return;
  try{
    const spec=networkSpec({address:$('scan-address').value,subnet:$('scan-subnet').value,port:Number($('scan-port').value),protocol:$('scan-protocol').value});
    const signature=`${spec.cidr}|${spec.protocol}|${spec.port}`;
    const targets=deep&&ref.signature===signature?ref.unresolved:scanTargets(spec);
    if(!targets.length)return;
    ref.signature=signature;ref.running=true;ref.controller?.abort();ref.controller=new AbortController();ref.identityQueue=[];
    if(!deep){ref.found=[];ref.selected.clear();ref.nodes.clear();$('scan-results').replaceChildren();}
    $('scan-address').value=spec.address;$('scan-subnet').value=spec.subnet;
    $('scan-error').textContent='';$('scan-progress').value=0;$('scan-deep').hidden=true;
    $('scan-status').textContent=t('Checking the VPS tunnel and remote subnet…');setDiscoveryBusy(ref);
    await validateScanNetwork(spec);if(ref.controller.signal.aborted)return;
    // This call must remain directly within the Search click, before any await.
    const permission=chrome.permissions.request({origins:permissionsFor(targets)});
    if(!await permission)throw new Error(t('Permission not granted. No changes saved.'));
    if(discovery!==ref||ref.controller.signal.aborted)return;
    config=await updateConfig(latest=>{latest.discovery={address:spec.address,subnet:spec.subnet,port:spec.port,protocol:spec.protocol};});
    if(discovery!==ref||ref.controller.signal.aborted)return;
    $('scan-status').textContent=t(deep?'Checking slower devices…':'Searching…');
    const profile=deep?SCAN_PROFILES.thorough:SCAN_PROFILES.quick;
    ref.scanDone=scanViaVps(targets,{...profile,known:discoveryPlayers().map(r=>r.base),signal:ref.controller.signal,
      onResult:found=>{
        if(discovery!==ref||ref.adding)return;
        if(ref.nodes.has(found.base))return;
        ref.found.push(found);renderDiscoveryResult(found);queueDiscoveryIdentity(ref,found);
      },
      onProgress:({checked,total,elapsedMs})=>{
        if(discovery!==ref||ref.adding)return;
        $('scan-progress').value=checked/total*100;
        $('scan-status').textContent=t('{checked}/{total} · Found: {found} · {seconds}s',{checked,total,found:ref.found.length,seconds:(elapsedMs/1000).toFixed(1)});
      }
    });
    const result=await ref.scanDone;
    if(discovery!==ref||ref.adding)return;
    ref.unresolved=result.unresolved;
    $('scan-status').textContent=`${t(result.stopped?'Scan stopped':'Scan finished')} · ${t('Found: {found} · {seconds}s',{found:ref.found.length,seconds:(result.elapsedMs/1000).toFixed(1)})}`;
    $('scan-deep').hidden=!ref.unresolved.length;
    if(!ref.found.length&&Object.keys(result.errors||{}).length){$('scan-error').textContent=t('Scan executed on VPS through WireGuard')+' · '+Object.entries(result.errors).map(([reason,count])=>`${t(reason)}: ${count}`).join(' · ');}
    if(!ref.found.length){const hint=node('p','hint scan-empty',t('No players detected. Check the subnet or try the more thorough search.'));$('scan-results').append(hint);}
  }catch(error){if(discovery===ref)$('scan-error').textContent=error.message;}
  finally{ref.running=false;if(discovery===ref)setDiscoveryBusy(ref);}
}
function renderDiscoveryResult(found){
  const ref=discovery;if(!ref||ref.adding)return;
  const match=classifyResult(found,discoveryPlayers());let item=ref.nodes.get(found.base);
  if(!item){
    $('scan-results').querySelector('.scan-empty')?.remove();
    const row=node('div','discovery-row'),check=node('input');check.type='checkbox';check.setAttribute('aria-label',found.base);
    const text=node('div','row-label'),input=textInput(match.player?.name||'',t('Name'));input.maxLength=40;
    input.setAttribute('aria-label',`${t('Name')} ${new URL(found.base).host}`);
    row.append(checkboxHit(check),text,input);$('scan-results').append(row);item={row,check,input,text,match};ref.nodes.set(found.base,item);
    action(check,()=>{if(check.checked)ref.selected.add(found.base);else ref.selected.delete(found.base);setDiscoveryBusy(ref);},'change');
  }
  item.match=match;item.row.classList.toggle('already-enrolled',match.kind==='existing');item.check.disabled=item.input.disabled=match.kind==='existing';
  if(match.kind==='existing'){item.check.checked=false;ref.selected.delete(found.base);}
  if(match.player&&!item.input.value)item.input.value=match.player.name;
  item.text.replaceChildren(node('strong','',new URL(found.base).host),node('small','',`${found.info.device_model} · ${found.info.anthias_version}`),
    node('small','',match.kind==='existing'?`${t('Already enrolled')} · ${label(match.player)}`:match.kind==='moved'?`${t('Update address')} · ${label(match.player)}`:t('New player')));
  setDiscoveryBusy(ref);
}
async function addDiscovered(){
  const ref=discovery;if(!ref||ref.adding||!ref.selected.size)return;
  const entries=ref.found.filter(f=>ref.selected.has(f.base)).map(found=>({found,name:normalizeName(ref.nodes.get(found.base).input.value||t('New player'))}));
  ref.adding=true;ref.controller?.abort();setDiscoveryBusy(ref);
  try{
    // Aborting outstanding probes is immediate; addition does not wait for the subnet.
    await ref.scanDone;
    for(const entry of entries){
      if(!entry.found.identityVerified){entry.found.identity=await playerIdentity(entry.found.base,{timeout:2500});entry.found.identityVerified=true;}
      entry.match=classifyResult(entry.found,discoveryPlayers());
    }
    if(ref.wizard){
      wizardRows=wizardRows.filter(r=>r.name.trim()||r.base.trim());
      for(const {found,name,match}of entries){
        if(match.kind==='moved'){const target=wizardRows.find(r=>r.identity===found.identity);if(target){target.name=name;target.base=found.base;}}
        else if(match.kind==='new'&&!wizardRows.some(r=>r.base===found.base||(found.identity&&r.identity===found.identity)))wizardRows.push({name,base:found.base,identity:found.identity});
      }
      await saveWizardDraft();ref.adding=false;closeDiscovery();renderGate();return;
    }
    await requireUnlocked();
    for(const {found,name}of entries){
      const match=classifyResult(found,config.rooms);
      if(match.kind==='moved'){
        const original=match.player;
        if(!await confirmAction(t('Update this player address?'),`${label(original)} · ${found.base}\n${t('The player identity matches an existing device. Its associations will be preserved at the new address.')}`))continue;
        const verified=await identifyPlayer(found.base,{timeout:6000});if(verified.identity!==original.identity)throw new Error(t('Player configuration changed. Reopen it and try again.'));
        await navigator.locks.request(roomLock(original),{ifAvailable:true},async lock=>{
          if(!lock)throw new Error(t('Another tab is changing this player.'));if(await readJournal(original.id))throw new Error(t('Complete playlist recovery before other changes.'));
          config=await updateConfig(latest=>{const target=latest.rooms.find(r=>r.id===original.id);if(!target||target.identity!==found.identity)throw new Error(t('Player configuration changed. Reopen it and try again.'));if(latest.rooms.some(r=>r.id!==target.id&&r.base===found.base))throw new Error(t('Address already assigned to another player.'));target.base=found.base;target.name=name;target.cleanup.forEach(j=>{j.base=found.base;});});runtime.delete(original.id);
        });
      }else if(match.kind==='new')config=await updateConfig(latest=>{if(classifyResult(found,latest.rooms).kind==='new')selectedId=appendPlayer(latest,name,found.base,found.identity).id;});
    }
    ref.adding=false;closeDiscovery();render();void refreshAll();toast(t('Player saved.'));
  }catch(error){if(discovery===ref)$('scan-error').textContent=error.message;}
  finally{ref.adding=false;if(discovery===ref)setDiscoveryBusy(ref);}
}
function stopDiscovery(){discovery?.controller?.abort();}
function closeDiscovery(){if(discovery?.adding)return;stopDiscovery();closeDialog('discovery-dialog');discovery=null;}

function showGate(stage){
  hideToast();stopDiscovery();admitted=false;gateStage=stage;$('app').hidden=true;$('gate').hidden=false;
  for(const video of document.querySelectorAll('video'))video.pause();
  if(stage==='players')wizardRows=config.wizardDraft?.length?structuredClone(config.wizardDraft):wizardRows.length?wizardRows:[{name:'',base:'',identity:''}];
  renderGate();
}
function gateLabel(text,input){const l=node('label');l.append(node('span','',t(text)),input);return l;}
function gateError(error){const el=$('gate-error');if(el)el.textContent=error.message||String(error);else report(error);}
function gateSteps(current){const steps=node('div','wizard-steps');for(let i=1;i<=3;i++)steps.append(node('span',i<=current?'active':''));return steps;}
function renderGate(){
  if(admitted)return;$('gate-logout').hidden=!security?.enabled||!hasSession(security);$('gate-language').value=config.language;const body=$('gate-body'),footer=$('gate-footer');body.replaceChildren();footer.replaceChildren();
  if(gateStage==='welcome'){
    body.append(node('span','eyebrow',t('Initial setup')),node('div','gate-symbol','▦'),node('h1','',t('Welcome to Anthias Rooms')),node('p','muted',t('Connect your displays, then add their Anthias players.')));
    const options=node('div','welcome-actions');options.append(button(t('Start setup'),'btn primary',()=>showGate('password')),button(t('Import an existing configuration'),'btn secondary',()=>$('import-file').click()));body.append(options,node('p','hint',t('Configuration only: media files and the local password are not included.')));
    // Cloud setup cannot skip authentication.
  }else if(gateStage==='login'){
    body.append(node('div','gate-symbol','◇'),node('h1','',t('Panel locked')));
    const form=node('form','gate-form'),input=node('input');input.id='gate-password';input.type='password';input.maxLength=128;input.required=true;input.autocomplete='current-password';form.append(gateLabel('Password',input));const error=node('p','inline-error');error.id='gate-error';error.setAttribute('role','alert');form.append(error);body.append(form,node('p','hint',t('Sign in with your server password. Configuration exports do not include credentials.')));
    const submit=button(t('Unlock'),'btn primary',()=>form.requestSubmit());footer.append(submit);
    action(form,async e=>{e.preventDefault();if(wizardBusy)return;wizardBusy=true;submit.disabled=true;try{security=await login(input.value);input.value='';await routeGate();}catch(error){gateError(error);}finally{wizardBusy=false;submit.disabled=false;}},'submit');setTimeout(()=>input.focus(),40);
  }else if(gateStage==='password'||gateStage==='security'){
    const setup=gateStage==='password';body.append(gateSteps(1),node('span','eyebrow',t(setup?'Set up your panel':'Security')),node('h1','',t('Create your password')));
    body.append(node('p','hint',t(setup?'Server login protects cloud access. Anthias players remain private behind the router.':'Your players have been preserved. Choose a local password or explicitly continue without protection.')));
    const form=node('form','gate-form'),first=node('input'),second=node('input');for(const i of [first,second]){i.type='password';i.minLength=8;i.maxLength=128;i.required=true;i.autocomplete='new-password';}first.id='setup-password';second.id='setup-confirm';if(!security){const key=node('input');key.id='setup-key';key.type='password';key.required=true;key.autocomplete='off';form.append(gateLabel('Installation setup key',key));}
    form.append(gateLabel('New password',first),gateLabel('Confirm password',second),node('small','hint',t('At least 8 characters')));const error=node('p','inline-error');error.id='gate-error';form.append(error);body.append(form);
    if(setup)footer.append(button(t('Back'),'text-btn',()=>showGate('welcome')));// Cloud access always requires server authentication.
    const submit=button(t('Save password'),'btn primary',()=>form.requestSubmit());footer.append(submit);
    action(form,async e=>{e.preventDefault();if(wizardBusy)return;wizardBusy=true;submit.disabled=true;try{security=await setPassword(first.value,second.value);const chosenLanguage=config.language;config=await updateConfig(latest=>{latest.language=chosenLanguage;});first.value=second.value='';if(setup)showGate('remote');else await routeGate();}catch(error){gateError(error);}finally{wizardBusy=false;submit.disabled=false;}},'submit');
  }else if(gateStage==='remote'){
    void renderRemote(body,footer,async remote=>{config=await updateConfig(latest=>{latest.discovery={...latest.discovery,address:remote.subnet.split('/')[0],subnet:remote.subnet.split('/')[1]};});showGate(config.setupComplete?'done':'players');});
  }else if(gateStage==='players'){
    body.append(gateSteps(2),node('span','eyebrow',t('Initial setup')),node('h1','',t('Choose your players')));
    const tools=node('div','wizard-tools'),count=node('input');count.id='wizard-count';count.type='number';count.min=1;count.max=100;count.value=wizardRows.length||1;
    tools.append(gateLabel('How many players?',count),button(t('Create fields'),'btn secondary',async()=>{const n=Number(count.value);if(!Number.isInteger(n)||n<1||n>100)throw new Error(t('Enter a number from 1 to 100.'));wizardRows=Array.from({length:n},(_,i)=>wizardRows[i]||{name:'',base:'',identity:''});await saveWizardDraft();renderGate();}),button(t('Discover players'),'btn primary',openDiscovery));body.append(tools);
    const rows=node('div','wizard-rows internal-scroll');
    wizardRows.forEach((draft,index)=>{
      const row=node('div','wizard-row'),name=textInput(draft.name,t('Name')),base=textInput(draft.base,'192.168.1.20'),result=node('small');name.maxLength=40;base.maxLength=255;name.setAttribute('aria-label',`${t('Name')} ${index+1}`);base.setAttribute('aria-label',`${t('Address')} ${index+1}`);row.append(node('strong','muted',String(config.nextPlayerNumber+index).padStart(2,'0')),name,base);
      action(name,()=>{draft.name=name.value;void saveWizardDraft();},'change');action(base,()=>{draft.base=base.value;draft.identity='';void saveWizardDraft();},'change');
      const test=button(t('Test connection'),'text-btn',async()=>{try{draft.name=name.value;draft.base=base.value;const address=normalizeBase(base.value);if(!address)throw new Error(t('Player is not configured.'));test.disabled=true;result.textContent=t('Checking…');if(!await chrome.permissions.request({origins:[originPermission(address)]}))throw new Error(t('Permission not granted. No changes saved.'));const found=await identifyPlayer(address,{timeout:20000});draft.base=address;draft.identity=found.identity;base.value=address;result.textContent=`${t('Connected')} · ${found.info.device_model}`;await saveWizardDraft();}catch(error){result.textContent=error.message;}finally{test.disabled=false;}});row.append(test,result);rows.append(row);
    });body.append(rows);const error=node('p','inline-error');error.id='gate-error';body.append(error);
    footer.append(button(t('Skip setup'),'text-btn',skipSetup),button(t('Finish setup'),'btn primary',finishSetup));
  }else if(gateStage==='done'){
    body.append(gateSteps(3),node('div','gate-symbol','✓'),node('h1','',t('Setup complete')),node('p','muted',t('You can add more players at any time from Settings. No content has been changed on the devices.')));footer.append(button(t('Open panel'),'btn primary',admit));
  }
}
async function saveWizardDraft(){const rows=structuredClone(wizardRows);config=await updateConfig(latest=>{latest.wizardDraft=rows;});}
async function finishSetup(){
  if(wizardBusy)return;wizardBusy=true;
  try{
    // Read current fields even when touchscreen users tap Finish without blurring first.
    const rows=Array.from($('gate-body').querySelectorAll('.wizard-row')).map((row,i)=>({name:normalizeName(row.querySelectorAll('input')[0].value),base:normalizeBase(row.querySelectorAll('input')[1].value),identity:wizardRows[i]?.identity||''}));
    if(!rows.length||rows.length>100)throw new Error(t('Enter a number from 1 to 100.'));
    if(rows.some(r=>!r.base))throw new Error(t('Player is not configured.'));
    if(new Set(rows.map(r=>r.base)).size!==rows.length)throw new Error(t('Address already assigned to another player.'));
    if(!await chrome.permissions.request({origins:permissionsFor(rows.map(r=>r.base))}))throw new Error(t('Permission not granted. No changes saved.'));
    config=await updateConfig(latest=>{if(latest.setupComplete)return;for(const r of rows){if(latest.rooms.some(x=>x.base===r.base))continue;appendPlayer(latest,r.name,r.base,r.identity);}latest.setupComplete=true;latest.wizardDraft=null;});
    wizardRows=[];showGate('done');
  }catch(error){gateError(error);}finally{wizardBusy=false;}
}
async function skipSecurity(){
  if(!await confirmAction(t('Skip without password?'),t('The panel will remain unprotected until you enable a password in Settings. No players are added automatically.'),t('Continue without password')))return;
  security=await disablePassword();await routeGate();
}
async function skipSetup(){
  if(!security)throw new Error(t('Cloud access requires a password.'));
  security=await authRecord();
  if(!security?.enabled){if(!await confirmAction(t('Skip without password?'),t('The panel will remain unprotected until you enable a password in Settings. No players are added automatically.'),t('Skip setup')))return;security=await disablePassword();}
  config=await updateConfig(latest=>{latest.setupComplete=true;latest.wizardDraft=null;});wizardRows=[];await routeGate();
}
async function routeGate(){
  security=await authRecord();
  if(security?.enabled&&!hasSession(security)){showGate('login');return;}
  if(security&&hasSession(security))config=await loadConfig();
  if(!security){showGate('welcome');return;}
  const remote=await remoteStatus();if(!remote.remote){showGate('remote');return;}
  if(!config.setupComplete){showGate('players');return;}
  if(!security){showGate('security');return;}
  await admit();
}
async function admit(){
  security=await authRecord();if(!config.setupComplete||!security||(security.enabled&&!hasSession(security))){await routeGate();return;}
  admitted=true;gateStage='';$('gate').hidden=true;$('app').hidden=false;if(!selectedId)selectedId=config.rooms[0]?.id||'';
  for(const r of config.rooms)state(r.id).journal=await readJournal(r.id);
  render();void refreshAll();
  // A migrated player can acquire a stable Balena identity without a content write.
  const unidentified=config.rooms.filter(r=>!r.identity&&r.base);let i=0;
  void (async()=>{while(i<unidentified.length&&admitted){const r=unidentified[i++];if(await chrome.permissions.contains({origins:[originPermission(r.base)]}))await rememberIdentity(r.id);}})();
}
function bindDrop(role){
  const input=$(`${role}-file`),drop=$(`${role}-drop`);let depth=0;
  action($(`pick-${role}`),()=>input.click());
  action(input,e=>{const files=Array.from(e.target.files);e.target.value='';if(files.length)openEditor(role,files);},'change');
  action(drop,e=>{if(e.target.closest('button,video'))return;const r=room();if(!r||operations.has(r.id))return;const {items}=getShown(r,role);if(items.length)openLargePreview(role);else input.click();});
  action(drop,e=>{if(e.target===drop&&['Enter',' '].includes(e.key)){e.preventDefault();const r=room();if(r&&!operations.has(r.id))getShown(r,role).items.length?openLargePreview(role):input.click();}},'keydown');
  drop.addEventListener('dragenter',e=>{e.preventDefault();depth++;if(!operations.has(selectedId))drop.classList.add('drag');});
  drop.addEventListener('dragover',e=>{e.preventDefault();if(e.dataTransfer)e.dataTransfer.dropEffect=operations.has(selectedId)?'none':'copy';});
  drop.addEventListener('dragleave',()=>{depth=Math.max(0,depth-1);if(!depth)drop.classList.remove('drag');});
  action(drop,e=>{e.preventDefault();e.stopPropagation();depth=0;drop.classList.remove('drag');const files=Array.from(e.dataTransfer?.files||[]);if(files.length)openEditor(role,files);},'drop');
}
function bind(){
  for(const key of ['content','settings'])action($(`nav-${key}`),()=>{if(key==='settings')for(const role of ['home','event'])stopPreview($(`${role}-preview`));view=key;render();});
  for(const id of ['add-player','empty-add','settings-add'])action($(id),()=>openPlayer());
  for(const id of ['empty-discover','settings-discover'])action($(id),openDiscovery);
  action($('configure-player'),()=>openPlayer(selectedId));action($('player-form'),savePlayer,'submit');action($('player-name'),updateNameCount,'input');
  action($('room-search'),renderRooms,'input');action($('grant-access'),grantAccess);
  action($('language'),e=>changeLanguage(e.target.value),'change');action($('gate-language'),e=>changeLanguage(e.target.value),'change');
  window.addEventListener('ar-session-expired',()=>{if(admitted){for(const d of document.querySelectorAll('dialog[open]'))d.close();editor=null;library=null;showGate('login');}});
  action($('auto-cleanup'),async e=>{const value=e.target.checked;await requireUnlocked();config=await updateConfig(latest=>{latest.autoCleanup=value;});render();toast(t('Settings saved.'));},'change');
  action($('image-duration'),async e=>{const value=Number(e.target.value);if(!Number.isInteger(value)||value<1||value>86400){e.target.value=config.defaultImageDuration;throw new Error(t('Image duration must be between 1 and 86400 seconds.'));}await requireUnlocked();config=await updateConfig(latest=>{latest.defaultImageDuration=value;});toast(t('Settings saved.'));},'change');
  action($('change-password'),()=>openSecurity('change'));action($('disable-password'),()=>openSecurity('disable'));action($('security-form'),saveSecurity,'submit');
  const logoutPanel=async()=>{if(operations.size||fleet?.running)throw new Error(t('Finish the current operation first.'));try{await lockSession();}finally{for(const d of document.querySelectorAll('dialog[open]'))d.close();editor=null;library=null;showGate('login');}};
  action($('lock'),logoutPanel);action($('gate-logout'),logoutPanel);
  action($('orientation-save'),saveOrientation);
  $('orientation-dialog').addEventListener('cancel',e=>{if(orientationBusy)e.preventDefault();});
  action($('refresh'),async()=>{
    const b=$('refresh');if(b.disabled)return;b.disabled=true;b.classList.add('refreshing');b.setAttribute('aria-busy','true');
    try{
      await refreshAll();
      for(const role of ['home','event'])releasePreview($(`${role}-preview`));render();
      const failed=config.rooms.filter(r=>r.base&&!online(r)).length;
      toast(failed?t('Refresh complete: {count} players unavailable.',{count:failed}):t('Players and previews refreshed.'),failed?'warning':'success');
    }finally{b.disabled=false;b.classList.remove('refreshing');b.removeAttribute('aria-busy');}
  });
  action($('toast-close'),hideToast);window.addEventListener('resize',positionToast);
  const noticeObserver=new ResizeObserver(positionToast);for(const id of ['notice-anchor','settings-notice-anchor','toast'])noticeObserver.observe($(id));
  for(const role of ['home','event']){
    bindDrop(role);action($(`edit-${role}`),()=>openEditor(role));action($(`show-${role}`),()=>showRole(role));action($(`${role}-expand`),()=>openLargePreview(role));
    for(const direction of ['prev','next'])action($(`${role}-${direction}`),()=>{const r=room();if(!r)return;const {items}=getShown(r,role);if(!items.length)return;const key=`${r.id}:${role}`,value=previewIndexes.get(key)||0;previewIndexes.set(key,(value+(direction==='next'?1:-1)+items.length)%items.length);renderCard(r,role);});
  }
  action($('editor-close'),closeEditor);action($('editor-add'),()=>$('editor-file').click());
  action($('editor-file'),e=>{const files=Array.from(e.target.files);e.target.value='';if(files.length)appendFiles(files);},'change');
  action($('editor-clear'),async()=>{if(!editor||editor.busy)return;if(!await confirmAction(t('Clear playlist'),t('Clearing a prepared playlist does not delete files or stop current playback.')))return;editor.items=[];renderEditor();});
  action($('editor-save'),()=>saveEditor(false));action($('editor-publish'),()=>saveEditor(true));
  $('editor-list').addEventListener('dragover',e=>{e.preventDefault();if(editor&&!editor.busy&&e.dataTransfer?.types.includes('Files'))$('editor-list').classList.add('drag');});
  $('editor-list').addEventListener('dragleave',e=>{if(!e.currentTarget.contains(e.relatedTarget))$('editor-list').classList.remove('drag');});
  action($('editor-list'),e=>{e.preventDefault();e.stopPropagation();$('editor-list').classList.remove('drag');if(editor&&!editor.busy&&e.dataTransfer?.files.length)appendFiles(e.dataTransfer.files);},'drop');
  $('editor-dialog').addEventListener('cancel',e=>{e.preventDefault();void closeEditor();});
  document.addEventListener('dragover',e=>e.preventDefault());document.addEventListener('drop',e=>e.preventDefault());
  action($('info-memory'),()=>openLibrary(infoRoomId));action($('player-media'),()=>openLibrary(selectedId));action($('library-search'),renderLibrary,'input');
  action($('editor-library'),()=>{if(editor?.role==='home')return openLibrary(editor.roomId,{pickForHome:true});});action($('library-use'),useHomeMedia);
  action($('restore-selected'),openFleet);action($('fleet-go'),runFleet);action($('fleet-select-all'),e=>{if(!fleet)return;fleet.rows.forEach(r=>{if(!r.check.disabled)r.check.checked=e.target.checked;});updateFleetSelection();},'change');
  $('fleet-dialog').addEventListener('cancel',e=>{if(fleet?.running)e.preventDefault();});
  action($('recover'),recover);action($('retry-cleanup'),()=>cleanRoom(selectedId,true));
  action($('scan-go'),()=>startDiscovery(false));action($('scan-deep'),()=>startDiscovery(true));
  for(const id of ['scan-address','scan-subnet','scan-port','scan-protocol'])action($(id),updateDiscoveryNetwork,id==='scan-protocol'?'change':'input');action($('scan-stop'),stopDiscovery);action($('scan-add'),addDiscovered);action($('discovery-close'),closeDiscovery);action($('discovery-done'),closeDiscovery);
  $('discovery-dialog').addEventListener('cancel',e=>{e.preventDefault();closeDiscovery();});
  action($('export-config'),async()=>{await requireUnlocked();downloadJson('anthias-rooms-config.json',exportConfig(config));});action($('import-config'),()=>$('import-file').click());
  action($('import-file'),e=>{const file=e.target.files[0];e.target.value='';if(file)return importConfigFile(file);},'change');
  $('router-gui').href=`https://${location.hostname}:8443/`;
  action($('remote-router'),()=>showGate('remote'));
  action($('diagnostics'),async()=>{await requireUnlocked();const local=await chrome.storage.local.get(null);downloadJson('anthias-rooms-diagnostics.json',{version:'1.0.1-vps',createdAt:new Date().toISOString(),config:exportConfig(config),players:config.rooms.map(r=>({id:r.id,number:r.number,online:state(r.id).online,error:state(r.id).error,operationError:state(r.id).operationError,info:state(r.id).info,assets:state(r.id).assets})),logs,pending:Object.fromEntries(Object.entries(local).filter(([key])=>key.startsWith('hmrJournal:')||key.startsWith('hmrUpload:')))});});
  action($('open-anthias'),()=>openPlayerAccess(infoRoomId));
  action($('reboot'),()=>rebootPlayer(infoRoomId));action($('quick-reboot'),()=>rebootPlayer(selectedId));
  document.querySelectorAll('[data-close]').forEach(b=>action(b,()=>closeDialog(b.dataset.close)));
  $('player-dialog').addEventListener('cancel',e=>{if(savingPlayer)e.preventDefault();});
  $('library-dialog').addEventListener('close',()=>{library=null;});$('fleet-dialog').addEventListener('close',()=>{if(!fleet?.running)fleet=null;});
  $('preview-dialog').addEventListener('close',()=>{emptyPreview($('large-preview'),'');});
  $('editor-dialog').addEventListener('close',()=>{$('editor-list').querySelectorAll('.preview').forEach(releasePreview);});
  window.addEventListener('beforeunload',e=>{if(operations.size||savingPlayer||editorHasChanges(editor)||discovery?.running||wizardBusy){e.preventDefault();e.returnValue='';}});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&admitted)void refreshAll();});
  chrome.storage.onChanged.addListener(async(changes,area)=>{
    if(area!=='local')return;
    try{
      if(changes.hmrConfig){config=await loadConfig();setLanguage(config.language);translateDOM();if(admitted)render();}
      if(changes.hmrAuthV4){security=await authRecord();if(admitted&&security?.enabled&&!hasSession(security)){for(const d of document.querySelectorAll('dialog[open]'))d.close();showGate('login');}else if(admitted)render();}
    }catch(error){report(error);}
  });
  window.addEventListener('unhandledrejection',e=>{e.preventDefault();report(e.reason);});window.addEventListener('error',e=>{if(e.error)report(e.error);});
}
async function start(){
  try{
    config=await loadConfig();setLanguage(config.language);translateDOM();security=await authRecord();bind();await routeGate();
    setInterval(()=>{if(admitted&&!document.hidden&&!discovery?.running&&room())void refreshRoom(selectedId);},5000);
    setInterval(()=>{if(admitted&&!document.hidden&&!discovery?.running)void refreshAll();},25000);
    setInterval(()=>{if(admitted&&!document.hidden&&config.autoCleanup)for(const r of config.rooms)if(online(r))void cleanRoom(r.id);},15000);
  }catch(error){$('gate-body').replaceChildren(node('h2','',t('Startup failed: {detail}',{detail:error.message})));report(error);}
}
start();
