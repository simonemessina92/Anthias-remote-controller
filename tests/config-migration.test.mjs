import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConfig,updateConfig,defaultConfig,newRoom} from '../web/storage.js';
test('VPS adds shared-state fields under its config lock and does not recursively acquire it',async()=>{
 const original=globalThis.fetch,c=defaultConfig();c.rooms=[newRoom('Room','http://player')];delete c.rooms[0].sharedRevision;
 const store={hmrConfig:structuredClone(c)};let held=false,acquires=0;
 globalThis.fetch=async(url,opts)=>{
  const body=JSON.parse(opts.body||'{}');let result={};
  if(url==='/ar/locks'){
   if(body.action==='acquire'){assert.equal(held,false,'recursive configuration lock');held=true;acquires++;result={acquired:true};}
   if(body.action==='release')held=false;
  }else if(url==='/ar/storage/get'){const keys=typeof body.keys==='string'?[body.keys]:body.keys||Object.keys(store);result=Object.fromEntries(keys.filter(k=>k in store).map(k=>[k,structuredClone(store[k])]));}
  else if(url==='/ar/storage/set'){if(body.items.hmrConfig)assert(held,'configuration migration without lock');Object.assign(store,structuredClone(body.items));}
  else throw new Error(url);
  return {ok:true,json:async()=>result};
 };
 try{
  const loaded=await loadConfig();assert.equal(loaded.rooms[0].sharedRevision,'');assert.equal(acquires,1);assert(store.hmrConfigBeforeV5);assert.equal(held,false);
  delete store.hmrConfig.rooms[0].sharedRevision;
  await updateConfig(latest=>{latest.rooms[0].name='Updated';});assert.equal(acquires,2);assert.equal(store.hmrConfig.rooms[0].name,'Updated');assert.equal(held,false);
 }finally{globalThis.fetch=original;}
});
