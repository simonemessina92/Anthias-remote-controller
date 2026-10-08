"""Reproducible Chrome extension package; excludes tests and developer tooling."""
import hashlib,json,zipfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
version=json.loads((root/'extension/package.json').read_text())['version']
folder='Anthias_Rooms_Chrome_v'+version
out=root/'dist';out.mkdir(exist_ok=True)
asset=out/(folder+'.zip')
with zipfile.ZipFile(asset,'w',zipfile.ZIP_DEFLATED) as z:
 for f in sorted((root/'extension').rglob('*')):
  if not f.is_file() or '__pycache__' in f.parts:continue
  info=zipfile.ZipInfo(folder+'/'+f.relative_to(root/'extension').as_posix(),date_time=(2026,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644<<16;z.writestr(info,f.read_bytes())
(out/'SHA256SUMS').write_text(hashlib.sha256(asset.read_bytes()).hexdigest()+'  '+asset.name+'\n')
print(asset.name)
