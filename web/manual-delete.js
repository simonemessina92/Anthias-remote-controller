import {forgetAsset} from './lifecycle.js';
import {t} from './i18n.js';

export function forgetDeletedMedia(room,id){
 forgetAsset(room,id);
 for(const role of ['home','event'])room.playlists[role]=room.playlists[role].filter(item=>item.id!==id);
 if(room.lastPublished){room.lastPublished.items=room.lastPublished.items.filter(item=>item.id!==id);if(!room.lastPublished.items.length)room.lastPublished=null;}
 for(const job of room.cleanup)job.targetIds=job.targetIds.filter(target=>target!==id);
}
export async function deleteMediaManually(api,room,id,persist){
 const asset=(await api.assets()).find(a=>a.asset_id===id);
 // Explicit manual deletion is permitted even for live/assigned/processing media.
 // Automatic cleanup continues to use its original guards in lifecycle.js.
 if(asset){await api.remove(id);if((await api.assets()).some(a=>a.asset_id===id))throw new Error(t('Deletion not confirmed by player.'));}
 forgetDeletedMedia(room,id);await persist();
}
