import {assertReady,mediaKind} from './api.js';
import {itemIds,cleanItems} from './storage.js';
import {t} from './i18n.js';
export const MANUAL_SCHEDULE=Object.freeze({start_date:'2000-01-01T00:00:00+00:00',end_date:'2099-12-31T23:59:59+00:00',play_days:[1,2,3,4,5,6,7],play_time_from:null,play_time_to:null});
export const sameIds=(a,b)=>a.length===b.length&&a.every((id,index)=>id===b[index]);
export const ordered=assets=>[...assets].sort((a,b)=>Number(a.play_order)-Number(b.play_order));
export function matchesActive(assets,items) {
  const enabled=ordered(assets.filter(a=>a.is_enabled));
  return items.length>0 && sameIds(enabled.map(a=>a.asset_id),itemIds(items)) && enabled.every(a=>a.is_active&&!a.is_processing);
}
export function playlistState(assets,room) {
  const enabled=ordered(assets.filter(a=>a.is_enabled)),active=enabled.filter(a=>a.is_active&&!a.is_processing);
  const candidates=[];
  if(room.lastPublished?.items.length)candidates.push(room.lastPublished);
  for(const role of ['home','event'])candidates.push({role,items:room.playlists[role]});
  for(const candidate of candidates)if(matchesActive(assets,candidate.items))return {...candidate,assets:enabled,active,enabled};
  return {role:active.length?'other':'empty',items:[],assets:active,active,enabled};
}
export function snapshotTarget(asset) {
  const result={is_enabled:asset.is_enabled};
  for(const key of ['start_date','end_date','play_days','play_time_from','play_time_to','play_order','duration']) {
    if(asset[key]!==undefined && !(asset[key]===null&&['start_date','end_date','duration'].includes(key)))result[key]=asset[key];
  }
  return result;
}
function equalField(key,a,b) {return ['start_date','end_date'].includes(key)?Date.parse(a)===Date.parse(b):JSON.stringify(a)===JSON.stringify(b);}
export async function restoreJournal(api,journal,onProgress=()=>{}) {
  const errors=[];onProgress(t('Restoring previous playlist…'));
  const ids=[...new Set(journal.touched||[])];
  const entries=ids.map(id=>({id,body:journal.before[id]})).filter(x=>x.body).sort((a,b)=>Number(b.body.is_enabled)-Number(a.body.is_enabled));
  for(const {id,body} of entries)try {await api.patch(id,body);}catch(e){errors.push(`${id}: ${e.message}`);}
  // The v0.3 recovery format has no ordering or settings journal; still accept it.
  if(journal.orderTouched && journal.orderBefore?.length)try{await api.order(journal.orderBefore);}catch(e){errors.push(e.message);}
  if(journal.settingsTouched)try{await api.patchSettings({shuffle_playlist:journal.shuffleBefore});}catch(e){errors.push(e.message);}
  if(!errors.length)try {
    const actual=await api.assets();
    for(const {id,body} of entries) {
      const asset=actual.find(a=>a.asset_id===id);if(!asset){errors.push(id);continue;}
      for(const [key,value] of Object.entries(body))if(key!=='play_order'&&!equalField(key,asset[key],value))errors.push(`${id}: ${key}`);
    }
    if(journal.orderTouched&&!sameIds(ordered(actual.filter(a=>a.is_enabled)).map(a=>a.asset_id),journal.orderBefore||[]))errors.push('order');
    if(journal.settingsTouched && (await api.settings()).shuffle_playlist!==journal.shuffleBefore)errors.push('shuffle_playlist');
  }catch(e){errors.push(e.message);}
  return errors;
}
export async function switchPlaylist(api,items,hooks={}) {
  items=cleanItems(items);if(!items.length)throw new Error(t('Choose at least one file.'));
  const report=hooks.progress||(()=>{}),save=hooks.saveJournal||(async()=>{}),clear=hooks.clearJournal||(async()=>{});
  report(t('Checking playlist…'));
  const assets=await api.assets(), settings=await api.settings();
  if(typeof settings?.shuffle_playlist!=='boolean')throw new Error(t('Invalid Anthias shuffle_playlist setting.'));
  const targetIds=itemIds(items),targets=items.map(item=>{const asset=assets.find(a=>a.asset_id===item.id);assertReady(asset);return asset;});
  // Never impose the image timer on a video. Anthias plays the native video to EOS.
  const changes=items.map((item,index)=>({id:item.id,body:{...MANUAL_SCHEDULE,is_enabled:true,...(mediaKind(targets[index])==='image'?{duration:item.duration||targets[index].duration||15}:{})}}));
  const others=assets.filter(a=>a.is_enabled&&!targetIds.includes(a.asset_id));
  const needs=changes.filter((change,index)=>Object.entries(change.body).some(([key,value])=>!equalField(key,targets[index][key],value)));
  const currentOrder=ordered(assets.filter(a=>a.is_enabled)).map(a=>a.asset_id);
  if(!needs.length&&!others.length&&sameIds(currentOrder,targetIds)&&!settings.shuffle_playlist&&matchesActive(assets,items))return {assets,warning:'',unchanged:true};
  const journal={version:4,base:api.base,createdAt:new Date().toISOString(),targetIds,before:{},touched:[],orderBefore:currentOrder,orderTouched:false,shuffleBefore:settings.shuffle_playlist,settingsTouched:false};
  for(const a of assets)journal.before[a.asset_id]=snapshotTarget(a);
  await save(journal);
  const patch=async(id,body)=>{if(!journal.touched.includes(id))journal.touched.push(id);await save(journal);return api.patch(id,body);};
  let current;
  try {
    report(t('Publishing playlist…'));
    for(const change of needs)await patch(change.id,change.body);
    // Only remove the old playlist once every target has passed readiness checks.
    const mid=await api.assets();
    for(const id of targetIds){const a=mid.find(x=>x.asset_id===id);assertReady(a);if(!a.is_active||!a.is_enabled)throw new Error(t('Playlist verification failed. Another controller may have changed the player.'));}
    for(const asset of others)await patch(asset.asset_id,{is_enabled:false});
    // Individual enable operations may cause Anthias to renumber play_order.
    journal.orderTouched=true;await save(journal);await api.order(targetIds);
    if(settings.shuffle_playlist){journal.settingsTouched=true;await save(journal);await api.patchSettings({shuffle_playlist:false});}
    report(t('Checking playlist…'));current=await api.assets();
    if(!matchesActive(current,items))throw new Error(t('Playlist verification failed. Another controller may have changed the player.'));
    for(const change of changes){const asset=current.find(a=>a.asset_id===change.id);assertReady(asset);
      for(const [key,value] of Object.entries(change.body))if(!equalField(key,asset[key],value))throw new Error(t('Playlist verification failed. Another controller may have changed the player.'));
    }
    if((await api.settings()).shuffle_playlist)throw new Error(t('Anthias still has shuffle enabled.'));
  }catch(error) {
    const errors=await restoreJournal(api,journal,report);if(!errors.length)await clear();
    throw new Error(`${error.message} ${t(errors.length?'Recovery incomplete. A recovery record has been kept.':'Previous settings restored and verified.')}`);
  }
  await clear();let warning='';
  try{await api.show(targetIds[0]);}catch{warning=t('Playback request not acknowledged. Playlist saved; check the monitor.');}
  return {assets:current,warning,unchanged:false};
}
