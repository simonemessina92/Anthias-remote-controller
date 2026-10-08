import os,subprocess,threading
from pathlib import Path
from http.server import ThreadingHTTPServer
from mock_player import Player,asset
p=Player(1);p.assets={'h1':asset('h1','[HMR] Home - abcdef12 - home.png','home.png',True),'e1':asset('e1','[HMR] Event - abcdef13 - event.png','event.png',False)}
server=ThreadingHTTPServer(('127.0.0.1',0),p.handler());threading.Thread(target=server.serve_forever,daemon=True).start()
try:
 subprocess.run(['node',str(Path(__file__).with_name('controller-sync.cjs'))],env={**os.environ,'AR_EXTENSION_DIR':str(Path(__file__).resolve().parents[1]/'extension'),'AR_BROWSER_BASE':f'http://127.0.0.1:{server.server_port}'},check=True)
finally:server.shutdown()
