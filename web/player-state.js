/* Player-resident Home/Event state. No player daemon or external storage service. */
import {isLocalMedia,mediaKind} from './api.js';
import {cleanItems,itemIds,unique} from './storage.js';
import {ordered,matchesActive} from './logic.js';
import {t} from './i18n.js';
export const STATE_URI='https://anthias-rooms.invalid/controller-state/v1';
export const STATE_PREFIX='[HMR] Controller state v1 - ';
const MAX_NAME=64000,LEASE_MS=60000;
const conflict=()=>new Error(t('Another controller changed this player. Refresh and reopen the editor.'));
export const isStateAsset=a=>a?.uri===STATE_URI||String(a?.name||'').startsWith(STATE_PREFIX);
export function encodeState(value){
 const bytes=new TextEncoder().encode(JSON.stringify(value));let binary='';for(const b of bytes)binary+=String.fromCharCode(b);
 const name=STATE_PREFIX+btoa(binary);if(name.length>MAX_NAME)throw new Error(t('Shared player state is too large.'));return name;
}
function items(value){
 if(!Array.isArray(value)||value.length>100)throw new Error('items');
 const result=cleanItems(value);if(result.length!==value.length)throw new Error('items');return result;
}
export function decodeState(asset){
 try{
  if(asset.uri!==STATE_URI||asset.is_enabled||!String(asset.name).startsWith(STATE_PREFIX)||asset.name.length>MAX_NAME)throw new Error('record');
  const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(asset.name.slice(STATE_PREFIX.length)),c=>c.charCodeAt(0))));
  if(data.schema!==1||typeof data.revision!=='string'||!data.revision||!data.playlists)throw new Error('version');
  data.playlists={home:items(data.playlists.home),event:items(data.playlists.event)};
  if(itemIds(data.playlists.home).some(id=>itemIds(data.playlists.event).includes(id)))throw new Error('overlap');
  if(data.lastPublished!==null){if(!['home','event'].includes(data.lastPublished?.role))throw new Error('published');data.lastPublished={role:data.lastPublished.role,items:items(data.lastPublished.items)};}
  for(const key of ['homeHistory','eventHistory','uploadedIds','managedEventIds']){if(!Array.isArray(data[key])||data[key].length>1000||unique(data[key]).length!==data[key].length)throw new Error(key);}
  if(data.recovery!==undefined&&data.recovery!==null&&typeof data.recovery!=='string')throw new Error('recovery');
  if(data.lease!==null&&(!data.lease||typeof data.lease.owner!=='string'||!Number.isFinite(data.lease.until)))throw new Error('lease');
  return data;
 }catch{throw new Error(t('Shared player state is invalid or enabled. Check it in Anthias before making changes.'));}
}
export function readState(assets){
 const records=assets.filter(isStateAsset);if(records.length>1)throw new Error(t('Multiple shared state records found. Resolve the duplicate in Anthias before making changes.'));
 return records.length?{asset:records[0],data:decodeState(records[0])}:null;
}
const fieldKeys=['playlists','lastPublished','homeHistory','eventHistory','uploadedIds','managedEventIds'];
function portable(room){return Object.fromEntries(fieldKeys.map(k=>[k,structuredClone(room[k])]));}
const validItems=(list,assets)=>list.filter(x=>assets.some(a=>a.asset_id===x.id&&isLocalMedia(a)));
const liveItems=assets=>ordered(assets.filter(a=>a.is_enabled&&isLocalMedia(a))).map(a=>({id:a.asset_id,duration:mediaKind(a)==='image'?a.duration:null}));
export function reconcilePlayer(room,assets,{recoveryToken}={}){
 const before=JSON.stringify({...portable(room),sharedRevision:room.sharedRevision}),record=readState(assets);let warning='';
 if(record){
  if(record.data.recovery)return {changed:false,busy:record.data.recovery!==recoveryToken,warning:t('Recover the interrupted publication in its original controller before making changes.')};
  if(record.data.lease&&record.data.lease.until>Date.now())return {changed:false,busy:true,warning:t('Another controller is changing this player. Wait before refreshing.')};
  const changedRevision=room.sharedRevision!==record.data.revision;
  Object.assign(room,portable(record.data));room.sharedRevision=record.data.revision;
  if(changedRevision)room.cleanup=[]; // Cleanup permissions never migrate between controllers.
 }else{
  room.sharedRevision='';
  // Existing local assignments take precedence only while no shared record exists.
  for(const role of ['home','event']){
   room.playlists[role]=validItems(room.playlists[role],assets);
   const named=ordered(assets.filter(a=>isLocalMedia(a)&&new RegExp('^\\[HMR\\] '+(role==='home'?'(?:Home|Hotel)':'(?:Event|Evento)')+' - [a-f0-9]{8} - ').test(a.name)));
   if(!room.playlists[role].length){
    const active=named.filter(a=>a.is_enabled);
    if(active.length&&matchesActive(assets,active.map(a=>({id:a.asset_id}))))room.playlists[role]=liveItems(assets);
    else if(named.length===1)room.playlists[role]=named.map(a=>({id:a.asset_id,duration:mediaKind(a)==='image'?a.duration:null}));
    else if(named.length>1)warning=t('Several legacy files have the same role. Select the intended playlist before publishing.');
   }
  }
 }
 for(const role of ['home','event'])room.playlists[role]=validItems(room.playlists[role],assets);
 if(room.lastPublished){room.lastPublished.items=validItems(room.lastPublished.items,assets);if(!room.lastPublished.items.length)room.lastPublished=null;}
 // Observe actual order/timing after native Anthias edits without discarding staged changes.
 const live=liveItems(assets),candidates=room.lastPublished?[room.lastPublished]:[];
 for(const role of ['home','event'])candidates.push({role,items:room.playlists[role]});
 const candidate=candidates.find(c=>c.items.length===live.length&&itemIds(c.items).every(id=>itemIds(live).includes(id))&&matchesActive(assets,live));
 if(candidate){
  const prior=room.lastPublished;
  if(!prior||JSON.stringify(room.playlists[candidate.role])===JSON.stringify(prior.items))room.playlists[candidate.role]=structuredClone(live);
  room.lastPublished={role:candidate.role,items:live};
 }
 const existing=new Set(assets.filter(isLocalMedia).map(a=>a.asset_id));
 for(const key of ['homeHistory','eventHistory','uploadedIds','managedEventIds'])room[key]=room[key].filter(id=>existing.has(id));
 room.cleanup=room.cleanup.filter(j=>existing.has(j.assetId));
 return {changed:before!==JSON.stringify({...portable(room),sharedRevision:room.sharedRevision}),busy:false,warning};
}
/* Anthias has no compare-and-swap API. This cooperative lease arbitrates updated
   controllers and checks ownership before every write; native/older clients do
   not participate. Readback and existing publication verification remain required. */
