"""Real extension + VPS interfaces against the same synthetic Anthias player."""
import os,subprocess
from test_backend import Backend,ROOT
Backend.setUpClass()
try:
    from mock_player import asset
    Backend.player.assets={'h1':asset('h1','[HMR] Home - abcdef12 - home.png','home.png',True),'e1':asset('e1','[HMR] Event - abcdef13 - event.png','event.png',False)}
    c=Backend.call('/ar/storage/get',{'keys':'hmrConfig'})[1]['hmrConfig'];c.update(setupComplete=True,nextPlayerNumber=2,autoCleanup=False)
    c['rooms']=[{'id':'remote-room','number':1,'name':'Room','base':Backend.base,'identity':'mock-identity-1','playlists':{'home':[],'event':[]},'lastPublished':None,'homeHistory':[],'eventHistory':[],'uploadedIds':[],'managedEventIds':[],'cleanup':[]}]
    Backend().lock('hmr-config-v3')
    try:assert Backend.call('/ar/storage/set',{'items':{'hmrConfig':c}})[0]==200
    finally:Backend().lock('hmr-config-v3',action='release')
    subprocess.run(['node',str(ROOT/'tests/controller-sync.cjs')],env={**os.environ,'AR_BROWSER_URL':Backend.url,'AR_BROWSER_BASE':Backend.base},check=True)
finally:Backend.tearDownClass()
