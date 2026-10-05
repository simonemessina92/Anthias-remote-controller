import {assertReady,isLocalMedia} from './api.js';
import {switchPlaylist,matchesActive,playlistState} from './logic.js';
import {unique,itemIds,cleanItems} from './storage.js';
import {t} from './i18n.js';
export function protectedIds(room) {return unique([...itemIds(room.playlists.home),...itemIds(room.playlists.event),...itemIds(room.lastPublished?.items)]);}
export function deletionBlock(asset,assets,room,{automatic=false}={}) {
  if(!asset)return '';
  if(!isLocalMedia(asset))return t('Local files only.');
  if(asset.is_enabled||asset.is_active)return t('File is active.');
  if(asset.is_processing)return t('Processing…');
  if(protectedIds(room).includes(asset.asset_id))return t('File is assigned to a playlist.');
  if(automatic&&room.homeHistory.includes(asset.asset_id))return t('Home file is protected.');
  if(automatic&&!room.managedEventIds.includes(asset.asset_id))return t('Not a temporary event upload.');
  if(assets.some(a=>a.asset_id!==asset.asset_id&&a.uri===asset.uri))return t('File is shared by another asset.');
  return '';
}
export function forgetAsset(room,id) {
  for(const key of ['uploadedIds','managedEventIds','eventHistory','homeHistory'])room[key]=room[key].filter(x=>x!==id);
  room.cleanup=room.cleanup.filter(j=>j.assetId!==id);
}
export function queueCleanup(room,ids,targetIds,now=Date.now()) {
  const jobs=new Map(room.cleanup.map(j=>[j.assetId,j]));
  for(const id of unique(ids)) {
    if(protectedIds(room).includes(id)||room.homeHistory.includes(id)||!room.managedEventIds.includes(id))continue;
    jobs.set(id,{assetId:id,targetIds:[...targetIds],base:room.base,notBefore:now+3000,attempts:0,lastError:''});
  }
  room.cleanup=[...jobs.values()];
}
export async function cleanupRoom(api,room,persist,{now=Date.now,onDeleted=()=>{},enabled=()=>true}={}) {
  const result={deleted:[],pending:[]};
  for(const job of [...room.cleanup]) {
    if(!enabled())break;
    if(job.base!==room.base||job.notBefore>now())continue;
    try {
      const assets=await api.assets(),file=assets.find(a=>a.asset_id===job.assetId);
      if(!file){forgetAsset(room,job.assetId);await persist();continue;}
      if(!matchesActive(assets,job.targetIds.map(id=>({id}))))throw new Error(t('Waiting for the expected active playlist.'));
      job.targetIds.forEach(id=>assertReady(assets.find(a=>a.asset_id===id)));
      const block=deletionBlock(file,assets,room,{automatic:true});if(block)throw new Error(block);
      if(!enabled())break;
      await api.remove(job.assetId);
      if((await api.assets()).some(a=>a.asset_id===job.assetId))throw new Error(t('Deletion not confirmed by player.'));
      forgetAsset(room,job.assetId);await persist();onDeleted(job.assetId);result.deleted.push(job.assetId);
    }catch(error){job.lastError=error.message;job.attempts++;job.notBefore=now()+Math.min(300000,30000*job.attempts);await persist();result.pending.push({id:job.assetId,reason:error.message});}
  }
  return result;
}
export async function mapPlaylist(room,role,items,assets,persist) {
  items=cleanItems(items);for(const item of items)assertReady(assets.find(a=>a.asset_id===item.id));
  const other=role==='home'?'event':'home';
  if(itemIds(items).some(id=>itemIds(room.playlists[other]).includes(id)))throw new Error(t('The same asset cannot belong to both Home and Event. Upload a separate copy if needed.'));
  // Preserve the observed old live snapshot when staging edits, including v0.3 migration.
  const before=playlistState(assets,room);if(['home','event'].includes(before.role))room.lastPublished={role:before.role,items:structuredClone(before.items)};
  room[role==='home'?'homeHistory':'eventHistory']=unique([...room[role==='home'?'homeHistory':'eventHistory'],...itemIds(room.playlists[role]),...itemIds(items)]);
  room.playlists[role]=structuredClone(items);room.cleanup=room.cleanup.filter(j=>!itemIds(items).includes(j.assetId));await persist();
}
export async function publishRoom(api,room,role,{persist,autoCleanup=true,...hooks}) {
  const targets=room.playlists[role], before=await api.assets(),previous=playlistState(before,room);
  if(role==='event') {
    if(!room.playlists.home.length)throw new Error(t('Set a ready Home playlist before showing an event.'));
    for(const item of room.playlists.home)assertReady(before.find(a=>a.asset_id===item.id));
  }
  const result=await switchPlaylist(api,targets,hooks);
  const endedEvent=previous.role==='event'?previous.items:[];
  // A prepared next event (including changed timing/order) remains protected.
  if(role==='home'&&autoCleanup&&endedEvent.length&&JSON.stringify(endedEvent)===JSON.stringify(room.playlists.event))room.playlists.event=[];
  room.lastPublished={role,items:structuredClone(targets)};
  if(role==='event')room.eventHistory=unique([...room.eventHistory,...itemIds(targets)]);
  await persist();
  if(autoCleanup&&!result.warning) {queueCleanup(room,room.managedEventIds,itemIds(targets));await persist();}
  return result;
}
