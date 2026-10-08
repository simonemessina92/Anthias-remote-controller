import test from 'node:test';
import assert from 'node:assert/strict';
import {networkSpec,scanTargets,prefixLength,prioritizeTargets,migrateDiscovery,SCAN_PROFILES,scanPlayers,probeInfo} from '../extension/discovery.js';
import {migrateConfig,defaultConfig,newRoom} from '../extension/storage.js';
import {editorSnapshot,editorHasChanges} from '../extension/editor-state.js';
import fs from 'node:fs';
const net = (address,subnet='24') => networkSpec({address,subnet});

test('v0.5 /24 scans usable hosts and accepts a host IP rather than network address',()=>{
 const spec=net('192.168.50.113');assert.equal(spec.cidr,'192.168.50.0/24');assert.equal(spec.count,254);
 const hosts=scanTargets(spec);assert.equal(hosts[0],'http://192.168.50.1');assert.equal(hosts.at(-1),'http://192.168.50.254');
});
test('v0.5 slash prefix and dotted mask describe the same subnet',()=>{
 assert.equal(net('192.168.50.113/24').cidr,net('192.168.50.113','255.255.255.0').cidr);
 assert.equal(prefixLength('/23'),23);assert.equal(prefixLength('255.255.252.0'),22);
});
test('v0.5 /31 and /32 retain endpoint addresses',()=>{
 assert.equal(net('192.168.50.113/31').count,2);assert.deepEqual(scanTargets(net('192.168.50.113/32')),['http://192.168.50.113']);
});
test('v0.5 public, malformed and oversized networks rejected before allocating targets',()=>{
 for(const address of ['8.8.8.8/24','192.168.1.1/21','192.168.1.1/0','1.2.3.4/33','192.168.1.1/','192.168.1.1/24/foo',''])assert.throws(()=>net(address));
 for(const mask of ['255.0.255.0','255.255.255.1','abc','-1','33'])assert.throws(()=>prefixLength(mask));
 assert.equal(net('10.1.2.9/22').count,1022);
});
test('v0.5 protocol/port validation and HTTPS origin normalization',()=>{
 assert.deepEqual(scanTargets({address:'192.168.1.2/32',protocol:'https',port:443}),['https://192.168.1.2']);
 assert.throws(()=>scanTargets({address:'192.168.1.1/32',protocol:'ftp'}));
});
test('v0.5 old range config migrates to containing CIDR without a prefilled lab IP',()=>{
 assert.deepEqual(migrateDiscovery({start:'192.168.50.2',end:'192.168.50.254',port:80,protocol:'http'}),{address:'192.168.50.2',subnet:'24',port:80,protocol:'http'});
 assert.equal(defaultConfig().discovery.address,'');
 const old=defaultConfig();old.discovery={start:'10.1.2.4',end:'10.1.3.250',port:80};old.rooms=[newRoom('Room','10.1.2.113')];
 const migrated=migrateConfig(old);assert.equal(migrated.discovery.subnet,'23');assert.deepEqual(migrated.rooms,old.rooms);
});
test('v0.5 known players are probed first only when inside the selected subnet',()=>{
 assert.deepEqual(prioritizeTargets(['a','b','c','d'],['c','x','c','b']),['c','b','a','d']);
});
test('v0.5 quick and thorough profiles are separate bounded operations',()=>{
 assert.equal(SCAN_PROFILES.quick.concurrency,48);assert.equal(SCAN_PROFILES.quick.timeout,1200);
 assert(SCAN_PROFILES.thorough.timeout>SCAN_PROFILES.quick.timeout);assert(SCAN_PROFILES.thorough.concurrency<=48);
});
test('v0.5 a result is delivered while other addresses are still pending',async()=>{
 let remaining=0,delivered=false,unfinishedAtDelivery=false;
 const out=await scanPlayers(['player','silent1','silent2'],{concurrency:3,probe:async base=>{
  remaining++;await new Promise(r=>setTimeout(r,base==='player'?5:40));remaining--;if(base!=='player')throw new Error('offline');return {base,identity:'',info:{}};
 },onResult:()=>{delivered=true;unfinishedAtDelivery=remaining>0;}});
 assert(delivered&&unfinishedAtDelivery);assert.equal(out.unresolved.length,2);
});
test('v0.5 cancellation aborts pending fetches and stops further launches',async()=>{
 const ctl=new AbortController();let count=0;
 const pending=scanPlayers(Array.from({length:254},(_,i)=>'host'+i),{signal:ctl.signal,concurrency:48,probe:async(base,{signal})=>{
  count++;await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true}));
 }});setTimeout(()=>ctl.abort(),10);const result=await pending;assert(result.stopped);assert.equal(count,48);
});
test('v0.5 definite non-player and access-denied responses do not enter slow retry queue',async()=>{
 const out=await scanPlayers(['printer','protected','offline'],{probe:async base=>{const e=new Error(base);if(base==='printer')e.status=422;if(base==='protected')e.status=403;throw e;}});
 assert.deepEqual(out.unresolved,['offline']);
});
test('v0.5 info probe rejects a printer JSON response',async()=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({version:'printer'}),{status:200});
 try{await assert.rejects(()=>probeInfo('http://192.168.1.3'),e=>e.status===422);}finally{globalThis.fetch=original;}
});
const items=()=>[{id:'image1',kind:'image',duration:15},{id:'video1',kind:'video',duration:50}];
const editor=()=>{const e={items:items()};e.baseline=editorSnapshot(e.items);return e;};
test('v0.5 opening a playlist is clean',()=>assert(!editorHasChanges(editor())));
test('v0.5 changing then restoring an image duration is clean',()=>{const e=editor();e.items[0].duration=20;assert(editorHasChanges(e));e.items[0].duration='15';assert(!editorHasChanges(e));});
test('v0.5 reorder and reverse reorder restore a clean editor',()=>{const e=editor();e.items.reverse();assert(editorHasChanges(e));e.items.reverse();assert(!editorHasChanges(e));});
test('v0.5 temporary upload progress and video metadata are not unsaved playlist changes',()=>{const e=editor();e.items[1].duration=0;e.items[0].is_processing=false;assert(!editorHasChanges(e));});
test('v0.5 adding and removing the same new file is clean',()=>{const e=editor();e.items.push({key:'file1',file:{name:'new.png'},kind:'image',duration:15});assert(editorHasChanges(e));e.items.pop();assert(!editorHasChanges(e));});
test('v0.5 two different local files with identical names remain different sources',()=>{const e={items:[{key:'a',file:{name:'file.mp4'},kind:'video'}]};e.baseline=editorSnapshot(e.items);e.items[0].key='b';assert(editorHasChanges(e));});
test('v0.5.1 restores Home picker but retains removed range fields and no permanent error strip',()=>{const html=fs.readFileSync(new URL('../extension/panel.html',import.meta.url),'utf8');for(const id of ['scan-start','scan-end','room-error'])assert(!html.includes(`id="${id}"`));for(const id of ['info-memory','editor-library','library-use','player-media','quick-reboot'])assert(html.includes(`id="${id}"`));});
