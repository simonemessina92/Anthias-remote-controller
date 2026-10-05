import importlib.util, ipaddress, json, os, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('wghelper',ROOT/'wg-helper.py');wg=importlib.util.module_from_spec(spec);spec.loader.exec_module(wg)
class WireGuard(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.etc=Path(self.tmp.name);wg.ETC=self.etc;wg.WG=self.etc/'arwg0.conf'
  (self.etc/'settings.json').write_text(json.dumps({'endpoint':'203.0.113.10','tunnel':'10.77.0.0/24','serverAddress':'10.77.0.1/24','routerAddress':'10.77.0.2/32'}))
  self.calls=[]
  def run(*args,input=None):
   self.calls.append(args)
   if args[:3]==('ip','-j','-4'):return '[]'
   if args[:3]==('wg','show','arwg0'):return 'PUBLICKEY\t0'
   if args[:2]==('wg','genkey'):return 'PRIVATE_KEY'
   if args[:2]==('wg','genpsk'):return 'PSK'
   if args[:2]==('wg','pubkey'):return 'PUBLIC_KEY'
   return ''
  self.mock=patch.object(wg,'run',side_effect=run);self.mock.start();self.addCleanup(self.mock.stop)
 def action(self,action,data=None):
  import io
  with patch('sys.argv',['wg-helper.py',action]),patch('sys.stdin',io.StringIO(json.dumps(data or {}))):return wg.main()
 def test_private_subnet_validated(self):self.assertEqual(wg.validate('192.168.10.113/24'),'192.168.10.0/24')
 def test_public_and_large_subnet_rejected(self):
  for n in ['8.8.8.0/24','10.1.0.0/16','127.0.0.0/24']:
   with self.assertRaises(ValueError):wg.validate(n)
 def test_overlap_tunnel_rejected(self):
  with self.assertRaises(ValueError):wg.validate('10.77.0.0/24')
 def test_server_configuration_routes_remote_lan(self):
  self.action('configure',{'subnet':'192.168.10.0/24'});s=wg.WG.read_text();self.assertIn('ListenPort = 443',s);self.assertIn('AllowedIPs = 10.77.0.2/32, 192.168.10.0/24',s)
 def test_profile_split_tunnel_and_keepalive(self):
  self.action('configure',{'subnet':'192.168.10.0/24'});s=self.action('profile')['profile'];self.assertIn('AllowedIPs = 10.77.0.1/32',s);self.assertNotIn('0.0.0.0/0',s);self.assertIn('PersistentKeepalive = 25',s);self.assertIn('Address = 10.77.0.2/32',s)
 def test_repeated_configuration_does_not_restart(self):
  self.action('configure',{'subnet':'192.168.10.0/24'});self.calls.clear();self.action('configure',{'subnet':'192.168.10.0/24'});self.assertNotIn(('systemctl','restart','wg-quick@arwg0'),self.calls)
 def test_keys_and_wireguard_configuration_private(self):
  self.action('init');self.assertEqual((wg.WG.stat().st_mode&0o777),0o600);self.assertEqual(((self.etc/'wg-keys.json').stat().st_mode&0o777),0o600)
 def test_old_keys_preserved(self):
  self.action('init');a=(self.etc/'wg-keys.json').read_bytes();self.action('configure',{'subnet':'192.168.10.0/24'});self.assertEqual(a,(self.etc/'wg-keys.json').read_bytes())
 def test_handshake_not_claimed_when_absent(self):self.assertFalse(self.action('status')['handshake'])
 def test_shell_injection_rejected(self):
  with self.assertRaises(ValueError):self.action('configure',{'subnet':'192.168.1.0/24; reboot'})
 def test_profile_before_configuration_rejected(self):
  with self.assertRaises(ValueError):self.action('profile')
if __name__=='__main__':unittest.main(verbosity=2)
