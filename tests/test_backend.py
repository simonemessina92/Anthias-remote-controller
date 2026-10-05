import copy, http.cookiejar, json, os, socket, subprocess, sys, tempfile, threading, time, unittest
from pathlib import Path
from http.server import ThreadingHTTPServer
from urllib.request import Request,build_opener,HTTPCookieProcessor
from urllib.error import HTTPError
from urllib.parse import urlencode
from mock_player import Player
ROOT=Path(__file__).resolve().parents[1]

def port():
    with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]

class Backend(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory();d=Path(cls.tmp.name);cls.port=port();cls.url=f'http://127.0.0.1:{cls.port}'
        (d/'settings.json').write_text(json.dumps({'tunnel':'10.77.0.0/24','bootstrap':'test-setup-key','endpoint':'example.com','serverAddress':'10.77.0.1/24','routerAddress':'10.77.0.2/32'}))
        cls.log=(d/'server.log').open('w+')
        cls.process=subprocess.Popen([sys.executable,str(ROOT/'server.py')],env={**os.environ,'AR_TEST':'1','AR_DATA':str(d/'data'),'AR_SETTINGS':str(d/'settings.json'),'AR_PORT':str(cls.port)},stdout=cls.log,stderr=cls.log)
        cls.player=Player(1);cls.fake=ThreadingHTTPServer(('127.0.0.1',0),cls.player.handler());threading.Thread(target=cls.fake.serve_forever,daemon=True).start();cls.base=f'http://127.0.0.1:{cls.fake.server_port}'
        cls.client='12345678-1234-1234-1234-123456789012';cls.other='12345678-1234-1234-1234-123456789013'
        cls.tokens={}
        cls.a=build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()));cls.b=build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()));cls.anon=build_opener()
        for _ in range(100):
            try:cls.call('/health',opener=cls.anon);break
            except OSError:time.sleep(.05)
        else:raise RuntimeError('Server did not start')
        code,_=cls.call('/ar/auth/password',{'password':'Password123','confirmation':'Password123','bootstrap':'wrong'},opener=cls.anon);assert code==403
        code,_=cls.call('/ar/auth/password',{'password':'Password123','confirmation':'Password123','bootstrap':'test-setup-key'},opener=cls.a);assert code==200
        cls.call('/ar/auth/login',{'password':'Password123'},opener=cls.b)
        cls.call('/ar/remote',{'subnet':'192.168.10.0/24'},opener=cls.a)
    @classmethod
    def tearDownClass(cls):cls.process.terminate();cls.process.wait(timeout=5);cls.fake.shutdown();cls.fake.server_close();cls.log.close();cls.tmp.cleanup()
    @classmethod
    def call(cls,path,body=None,opener=None,method=None,client=None,headers=None):
        raw=json.dumps(body).encode() if body is not None else None
        opener=opener or cls.a
        h={'X-AR-Tab':cls.tokens.get(opener,''),'X-AR-Client':client or cls.client,**({'Content-Type':'application/json'} if raw is not None else {}),**(headers or {})}
        req=Request(cls.url+path,data=raw,headers=h,method=method or ('POST' if body is not None else 'GET'))
        try:r=(opener or cls.a).open(req,timeout=5)
        except HTTPError as e:r=e
        content=r.read()
        try:content=json.loads(content)
        except (ValueError,UnicodeDecodeError):pass
        if isinstance(content,dict) and content.get('tabToken'):cls.tokens[opener]=content['tabToken']
        return r.code,content
    def proxy(self,path,body=None,**kw):return self.call('/ar/proxy?'+urlencode({'base':self.base,'path':path}),body,**kw)
    def lock(self,name='hmr-player-v3:',action='acquire',**kw):return self.call('/ar/locks',{'name':name+self.base if name.endswith(':') else name,'action':action},**kw)
    def test_31_router_proxy_auth(self):
        self.assertEqual(self.call('/ar/router-auth',opener=self.anon)[0],401)
        self.assertEqual(self.call('/ar/router-auth')[0],200)
    def test_32_network_diagnostics_authenticated(self):
        self.assertEqual(self.call('/ar/network',opener=self.anon)[0],401)
        code,info=self.call('/ar/network');self.assertEqual(code,200)
        self.assertTrue(info['handshake']);self.assertEqual(info['route']['dev'],'arwg0')
        self.assertEqual(info['routerIp'],'10.77.0.2')
    def test_33_scan_runs_on_backend(self):
        code,data=self.call('/ar/scan',{'targets':[self.base]});self.assertEqual(code,200)
        for _ in range(50):
            code,state=self.call('/ar/scan?id='+data['id'])
            if state['done']:break
            time.sleep(.02)
        self.assertTrue(state['done']);self.assertEqual(state['checked'],1)
        self.assertEqual(state['results'][0]['base'],self.base)
        self.assertIn('anthias_version',state['results'][0]['info'])
        self.assertEqual(self.call('/ar/scan?id='+data['id'],opener=self.b,client=self.other)[0],404)
    def test_34_scan_target_restrictions(self):
        self.assertEqual(self.call('/ar/scan',{'targets':['http://8.8.8.8']})[0],400)
        self.assertEqual(self.call('/ar/scan',{'targets':[]})[0],400)
        self.assertEqual(self.call('/ar/scan',{'targets':[self.base,self.base]})[0],400)
        self.assertEqual(self.call('/ar/scan',{'targets':[self.base]},opener=self.anon)[0],401)
    def test_35_scan_reports_connection_errors(self):
        bad=f'http://127.0.0.1:{port()}'
        code,data=self.call('/ar/scan',{'targets':[bad]});self.assertEqual(code,200)
        for _ in range(50):
            _,state=self.call('/ar/scan?id='+data['id'])
            if state['done']:break
            time.sleep(.02)
        self.assertTrue(state['done']);self.assertEqual(state['unresolved'],[bad])
        self.assertEqual(sum(state['errors'].values()),1)
    def save_config(self,c):
        self.lock('hmr-config-v3')
        try:return self.call('/ar/storage/set',{'items':{'hmrConfig':c}})
        finally:self.lock('hmr-config-v3',action='release')
    def test_36_player_access_lifecycle(self):
        original=copy.deepcopy(self.call('/ar/storage/get',{'keys':'hmrConfig'})[1]['hmrConfig'])
        c=copy.deepcopy(original);c['rooms']=[{'id':'first','base':self.base,'name':'First'},{'id':'second','base':'http://192.168.10.123','name':'Second'}]
        try:
            self.assertEqual(self.save_config(c)[0],200)
            first=self.call('/ar/player-access?id=first')[1]['port'];second=self.call('/ar/player-access?id=second')[1]['port']
            self.assertNotEqual(first,second);self.assertTrue(8444<=first<=8543)
            self.assertEqual(self.call('/ar/player-access?id=first',opener=self.anon)[0],401)
            self.assertEqual(self.call('/ar/player-auth',headers={'X-AR-Gui-Port':str(first)},opener=self.anon)[0],401)
            self.assertEqual(self.call('/ar/player-auth',headers={'X-AR-Gui-Port':str(first)})[0],200)
            c['rooms'][0]['name']='Renamed';c['rooms'][0]['base']='http://192.168.10.124';c['rooms'].reverse()
            self.assertEqual(self.save_config(c)[0],200)
            self.assertEqual(self.call('/ar/player-access?id=first')[1],{'port':first,'base':'http://192.168.10.124'})
            c['rooms']=[r for r in c['rooms'] if r['id']!='first'];self.save_config(c)
            self.assertEqual(self.call('/ar/player-access?id=first')[0],404)
            self.assertEqual(self.call('/ar/player-auth',headers={'X-AR-Gui-Port':str(first)})[0],403)
            self.assertEqual(self.call('/ar/player-access?id=second')[1]['port'],second)
        finally:self.save_config(original)
    def test_37_player_access_config_atomic_validation(self):
        original=copy.deepcopy(self.call('/ar/storage/get',{'keys':'hmrConfig'})[1]['hmrConfig'])
        for rooms in [[{'id':'duplicate','base':self.base},{'id':'duplicate','base':'http://192.168.10.124'}],[{'id':'a','base':self.base},{'id':'b','base':self.base}],[{'id':'a','base':'http://8.8.8.8'}]]:
            c=copy.deepcopy(original);c['rooms']=rooms;self.assertEqual(self.save_config(c)[0],400)
            self.assertEqual(self.call('/ar/storage/get',{'keys':'hmrConfig'})[1]['hmrConfig'],original)
    def test_38_player_auth_headers_do_not_forward_cloud_cookie(self):
        original=copy.deepcopy(self.call('/ar/storage/get',{'keys':'hmrConfig'})[1]['hmrConfig']);c=copy.deepcopy(original);c['rooms']=[{'id':'header-test','base':self.base}]
        try:
            self.save_config(c);port=self.call('/ar/player-access?id=header-test')[1]['port']
            req=Request(self.url+'/ar/player-auth',headers={'X-AR-Gui-Port':str(port),'X-AR-Client':self.client,'X-AR-Tab':self.tokens[self.a]})
            response=self.a.open(req,timeout=5)
            self.assertEqual(response.headers['X-AR-Upstream'],self.base)
            self.assertNotIn('ar_session',response.headers.get('X-AR-Upstream-Cookie',''))
        finally:self.save_config(original)
    def test_39_player_access_import_and_remove_all_records(self):
        original=copy.deepcopy(self.call('/ar/storage/get',{'keys':'hmrConfig'})[1]['hmrConfig']);c=copy.deepcopy(original)
        c['rooms']=[{'id':f'p{i}','base':f'http://192.168.10.{i+1}'} for i in range(100)]
        try:
            self.assertEqual(self.save_config(c)[0],200)
            ports=[self.call('/ar/player-access?id='+r['id'])[1]['port'] for r in c['rooms']]
            self.assertEqual(len(set(ports)),100);self.assertEqual(set(ports),set(range(8444,8544)))
            self.save_config(original)
            for r in c['rooms']:self.assertEqual(self.call('/ar/player-access?id='+r['id'])[0],404)
        finally:self.save_config(original)
    def test_40_cookie_alone_never_authenticates_panel(self):
        self.assertFalse(self.call('/ar/auth/status',headers={'X-AR-Tab':''})[1]['authenticated'])
        self.assertEqual(self.call('/ar/remote',headers={'X-AR-Tab':''})[0],401)
        self.assertEqual(self.proxy('/api/v2/info',headers={'X-AR-Tab':''})[0],401)
        self.assertTrue(self.call('/ar/auth/status')[1]['authenticated'])
    def test_41_logout_revokes_tab_token_and_gui(self):
        op=build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.call('/ar/auth/login',{'password':'Password123'},opener=op)
        tok=self.tokens[op];self.assertTrue(self.call('/ar/auth/status',opener=op)[1]['authenticated'])
        self.call('/ar/auth/logout',{},opener=op)
        self.assertFalse(self.call('/ar/auth/status',opener=op,headers={'X-AR-Tab':tok})[1]['authenticated'])
        self.assertEqual(self.call('/ar/router-auth',opener=op)[0],401)
        self.assertTrue(self.call('/ar/auth/status')[1]['authenticated'])
    def test_42_tab_credential_is_not_replaced_by_another_login(self):
        tok=self.tokens[self.a]
        op=build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.call('/ar/auth/login',{'password':'Password123'},opener=op)
        self.assertNotEqual(tok,self.tokens[op])
        self.assertTrue(self.call('/ar/auth/status',headers={'X-AR-Tab':tok})[1]['authenticated'])
    def test_01_anonymous_cannot_read_remote(self):self.assertEqual(self.call('/ar/remote',opener=self.anon)[0],401)
    def test_02_anonymous_cannot_read_saved_config(self):self.assertEqual(self.call('/ar/storage/get',{'keys':'hmrConfig'},opener=self.anon)[1]['hmrConfig']['rooms'],[])
    def test_03_anonymous_cannot_proxy(self):self.assertEqual(self.proxy('/api/v2/info',opener=self.anon)[0],401)
    def test_04_cross_origin_rejected(self):self.assertEqual(self.call('/ar/remote',headers={'Origin':'https://evil.example'})[0],400)
    def test_05_remote_subnet_private(self):self.assertEqual(self.call('/ar/remote',{'subnet':'8.8.8.0/24'})[0],400)
    def test_06_remote_tunnel_overlap(self):self.assertEqual(self.call('/ar/remote',{'subnet':'10.77.0.0/24'})[0],400)
    def test_07_remote_size_bound(self):self.assertEqual(self.call('/ar/remote',{'subnet':'10.1.0.0/16'})[0],400)
    def test_08_profile_requires_login(self):self.assertEqual(self.call('/ar/remote/profile',opener=self.anon)[0],401)
    def test_09_profile_authenticated(self):self.assertIn('[Interface]',self.call('/ar/remote/profile')[1]['profile'])
    def test_10_info_through_backend(self):self.assertIn('anthias_version',self.proxy('/api/v2/info')[1])
    def test_11_outside_subnet_rejected(self):self.assertEqual(self.call('/ar/proxy?'+urlencode({'base':'http://169.254.169.254','path':'/api/v2/info'}))[0],400)
    def test_12_hostname_rejected(self):self.assertEqual(self.call('/ar/proxy?'+urlencode({'base':'http://localhost','path':'/api/v2/info'}))[0],400)
    def test_13_unsupported_api_rejected(self):self.assertEqual(self.proxy('/api/v2/shell')[0],400)
    def test_14_path_traversal_rejected(self):self.assertEqual(self.proxy('/api/v2/assets/../../etc/passwd')[0],400)
    def test_15_player_write_requires_lock(self):self.assertEqual(self.proxy('/api/v2/assets/h1',{'duration':30},method='PATCH')[0],409)
    def test_16_show_get_requires_lock(self):self.assertEqual(self.proxy('/api/v2/assets/control/asset&h1')[0],409)
    def test_17_locks_coordinate_independent_sessions(self):
        self.assertTrue(self.lock()[1]['acquired']);self.assertFalse(self.lock(opener=self.b,client=self.other)[1]['acquired']);self.lock(action='release')
    def test_18_other_session_cannot_release_lock(self):
        self.lock();self.lock(action='release',opener=self.b,client=self.other);self.assertFalse(self.lock(opener=self.b,client=self.other)[1]['acquired']);self.lock(action='release')
    def test_19_locked_patch_and_order_reach_player(self):
        self.lock()
        try:
            self.assertEqual(self.proxy('/api/v2/assets/h1',{'duration':23},method='PATCH')[0],200)
            self.assertEqual(self.proxy('/api/v2/assets/order',{'ids':'e1,h1'})[0],204)
            self.assertEqual(self.player.assets['h1']['duration'],23)
        finally:self.lock(action='release')
    def test_20_video_preview_bytes_proxy(self):self.assertGreater(len(self.proxy('/assets/v1/preview/')[1]),100)
    def test_21_config_requires_lock(self):self.assertEqual(self.call('/ar/storage/set',{'items':{'hmrConfig':self.call('/ar/storage/get',{'keys':'hmrConfig'})[1]['hmrConfig']}})[0],409)
    def test_22_config_shared_persistent(self):
        self.lock('hmr-config-v3')
        try:
            c=self.call('/ar/storage/get',{'keys':'hmrConfig'})[1]['hmrConfig'];c['language']='it'
            self.assertEqual(self.call('/ar/storage/set',{'items':{'hmrConfig':c}})[0],200)
            self.assertEqual(self.call('/ar/storage/get',{'keys':'hmrConfig'},opener=self.b)[1]['hmrConfig']['language'],'it')
        finally:self.lock('hmr-config-v3',action='release')
    def test_23_auth_secrets_not_in_diagnostics_storage(self):
        data=self.call('/ar/storage/get',{'keys':None})[1];self.assertNotIn('auth',data);self.assertNotIn('hmrAuthV4',data)
    def test_24_password_change_requires_current(self):self.assertEqual(self.call('/ar/auth/password',{'password':'OtherPassword123','confirmation':'OtherPassword123','current':'bad'})[0],400)
    def test_25_multipart_upload_streams(self):
        self.lock()
        try:
            boundary='ar-test-boundary';raw=(f'--{boundary}\r\nContent-Disposition: form-data; name="file_upload"; filename="test.png"\r\nContent-Type: image/png\r\n\r\n').encode()+b'IMAGE_BYTES'+f'\r\n--{boundary}--\r\n'.encode()
            req=Request(self.url+'/ar/proxy?'+urlencode({'base':self.base,'path':'/api/v2/file_asset'}),data=raw,headers={'Content-Type':f'multipart/form-data; boundary={boundary}','X-AR-Client':self.client,'X-AR-Tab':self.tokens[self.a]})
            data=json.load(self.a.open(req,timeout=5));self.assertEqual(data['ext'],'.png');self.assertIn(b'IMAGE_BYTES',self.player.data.values())
        finally:self.lock(action='release')
    def test_26_cookie_is_http_only(self):
        jar=http.cookiejar.CookieJar();op=build_opener(HTTPCookieProcessor(jar));self.call('/ar/auth/login',{'password':'Password123'},opener=op)
        self.assertTrue(any('HttpOnly' in c._rest and c._rest.get('SameSite')=='Strict' for c in jar))
    def test_27_static_page_and_modules(self):
        code,html=self.call('/');self.assertEqual(code,200);self.assertIn(b'VPS v0.1.0-dev4',html)
        self.assertEqual(self.call('/vps-adapter.js')[0],200)
    def test_28_storage_arbitrary_key_rejected(self):self.assertEqual(self.call('/ar/storage/set',{'items':{'auth':{'enabled':False}}})[0],400)
    def test_29_reboot_with_lock(self):
        self.lock()
        try:self.assertEqual(self.proxy('/api/v2/reboot',{},method='POST')[0],200)
        finally:self.lock(action='release');self.player.offlineUntil=0
    def test_30_sessions_independent_logout(self):
        jar=http.cookiejar.CookieJar();op=build_opener(HTTPCookieProcessor(jar));self.call('/ar/auth/login',{'password':'Password123'},opener=op)
        self.call('/ar/auth/logout',{},opener=op);self.assertFalse(self.call('/ar/auth/status',opener=op)[1]['authenticated']);self.assertTrue(self.call('/ar/auth/status',opener=self.a)[1]['authenticated'])

if __name__=='__main__':unittest.main(verbosity=2)
