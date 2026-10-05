import {tabHeaders,acceptTabSession,clearTabSession,hasTabToken} from './tab-session.js';
export {tabHeaders,clearTabSession} from './tab-session.js';
// Server storage and cross-browser leases. The GOLDEN files remain untouched.
export const clientId=crypto.randomUUID();
export async function rpc(path,body,method=body===undefined?'GET':'POST') {
  const r=await fetch(path,{method,credentials:'same-origin',headers:{...tabHeaders(),'X-AR-Client':clientId,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await r.json();if(!r.ok){if(r.status===401){clearTabSession();globalThis.dispatchEvent?.(new Event('ar-session-expired'));}throw new Error(value.error||`HTTP ${r.status}`);}acceptTabSession(value);return value;
}
export function proxyUrl(base,path,timeout){return '/ar/proxy?'+new URLSearchParams({base,path,...(timeout?{timeout:String(timeout)}:{})});}
const listeners=new Set();let last='';
const local={
  get:keys=>rpc('/ar/storage/get',{keys}),
  set:async items=>{await rpc('/ar/storage/set',{items});},
  remove:keys=>rpc('/ar/storage/remove',{keys:typeof keys==='string'?[keys]:keys})
};
globalThis.chrome={storage:{local,onChanged:{addListener:fn=>listeners.add(fn)}},permissions:{contains:async()=>true,request:async()=>true},tabs:{create:({url})=>{
  if(url.startsWith('/ar/proxy?'))window.open(url,'_blank','noopener');
  else {const u=new URL(url,location.href);if(u.protocol==='https:'&&u.hostname===location.hostname&&Number(u.port)>=8443&&Number(u.port)<=8543)window.open(u.href,'_blank','noopener');else throw new Error('Unsupported remote address.');}
}}};
Object.defineProperty(navigator,'locks',{value:{request:async(name,options,callback)=>{
  if(typeof options==='function'){callback=options;options={};}
  let acquired=false;
  do {acquired=(await rpc('/ar/locks',{name,action:'acquire'})).acquired;
    if(!acquired){if(options.ifAvailable)return callback(null);await new Promise(r=>setTimeout(r,150));}
  } while(!acquired);
  let renewError=null;const heartbeat=setInterval(()=>rpc('/ar/locks',{name,action:'renew'}).catch(e=>{renewError=e;}),20000);
  try{const result=await callback({name});if(renewError)throw renewError;return result;}
  finally{clearInterval(heartbeat);await rpc('/ar/locks',{name,action:'release'}).catch(()=>{});}
}}});
setInterval(async()=>{
  try{if(!hasTabToken())return;const auth=await rpc('/ar/auth/status');if(!auth.authenticated){clearTabSession();globalThis.dispatchEvent?.(new Event('ar-session-expired'));return;}
    const value=await local.get('hmrConfig'),serialized=JSON.stringify(value);
    if(last&&serialized!==last)for(const fn of listeners)void fn({hmrConfig:{newValue:value.hmrConfig}},'local');last=serialized;
  }catch{}
},2500).unref?.();
