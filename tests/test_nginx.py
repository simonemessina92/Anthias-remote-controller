"""Real Nginx/TLS integration with a simulated GUI and a real backend process."""
import http.cookiejar,importlib.util,json,os,shutil,socket,ssl,subprocess,sys,tempfile,threading,time,unittest
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from urllib.request import Request,build_opener,HTTPCookieProcessor,HTTPSHandler,HTTPRedirectHandler
from urllib.error import HTTPError
ROOT=Path(__file__).resolve().parents[1]
def port():
 with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
class NoRedirect(HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
class Gui(BaseHTTPRequestHandler):
 cookies=[]
 def log_message(self,*args):pass
 def answer(self,code,raw,headers=None):
  self.send_response(code);self.send_header('Content-Length',str(len(raw)))
  for k,v in (headers or {}).items():self.send_header(k,v)
  self.end_headers();self.wfile.write(raw)
 def do_GET(self):
  self.cookies.append(self.headers.get('Cookie',''))
  if self.path=='/redirect':return self.answer(302,b'',{'Location':f'http://127.0.0.1:{self.server.server_port}/dashboard'})
  if self.path=='/app.js':return self.answer(200,b'window.GUI_LOADED=true',{'Content-Type':'application/javascript'})
  if self.path=='/ws' and self.headers.get('Upgrade')=='websocket':
   self.send_response(101);self.send_header('Upgrade','websocket');self.send_header('Connection','Upgrade');self.end_headers();return
  return self.answer(200,b'<html><script src="/app.js"></script>ANTHIAS GUI</html>',{'Content-Type':'text/html'})
 def do_POST(self):
  raw=self.rfile.read(int(self.headers.get('Content-Length',0)));return self.answer(200,raw,{'Content-Type':'application/octet-stream'})
@unittest.skipUnless(shutil.which('nginx'),'Nginx unavailable locally; executed by GitHub Actions')
class Nginx(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.tmp=tempfile.TemporaryDirectory();cls.root=Path(cls.tmp.name);cls.backend=port();cls.main=port();cls.router=port();cls.processes=[]
  cls.player=ThreadingHTTPServer(('127.0.0.1',0),Gui);threading.Thread(target=cls.player.serve_forever,daemon=True).start()
  settings={'tunnel':'10.77.0.0/24','bootstrap':'test-setup-key','endpoint':'127.0.0.1','serverAddress':'10.77.0.1/24','routerAddress':'10.77.0.2/32'}
  (cls.root/'settings.json').write_text(json.dumps(settings));cls.log=(cls.root/'backend.log').open('w+')
  cls.processes.append(subprocess.Popen([sys.executable,str(ROOT/'server.py')],env={**os.environ,'AR_TEST':'1','AR_DATA':str(cls.root/'data'),'AR_SETTINGS':str(cls.root/'settings.json'),'AR_PORT':str(cls.backend)},stdout=cls.log,stderr=cls.log))
  subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',str(cls.root/'tls.key'),'-out',str(cls.root/'tls.crt'),'-subj','/CN=127.0.0.1'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  spec=importlib.util.spec_from_file_location('nginx_config',ROOT/'nginx-config.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  conf=module.render(settings,str(cls.root)).replace('listen 443 ssl;',f'listen {cls.main} ssl;').replace('listen 8443 ssl;',f'listen {cls.router} ssl;').replace('listen 80;',f'listen {port()};').replace('127.0.0.1:8787',f'127.0.0.1:{cls.backend}').replace('return 302 https://$host/;',f'return 302 https://$host:{cls.main}/;')
  conf='worker_processes 1; daemon off; pid '+str(cls.root/'nginx.pid')+'; error_log '+str(cls.root/'nginx.log')+'; events {worker_connections 1024;} http {access_log off; client_body_temp_path '+str(cls.root/'client_temp')+'; proxy_temp_path '+str(cls.root/'proxy_temp')+'; '+conf+'}'
  (cls.root/'nginx.conf').write_text(conf)
  subprocess.run(['nginx','-p',str(cls.root)+'/', '-c',str(cls.root/'nginx.conf'),'-t'],check=True)
  cls.processes.append(subprocess.Popen(['nginx','-p',str(cls.root)+'/', '-c',str(cls.root/'nginx.conf')],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
  cls.jar=http.cookiejar.CookieJar();cls.op=build_opener(HTTPCookieProcessor(cls.jar),HTTPSHandler(context=ssl._create_unverified_context()),NoRedirect());cls.anon=build_opener(HTTPSHandler(context=ssl._create_unverified_context()),NoRedirect());cls.token='';cls.client='12345678-1234-1234-1234-123456789012'
  for _ in range(100):
   try:cls.request(cls.main,'/health');break
   except OSError:time.sleep(.05)
  else:raise RuntimeError('Nginx/backend did not start')
  _,raw,_=cls.request(cls.main,'/ar/auth/password',{'password':'Password123','confirmation':'Password123','bootstrap':'test-setup-key'});cls.token=json.loads(raw)['tabToken']
  cls.request(cls.main,'/ar/remote',{'subnet':'192.168.10.0/24'})
  cls.request(cls.main,'/ar/locks',{'name':'hmr-config-v3','action':'acquire'})
  cls.config={'schema':4,'rooms':[{'id':'gui-test','base':f'http://127.0.0.1:{cls.player.server_port}'}]}
  cls.request(cls.main,'/ar/storage/set',{'items':{'hmrConfig':cls.config}});cls.request(cls.main,'/ar/locks',{'name':'hmr-config-v3','action':'release'})
  _,raw,_=cls.request(cls.main,'/ar/player-access?id=gui-test');cls.gui=json.loads(raw)['port']
 @classmethod
 def tearDownClass(cls):
  for p in reversed(cls.processes):p.terminate();p.wait(timeout=5)
  cls.player.shutdown();cls.player.server_close();cls.log.close();cls.tmp.cleanup()
 @classmethod
 def request(cls,port,path,body=None,op=None,headers=None):
  raw=json.dumps(body).encode() if isinstance(body,dict) else body
  h={'X-AR-Tab':cls.token,'X-AR-Client':cls.client,**({'Content-Type':'application/json'} if isinstance(body,dict) else {}),**(headers or {})}
  req=Request(f'https://127.0.0.1:{port}'+path,data=raw,headers=h)
  try:r=(op or cls.op).open(req,timeout=5)
  except HTTPError as e:r=e
  return r.code,r.read(),r.headers
 def test_01_cookie_cannot_reopen_panel(self):self.assertFalse(json.loads(self.request(self.main,'/ar/auth/status',headers={'X-AR-Tab':''})[1])['authenticated'])
 def test_02_gui_requires_login(self):self.assertEqual(self.request(self.gui,'/',op=self.anon)[0],302)
 def test_03_gui_html_and_absolute_asset_paths(self):
  self.assertIn(b'ANTHIAS GUI',self.request(self.gui,'/')[1]);self.assertIn(b'GUI_LOADED',self.request(self.gui,'/app.js')[1])
  self.assertTrue(all('ar_session' not in cookie for cookie in Gui.cookies))
 def test_04_native_redirect_rewritten_to_https_port(self):
  code,_,headers=self.request(self.gui,'/redirect');self.assertEqual(code,302);self.assertEqual(headers['Location'],f'https://127.0.0.1:{self.gui}/dashboard')
 def test_05_native_upload_forwarded(self):
  payload=b'file-data'*1024;code,raw,_=self.request(self.gui,'/upload',payload);self.assertEqual(code,200);self.assertEqual(raw,payload)
 def test_06_websocket_upgrade(self):
  code,_,_=self.request(self.gui,'/ws',headers={'Upgrade':'websocket','Connection':'Upgrade'});self.assertEqual(code,101)
 def test_07_removal_revokes_existing_port(self):
  self.request(self.main,'/ar/locks',{'name':'hmr-config-v3','action':'acquire'});self.request(self.main,'/ar/storage/set',{'items':{'hmrConfig':{'schema':4,'rooms':[]}}});self.request(self.main,'/ar/locks',{'name':'hmr-config-v3','action':'release'})
  self.assertEqual(self.request(self.gui,'/')[0],403)
@unittest.skipUnless(shutil.which('nginx'),'Nginx unavailable locally; executed by GitHub Actions')
class Removal(unittest.TestCase):
 def test_remove_all_closes_open_connection_removes_cache_and_allows_reinstall(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);shared=port();real_nginx=shutil.which('nginx');bin=root/'bin';bin.mkdir()
   for name in ['opt/anthias-rooms','etc/anthias-rooms','var/lib/anthias-rooms/thumbnails','etc/nginx/sites-enabled','etc/nginx/sites-available']:(root/name).mkdir(parents=True)
   (root/'etc/anthias-rooms/owned-by-installer').touch()
   (root/'var/lib/anthias-rooms/thumbnails/cached.jpg').write_bytes(b'test cache')
   (root/'var/lib/anthias-rooms-packages.json').write_text('{"version":1,"packages":[]}')
   site=root/'etc/nginx/sites-available/anthias-rooms';site.write_text('server {listen 8444; return 200 "player";}')
   (root/'etc/nginx/sites-enabled/anthias-rooms').symlink_to(site)
   conf=root/'nginx.conf';conf.write_text(f'worker_processes 1; pid {root}/nginx.pid; error_log {root}/nginx.log; events {{worker_connections 64;}} http {{access_log off; server {{listen 127.0.0.1:{shared}; return 200 "shared";}} include {root}/etc/nginx/sites-enabled/*;}}')
   wrapper=bin/'nginx';wrapper.write_text('#!/bin/sh\nexec '+real_nginx+' -p "$TEST_NGINX_ROOT/" -c "$TEST_NGINX_ROOT/nginx.conf" "$@"\n');wrapper.chmod(0o755)
   control=bin/'systemctl';control.write_text("""#!/bin/bash
if [[ "$1" == restart && "$2" == nginx ]]; then
 nginx -s stop
 for attempt in {1..100}; do
  [[ -z $(ss -H -ltn "sport = :$TEST_SHARED_PORT") ]] && break
  sleep .05
 done
 nginx
fi
exit 0
""");control.chmod(0o755)
   for name in ['nft','id','ip']:
    f=bin/name;f.write_text('#!/bin/sh\nexit 1\n');f.chmod(0o755)
   env={**os.environ,'PATH':str(bin)+':'+os.environ['PATH'],'TEST_NGINX_ROOT':d,'TEST_SHARED_PORT':str(shared)}
   subprocess.run([str(wrapper)],env=env,check=True)
   connection=None
   try:
    for _ in range(100):
     try:connection=socket.create_connection(('127.0.0.1',8444),timeout=2);break
     except OSError:time.sleep(.05)
    self.assertIsNotNone(connection)
    connection.sendall(b'GET / HTTP/1.1\r\nHost: localhost\r\n')
    source=(ROOT/'install.sh').read_text();check=source.split("<<'PYPORTS'\n",1)[1].split('\nPYPORTS',1)[0]
    occupied=subprocess.run([sys.executable,'-c',check],capture_output=True,text=True);self.assertNotEqual(occupied.returncode,0);self.assertIn('8444',occupied.stderr)
    block=source[source.index('remove_all(){'):source.index('\ntrap ')]
    for prefix in ['/etc/','/root/']:block=block.replace(prefix,str(root)+prefix)
    script='set -Eeuo pipefail\nheading(){ :; }; step(){ :; }; fail(){ echo "$*"; exit 1; }\nAPP="$1/opt/anthias-rooms"; ETC="$1/etc/anthias-rooms"; DATA="$1/var/lib/anthias-rooms"; PACKAGES="$1/var/lib/anthias-rooms-packages.json"; SCRIPT_DIR="$2"\n'+block+'\nremove_all\n'
    result=subprocess.run(['bash','-c',script,'bash',d,str(ROOT)],input='REMOVE ALL\n',text=True,capture_output=True,env=env,timeout=20)
    self.assertEqual(result.returncode,0,result.stdout+result.stderr)
    try:self.assertEqual(connection.recv(1),b'')
    except ConnectionResetError:pass
    self.assertFalse((root/'var/lib/anthias-rooms').exists());self.assertFalse((root/'var/lib/anthias-rooms-packages.json').exists());self.assertFalse(site.exists())
    shared_connection=socket.create_connection(('127.0.0.1',shared),timeout=2);shared_connection.close()
    available=subprocess.run([sys.executable,'-c',check],capture_output=True,text=True);self.assertEqual(available.returncode,0,available.stderr)
   finally:
    if connection:connection.close()
    subprocess.run([str(wrapper),'-s','stop'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

if __name__=='__main__':unittest.main(verbosity=2)
