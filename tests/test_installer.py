"""Installer regressions in a disposable tree; no host service/firewall changes."""
import os, subprocess, tempfile, unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
SOURCE=(ROOT/'install.sh').read_text()
class Installer(unittest.TestCase):
    def test_service_group_permissions_with_restrictive_umask(self):
        if os.geteuid()!=0:self.skipTest('requires uid switch')
        with tempfile.TemporaryDirectory() as d:
            os.chmod(d,0o755)
            app=Path(d)/'app';app.mkdir()
            start=SOURCE.index('  cp "$SCRIPT_DIR/server.py"')
            end=SOURCE.index('  python3 - "$ETC/settings.json"',start)
            block=SOURCE[start:end].replace('root:anthias-rooms','root:root')
            subprocess.run(['bash','-c','set -e; umask 077; APP="$1"; SCRIPT_DIR="$2"; '+block,'bash',str(app),str(ROOT)],check=True)
            for f in app.rglob('*'):
                self.assertTrue(f.stat().st_mode & 0o040, str(f))
                if f.is_dir():self.assertTrue(f.stat().st_mode & 0o010, str(f))
            self.assertFalse((app/'server.py').stat().st_mode & 0o002)
    def test_remove_order_and_owned_paths(self):
        with tempfile.TemporaryDirectory() as d:
            tree=Path(d);log=tree/'events';bin=tree/'bin';bin.mkdir()
            for name,body in {'systemctl':'echo "$*" >> "$EVENTS"; exit 0','nginx':'exit 0','nft':'exit 1','id':'exit 1','ip':'exit 1'}.items():
                f=bin/name;f.write_text('#!/bin/sh\n'+body+'\n');f.chmod(0o755)
            paths=['opt/anthias-rooms','etc/anthias-rooms','var/lib/anthias-rooms']
            for name in paths:(tree/name).mkdir(parents=True)
            (tree/'etc/anthias-rooms/owned-by-installer').touch()
            (tree/'var/lib/anthias-rooms-packages.json').write_text('{"version":1,"packages":[]}')
            for name in ['etc/systemd/system/anthias-rooms.service','etc/systemd/system/anthias-rooms-firewall.service','etc/wireguard/arwg0.conf','etc/sudoers.d/anthias-rooms','etc/nginx/sites-enabled/anthias-rooms','etc/nginx/sites-available/anthias-rooms']:
                f=tree/name;f.parent.mkdir(parents=True,exist_ok=True);f.touch()
            start=SOURCE.index('remove_all(){');end=SOURCE.index('\ntrap ',start)
            block=SOURCE[start:end]
            for prefix in ['/etc/','/root/']:block=block.replace(prefix,str(tree)+prefix)
            script='set -Eeuo pipefail\nheading(){ :; }; step(){ :; }; fail(){ echo "$*"; exit 1; }\nAPP="$1/opt/anthias-rooms"; ETC="$1/etc/anthias-rooms"; DATA="$1/var/lib/anthias-rooms"; PACKAGES="$1/var/lib/anthias-rooms-packages.json"; SCRIPT_DIR="$2"\n'+block+'\nremove_all\n'
            r=subprocess.run(['bash','-c',script,'bash',d,str(ROOT)],input='REMOVE ALL\n',text=True,capture_output=True,env={**os.environ,'PATH':str(bin)+':'+os.environ['PATH'],'EVENTS':str(log)})
            self.assertEqual(r.returncode,0,r.stderr);self.assertIn('Anthias Rooms removed.',r.stdout)
            for name in paths:self.assertFalse((tree/name).exists())
            events=log.read_text().splitlines();self.assertIn('restart nginx',events);self.assertNotIn('reload nginx',events);self.assertLess(next(i for i,x in enumerate(events) if x.startswith('reset-failed')),next(i for i,x in enumerate(events) if x=='daemon-reload'))
if __name__=='__main__':unittest.main(verbosity=2)
