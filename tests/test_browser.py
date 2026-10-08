"""Desktop/mobile regression checks against the real backend and a synthetic player."""
import json,os,subprocess,tempfile
from pathlib import Path
from test_backend import Backend,ROOT
Backend.setUpClass()
try:
    with tempfile.TemporaryDirectory() as d:
        video=Path(d)/'generated.mp4'
        subprocess.run(['ffmpeg','-nostdin','-v','error','-f','lavfi','-i','color=c=purple:s=160x90:d=1','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-movflags','+faststart',str(video)],check=True)
        Backend.player.data['event.mp4']=video.read_bytes()
        c=Backend.call('/ar/storage/get',{'keys':'hmrConfig'})[1]['hmrConfig'];c.update(setupComplete=True,nextPlayerNumber=2)
        c['rooms']=[{'id':'browser-player','number':1,'name':'Room 1','base':Backend.base,'identity':'mock-identity-1','playlists':{'home':[{'id':'h1','duration':15}],'event':[{'id':'v1','duration':1}]},'lastPublished':None,'homeHistory':[],'eventHistory':[],'uploadedIds':[],'managedEventIds':[],'cleanup':[]}]
        Backend().lock('hmr-config-v3')
        try:assert Backend.call('/ar/storage/set',{'items':{'hmrConfig':c}})[0]==200
        finally:Backend().lock('hmr-config-v3',action='release')
        subprocess.run(['node',str(ROOT/'tests/browser.cjs')],env={**os.environ,'AR_BROWSER_URL':Backend.url,'AR_BROWSER_BASE':Backend.base},check=True)
finally:Backend.tearDownClass()
