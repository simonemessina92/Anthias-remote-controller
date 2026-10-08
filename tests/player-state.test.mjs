import test from 'node:test';
import assert from 'node:assert/strict';
import {newRoom} from '../web/storage.js';
import {MANUAL_SCHEDULE} from '../web/logic.js';
import {mapPlaylist,publishRoom,cleanupRoom} from '../web/lifecycle.js';
import {STATE_URI,encodeState,decodeState,readState,reconcilePlayer,beginPlayerSession} from '../web/player-state.js';
const clone=x=>structuredClone(x);
const media=(id,role='Home',active=false,order=0)=>({asset_id:id,name:`[HMR] ${role} - abcdef12 - ${id}.png`,uri:'/data/'+id+'.png',mimetype:'image',duration:15,is_enabled:active,is_active:active,is_processing:false,is_reachable:true,play_order:order,...MANUAL_SCHEDULE});
function mock(list){
 const state={list:clone(list),settings:{shuffle_playlist:false},writes:[]};
 const make=()=>({base:'http://player',assets:async()=>clone(state.list),get:async id=>clone(state.list.find(a=>a.asset_id===id)),
  patch:async(id,body)=>{state.writes.push(['patch',id,clone(body)]);const a=state.list.find(a=>a.asset_id===id);assert(a);Object.assign(a,body);if(body.is_enabled!==undefined)a.is_active=body.is_enabled;return clone(a);},
  create:async body=>{state.writes.push(['create',clone(body)]);const a={asset_id:'state-'+(state.list.length+1),is_active:false,...clone(body)};state.list.push(a);return clone(a);},
  remove:async id=>{state.writes.push(['remove',id]);state.list=state.list.filter(a=>a.asset_id!==id);},
  settings:async()=>clone(state.settings),patchSettings:async b=>Object.assign(state.settings,b),
  order:async ids=>ids.forEach((id,i)=>{state.list.find(a=>a.asset_id===id).play_order=i;}),show:async()=>{}});
 return {state,make};
}
const begin=(api,r,opts={})=>beginPlayerSession(api,r,{delay:async()=>{},...opts});
async function edit(m,r,role,items,publish=false){
 const api=m.make(),session=await begin(api,r);const persist=()=>session.commit();
 try{await mapPlaylist(r,role,items,await api.assets(),persist);if(publish)await publishRoom(api,r,role,{persist,autoCleanup:false});await session.commit();}finally{await session.close();}
}
test('legacy single Home and Event are read without player writes or cleanup authority',()=>{
 const r=newRoom();reconcilePlayer(r,[media('h'),media('e','Event')]);assert.equal(r.playlists.home[0].id,'h');assert.equal(r.playlists.event[0].id,'e');assert.deepEqual(r.managedEventIds,[]);
});
test('ambiguous inactive legacy groups are not guessed',()=>{const r=newRoom();const x=reconcilePlayer(r,[media('h1'),media('h2')]);assert.equal(r.playlists.home.length,0);assert.match(x.warning,/Several/);});
test('legacy active ordered multi-file playlist can be recovered',()=>{const r=newRoom();reconcilePlayer(r,[media('h2','Home',true,1),media('h1','Home',true,0)]);assert.deepEqual(r.playlists.home.map(x=>x.id),['h1','h2']);});
test('local -> cloud -> local: staged roles, Home memory, event playback and restoration',async()=>{
 const m=mock([media('h'),media('e','Event'),media('h2','Other')]),local=newRoom(),cloud=newRoom();
 await edit(m,local,'home',[{id:'h',duration:20}],true);
 reconcilePlayer(cloud,m.state.list);assert.equal(cloud.playlists.home[0].duration,20);
 await edit(m,cloud,'event',[{id:'e',duration:11}],true);
 reconcilePlayer(local,m.state.list);assert.equal(local.lastPublished.role,'event');assert.equal(local.playlists.home[0].id,'h');
 await edit(m,local,'home',[{id:'h2',duration:27}]); // staged Home while event stays live
 reconcilePlayer(cloud,m.state.list);assert.equal(cloud.lastPublished.role,'event');assert.equal(cloud.playlists.home[0].id,'h2');assert.equal(m.state.list.find(a=>a.asset_id==='e').is_enabled,true);
 const api=m.make(),session=await begin(api,cloud);try{await publishRoom(api,cloud,'home',{persist:()=>session.commit(),autoCleanup:false});}finally{await session.close();}
 reconcilePlayer(local,m.state.list);assert.equal(local.lastPublished.role,'home');assert.equal(local.playlists.home[0].duration,27);
});
test('shared state survives fresh controller setup and contains no controller address/password',async()=>{
 const m=mock([media('h')]),a=newRoom('Room','http://local');await edit(m,a,'home',[{id:'h',duration:19}]);
 const record=readState(m.state.list);assert.equal(record.asset.is_enabled,false);assert.equal(record.asset.uri,STATE_URI);assert.equal(record.data.lease,null);assert(!record.asset.name.includes('http://local'));
 const b=newRoom('Remote','http://remote');reconcilePlayer(b,m.state.list);assert.equal(b.playlists.home[0].duration,19);
});
test('another controller cannot acquire a live lease or write any media',async()=>{
 const m=mock([media('h')]),a=newRoom(),b=newRoom(),api=m.make();const session=await begin(api,a);
 try{const count=m.state.writes.length;await assert.rejects(begin(m.make(),b),/Another controller/);assert.equal(m.state.writes.length,count);}finally{await session.close();}
});
test('expired lease can be recovered after a browser closes',async()=>{
 const m=mock([media('h')]),r=newRoom(),a=await begin(m.make(),r);await a.close();const record=readState(m.state.list);record.data.lease={owner:'dead-controller',until:1};record.asset.name=encodeState(record.data);m.state.list.find(x=>x.uri===STATE_URI).name=record.asset.name;
 const b=await begin(m.make(),newRoom());await b.close();assert.equal(readState(m.state.list).data.lease,null);
});
test('lost ownership prevents writes and stale shared-state commits',async()=>{
 const m=mock([media('h')]),r=newRoom(),api=m.make(),session=await begin(api,r);
 const record=readState(m.state.list);record.data.lease.owner='other';m.state.list.find(a=>a.uri===STATE_URI).name=encodeState(record.data);
 await assert.rejects(api.patch('h',{is_enabled:true}),/Another controller/);await assert.rejects(session.commit(),/Another controller/);assert.equal(m.state.list[0].is_enabled,false);await assert.rejects(session.close(),/Another controller/);
});
test('remote revision invalidates stale cleanup permissions',async()=>{
 const m=mock([media('h'),media('e','Event')]),a=newRoom(),b=newRoom();await edit(m,a,'home',[{id:'h',duration:15}]);reconcilePlayer(b,m.state.list);
 b.cleanup=[{assetId:'e',targetIds:['h'],base:b.base}];await edit(m,a,'event',[{id:'e',duration:15}]);reconcilePlayer(b,m.state.list);assert.deepEqual(b.cleanup,[]);
});
test('deleted referenced media is removed from both role views',async()=>{
 const m=mock([media('h'),media('e','Event')]),a=newRoom();await edit(m,a,'home',[{id:'h',duration:15}]);await m.make().remove('h');const b=newRoom();reconcilePlayer(b,m.state.list);assert.equal(b.playlists.home.length,0);
});
test('corrupt, enabled, foreign-URI and duplicate manifests fail closed',async()=>{
 const m=mock([media('h')]),r=newRoom(),s=await begin(m.make(),r);await s.close();const record=readState(m.state.list).asset;
 assert.throws(()=>decodeState({...record,name:'bad'}),/invalid/);assert.throws(()=>decodeState({...record,is_enabled:true}),/invalid/);assert.throws(()=>decodeState({...record,uri:'https://other.invalid'}),/invalid/);
 assert.throws(()=>readState([...m.state.list,{...record,asset_id:'duplicate'}]),/Multiple/);
});
test('native order and image duration changes are observed across controllers',async()=>{
 const m=mock([media('h1'),media('h2')]),r=newRoom();await edit(m,r,'home',[{id:'h1',duration:15},{id:'h2',duration:20}],true);
 m.state.list.find(a=>a.asset_id==='h1').play_order=1;m.state.list.find(a=>a.asset_id==='h2').play_order=0;m.state.list.find(a=>a.asset_id==='h2').duration=31;
 const fresh=newRoom();reconcilePlayer(fresh,m.state.list);assert.deepEqual(fresh.playlists.home,[{id:'h2',duration:31},{id:'h1',duration:15}]);
});

test('interrupted publication blocks other controllers until origin recovery',async()=>{
 const m=mock([media('h')]),r=newRoom(),session=await begin(m.make(),r);await session.markRecovery('journal-token');await session.close();
 await assert.rejects(begin(m.make(),newRoom()),/Recover/);
 const recovery=await begin(m.make(),r,{recoveryToken:'journal-token'});await recovery.markRecovery(null);await recovery.close();const other=await begin(m.make(),newRoom());await other.close();
});
