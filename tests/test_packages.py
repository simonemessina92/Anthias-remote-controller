"""Package ownership, legacy recovery and purge boundaries without host mutations."""
import gzip,importlib.util,json,os,subprocess,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('ownership',ROOT/'package-ownership.py');ownership=importlib.util.module_from_spec(spec);spec.loader.exec_module(ownership)
class Packages(unittest.TestCase):
 def test_snapshot_records_only_added_packages_including_dependencies(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);before=root/'before';receipt=root/'receipt';before.write_text('python3:amd64\nopenssl:amd64\n')
   with patch.object(ownership,'packages',return_value={'python3:amd64','openssl:amd64','ffmpeg:amd64','libavcodec61:amd64'}):ownership.record(before,receipt)
   self.assertEqual(ownership.load(receipt)['packages'],['ffmpeg:amd64','libavcodec61:amd64']);self.assertEqual(receipt.stat().st_mode&0o777,0o600)
 def test_recovers_exact_legacy_installations_from_compressed_history(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);receipt=root/'receipt'
   history='Commandline: apt-get install -y python3 wireguard-tools nginx openssl sudo nftables iproute2 ffmpeg\nInstall: ffmpeg:amd64 (1), libavcodec61:amd64 (2, automatic)\n\nCommandline: apt-get install -y unrelated\nInstall: unrelated:amd64 (1)\n'
   with gzip.open(root/'history.log.1.gz','wt') as f:f.write(history)
   with patch.object(ownership,'packages',return_value={'ffmpeg:amd64','libavcodec61:amd64','unrelated:amd64'}):data=ownership.recover(receipt,root,strict=True)
   self.assertEqual(data['packages'],['ffmpeg:amd64','libavcodec61:amd64'])
 def test_missing_legacy_history_stops_without_creating_receipt(self):
  with tempfile.TemporaryDirectory() as d:
   receipt=Path(d)/'receipt'
   with self.assertRaisesRegex(ValueError,'nothing was removed'):ownership.recover(receipt,Path(d),strict=True)
   self.assertFalse(receipt.exists())
 def test_purge_refuses_removal_of_unowned_dependants(self):
  with tempfile.TemporaryDirectory() as d:
   receipt=Path(d)/'receipt';ownership.save(receipt,{'version':1,'packages':['ffmpeg:amd64']})
   with patch.object(ownership,'packages',return_value={'ffmpeg:amd64','other-service:amd64'}),patch.object(ownership.subprocess,'run',return_value=subprocess.CompletedProcess([],0,'Purg ffmpeg [1]\nRemv other-service [2]\n')) as run:
    with self.assertRaisesRegex(ValueError,'outside this installation'):ownership.purge(receipt)
    self.assertEqual(run.call_count,1);self.assertTrue(receipt.exists())
 def test_purges_owned_dependency_set_and_deletes_receipt(self):
  with tempfile.TemporaryDirectory() as d:
   receipt=Path(d)/'receipt';ownership.save(receipt,{'version':1,'packages':['ffmpeg:amd64','libavcodec61:amd64']})
   current={'python3:amd64','ffmpeg:amd64','libavcodec61:amd64'}
   def run(args,**kw):
    if '-s' not in args:current.difference_update({'ffmpeg:amd64','libavcodec61:amd64'})
    return subprocess.CompletedProcess(args,0,'Purg ffmpeg [1]\nPurg libavcodec61 [1]\n')
   with patch.object(ownership,'packages',side_effect=lambda:set(current)),patch.object(ownership.subprocess,'run',side_effect=run) as call:ownership.purge(receipt)
   self.assertFalse(receipt.exists());self.assertEqual(current,{'python3:amd64'});self.assertNotIn('--auto-remove',call.call_args.args[0])
 def test_failed_purge_keeps_receipt_for_retry(self):
  with tempfile.TemporaryDirectory() as d:
   receipt=Path(d)/'receipt';ownership.save(receipt,{'version':1,'packages':['ffmpeg:amd64']})
   with patch.object(ownership,'packages',return_value={'ffmpeg:amd64'}),patch.object(ownership.subprocess,'run',side_effect=[subprocess.CompletedProcess([],0,'Purg ffmpeg [1]\n'),subprocess.CalledProcessError(1,['apt-get'])]):
    with self.assertRaises(subprocess.CalledProcessError):ownership.purge(receipt)
   self.assertTrue(receipt.exists())
 @unittest.skipUnless(os.environ.get('AR_PACKAGE_INTEGRATION')=='1' and os.geteuid()==0,'real package integration runs in disposable release CI')
 def test_real_package_and_dependency_purge_removes_conffiles(self):
  names=['anthias-rooms-purge-fixture','anthias-rooms-purge-dependency']
  files=[Path('/etc/'+name+'.conf') for name in names]
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);before=root/'before';before.write_text('\n'.join(ownership.packages())+'\n');receipt=root/'receipt';archives=[]
   try:
    for name in reversed(names):
     tree=root/name;(tree/'DEBIAN').mkdir(parents=True);(tree/'etc').mkdir()
     dependency='Depends: '+names[1]+'\n' if name==names[0] else ''
     (tree/'DEBIAN/control').write_text(f'Package: {name}\nVersion: 1.0\nArchitecture: all\nMaintainer: Integration Test <test@example.invalid>\n{dependency}Description: disposable purge integration fixture\n')
     (tree/'DEBIAN/conffiles').write_text('/etc/'+name+'.conf\n');(tree/'etc'/files[names.index(name)].name).write_text('fixture configuration\n')
     archive=root/(name+'.deb');subprocess.run(['dpkg-deb','--build',str(tree),str(archive)],check=True,stdout=subprocess.DEVNULL);archives.append(str(archive))
    subprocess.run(['dpkg','-i',*archives],check=True,stdout=subprocess.DEVNULL)
    ownership.record(before,receipt);self.assertEqual({x.split(':')[0] for x in ownership.load(receipt)['packages']},set(names))
    self.assertTrue(all(x.exists() for x in files));ownership.purge(receipt)
    self.assertTrue(all(not x.exists() for x in files));self.assertFalse(receipt.exists())
   finally:subprocess.run(['dpkg','--purge',*names],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

if __name__=='__main__':unittest.main(verbosity=2)
