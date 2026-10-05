import test from 'node:test';
import assert from 'node:assert/strict';
const moduleUrl=new URL('../web/tab-session.js',import.meta.url);
async function load(type,stored='saved-token'){
 const values=new Map(stored?[['arTabToken',stored]]:[]);
 globalThis.sessionStorage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 Object.defineProperty(globalThis,'performance',{configurable:true,value:{getEntriesByType:()=>[{type}]}});
 const mod=await import(moduleUrl.href+'?test='+crypto.randomUUID());return {mod,values};
}
test('new and restored tabs cannot reuse a copied token',async()=>{for(const type of ['navigate','back_forward',undefined]){const {mod,values}=await load(type);assert.deepEqual(mod.tabHeaders(),{});assert.equal(values.size,0);}});
test('refresh keeps the current tab credential',async()=>{const {mod}=await load('reload');assert.deepEqual(mod.tabHeaders(),{'X-AR-Tab':'saved-token'});});
test('login stores tab credential and logout removes it',async()=>{const {mod,values}=await load('navigate','');mod.acceptTabSession({tabToken:'fresh-token'});assert.equal(values.get('arTabToken'),'fresh-token');assert.deepEqual(mod.tabHeaders(),{'X-AR-Tab':'fresh-token'});mod.clearTabSession();assert.deepEqual(mod.tabHeaders(),{});assert.equal(values.size,0);});
