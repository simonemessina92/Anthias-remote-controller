import {rpc} from './vps-adapter.js';
import {t} from './i18n.js';
export async function scanViaVps(targets,{signal,onResult=()=>{},onProgress=()=>{},timeout}={}){
 const {id}=await rpc('/ar/scan',{targets,deep:timeout>2000});let seen=0;
 const stop=()=>void rpc('/ar/scan/stop',{id}).catch(()=>{});
 signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
 try{
  while(true){const state=await rpc('/ar/scan?id='+encodeURIComponent(id));
   for(const result of state.results.slice(seen))onResult(result);seen=state.results.length;
   onProgress(state);
   if(state.done){if(state.fatal)throw new Error(state.fatal);return state;}
   await new Promise(r=>setTimeout(r,200));
  }
 }finally{signal?.removeEventListener('abort',stop);stop();}
}
export async function validateScanNetwork(spec){
 const s=await rpc('/ar/network');
 if(!s.remote)throw new Error(t('Configure the remote router first.'));
 // Every selected target is also checked server-side against the authorized subnet.
 if(!s.handshake)throw new Error(t('WireGuard has no recent handshake. Connect the remote router first.'));
 if(s.route?.dev!=='arwg0')throw new Error(t('Remote subnet is not routed through arwg0. Check Connect remote router.'));
 return s;
}
