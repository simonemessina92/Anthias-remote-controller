import {rpc} from './vps-adapter.js';
import {t} from './i18n.js';
export function playerAccessUrl(port){
 if(!Number.isInteger(port)||port<8444||port>8543)throw new Error(t('Invalid player access port.'));
 const url=new URL(location.href);url.protocol='https:';url.port=String(port);url.pathname='/';url.search='';url.hash='';return url.href;
}
export async function openPlayerAccess(id){
 // Create the tab within the click event, before network awaits.
 const tab=window.open('about:blank','_blank');
 if(!tab)throw new Error(t('Allow pop-ups to open the player GUI.'));
 tab.opener=null;
 try{const {port}=await rpc('/ar/player-access?id='+encodeURIComponent(id));tab.location.replace(playerAccessUrl(port));}
 catch(error){tab.close();throw error;}
}
