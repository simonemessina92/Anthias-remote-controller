#!/usr/bin/env python3
"""Build reproducible ZIP and release checksums from source; never include runtime credentials."""
import hashlib,json,shutil,sys,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
version=json.loads((ROOT/'package.json').read_text())['version']
if f'VERSION={version}\n' not in (ROOT/'bootstrap.sh').read_text():raise SystemExit('bootstrap version mismatch')
folder='Anthias_Rooms_VPS_v'+version
out=ROOT/'dist';out.mkdir(exist_ok=True)
# Keep dist limited to this version; never upload stale release assets.
for old in out.glob('Anthias_Rooms_VPS_v*.zip'):old.unlink()
files=[]
for f in ROOT.rglob('*'):
 relative=f.relative_to(ROOT)
 if not f.is_file() or any(x in ('.git','.github','dist','__pycache__','node_modules','fixtures','results') for x in relative.parts) or f.name=='SHA256SUMS.txt':continue
 if f.suffix not in ('.py','.js','.mjs','.sh','.html','.css','.png','.json','.md','.txt','.mp4'):continue
 files.append(f)
files.sort()
manifest=''.join(hashlib.sha256(f.read_bytes()).hexdigest()+'  '+f.relative_to(ROOT).as_posix()+'\n' for f in files)
asset=out/(folder+'.zip')
with zipfile.ZipFile(asset,'w',zipfile.ZIP_DEFLATED) as z:
 for f in files:
  info=zipfile.ZipInfo(folder+'/'+f.relative_to(ROOT).as_posix(),date_time=(2026,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=(0o100755 if f.suffix=='.sh' else 0o100644)<<16
  z.writestr(info,f.read_bytes())
 info=zipfile.ZipInfo(folder+'/SHA256SUMS.txt',date_time=(2026,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644<<16;z.writestr(info,manifest)
shutil.copyfile(ROOT/'bootstrap.sh',out/'bootstrap.sh')
(out/'SHA256SUMS').write_text(''.join(hashlib.sha256(f.read_bytes()).hexdigest()+'  '+f.name+'\n' for f in (asset,out/'bootstrap.sh')))
print(asset.name)
