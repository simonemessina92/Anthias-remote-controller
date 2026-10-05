const KEY='arTabToken';
const navigation=globalThis.performance?.getEntriesByType?.('navigation')?.[0]?.type;
// Only an explicit reload keeps this tab's credential. New/duplicated/restored
// navigations never use a credential copied from another browser tab.
let token='';
try{if(navigation==='reload')token=sessionStorage.getItem(KEY)||'';else sessionStorage.removeItem(KEY);}catch{}
export const tabHeaders=()=>token?{'X-AR-Tab':token}:{};
export function acceptTabSession(value){if(value?.tabToken){token=value.tabToken;try{sessionStorage.setItem(KEY,token);}catch{}}}
export function clearTabSession(){token='';try{sessionStorage.removeItem(KEY);}catch{}}
export const hasTabToken=()=>Boolean(token);
globalThis.addEventListener?.('pagehide',()=>{
 if(token)void fetch('/ar/auth/suspend',{method:'POST',credentials:'same-origin',headers:tabHeaders(),keepalive:true}).catch(()=>{});
});
