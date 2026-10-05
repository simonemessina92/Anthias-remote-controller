import {normalizeBase} from './api.js';
import {t} from './i18n.js';
import {migrateDiscovery} from './discovery.js';
export const ROOM_NAME_MAX = 40;
export const unique = items => [...new Set((items || []).filter(x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(x)))];
export function normalizeName(value, truncate = false) {
  const chars = Array.from(String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim());
  if (!chars.length) throw new Error(t('Enter a name.'));
  if (chars.length > ROOM_NAME_MAX && !truncate) throw new Error(t('Names can contain at most 40 characters.'));
  return chars.slice(0, ROOM_NAME_MAX).join('');
}
export function cleanItems(items) {
  if (!Array.isArray(items) || items.length > 100) throw new Error(t('A playlist can contain up to 100 items.'));
  const seen = new Set();
  return items.map(item => {
    const id = unique([typeof item === 'string' ? item : item?.id])[0];
    if (!id || seen.has(id)) throw new Error(t('This file is already in the playlist.'));
    seen.add(id);
    const duration = item?.duration == null ? null : Number(item.duration);
    if (duration !== null && (!Number.isInteger(duration) || duration < 1 || duration > 86400)) throw new Error(t('Image duration must be between 1 and 86400 seconds.'));
    return {id, duration};
  });
}
export const itemIds = items => (items || []).map(x => x.id);
export function newRoom(name = 'Player', base = '', number = 1) {
  return {id:`room-${crypto.randomUUID()}`, number, name:normalizeName(name,true), base:normalizeBase(base), identity:'',
    playlists:{home:[], event:[]}, lastPublished:null, homeHistory:[], eventHistory:[], uploadedIds:[], managedEventIds:[], cleanup:[]};
}
export function defaultConfig() {
  return {schema:4, language:'en', setupComplete:false, wizardDraft:null, nextPlayerNumber:1, autoCleanup:true, defaultImageDuration:15, discovery:{address:'',subnet:'24',port:80,protocol:'http'}, rooms:[]};
}
export function migrateConfig(value) {
  if (!value || ![1,2,4].includes(value.schema) || !Array.isArray(value.rooms)) throw new Error(t('Unrecognised configuration. Existing data has not been overwritten.'));
  const ids=new Set(), bases=new Set(), numbers=new Set();
  const rooms=value.rooms.map((r,index) => {
    if (!r || !unique([r.id]).length || ids.has(r.id)) throw new Error(t('Invalid or duplicate player identifier.'));
    ids.add(r.id);
    const number=value.schema===4?Number(r.number):index+1;
    if (!Number.isSafeInteger(number) || number<1 || numbers.has(number)) throw new Error(t('Duplicate player number.'));
    numbers.add(number);
    const base=normalizeBase(r.base); if(base && bases.has(base)) throw new Error(t('Address already assigned to another player.')); if(base) bases.add(base);
    const playlists=value.schema===4 ? {home:cleanItems(r.playlists?.home||[]), event:cleanItems(r.playlists?.event||[])}
      : {home:unique([r.hotelId]).map(id=>({id,duration:null})),event:unique([r.eventId]).map(id=>({id,duration:null}))};
    if(itemIds(playlists.home).some(id=>itemIds(playlists.event).includes(id))) throw new Error(t('The same asset cannot belong to both Home and Event. Upload a separate copy if needed.'));
    const uploadedIds=unique(r.uploadedIds), eventHistory=unique(r.eventHistory);
    const managedEventIds=value.schema===1?uploadedIds.filter(id=>!itemIds(playlists.home).includes(id)&&(itemIds(playlists.event).includes(id)||eventHistory.includes(id))):unique(r.managedEventIds);
    let lastPublished=null;
    if(value.schema===4 && ['home','event'].includes(r.lastPublished?.role)) lastPublished={role:r.lastPublished.role,items:cleanItems(r.lastPublished.items||[])};
    const cleanup=(Array.isArray(r.cleanup)?r.cleanup:[]).filter(j=>j && unique([j.assetId]).length && j.base===base)
      .map(j=>({assetId:j.assetId,targetIds:unique(j.targetIds || [j.targetId]),base,notBefore:Number(j.notBefore)||0,attempts:Number(j.attempts)||0,lastError:String(j.lastError||'')})).filter(j=>j.targetIds.length);
    return {id:r.id,number,name:normalizeName(r.name,true),base,identity:String(r.identity||'').slice(0,160),playlists,lastPublished,
      homeHistory:unique(value.schema===4?r.homeHistory:r.hotelHistory),eventHistory,uploadedIds,managedEventIds,cleanup};
  });
  const max=Math.max(0,...numbers), rawDuration=Number(value.defaultImageDuration);
  return {...defaultConfig(), schema:4, language:value.language==='it'?'it':'en',setupComplete:value.schema===4?value.setupComplete===true:true,
    wizardDraft:value.schema===4 && Array.isArray(value.wizardDraft)?value.wizardDraft.slice(0,100).map(r=>({name:String(r.name||'').slice(0,40),base:String(r.base||'').slice(0,255),identity:String(r.identity||'').slice(0,160)})):null,
    nextPlayerNumber:Math.max(max+1,Number.isSafeInteger(value.nextPlayerNumber)?value.nextPlayerNumber:1),autoCleanup:value.autoCleanup!==false,
    defaultImageDuration:Number.isInteger(rawDuration)&&rawDuration>=1&&rawDuration<=86400?rawDuration:15,
    discovery:migrateDiscovery(value.discovery), rooms};
}
export async function loadConfig() {
  const {hmrConfig} = await chrome.storage.local.get('hmrConfig');
  if (!hmrConfig) { const initial=defaultConfig(); await chrome.storage.local.set({hmrConfig:initial}); return initial; }
  const config=migrateConfig(hmrConfig);
  if(JSON.stringify(hmrConfig)!==JSON.stringify(config)) {
    const prior=await chrome.storage.local.get('hmrConfigBeforeV5');
    await chrome.storage.local.set({...(!prior.hmrConfigBeforeV5?{hmrConfigBeforeV5:hmrConfig}:{}),hmrConfig:config});
  }
  return config;
}
export const saveConfig = config => chrome.storage.local.set({hmrConfig:config});
export async function readJournal(id) { const key=`hmrJournal:${id}`; return (await chrome.storage.local.get(key))[key] || null; }
export const saveJournal = (id,value) => chrome.storage.local.set({[`hmrJournal:${id}`]:value});
export const clearJournal = id => chrome.storage.local.remove(`hmrJournal:${id}`);
export async function updateConfig(mutator) {
  if(!navigator.locks) throw new Error(t('Open the panel from the Chrome extension.'));
  // Keep the existing lock name so two open revisions do not write concurrently.
  return navigator.locks.request('hmr-config-v3',async()=>{const latest=await loadConfig();await mutator(latest);const valid=migrateConfig(latest);await saveConfig(valid);return valid;});
}
export async function saveRoomSnapshot(snapshot) {
  return updateConfig(latest=>{
    const index=latest.rooms.findIndex(r=>r.id===snapshot.id);
    if(index<0||latest.rooms[index].base!==snapshot.base) throw new Error(t('Player configuration changed. Reopen it and try again.'));
    latest.rooms[index]={...snapshot,name:latest.rooms[index].name,number:latest.rooms[index].number,identity:latest.rooms[index].identity||snapshot.identity};
  });
}
export function appendPlayer(config,name,base,identity='') {
  const player=newRoom(name,base,config.nextPlayerNumber++);player.identity=identity;config.rooms.push(player);return player;
}
export function exportConfig(config) {
  const copy=structuredClone(config);copy.setupComplete=true;copy.wizardDraft=null;
  // Cleanup is tied to the originating controller's acknowledged switch, not portable.
  copy.rooms.forEach(r=>{r.cleanup=[];});return copy;
}