export async function beginPlayerSession(api,room,{delay=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,owner=crypto.randomUUID(),recoveryToken}={}){
 const raw={};for(const key of ['assets','get','patch','create','remove','order','patchSettings','show','upload'])if(typeof api[key]==='function')raw[key]=api[key].bind(api);
 let record=readState(await raw.assets());
 if(record?.data.recovery&&record.data.recovery!==recoveryToken)throw new Error(t('Recover the interrupted publication in its original controller before making changes.'));
 if(record?.data.lease&&record.data.lease.until>now())throw new Error(t('Another controller is changing this player. Wait before refreshing.'));
 const fresh=await raw.assets();const reconciled=reconcilePlayer(room,fresh,{recoveryToken});if(reconciled.busy)throw conflict();
 record=readState(fresh);const baseRevision=record?.data.revision||'';
 if(!record){
  const data={schema:1,revision:crypto.randomUUID(),...portable(room),recovery:null,lease:{owner,until:now()+LEASE_MS}};
  await raw.create({name:encodeState(data),uri:STATE_URI,mimetype:'webpage',duration:0,is_enabled:false,is_processing:false,skip_asset_check:true,start_date:'2099-01-01T00:00:00+00:00',end_date:'2100-01-01T00:00:00+00:00'});
  record=readState(await raw.assets());if(!record||record.data.lease?.owner!==owner)throw conflict();
 }else{
  record.data.lease={owner,until:now()+LEASE_MS};await raw.patch(record.asset.asset_id,{name:encodeState(record.data),is_enabled:false});
 }
 await delay(250);
 let stopped=false,lost=false,queue=Promise.resolve();
 const serial=fn=>{const next=queue.then(fn);queue=next.catch(()=>{});return next;};
 const check=async()=>{
  if(lost)throw conflict();const current=readState(await raw.assets());
  if(!current||current.asset.asset_id!==record.asset.asset_id||current.data.lease?.owner!==owner||current.data.lease.until<=now()||current.data.revision!==record.data.revision){lost=true;throw conflict();}
  record=current;return current;
 };
 await check();room.sharedRevision=record.data.revision;
 for(const key of ['patch','create','remove','order','patchSettings','show','upload'])if(raw[key])api[key]=async(...args)=>{await serial(check);return raw[key](...args);};
 const timer=setInterval(()=>{if(!stopped)void serial(async()=>{await check();record.data.lease.until=now()+LEASE_MS;await raw.patch(record.asset.asset_id,{name:encodeState(record.data),is_enabled:false});}).catch(()=>{lost=true;});},10000);
 return {
  changed:reconciled.changed,warning:reconciled.warning,baseRevision,
  markRecovery:token=>serial(async()=>{await check();record.data.recovery=token;await raw.patch(record.asset.asset_id,{name:encodeState(record.data),is_enabled:false});await check();}),
  commit:()=>serial(async()=>{
   if(stopped)return;await check();const desired=portable(room);if(JSON.stringify(desired)===JSON.stringify(portable(record.data)))return;
   const next={...record.data,...desired,revision:crypto.randomUUID(),lease:{owner,until:now()+LEASE_MS}};
   await raw.patch(record.asset.asset_id,{name:encodeState(next),is_enabled:false});record.data=next;await check();room.sharedRevision=next.revision;
  }),
  close:async()=>{if(stopped)return;stopped=true;clearInterval(timer);await queue;
   try{await check();await raw.patch(record.asset.asset_id,{name:encodeState({...record.data,lease:null}),is_enabled:false});}finally{for(const key of ['patch','create','remove','order','patchSettings','show','upload'])if(raw[key])api[key]=raw[key];}
  }
 };
}
