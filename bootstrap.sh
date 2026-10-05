#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
VERSION=1.0.1-dev1
REPO=simonemessina92/Anthias-remote-controller
[[ $EUID == 0 ]] || { echo 'Run this command as root on the VPS.' >&2; exit 1; }
# Existing managed installs can be removed offline using this same local menu.
if [[ -f /etc/anthias-rooms/owned-by-installer && -f /opt/anthias-rooms/install.sh ]]; then
  bash /opt/anthias-rooms/install.sh
  exit
fi
command -v curl >/dev/null || { echo 'Install curl before running the bootstrap.' >&2; exit 1; }
if ! command -v python3 >/dev/null; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y python3
fi
work=$(mktemp -d /tmp/anthias-remote.XXXXXXXX)
cleanup(){ rm -rf -- "$work"; }
trap cleanup EXIT
asset="Anthias_Rooms_VPS_v${VERSION}.zip"
base="https://github.com/${REPO}/releases/download/v${VERSION}"
printf '\n  Anthias Remote Controller — %s\n  Download package and verify SHA-256…\n\n' "$VERSION"
fetch(){ curl --fail --show-error --silent --location --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 180 --retry 3 "$1" -o "$2"; }
fetch "$base/$asset" "$work/$asset"
fetch "$base/SHA256SUMS" "$work/SHA256SUMS"
python3 - "$work" "$asset" <<'PY'
import hashlib,stat,sys,zipfile
from pathlib import Path,PurePosixPath
work=Path(sys.argv[1]);asset=sys.argv[2];lines=(work/'SHA256SUMS').read_text().splitlines()
expected=[line.split()[0] for line in lines if len(line.split())==2 and line.split()[1]==asset]
if len(expected)!=1 or hashlib.sha256((work/asset).read_bytes()).hexdigest()!=expected[0]:raise SystemExit('ERROR: invalid package checksum. No installer was executed.')
root=asset.removesuffix('.zip')
with zipfile.ZipFile(work/asset) as archive:
 total=0
 for entry in archive.infolist():
  path=PurePosixPath(entry.filename);total+=entry.file_size
  if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0]!=root or '\\' in entry.filename or stat.S_ISLNK(entry.external_attr>>16) or total>128*1024*1024:raise SystemExit('ERROR: invalid ZIP contents.')
 archive.extractall(work)
if not (work/root/'install.sh').is_file():raise SystemExit('ERROR: installer missing from package.')
PY
bash "$work/${asset%.zip}/install.sh"
# EXIT also removes the downloaded ZIP and extracted sources after Install/Remove.
