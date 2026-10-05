/** Home-only reuse rules. Event ownership and deletion guards remain unchanged. */
import {assertReady,isLocalMedia,mediaKind} from './api.js';
import {t} from './i18n.js';

export function homeSelectionBlock(asset,room,items=[]){
  if(!asset||!isLocalMedia(asset))return t('Local files only.');
  if(items.some(item=>item.id===asset.asset_id))return t('This file is already in the playlist.');
  const eventIds=[...room.playlists.event,...(room.lastPublished?.role==='event'?room.lastPublished.items:[])].map(item=>item.id);
  if(eventIds.includes(asset.asset_id))return t('Assigned to Event.');
  if(room.cleanup.some(job=>job.assetId===asset.asset_id))return t('File awaiting cleanup.');
  try{assertReady(asset);}catch(error){return error.message;}
  return '';
}

export function homeMediaDraft(asset,defaultDuration=15){
  const kind=mediaKind(asset),duration=Number(asset.duration);
  const fallback=Number.isInteger(defaultDuration)&&defaultDuration>=1&&defaultDuration<=86400?defaultDuration:15;
  return {key:crypto.randomUUID(),id:asset.asset_id,file:null,kind,
    duration:kind==='video'?null:(Number.isInteger(duration)&&duration>=1&&duration<=86400?duration:fallback)};
}
