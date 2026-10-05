import {rpc} from './vps-adapter.js';
import {t} from './i18n.js';
export const remoteStatus=()=>rpc('/ar/remote');
function el(tag,cls,text){const n=document.createElement(tag);n.className=cls||'';if(text)n.textContent=t(text);return n;}
function btn(text,fn,primary=false){const n=el('button','btn '+(primary?'primary':'secondary'),text);n.type='button';n.onclick=fn;return n;}
export async function renderRemote(body,footer,next){
 body.append(el('span','eyebrow','VPS SETUP'),el('h1','','Connect remote router'),el('p','hint','1. Generate the configuration for the remote LAN. 2. Copy or download it and import it into GL.iNet. 3. Enable WireGuard and Allow Remote Access LAN, then check the connection.'));
 const label=el('label'),input=el('input');input.id='remote-subnet';input.placeholder='192.168.1.0/24';label.append(el('span','','Remote devices subnet'),input);body.append(label);
 const status=el('p','hint'),error=el('p','inline-error');error.id='gate-error';body.append(status,error);
 const run=fn=>async()=>{error.textContent='';try{await fn();}catch(e){error.textContent=e.message;}};
 let saved=null,profile='';
 const detail=el('details','remote-profile'),area=el('textarea');area.readOnly=true;area.rows=8;area.spellcheck=false;area.setAttribute('aria-label',t('WireGuard configuration'));detail.append(el('summary','','View configuration'),area);
 const copy=btn('Copy configuration',run(async()=>{
  if(!profile)throw new Error(t('Generate the configuration first.'));
  try{await navigator.clipboard.writeText(profile);}catch{detail.open=true;area.focus();area.select();if(!document.execCommand('copy'))throw new Error(t('Select the configuration and copy it manually.'));}
  status.textContent=t('Configuration copied. Paste it into WireGuard Client on the remote router.');
 }));
 const download=btn('Download WireGuard profile',run(async()=>{
  if(!profile)throw new Error(t('Generate the configuration first.'));
  const url=URL.createObjectURL(new Blob([profile],{type:'text/plain'}));const a=el('a');a.href=url;a.download='anthias-rooms-router.conf';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }));
 const controls=el('div','remote-profile-actions');controls.append(copy,download);
 const link=el('a','btn secondary','Open remote router');link.target='_blank';link.rel='noopener';
 const setLink=ready=>{link.setAttribute('aria-disabled',String(!ready));link.tabIndex=ready?0:-1;if(ready)link.href=`https://${location.hostname}:8443/`;else link.removeAttribute('href');};setLink(false);
 const syncControls=()=>{const ready=Boolean(profile&&saved&&input.value.trim()===saved.subnet);copy.disabled=download.disabled=!ready;detail.hidden=!profile;};syncControls();
 input.addEventListener('input',()=>{syncControls();setLink(false);});
 const loadProfile=async()=>{({profile}=await rpc('/ar/remote/profile'));area.value=profile;syncControls();};
 body.append(btn('Generate configuration',run(async()=>{
  if(saved&&input.value.trim()!==saved.subnet&&!confirm(t('Changing the subnet interrupts remote access. Continue?')))return;
  profile='';syncControls();setLink(false);
  await rpc('/ar/remote',{subnet:input.value.trim()});saved=(await remoteStatus()).remote;input.value=saved.subnet;await loadProfile();
  status.textContent=t('Configuration ready. Copy or download it, then import it on the remote router.');
 })),controls,detail);
 body.append(el('p','hint','GL.iNet: import under WireGuard Client, enable the connection and Allow Remote Access LAN. The profile routes only the VPS tunnel IP; it does not redirect the router’s Internet traffic.'));
 body.append(el('p','hint','Router access becomes available after the profile is imported, the VPN is connected and Check connection succeeds. During setup you can keep local access using GL.iNet Wi-Fi.'),link);
 const checkNetwork=async()=>{const s=await rpc('/ar/network');setLink(Boolean(s.remote&&s.handshake&&s.routerHttp&&input.value.trim()===s.remote.subnet));status.textContent=[s.handshake?t('WireGuard connected'):t('Waiting for router connection'),t('Remote route')+': '+(s.route?.dev||t('Missing')),t('Router web GUI')+': '+t(s.routerHttp?'Reachable':'Not reachable')].join(' · ');return s;};
 footer.append(btn('Check connection',run(checkNetwork)));
 footer.append(btn('Continue to players',run(async()=>{const s=await checkNetwork();if(!s.remote)throw new Error(t('Generate the configuration first.'));if(input.value.trim()!==s.remote.subnet)throw new Error(t('Generate the configuration for the edited subnet first.'));if(!s.handshake)throw new Error(t('Waiting for router connection'));if(s.route?.dev!=='arwg0')throw new Error(t('Remote subnet is not routed through arwg0. Check Connect remote router.'));await next(s.remote);}),true));
 try{saved=(await remoteStatus()).remote;input.value=saved?.subnet||'';if(saved){await loadProfile();await checkNetwork();}}catch(e){error.textContent=e.message;}
}
