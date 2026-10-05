import {t,setLanguage,getLanguage,translateDOM} from './i18n.js';
import {AnthiasApi,normalizeBase,originPermission,mediaKind,isLocalMedia,assertReady,processingError,fileKind} from './api.js';
import {loadConfig,migrateConfig,updateConfig,saveRoomSnapshot,appendPlayer,newRoom,normalizeName,unique,itemIds,readJournal,saveJournal,clearJournal,exportConfig} from './storage.js';
import {MANUAL_SCHEDULE,playlistState,restoreJournal} from './logic.js';
import {publishRoom,mapPlaylist,cleanupRoom} from './lifecycle.js';
import {deleteMedia,deletionPlan,deletionMessage,reconcileDeletion,validDeletionReceipt} from './manual-delete.js';
import {authRecord,hasSession,login,setPassword,disablePassword,lockSession} from './auth.js';
import {scanTargets,permissionsFor,scanPlayers,identifyPlayer,classifyResult,ipv4,ipString,networkSpec,playerIdentity,SCAN_PROFILES} from './discovery.js';
import {showAssetPreview,showLocalPreview,emptyPreview,cacheUploadedPreview,forgetPreview,releasePreview,stopPreview} from './previews.js';

import {editorSnapshot,editorHasChanges} from './editor-state.js';
import {homeSelectionBlock,homeMediaDraft} from './media-library.js';
import {getPanelAddress,copyPanelAddress} from './panel-address.js';

const $=id=>document.getElementById(id),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const runtime=new Map(),operations=new Map(),roomNodes=new Map(),previewIndexes=new Map(),logs=[];
let config,security,admitted=false,selectedId='',view='content',editingId=null,savingPlayer=false;
let editor=null,library=null,fleet=null,discovery=null,infoRoomId='',toastTimer,settingsSignature='',gateStage='',wizardRows=[],wizardBusy=false,securityMode='change';
const byId=id=>config?.rooms.find(r=>r.id===id),room=()=>byId(selectedId);
const state=id=>{if(!runtime.has(id))runtime.set(id,{assets:[],online:null,updated:0,error:'',operationError:'',pending:null,revision:0,journal:null});return runtime.get(id);};
const online=r=>Boolean(r?.base&&!state(r.id).reboot&&state(r.id).online&&Date.now()-state(r.id).updated<45000);
const label=r=>`${t('Player {number}',{number:r.number})} · ${r.name}`;
const titleOf=a=>String(a?.name||'').replace(/^\[HMR\] (?:Hotel|Evento|Home|Event) - [a-f0-9]{8} - /,'');
const roomLock=r=>`hmr-player-v3:${r.base||r.id}`;
const apiFor=r=>new AnthiasApi(r.base,item=>log(r.id,item));
const node=(tag,cls='',text='')=>{const el=document.createElement(tag);el.className=cls;el.textContent=text;return el;};
const ready=a=>{try{assertReady(a);return true;}catch{return false;}};
function log(id,item){logs.push({time:new Date().toISOString(),player:id,...item});if(logs.length>400)logs.shift();}
function action(el,fn,event='click') {el.addEventListener(event,e=>{try{Promise.resolve(fn(e)).catch(report);}catch(error){report(error);}});}
function button(text,cls,fn){const b=node('button',cls,text);b.type='button';action(b,fn);return b;}
function checkboxHit(input){const label=node('label','check-hit');label.append(input);return label;}
function textInput(value='',placeholder=''){const i=node('input');i.type='text';i.value=value;i.placeholder=placeholder;return i;}
function report(error){const message=error?.message||String(error);log(selectedId,{error:message});toast(message,'error');}
function positionToast(){
  const target=$('toast');if(target.hidden)return;
  const anchor=$(view==='settings'?'settings-notice-anchor':'notice-anchor');
  const rect=admitted&&!document.querySelector('dialog[open]')?anchor?.getBoundingClientRect():null;
  const usable=rect&&rect.width>120&&rect.height>0;
  // Keep short notices content-sized; the header slot only sets the wrapping limit.
  const maximum=Math.max(0,Math.min(usable?rect.width:540,window.innerWidth-24));
  target.style.width='max-content';target.style.maxWidth=`${maximum}px`;target.style.maxHeight=`${Math.min(120,window.innerHeight-24)}px`;
  const width=target.getBoundingClientRect().width;
  const left=usable?rect.left+(rect.width-width)/2:((window.innerWidth-width)/2);
  const top=usable?rect.top+(rect.height-target.offsetHeight)/2:12;
  target.style.left=`${Math.max(12,Math.min(left,window.innerWidth-width-12))}px`;
  target.style.top=`${Math.max(8,top)}px`;
}
function toast(text,kind='success'){
  clearTimeout(toastTimer);const target=$('toast');target.className=`toast ${kind}`;
  $('toast-text').textContent=text;target.title=text;target.hidden=false;
  if(target.showPopover&&!target.matches(':popover-open'))target.showPopover();
  positionToast();toastTimer=setTimeout(hideToast,kind==='success'?4500:kind==='warning'?7000:11000);
}
function hideToast(){clearTimeout(toastTimer);if($('toast').hidePopover&&$('toast').matches(':popover-open'))$('toast').hidePopover();$('toast').hidden=true;}
function closeDialog(id){if($(id).open)$(id).close();}
function describe(a){if(!a)return t('Missing file');if(a.is_processing)return t('Processing…');if(processingError(a))return t('Preview unavailable');const m=a.metadata||{};return [t(mediaKind(a)==='video'?'Video':mediaKind(a)==='image'?'Image':'Web content'),m.video_width&&m.video_height?`${m.video_width} × ${m.video_height}`:''].filter(Boolean).join(' · ');}
function mode(r){if(!r?.base)return {role:'unconfigured'};if(state(r.id).reboot)return {role:'rebooting'};if(!online(r))return {role:state(r.id).online===null?'checking':'offline'};return playlistState(state(r.id).assets,r);}
function statusLabel(role){return t(({home:'Home live',event:'Event live',other:'External content',empty:'No active content',unconfigured:'Not configured',checking:'Checking…',offline:'Offline',rebooting:'Rebooting…'})[role]||'Unknown');}
function getShown(r,role){const status=mode(r);const items=status.role===role?status.items:r.playlists[role];return {status,items,assets:items.map(item=>state(r.id).assets.find(a=>a.asset_id===item.id)).filter(Boolean)};}
function renderRooms(){
  const term=$('room-search').value.toLowerCase(),valid=new Set(config.rooms.map(r=>r.id));
  for(const [id,el]of roomNodes)if(!valid.has(id)){el.remove();roomNodes.delete(id);}
  for(const r of config.rooms){
    let b=roomNodes.get(r.id);
    if(!b){b=button('','room-button',()=>selectRoom(r.id));b.dataset.room=r.id;const text=node('span','room-label');text.append(node('strong'),node('small'));b.append(node('span','room-num',String(r.number).padStart(2,'0')),text,node('span','tiny-dot'));roomNodes.set(r.id,b);$('room-list').append(b);}
    b.hidden=Boolean(term&&!`${r.name} player ${r.number}`.toLowerCase().includes(term));b.classList.toggle('selected',r.id===selectedId);b.setAttribute('aria-current',String(r.id===selectedId));b.title=`${label(r)} · ${statusLabel(mode(r).role)}`;
    b.querySelector('.room-num').textContent=String(r.number).padStart(2,'0');b.querySelector('strong').textContent=r.name;b.querySelector('small').textContent=`${t('Player {number}',{number:r.number})} · ${operations.has(r.id)?t('Operation in progress…'):statusLabel(mode(r).role)}`;
    b.querySelector('.tiny-dot').className=`tiny-dot ${online(r)?'online':state(r.id).online===false?'offline':''}`;
  }
  $('room-count').textContent=config.rooms.length;$('room-search').hidden=config.rooms.length<7;
  $('fleet-status').textContent=t('{online} / {total} connected',{online:config.rooms.filter(online).length,total:config.rooms.length});
}
function renderCard(r,role){
  const {status,items}=getShown(r,role),active=status.role===role,op=operations.has(r.id)||Boolean(state(r.id).reboot),key=`${r.id}:${role}`;
  const index=Math.min(previewIndexes.get(key)||0,Math.max(0,items.length-1));previewIndexes.set(key,index);
  const asset=state(r.id).assets.find(a=>a.asset_id===items[index]?.id);
  $(`${role}-card`).classList.toggle('is-live',active);
  $(`${role}-state`).textContent=active?'LIVE':t(!online(r)?'Not verified':items.length?'Ready':'Empty');
  if(asset)showAssetPreview($(`${role}-preview`),r.base,asset);else emptyPreview($(`${role}-preview`),t(items.length?'Missing file':'Image or video'),items.length?'':t('Drop files or choose from your computer'));
  $(`${role}-name`).textContent=asset?titleOf(asset):t(items.length?'Missing file':'No content selected');$(`${role}-name`).title=$(`${role}-name`).textContent;
  $(`${role}-meta`).textContent=asset?describe(asset):'';
  $(`${role}-count`).textContent=items.length?`${index+1} / ${items.length}`:'0 / 0';
  for(const direction of ['prev','next']){$(`${role}-${direction}`).disabled=items.length<2;$(`${role}-${direction}`).title=t(direction==='prev'?'Back':'Next');}
  $(`${role}-expand`).disabled=!asset;
  const prepared=active&&JSON.stringify(items)!==JSON.stringify(r.playlists[role]);$(`${role}-prepared`).hidden=!prepared;$(`${role}-prepared`).textContent=t('Prepared changes');
  $(`show-${role}`).textContent=active&&!prepared?`${role==='home'?t('Home content'):t('Event')} · LIVE`:t(role==='home'?'Show home':'Show event');
  $(`show-${role}`).classList.toggle('current',active&&!prepared);$(`show-${role}`).disabled=op||!r.base||!r.playlists[role].length;
  $(`edit-${role}`).textContent=t('Edit playlist');$(`edit-${role}`).disabled=op||!r.base;$(`pick-${role}`).disabled=op||!r.base;
  $(`${role}-drop`).setAttribute('aria-disabled',String(op||!r.base));
}
function render(){
  if(!config||!admitted)return;
  if(!room())selectedId=config.rooms[0]?.id||'';
  for(const name of ['content','settings']){$(`nav-${name}`).classList.toggle('selected',view===name);$(`nav-${name}`).setAttribute('aria-pressed',String(view===name));$(`${name}-view`).hidden=view!==name;}
  $('lock').hidden=!security?.enabled;
  renderRooms();if(view==='settings')renderSettings();
  $('restore-selected').disabled=!config.rooms.length||Boolean(fleet?.running);
  const r=room();$('no-rooms').hidden=Boolean(r);$('room-content').hidden=!r;$('room-title').textContent=r?r.name:t('Contents');$('player-subtitle').textContent=r?t('Player {number}',{number:r.number}):'';
  $('player-media').hidden=$('quick-reboot').hidden=!r;
  $('player-media').disabled=!r?.base||Boolean(r&&operations.has(r.id))||Boolean(r&&state(r.id).reboot);
  $('quick-reboot').disabled=!r||!online(r)||operations.has(r.id)||Boolean(state(r.id).reboot);
  if(!r)return;
  $('quick-reboot').title=`${t('Reboot player')} · ${label(r)}`;$('quick-reboot').setAttribute('aria-label',$('quick-reboot').title);
  const s=state(r.id),op=operations.get(r.id),status=mode(r);
  $('connection').textContent=t(s.reboot?'Rebooting…':online(r)?'Connected':!r.base?'Not configured':s.online===null?'Checking…':'Offline');$('connection').className=`badge ${s.reboot?'rebooting':online(r)?'online':s.online===false?'offline':''}`;$('connection').title=s.error||'';
  $('mode-status').textContent=statusLabel(status.role);
  $('unconfigured').hidden=Boolean(r.base);$('work-area').hidden=!r.base;
  $('recovery').hidden=!s.journal;$('recover').disabled=Boolean(op);
  renderCard(r,'home');renderCard(r,'event');positionToast();
  $('room-operation').hidden=!op;if(op){$('operation-label').textContent=op.text;if(typeof op.percent==='number')$('progress').value=op.percent;else $('progress').removeAttribute('value');}
  $('status-detail').textContent=[s.updated?t('Playlist checked at {time}',{time:new Date(s.updated).toLocaleTimeString(getLanguage()==='it'?'it-IT':'en-GB')}):'',t('File previews · not a live HDMI return')].filter(Boolean).join(' · ');
  $('cleanup-status').textContent=r.cleanup.length?t('{count} files awaiting cleanup',{count:r.cleanup.length}):'';$('retry-cleanup').hidden=!r.cleanup.length;$('retry-cleanup').disabled=Boolean(op)||!config.autoCleanup;
}
async function refreshRoom(id,{duringOperation=false}={}){
  if(!admitted)return;const r=byId(id);if(!r?.base||(operations.has(id)&&!duringOperation))return;
  const s=state(id);if(s.pending)return s.pending;if(s.reboot&&Date.now()<s.reboot.notBefore)return;
  const base=r.base,revision=s.revision,wasOnline=s.online;
  s.pending=(async()=>{
    try{
      if(!await chrome.permissions.contains({origins:[originPermission(base)]}))throw new Error(t('Network permission missing. Edit and save the player, or grant access in Settings.'));
      const api=apiFor(r),assets=await api.assets(s.reboot?{timeout:2200}:{});
      if(byId(id)?.base!==base||s.revision!==revision||!admitted)return;
      if(s.reboot){
        const reboot=s.reboot;let restarted=reboot.sawOffline;
        if(!restarted&&reboot.previousUptime!==null){
          const info=await api.request('/api/v2/info',{timeout:2500}).catch(()=>null);
          const current=uptimeSeconds(info);restarted=current!==null&&current+1<reboot.previousUptime;
        }
        if(restarted){s.reboot=null;toast(`${label(r)}: ${t('Player is back online.')}`);}
        else if(Date.now()>reboot.deadline){s.reboot=null;toast(`${label(r)}: ${t('Player is reachable. Restart could not be confirmed.')}`,'warning');}
        else{s.assets=assets;s.online=true;s.error='';return;}
      }
      s.assets=assets;s.online=true;s.updated=Date.now();s.error='';
      setTimeout(()=>void resumeManualReceipt(id).catch(error=>log(id,{error:error.message})),0);
      if(wasOnline===false&&!s.reboot&&id===selectedId)log(id,{connection:'online'});
    }catch(error){
      if(byId(id)?.base!==base||s.revision!==revision)return;
      if(s.reboot){s.reboot.sawOffline=true;s.online=false;if(Date.now()>s.reboot.deadline){s.reboot=null;s.error=t('Player did not return after the restart. Check its power and network.');toast(`${label(r)}: ${s.error}`,'error');}}
      else{s.online=false;s.error=error.message;if(wasOnline!==false&&id===selectedId&&admitted)toast(`${label(r)}: ${error.message}`,'error');}
    }finally{s.pending=null;render();if(fleet&&!fleet.running&&!fleet.done)updateFleetRows();}
  })();return s.pending;
}
function uptimeSeconds(info){
  if(!info?.uptime)return null;const days=Number(info.uptime.days),hours=Number(info.uptime.hours);
  return Number.isFinite(days)&&Number.isFinite(hours)?days*86400+hours*3600:null;
}
async function refreshAll(){if(!admitted)return;const ids=config.rooms.map(r=>r.id);let cursor=0;await Promise.all(Array.from({length:Math.min(4,ids.length)},async()=>{while(cursor<ids.length&&admitted)await refreshRoom(ids[cursor++]);}));}
async function selectRoom(id){for(const role of ['home','event'])releasePreview($(`${role}-preview`));selectedId=id;view='content';render();void refreshRoom(id);}
function confirmAction(title,text,yes=t('Confirm'),danger=false){
  return new Promise(resolve=>{
    const d=$('confirm-dialog');if(d.open){resolve(false);return;}
    $('confirm-title').textContent=title;$('confirm-text').textContent=text;$('confirm-yes').textContent=yes;$('confirm-yes').className=`btn ${danger?'danger':'primary'}`;
    const abort=new AbortController();let done=false;const finish=value=>{if(done)return;done=true;abort.abort();d.close();resolve(value);};
    $('confirm-yes').addEventListener('click',()=>finish(true),{signal:abort.signal});$('confirm-no').addEventListener('click',()=>finish(false),{signal:abort.signal});d.addEventListener('cancel',e=>{e.preventDefault();finish(false);},{signal:abort.signal});d.showModal();$('confirm-no').focus();
  });
}
async function requireUnlocked(){security=await authRecord();if(!admitted||!security||!hasSession(security))throw new Error(t('Panel locked'));}
async function withRoom(id,fn,{silent=false,refreshAfter=true}={}){
  const initial=byId(id);if(!initial?.base){if(!silent)toast(t('Player is not configured.'),'warning');return {ok:false,error:t('Player is not configured.')};}
  if(operations.has(id)){if(!silent)toast(t('Finish the current operation first.'),'warning');return {ok:false,error:t('Finish the current operation first.')};}
  const op={text:t('Checking playlist…'),percent:null};operations.set(id,op);state(id).operationError='';render();let result={ok:false};
  try{
    await requireUnlocked();
    await navigator.locks.request(roomLock(initial),{ifAvailable:true},async lock=>{
      if(!lock)throw new Error(t('Another tab is changing this player.'));
      const latest=await loadConfig(),found=latest.rooms.find(r=>r.id===id);if(!found||found.base!==initial.base)throw new Error(t('Player configuration changed. Reopen it and try again.'));
      config=latest;const r=structuredClone(found),s=state(id);if(s.pending)await s.pending;s.revision++;
      if(!await chrome.permissions.contains({origins:[originPermission(r.base)]}))throw new Error(t('Network permission missing. Edit and save the player, or grant access in Settings.'));
      const api=apiFor(r),persist=async()=>{config=await saveRoomSnapshot(r);render();};
      const progress=(text,percent=null)=>{op.text=text;op.percent=percent;render();if(editor?.roomId===id&&editor.busy){$('editor-progress-text').textContent=text;$('editor-progress').hidden=false;if(typeof percent==='number')$('editor-progress').value=percent;else $('editor-progress').removeAttribute('value');}};
      const ensure=async()=>{if(await readJournal(id))throw new Error(t('Complete playlist recovery before other changes.'));};
      const ctx={r,api,persist,progress,ensure};await settleManualReceipt(ctx);
      const value=await fn(ctx);result={ok:true,value};
      s.journal=await readJournal(id);
      if(refreshAfter)try{s.assets=await api.assets();s.online=true;s.updated=Date.now();s.error='';}catch(error){s.online=false;s.error=error.message;}
    });
  }catch(error){state(id).operationError=error.message;log(id,{error:error.message});if(!silent)toast(error.message,'error');result={ok:false,error:error.message};state(id).journal=await readJournal(id).catch(()=>null);}
  finally{operations.delete(id);render();}return result;
}
async function activate(ctx,role){
  await ctx.ensure();const result=await publishRoom(ctx.api,ctx.r,role,{persist:ctx.persist,autoCleanup:config.autoCleanup,progress:ctx.progress,saveJournal:value=>saveJournal(ctx.r.id,value),clearJournal:()=>clearJournal(ctx.r.id)});
  Object.assign(state(ctx.r.id),{assets:result.assets,online:true,updated:Date.now(),error:''});render();
  if(ctx.r.cleanup.length)setTimeout(()=>void cleanRoom(ctx.r.id),3400);
  return result;
}
async function showRole(role){
  const r=room();if(!r)return;
  if(role==='home'&&mode(r).role==='event'&&!await confirmAction(`${t('Switch to Home?')} · ${label(r)}`,t('The player returns to its own Home playlist. Temporary event uploads are removed only when automatic cleanup is enabled.'),t('Show home')))return;
  for(const name of ['home','event'])stopPreview($(`${name}-preview`));
  const result=await withRoom(r.id,ctx=>activate(ctx,role));
  if(result.ok)toast(`${label(r)}: ${result.value.warning||t(result.value.unchanged?'Already active; no playback restart sent.':'Playlist published.')}`,result.value.warning?'warning':'success');
}
async function cleanRoom(id,force=false){
  const r=byId(id);if(!admitted||!r||!config.autoCleanup||operations.has(id)||!r.cleanup.some(j=>force||j.notBefore<=Date.now()))return;
  const result=await withRoom(id,async ctx=>{if(!config.autoCleanup)return {deleted:[],pending:[]};await ctx.ensure();ctx.progress(t('Cleaning up temporary events…'));if(force)ctx.r.cleanup.forEach(j=>j.notBefore=0);return cleanupRoom(ctx.api,ctx.r,ctx.persist,{onDeleted:assetId=>void forgetPreview(ctx.r.base,assetId),enabled:()=>config.autoCleanup});},{silent:!force});
  if(force&&result.ok)toast(t(result.value.pending.length?'Cleanup pending':'Cleaned up'),result.value.pending.length?'warning':'success');
  return result;
}
function validateFile(file){const kind=fileKind(file);if(!file.size||file.size>2*1024**3)throw new Error(t('Choose a non-empty file up to 2 GB.'));return kind;}
function makeDraft(file){return {key:crypto.randomUUID(),file,kind:validateFile(file),id:'',duration:config.defaultImageDuration};}
function openEditor(role,files=null){
  const r=room();if(!r?.base)throw new Error(t('Player is not configured.'));if(operations.has(r.id))throw new Error(t('Finish the current operation first.'));
  const existingItems=r.playlists[role].map(item=>({key:crypto.randomUUID(),id:item.id,file:null,kind:mediaKind(state(r.id).assets.find(a=>a.asset_id===item.id)),duration:item.duration??state(r.id).assets.find(a=>a.asset_id===item.id)?.duration??config.defaultImageDuration}));
  const items=files?Array.from(files).map(makeDraft):existingItems;
  if(items.length>100)throw new Error(t('A playlist can contain up to 100 items.'));
  editor={roomId:r.id,role,items,original:JSON.stringify(r.playlists[role]),baseline:editorSnapshot(existingItems),busy:false,dragKey:null};
  setEditorBusy(false);$('editor-error').textContent='';$('editor-progress-text').textContent='';$('editor-progress').hidden=true;renderEditor();$('editor-dialog').showModal();
}
function setEditorBusy(value){if(!editor)return;editor.busy=value;for(const id of ['editor-close','editor-add','editor-library','editor-clear','editor-save','editor-publish'])$(id).disabled=value;$('editor-list').querySelectorAll('button,input').forEach(el=>{el.disabled=value;});}
function updateEditorSummary(){if(editor)$('editor-summary').textContent=t('{count} items',{count:editor.items.length});}
function renderEditor(){
  if(!editor)return;const r=byId(editor.roomId);if(!r)return;
  $('editor-player').textContent=label(r);$('editor-title').textContent=`${t(editor.role==='home'?'Home content':'Event')} · ${t('Edit playlist')}`;
  $('editor-library').hidden=editor.role!=='home';$('editor-library').disabled=editor.busy;
  $('editor-list').querySelectorAll('.preview').forEach(releasePreview);$('editor-list').replaceChildren();updateEditorSummary();
  if(!editor.items.length){const empty=node('div','empty-state');empty.append(node('div','empty-symbol','＋'),node('h3','',t('Add or drop several files, then arrange the sequence.')));$('editor-list').append(empty);}
  editor.items.forEach((item,index)=>{
    const row=node('div','editor-row');row.dataset.key=item.key;row.draggable=true;
    const grip=node('span','drag-handle','⠿');grip.title=t('Move up');row.append(grip,node('span','item-index',String(index+1).padStart(2,'0')));
    const thumb=node('div','item-thumb preview'),a=state(r.id).assets.find(a=>a.asset_id===item.id);
    if(item.file)showLocalPreview(thumb,item.file,item.kind);else if(a)void showAssetPreview(thumb,r.base,a,{compact:true});else emptyPreview(thumb,t('Missing file'));
    row.append(thumb);const text=node('div','item-label');text.append(node('strong','',item.file?.name||titleOf(a)||item.id),node('small','',item.id?t('Ready on player'):t('Local file')));text.firstChild.title=text.firstChild.textContent;row.append(text);
    const kind=item.kind||mediaKind(a),timing=node('div','timing');
    if(kind==='video')timing.append(node('span','muted',t('To end')));
    else{const input=node('input');input.type='number';input.min='1';input.max='86400';input.value=item.duration||config.defaultImageDuration;input.setAttribute('aria-label',`${t('Duration')} ${index+1}`);action(input,()=>{const value=Number(input.value);item.duration=value;},'input');timing.append(input,node('span','muted','s'));}
    row.append(timing);const tools=node('div','item-tools');
    const up=button('↑','icon-btn',()=>moveEditor(item.key,-1)),down=button('↓','icon-btn',()=>moveEditor(item.key,1)),remove=button('×','icon-btn',()=>{editor.items=editor.items.filter(x=>x.key!==item.key);renderEditor();});
    up.title=t('Move up');up.setAttribute('aria-label',up.title);up.disabled=index===0;down.title=t('Move down');down.setAttribute('aria-label',down.title);down.disabled=index===editor.items.length-1;remove.title=t('Remove item');remove.setAttribute('aria-label',remove.title);tools.append(up,down,remove);row.append(tools);
    row.addEventListener('dragstart',e=>{if(editor.busy||e.target.closest('input,button,video')){e.preventDefault();return;}editor.dragKey=item.key;e.dataTransfer.setData('text/plain',item.key);e.dataTransfer.effectAllowed='move';row.classList.add('dragging');});
    row.addEventListener('dragend',()=>{row.classList.remove('dragging');document.querySelectorAll('.drop-target').forEach(el=>el.classList.remove('drop-target'));if(editor)editor.dragKey=null;});
    row.addEventListener('dragover',e=>{e.preventDefault();if(editor?.dragKey&&!editor.busy)row.classList.add('drop-target');});row.addEventListener('dragleave',()=>row.classList.remove('drop-target'));
    row.addEventListener('drop',e=>{if(!editor?.dragKey||editor.busy)return;e.preventDefault();e.stopPropagation();const from=editor.items.findIndex(x=>x.key===editor.dragKey),to=editor.items.findIndex(x=>x.key===item.key);if(from<0||to<0)return;const [moving]=editor.items.splice(from,1);editor.items.splice(to,0,moving);editor.dragKey=null;renderEditor();});
    $('editor-list').append(row);
  });
  $('editor-publish').textContent=t(editor.items.some(x=>x.file&&!x.id)?'Upload and show':editor.role==='home'?'Show home':'Show event');
  $('editor-save').disabled=false;$('editor-publish').disabled=!editor.items.length;
}
function moveEditor(key,direction){if(!editor||editor.busy)return;const i=editor.items.findIndex(x=>x.key===key),j=i+direction;if(i<0||j<0||j>=editor.items.length)return;[editor.items[i],editor.items[j]]=[editor.items[j],editor.items[i]];renderEditor();}
function appendFiles(files){if(!editor||editor.busy)return;const additions=Array.from(files).map(makeDraft);if(additions.length+editor.items.length>100)throw new Error(t('A playlist can contain up to 100 items.'));editor.items.push(...additions);renderEditor();}
async function closeEditor(){if(!editor||editor.busy)return;if(editorHasChanges(editor)&&!await confirmAction(t('Discard changes?'),t('Unsaved changes in this editor will be lost. Files already uploaded remain in player memory.'),t('Discard')))return;closeDialog('editor-dialog');editor=null;}
async function uploadAsset(ctx,role,item){
  const {r,api,persist,progress}=ctx;
  if(item.id){const a=await api.get(item.id);assertReady(a);return a;}
  const file=item.file,kind=validateFile(file),pendingKey=`hmrUpload:${r.id}`;
  // One asset registration at a time. Preserve the uncertain transfer instead of blindly uploading again.
  const pending=(await chrome.storage.local.get(pendingKey))[pendingKey];
  let response,name;
  if(pending){
    const matches=(await api.assets()).filter(a=>a.name===pending.name&&a.uri);
    if(matches.length===1){
      r.uploadedIds=unique([...r.uploadedIds,matches[0].asset_id]);if(pending.role==='event')r.managedEventIds=unique([...r.managedEventIds,matches[0].asset_id]);await persist();await chrome.storage.local.remove(pendingKey);
      if(pending.draftKey===item.key){item.id=matches[0].asset_id;assertReady(matches[0]);return matches[0];}
    }else throw new Error(t('File transferred, registration not confirmed. Check player memory before uploading it again.'));
  }
  progress(t('Uploading {name}',{name:file.name}),0);
  response=await api.upload(file,p=>progress(t('Uploading {name}',{name:file.name}),p));
  name=`[HMR] ${role==='home'?'Home':'Event'} - ${crypto.randomUUID().slice(0,8)} - ${file.name.slice(0,180)}`;
  await chrome.storage.local.set({[pendingKey]:{name,uri:response.uri,ext:response.ext,role,draftKey:item.key,time:new Date().toISOString(),base:r.base}});
  progress(t('Registering file…'));let asset;
  try{asset=await api.create({name,uri:response.uri,ext:response.ext,mimetype:kind,duration:kind==='video'?0:item.duration||config.defaultImageDuration,is_enabled:false,...MANUAL_SCHEDULE,play_order:0,skip_asset_check:false,skip_ssl_verify:false});}
  catch(error){const matches=await api.assets().then(all=>all.filter(a=>a.name===name)).catch(()=>[]);if(matches.length===1)asset=matches[0];else throw new Error(`${t('File transferred, registration not confirmed. Check player memory before uploading it again.')} ${error.message}`);}
  if(!asset?.asset_id)throw new Error(t('The player did not return an asset identifier.'));
  item.id=asset.asset_id;r.uploadedIds=unique([...r.uploadedIds,asset.asset_id]);if(role==='event')r.managedEventIds=unique([...r.managedEventIds,asset.asset_id]);await persist();await chrome.storage.local.remove(pendingKey);
  const deadline=Date.now()+300000;
  while(asset.is_processing&&Date.now()<deadline){progress(t('Processing…'));await pause(1500);asset=await api.get(asset.asset_id);}
  if(asset.is_processing)throw new Error(t('Processing is taking longer than expected. The upload is retained; retry from this editor when ready.'));
  assertReady(asset);void cacheUploadedPreview(r.base,asset,file);return asset;
}
async function saveEditor(publish){
  const draft=editor;if(!draft||draft.busy)return;
  try{
    if(publish&&!draft.items.length)throw new Error(t('Choose at least one file.'));
    for(const item of draft.items)if(item.kind!=='video'&&(!Number.isInteger(item.duration)||item.duration<1||item.duration>86400))throw new Error(t('Image duration must be between 1 and 86400 seconds.'));
    const r=byId(draft.roomId);
    if(publish&&draft.role==='home'&&mode(r).role==='event'&&!await confirmAction(t('Switch to Home?'),t('The player returns to its own Home playlist. Temporary event uploads are removed only when automatic cleanup is enabled.'),t('Show home')))return;
    setEditorBusy(true);$('editor-error').textContent='';
    const result=await withRoom(draft.roomId,async ctx=>{
      await ctx.ensure();
      if(JSON.stringify(ctx.r.playlists[draft.role])!==draft.original)throw new Error(t('A different tab changed this playlist. Reopen the editor before saving.'));
      if(publish&&draft.role==='event'){
        if(!ctx.r.playlists.home.length)throw new Error(t('Set a ready Home playlist before showing an event.'));
        const existing=await ctx.api.assets();for(const item of ctx.r.playlists.home)assertReady(existing.find(a=>a.asset_id===item.id));
      }
      for(const item of draft.items)await uploadAssetOrCheck(ctx,draft.role,item);
      const assets=await ctx.api.assets();
      const items=draft.items.map(item=>({id:item.id,duration:mediaKind(assets.find(a=>a.asset_id===item.id))==='image'?item.duration:null}));
      await mapPlaylist(ctx.r,draft.role,items,assets,ctx.persist);draft.original=JSON.stringify(items);draft.baseline=editorSnapshot(draft.items);
      if(publish)return activate(ctx,draft.role);return {warning:'',unchanged:false};
    });
    if(result.ok){closeDialog('editor-dialog');editor=null;toast(result.value?.warning||t(publish?'Playlist published.':'Playlist saved; playback unchanged.'),result.value?.warning?'warning':'success');}
    else{$('editor-error').textContent=result.error||'';setEditorBusy(false);}
  }catch(error){$('editor-error').textContent=error.message;setEditorBusy(false);}
  finally{if(editor===draft){setEditorBusy(false);$('editor-progress').hidden=true;$('editor-progress-text').textContent='';}}
}
async function uploadAssetOrCheck(ctx,role,item){if(item.id){const a=await ctx.api.get(item.id);assertReady(a);return a;}return uploadAsset(ctx,role,item);}
async function openLibrary(id=infoRoomId,{pickForHome=false}={}){
  const r=byId(id);if(!r?.base)return;
  // Reuse is available only from the Home editor. Event remains upload-only.
  const draft=pickForHome?editor:null;
  if(pickForHome&&(!draft||draft.role!=='home'||draft.roomId!==id||draft.busy))return;
  library={roomId:r.id,assets:[],editor:draft,selected:new Set(),loaded:false};
  $('library-title').textContent=`${label(r)} · ${t(pickForHome?'Add from player media':'Player media')}`;
  $('library-search').value='';$('library-error').textContent='';$('library-list').replaceChildren(node('p','muted',t('Loading…')));
  $('library-note').textContent=t(pickForHome?'Select files to add to Home. Playback changes only when you publish.':'All player assets can be deleted after confirmation, including LIVE and assigned content.');
  $('library-use').hidden=!pickForHome;$('library-use').disabled=true;$('library-dialog').showModal();
  const ref=library;try{ref.assets=await apiFor(r).assets();if(library===ref){ref.loaded=true;state(r.id).assets=ref.assets;renderLibrary();}}
  catch(error){if(library===ref)$('library-list').replaceChildren(node('p','inline-error',error.message));}
}
function renderLibrary(){
  if(!library||!library.loaded)return;const r=byId(library.roomId);if(!r)return;
  const ref=library,picking=Boolean(ref.editor),term=$('library-search').value.toLowerCase();$('library-list').replaceChildren();
  $('library-title').textContent=`${label(r)} · ${t(picking?'Add from player media':'Player media')}`;
  $('library-note').textContent=t(picking?'Select files to add to Home. Playback changes only when you publish.':'All player assets can be deleted after confirmation, including LIVE and assigned content.');
  const assets=ref.assets.filter(a=>(!picking||isLocalMedia(a))&&`${titleOf(a)} ${a.asset_id}`.toLowerCase().includes(term));
  if(!assets.length)$('library-list').append(node('p','muted',t('No matching files.')));
  for(const asset of assets){
    const row=node('div','library-row'),text=node('div','row-label'),name=node('strong','',titleOf(asset));name.title=name.textContent;row.dataset.asset=asset.asset_id;
    const plan=picking?null:deletionPlan(ref.assets,r,asset.asset_id);
    const block=picking?homeSelectionBlock(asset,r,ref.editor.items):[plan?.live?'LIVE':'',...(plan?.roles||[]).map(role=>t(role==='home'?'Home content':'Event'))].filter(Boolean).join(' · ');
    if(picking){
      const check=node('input');check.type='checkbox';check.disabled=Boolean(block);check.checked=ref.selected.has(asset.asset_id);check.setAttribute('aria-label',titleOf(asset));
      action(check,()=>{if(library!==ref)return;$('library-error').textContent='';if(check.checked)ref.selected.add(asset.asset_id);else ref.selected.delete(asset.asset_id);$('library-use').disabled=!ref.selected.size;},'change');row.append(checkboxHit(check));
    }else row.append(node('span','room-num',mediaKind(asset)==='video'?'▶':'▧'));
    text.append(name,node('small','',describe(asset)));if(block)text.append(node('small','file-protection',block));row.append(text);
    if(!picking){const b=button(t('Delete'),'btn danger',()=>deleteLibraryAsset(asset.asset_id));b.disabled=Boolean(ref.busy);b.title=t('Delete after confirmation');row.append(b);}
    $('library-list').append(row);
  }
  $('library-use').disabled=!picking||!ref.selected.size;
}
function useHomeMedia(){
  const ref=library,draft=ref?.editor;
  if(!draft||editor!==draft||draft.role!=='home'||draft.busy)return;
  try{
    const r=byId(ref.roomId),assets=ref.assets.filter(a=>ref.selected.has(a.asset_id));
    if(!r||!assets.length)return;
    if(draft.items.length+assets.length>100)throw new Error(t('A playlist can contain up to 100 items.'));
    // Validate the complete selection before changing the draft. This never writes to a player.
    const additions=assets.map(asset=>{const block=homeSelectionBlock(asset,r,draft.items);if(block)throw new Error(block);return homeMediaDraft(asset,config.defaultImageDuration);});
    draft.items.push(...additions);closeDialog('library-dialog');renderEditor();
  }catch(error){$('library-error').textContent=error.message;}
}
const manualReceiptKey=id=>`hmrManualDelete:${id}`;
function deletionHooks(ctx){
  const key=manualReceiptKey(ctx.r.id);
  return {persist:ctx.persist,clearReceipt:()=>chrome.storage.local.remove(key),
    onDeleted:async id=>{await forgetPreview(ctx.r.base,id);for(const role of ['home','event'])previewIndexes.delete(`${ctx.r.id}:${role}`);}};
}
async function settleManualReceipt(ctx){
  const key=manualReceiptKey(ctx.r.id),receipt=(await chrome.storage.local.get(key))[key];
  if(!validDeletionReceipt(receipt,ctx.r.base))return;
  return reconcileDeletion(ctx.api,ctx.r,receipt,deletionHooks(ctx));
}
async function resumeManualReceipt(id){
  if(!admitted||operations.has(id)||state(id).reboot)return;
  const r=byId(id);if(!r)return;
  const receipt=(await chrome.storage.local.get(manualReceiptKey(id)))[manualReceiptKey(id)];
  if(validDeletionReceipt(receipt,r.base))await withRoom(id,async()=>{}, {silent:true});
}
async function deleteLibraryAsset(id){
  const ref=library;if(!ref||ref.editor||ref.busy)return;
  ref.busy=true;$('library-error').textContent='';renderLibrary();
  const result=await withRoom(ref.roomId,async ctx=>{
    await ctx.ensure();
    return deleteMedia(ctx.api,ctx.r,id,{
      ...deletionHooks(ctx),progress:ctx.progress,authorize:requireUnlocked,
      saveReceipt:value=>chrome.storage.local.set({[manualReceiptKey(ctx.r.id)]:value}),
      confirm:plan=>confirmAction(`${t(plan.live?'Delete LIVE content?':'Delete file?')} · ${label(ctx.r)}`,
        deletionMessage(plan),t('Delete permanently'),true)
    });
  });
  if(library===ref){
    ref.busy=false;
    // Refresh even after a partial failure: never continue to offer removed entries.
    try{ref.assets=await apiFor(byId(ref.roomId)).assets();state(ref.roomId).assets=ref.assets;}
    catch(error){$('library-error').textContent=error.message;}
    if(!result.ok)$('library-error').textContent=result.error||'';
    renderLibrary();render();
  }
  if(result.ok&&!result.value?.cancelled)toast(`${label(byId(ref.roomId))}: ${t(result.value?.alreadyAbsent?
    'Asset was already absent. Panel references updated.':'Deleted from player and panel playlists.')}`);
}

function openLargePreview(role){stopPreview($(`${role}-preview`));const r=room();if(!r)return;const {items}=getShown(r,role),index=previewIndexes.get(`${r.id}:${role}`)||0,asset=state(r.id).assets.find(a=>a.asset_id===items[index]?.id);if(!asset)return;$('preview-title').textContent=titleOf(asset);showAssetPreview($('large-preview'),r.base,asset);$('preview-dialog').showModal();}
function renderSettings(){
  if(document.activeElement!==$('panel-address'))$('panel-address').value=getPanelAddress();
  $('language').value=config.language;$('auto-cleanup').checked=config.autoCleanup;if(document.activeElement!==$('image-duration'))$('image-duration').value=config.defaultImageDuration;
  $('security-status').textContent=t(security?.enabled?'Password enabled':'Password disabled');$('change-password').textContent=t(security?.enabled?'Change password':'Set password');$('disable-password').hidden=!security?.enabled;
  const signature=JSON.stringify([getLanguage(),config.rooms.map(r=>[r.id,r.number,r.name,r.base])]);
  if(signature!==settingsSignature){settingsSignature=signature;$('settings-rooms').replaceChildren();
    for(const r of config.rooms){const row=node('div','settings-row');row.dataset.room=r.id;const text=node('div','row-label');text.append(node('strong','',r.name),node('small','',`${t('Player {number}',{number:r.number})} · ${r.base?new URL(r.base).host:t('Not configured')}`));const actions=node('div','row-actions');actions.append(button(t('Edit'),'text-btn',()=>openPlayer(r.id)),button(t('Info'),'text-btn',()=>openInfo(r.id)),button(t('Remove'),'text-btn',()=>removePlayer(r.id)));row.append(text,actions);$('settings-rooms').append(row);}
    if(!config.rooms.length)$('settings-rooms').append(node('p','muted',t('No players yet')));
  }
  for(const row of $('settings-rooms').children){if(!row.dataset.room)continue;row.querySelectorAll('button').forEach(b=>{b.disabled=operations.has(row.dataset.room);});}
}
function openPlayer(id=null){
  if(id&&operations.has(id))throw new Error(t('Finish the current operation first.'));editingId=id;const r=id?byId(id):null;
  $('player-title').textContent=r?`${t('Edit player')} · ${t('Player {number}',{number:r.number})}`:`${t('Add player')} · ${config.nextPlayerNumber}`;
  $('player-name').value=r?.name||'';$('player-base').value=r?.base||'';$('player-error').textContent='';updateNameCount();$('player-dialog').showModal();$('player-name').focus();
}
function updateNameCount(){$('name-count').textContent=`${Array.from($('player-name').value).length} / 40`;}
async function savePlayer(e){
  e.preventDefault();if(savingPlayer)return;const id=editingId;
  try{
    const name=normalizeName($('player-name').value),base=normalizeBase($('player-base').value);if(!base)throw new Error(t('Player is not configured.'));
    if(config.rooms.some(r=>r.id!==id&&r.base===base))throw new Error(t('Address already assigned to another player.'));
    savingPlayer=true;$('save-player').disabled=true;
    // Chrome permission requests begin in the user gesture, before network or storage waits.
    if(!await chrome.permissions.request({origins:[originPermission(base)]}))throw new Error(t('Permission not granted. No changes saved.'));
    await requireUnlocked();const old=id?byId(id):null;
    if(old&&old.base!==base&&!await confirmAction(t('Change player address?'),t('An unverified address change clears content associations. Files on the old device are not modified. Use discovery to recognise a device with a changed IP.')))return;
    const commit=async()=>{
      if(id&&await readJournal(id))throw new Error(t('Complete playlist recovery before other changes.'));
      config=await updateConfig(latest=>{
        if(latest.rooms.some(r=>r.id!==id&&r.base===base))throw new Error(t('Address already assigned to another player.'));
        const target=latest.rooms.find(r=>r.id===id);
        if(id&&!target)throw new Error(t('Player configuration changed. Reopen it and try again.'));
        if(target&&target.base!==base){Object.assign(target,newRoom(name,base,target.number),{id});runtime.delete(id);}
        else if(target){target.name=name;target.base=base;}
        else selectedId=appendPlayer(latest,name,base).id;
      });
    };
    if(old)await navigator.locks.request(roomLock(old),{ifAvailable:true},async lock=>{if(!lock)throw new Error(t('Another tab is changing this player.'));await commit();});else await commit();
    if(id)selectedId=id;closeDialog('player-dialog');render();toast(t('Player saved.'));void refreshRoom(selectedId);void rememberIdentity(selectedId);
  }catch(error){$('player-error').textContent=error.message;}
  finally{savingPlayer=false;$('save-player').disabled=false;}
}
async function rememberIdentity(id){
  const r=byId(id);if(!r?.base||r.identity||!admitted)return;
  try{const found=await identifyPlayer(r.base,{timeout:20000});if(found.identity&&byId(id)?.base===r.base)config=await updateConfig(latest=>{const target=latest.rooms.find(x=>x.id===id);if(target?.base===r.base&&!target.identity)target.identity=found.identity;});}catch{/* Identity is optional; normal control does not wait for it. */}
}
async function removePlayer(id){
  const r=byId(id);if(!r||operations.has(id))return;
  if(!await confirmAction(`${t('Remove this player?')} · ${label(r)}`,t('Only the panel association is removed. Files and playback are unchanged.'),t('Remove'),true))return;
  await requireUnlocked();await navigator.locks.request(roomLock(r),{ifAvailable:true},async lock=>{if(!lock)throw new Error(t('Another tab is changing this player.'));if(await readJournal(id))throw new Error(t('Complete playlist recovery before other changes.'));config=await updateConfig(latest=>{latest.rooms=latest.rooms.filter(x=>x.id!==id);});});runtime.delete(id);render();toast(t('Player removed from this panel.'));
}
async function grantAccess(){
  const origins=permissionsFor(config.rooms.filter(r=>r.base).map(r=>r.base));if(!origins.length)return;
  if(!await chrome.permissions.request({origins}))throw new Error(t('Permission not granted. No changes saved.'));
  toast(t('Network access granted.'));void refreshAll();for(const r of config.rooms)void rememberIdentity(r.id);
}
async function changeLanguage(value){
  config=await updateConfig(latest=>{latest.language=value==='it'?'it':'en';});setLanguage(config.language);translateDOM();settingsSignature='';
  if(!admitted)renderGate();else{render();if(editor&&!editor.busy)renderEditor();if(library)renderLibrary();if(fleet&&!fleet.running)updateFleetRows();}
}
async function openFleet(){
  fleet={rows:new Map(),running:false,done:false};$('fleet-rooms').replaceChildren();$('fleet-result').textContent='';$('fleet-select-all').checked=false;$('fleet-select-all').disabled=false;$('fleet-go').hidden=false;
  for(const r of config.rooms){const row=node('div','fleet-row');row.dataset.id=r.id;const check=node('input');check.type='checkbox';check.checked=r.id===selectedId;check.setAttribute('aria-label',label(r));const text=node('div','row-label');text.append(node('strong','',label(r)),node('small'));const status=node('span','hint');row.append(checkboxHit(check),text,status);$('fleet-rooms').append(row);fleet.rows.set(r.id,{row,check,text,status});action(check,updateFleetSelection,'change');}
  updateFleetRows();$('fleet-dialog').showModal();void refreshAll();
}
function restoreReady(r){return online(r)&&r.playlists.home.length>0&&r.playlists.home.every(item=>ready(state(r.id).assets.find(a=>a.asset_id===item.id)))&&!operations.has(r.id);}
function updateFleetRows(){
  if(!fleet||fleet.running||fleet.done)return;
  for(const [id,item]of fleet.rows){const r=byId(id);if(!r){item.check.disabled=true;item.check.checked=false;item.status.textContent=t('Excluded');continue;}
    const usable=restoreReady(r);item.check.disabled=!usable;if(!usable)item.check.checked=false;
    item.text.querySelector('small').textContent=t('{count} items',{count:r.playlists.home.length});
    item.status.textContent=t(usable?(mode(r).role==='home'?'Home is already active':'Ready to restore'):!online(r)?'Offline':'Home playlist missing or not ready');
  }updateFleetSelection();
}
function updateFleetSelection(){if(!fleet||fleet.running||fleet.done)return;const entries=[...fleet.rows.values()].filter(x=>!x.check.disabled),selected=entries.filter(x=>x.check.checked);$('fleet-go').disabled=!selected.length;$('fleet-select-all').checked=entries.length>0&&selected.length===entries.length;$('fleet-select-all').indeterminate=selected.length>0&&selected.length<entries.length;}
async function runFleet(){
  const ref=fleet;if(!ref||ref.running)return;
  const ids=[...ref.rows.entries()].filter(([,r])=>r.check.checked&&!r.check.disabled).map(([id])=>id);if(!ids.length)return;
  ref.running=true;$('fleet-go').disabled=true;$('fleet-select-all').disabled=true;$('fleet-dialog').querySelectorAll('[data-close]').forEach(b=>{b.disabled=true;});ref.rows.forEach(r=>{r.check.disabled=true;});
  let cursor=0,ok=0,failed=0;
  try{
    await Promise.all(Array.from({length:Math.min(2,ids.length)},async()=>{
      while(cursor<ids.length){const id=ids[cursor++],row=ref.rows.get(id);row.status.textContent=t('Publishing playlist…');
        const result=await withRoom(id,ctx=>activate(ctx,'home'),{silent:true});
        if(!result.ok){failed++;row.status.textContent=result.error||t('Offline');continue;}
        ok++;let tail='';
        if(result.value?.warning)tail=result.value.warning;
        else if(config.autoCleanup&&byId(id)?.cleanup.length){await pause(3400);if(!operations.has(id))await cleanRoom(id,true);tail=t(byId(id)?.cleanup.length?'Cleanup pending':'Cleaned up');}
        else if(!config.autoCleanup)tail=t('Cleanup disabled');
        row.status.textContent=[t('Home restored'),tail].filter(Boolean).join(' · ');
      }
    }));
  }finally{ref.running=false;ref.done=true;$('fleet-go').hidden=true;$('fleet-dialog').querySelectorAll('[data-close]').forEach(b=>{b.disabled=false;});$('fleet-result').textContent=t('{ok} restored · {failed} incomplete · {skipped} not selected',{ok,failed,skipped:ref.rows.size-ids.length});render();}
}
async function openInfo(id){
  const r=byId(id);if(!r?.base)return;infoRoomId=id;$('info-title').textContent=label(r);$('info-data').replaceChildren(node('dt','',t('Loading…')));$('info-dialog').showModal();
  try{const info=await apiFor(r).info();state(id).info=info;if(infoRoomId!==id||!$('info-dialog').open)return;$('info-data').replaceChildren();const values=[['Model',info.device_model],['Anthias',info.anthias_version],['Address',r.base],['Free space',info.free_space],['Storage',info.storage?.status],['Display',info.display_power]];values.forEach(([key,value])=>$('info-data').append(node('dt','',t(key)),node('dd','',value||'—')));void rememberIdentity(id);}catch(error){if(infoRoomId===id)$('info-data').replaceChildren(node('dd','inline-error',error.message));}
}
async function rebootPlayer(id){
  const r=byId(id);if(!r||state(id).reboot||!await confirmAction(`${t('Reboot this player?')} · ${label(r)}`,t('Playback will stop while the player reboots.'),t('Reboot player'),true))return;
  if(infoRoomId===id)closeDialog('info-dialog');
  const result=await withRoom(id,async ctx=>{
    await ctx.ensure();await ctx.api.reboot();
    const now=Date.now(),s=state(id);s.reboot={requestedAt:now,notBefore:now+2500,deadline:now+120000,sawOffline:false,previousUptime:uptimeSeconds(s.info)};s.error='';s.operationError='';
  },{refreshAfter:false});
  if(result.ok){toast(`${label(r)}: ${t('Reboot requested.')}`);setTimeout(()=>void refreshRoom(id),3000);}
}
async function recover(){
  const id=selectedId;if(!await confirmAction(t('Recover previous playlist'),t('Restore settings from the interrupted operation? Later manual changes to the same assets may be overwritten.')))return;
  const result=await withRoom(id,async ctx=>{const journal=await readJournal(id);if(!journal||journal.base!==ctx.r.base)throw new Error(t('Invalid recovery record.'));const errors=await restoreJournal(ctx.api,journal,ctx.progress);if(errors.length)throw new Error(`${t('Recovery incomplete. A recovery record has been kept.')} ${errors.join(' · ')}`);await clearJournal(id);});if(result.ok)toast(t('Recovery completed.'));
}
function downloadJson(name,data){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=node('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
async function importConfigFile(file){
  if(!file||file.size>2*1024**2)throw new Error(t('Choose a panel configuration JSON file up to 2 MB.'));
  if(operations.size)throw new Error(t('Finish the current operation first.'));
  const incoming=migrateConfig(JSON.parse(await file.text()));
  if(!await confirmAction(t('Import configuration?'),t('This replaces the local player configuration, not files on the players. Your local password is unchanged.')))return;
  const origins=permissionsFor(incoming.rooms.filter(r=>r.base).map(r=>r.base));
  const allowed=!origins.length||await chrome.permissions.request({origins});
  for(const r of config.rooms)if(await readJournal(r.id))throw new Error(t('Complete playlist recovery before other changes.'));
  const locks=[...new Set(config.rooms.filter(r=>r.base).map(roomLock))].sort();
  const commit=async index=>{
    if(index<locks.length)return navigator.locks.request(locks[index],{ifAvailable:true},async held=>{if(!held)throw new Error(t('Another tab is changing this player.'));return commit(index+1);});
    for(const r of config.rooms)if(await readJournal(r.id))throw new Error(t('Complete playlist recovery before other changes.'));
    config=await updateConfig(async latest=>{await chrome.storage.local.set({hmrConfigBeforeImport:latest});incoming.rooms.forEach(r=>{r.cleanup=[];});incoming.setupComplete=true;incoming.wizardDraft=null;Object.assign(latest,incoming);});
  };
  await commit(0);
  runtime.clear();selectedId=config.rooms[0]?.id||'';settingsSignature='';setLanguage(config.language);translateDOM();security=await authRecord();
  if(!security)showGate('security');else await routeGate();
  toast(t(allowed?'Configuration imported.':'Your network permissions were not granted. You can authorise the imported players in Settings.'),allowed?'success':'warning');
}
function openSecurity(mode='change'){
  if(operations.size)throw new Error(t('Cannot change security while a player operation is running.'));securityMode=mode;
  $('security-title').textContent=t(mode==='disable'?'Disable password':security?.enabled?'Change password':'Set password');$('current-password-label').hidden=!security?.enabled;$('current-password').required=Boolean(security?.enabled);
  $('new-password-fields').hidden=mode==='disable';$('new-password').required=$('confirm-password').required=mode!=='disable';
  for(const id of ['current-password','new-password','confirm-password'])$(id).value='';$('security-error').textContent='';$('security-save').textContent=t(mode==='disable'?'Confirm disable':'Save password');$('security-dialog').showModal();
}
async function saveSecurity(e){
  e.preventDefault();$('security-save').disabled=true;
  try{await requireUnlocked();if(operations.size)throw new Error(t('Cannot change security while a player operation is running.'));
    security=securityMode==='disable'?await disablePassword($('current-password').value):await setPassword($('new-password').value,$('confirm-password').value,$('current-password').value);
    closeDialog('security-dialog');for(const id of ['current-password','new-password','confirm-password'])$(id).value='';render();toast(t(securityMode==='disable'?'Password disabled.':'Password updated.'));
  }catch(error){$('security-error').textContent=error.message;}finally{$('security-save').disabled=false;}
}
function discoveryPlayers(){
  if(admitted)return config.rooms;
  return wizardRows.flatMap((r,i)=>{try{return r.base?[{...r,id:`wizard-${i}`,number:config.nextPlayerNumber+i,base:normalizeBase(r.base)}]:[];}catch{return [];}});
}
function updateDiscoveryNetwork(){
  const ref=discovery;if(!ref)return;
  const hasCidr=$('scan-address').value.includes('/');$('scan-subnet').disabled=ref.running||ref.adding||hasCidr;
  try{
    const spec=networkSpec({address:$('scan-address').value,subnet:$('scan-subnet').value,port:$('scan-port').value,protocol:$('scan-protocol').value});
    $('scan-network').textContent=t('{network} · {count} addresses',{network:spec.cidr,count:spec.count});
    if(ref.signature&&ref.signature!==`${spec.cidr}|${spec.protocol}|${spec.port}`)$('scan-deep').hidden=true;
  }catch{$('scan-network').textContent=t('Enter an IP and subnet, or a network such as 192.168.1.0/24.');$('scan-deep').hidden=true;}
}
function setDiscoveryBusy(ref){
  if(discovery!==ref)return;
  for(const id of ['scan-address','scan-subnet','scan-port','scan-protocol'])$(id).disabled=ref.running||ref.adding;
  $('scan-go').disabled=ref.running||ref.adding;$('scan-stop').disabled=!ref.running||ref.adding;
  $('scan-deep').disabled=ref.running||ref.adding;$('scan-add').disabled=ref.adding||!ref.selected.size;
  $('scan-add').textContent=t(ref.adding?'Adding players…':'Add selected');
  $('discovery-close').disabled=$('discovery-done').disabled=ref.adding;
  if(!ref.running&&!ref.adding)updateDiscoveryNetwork();
}
function openDiscovery(){
  if(discovery?.running||discovery?.adding)return;
  discovery={running:false,adding:false,controller:null,found:[],selected:new Set(),nodes:new Map(),wizard:!admitted,unresolved:[],identityQueue:[],identityActive:0,scanDone:null};
  const saved=config.discovery;let address=saved.address||'',subnet=saved.subnet||'24',port=saved.port||80,protocol=saved.protocol||'http';
  if(!address){
    const known=discoveryPlayers().find(r=>r.base);
    if(known)try{const url=new URL(known.base);address=ipString(ipv4(url.hostname));port=Number(url.port)|| (url.protocol==='https:'?443:80);protocol=url.protocol.slice(0,-1);}catch{}
  }
  $('scan-address').value=address;$('scan-subnet').value=subnet;$('scan-port').value=port;$('scan-protocol').value=protocol;
  $('scan-results').replaceChildren();$('scan-status').textContent='';$('scan-error').textContent='';$('scan-progress').value=0;
  $('scan-deep').hidden=true;$('scan-advanced').open=false;setDiscoveryBusy(discovery);updateDiscoveryNetwork();$('discovery-dialog').showModal();
}
function queueDiscoveryIdentity(ref,found){
  ref.identityQueue.push({found,controller:ref.controller});drainDiscoveryIdentities(ref);
}
function drainDiscoveryIdentities(ref){
  if(discovery!==ref||ref.adding)return;
  while(ref.identityActive<4&&ref.identityQueue.length){
    const {found,controller}=ref.identityQueue.shift();if(controller.signal.aborted)continue;
    ref.identityActive++;
    void playerIdentity(found.base,{signal:controller.signal,timeout:1800}).then(identity=>{
      if(discovery!==ref||ref.controller!==controller||controller.signal.aborted||ref.adding)return;
      found.identity=identity;found.identityVerified=true;renderDiscoveryResult(found);
    }).finally(()=>{ref.identityActive--;drainDiscoveryIdentities(ref);});
  }
}
async function startDiscovery(deep=false){
  const ref=discovery;if(!ref||ref.running||ref.adding)return;
  try{
    const spec=networkSpec({address:$('scan-address').value,subnet:$('scan-subnet').value,port:Number($('scan-port').value),protocol:$('scan-protocol').value});
    const signature=`${spec.cidr}|${spec.protocol}|${spec.port}`;
    const targets=deep&&ref.signature===signature?ref.unresolved:scanTargets(spec);
    if(!targets.length)return;
    ref.signature=signature;ref.running=true;ref.controller?.abort();ref.controller=new AbortController();ref.identityQueue=[];
    if(!deep){ref.found=[];ref.selected.clear();ref.nodes.clear();$('scan-results').replaceChildren();}
    $('scan-address').value=spec.address;$('scan-subnet').value=spec.subnet;
    $('scan-error').textContent='';$('scan-progress').value=0;$('scan-deep').hidden=true;
    $('scan-status').textContent=t('Waiting for network permission…');setDiscoveryBusy(ref);
    // This call must remain directly within the Search click, before any await.
    const permission=chrome.permissions.request({origins:permissionsFor(targets)});
    if(!await permission)throw new Error(t('Permission not granted. No changes saved.'));
    if(discovery!==ref||ref.controller.signal.aborted)return;
    config=await updateConfig(latest=>{latest.discovery={address:spec.address,subnet:spec.subnet,port:spec.port,protocol:spec.protocol};});
    if(discovery!==ref||ref.controller.signal.aborted)return;
    $('scan-status').textContent=t(deep?'Checking slower devices…':'Searching…');
    const profile=deep?SCAN_PROFILES.thorough:SCAN_PROFILES.quick;
    ref.scanDone=scanPlayers(targets,{...profile,known:discoveryPlayers().map(r=>r.base),signal:ref.controller.signal,
      onResult:found=>{
        if(discovery!==ref||ref.adding)return;
        if(ref.nodes.has(found.base))return;
        ref.found.push(found);renderDiscoveryResult(found);queueDiscoveryIdentity(ref,found);
      },
      onProgress:({checked,total,elapsedMs})=>{
        if(discovery!==ref||ref.adding)return;
        $('scan-progress').value=checked/total*100;
        $('scan-status').textContent=t('{checked}/{total} · Found: {found} · {seconds}s',{checked,total,found:ref.found.length,seconds:(elapsedMs/1000).toFixed(1)});
      }
    });
    const result=await ref.scanDone;
    if(discovery!==ref||ref.adding)return;
    ref.unresolved=result.unresolved;
    $('scan-status').textContent=`${t(result.stopped?'Scan stopped':'Scan finished')} · ${t('Found: {found} · {seconds}s',{found:ref.found.length,seconds:(result.elapsedMs/1000).toFixed(1)})}`;
    $('scan-deep').hidden=!ref.unresolved.length;
    if(!ref.found.length){const hint=node('p','hint scan-empty',t('No players detected. Check the subnet or try the more thorough search.'));$('scan-results').append(hint);}
  }catch(error){if(discovery===ref)$('scan-error').textContent=error.message;}
  finally{ref.running=false;if(discovery===ref)setDiscoveryBusy(ref);}
}
function renderDiscoveryResult(found){
  const ref=discovery;if(!ref||ref.adding)return;
  const match=classifyResult(found,discoveryPlayers());let item=ref.nodes.get(found.base);
  if(!item){
    $('scan-results').querySelector('.scan-empty')?.remove();
    const row=node('div','discovery-row'),check=node('input');check.type='checkbox';check.setAttribute('aria-label',found.base);
    const text=node('div','row-label'),input=textInput(match.player?.name||'',t('Name'));input.maxLength=40;
    input.setAttribute('aria-label',`${t('Name')} ${new URL(found.base).host}`);
    row.append(checkboxHit(check),text,input);$('scan-results').append(row);item={row,check,input,text,match};ref.nodes.set(found.base,item);
    action(check,()=>{if(check.checked)ref.selected.add(found.base);else ref.selected.delete(found.base);setDiscoveryBusy(ref);},'change');
  }
  item.match=match;item.check.disabled=item.input.disabled=match.kind==='existing';
  if(match.kind==='existing'){item.check.checked=false;ref.selected.delete(found.base);}
  if(match.player&&!item.input.value)item.input.value=match.player.name;
  item.text.replaceChildren(node('strong','',new URL(found.base).host),node('small','',`${found.info.device_model} · ${found.info.anthias_version}`),
    node('small','',match.kind==='existing'?`${t('Already configured')} · ${label(match.player)}`:match.kind==='moved'?`${t('Update address')} · ${label(match.player)}`:t('New player')));
  setDiscoveryBusy(ref);
}
async function addDiscovered(){
  const ref=discovery;if(!ref||ref.adding||!ref.selected.size)return;
  const entries=ref.found.filter(f=>ref.selected.has(f.base)).map(found=>({found,name:normalizeName(ref.nodes.get(found.base).input.value||t('New player'))}));
  ref.adding=true;ref.controller?.abort();setDiscoveryBusy(ref);
  try{
    // Aborting outstanding probes is immediate; addition does not wait for the subnet.
    await ref.scanDone;
    for(const entry of entries){
      if(!entry.found.identityVerified){entry.found.identity=await playerIdentity(entry.found.base,{timeout:2500});entry.found.identityVerified=true;}
      entry.match=classifyResult(entry.found,discoveryPlayers());
    }
    if(ref.wizard){
      wizardRows=wizardRows.filter(r=>r.name.trim()||r.base.trim());
      for(const {found,name,match}of entries){
        if(match.kind==='moved'){const target=wizardRows.find(r=>r.identity===found.identity);if(target){target.name=name;target.base=found.base;}}
        else if(match.kind==='new'&&!wizardRows.some(r=>r.base===found.base||(found.identity&&r.identity===found.identity)))wizardRows.push({name,base:found.base,identity:found.identity});
      }
      await saveWizardDraft();ref.adding=false;closeDiscovery();renderGate();return;
    }
    await requireUnlocked();
    for(const {found,name}of entries){
      const match=classifyResult(found,config.rooms);
      if(match.kind==='moved'){
        const original=match.player;
        if(!await confirmAction(t('Update this player address?'),`${label(original)} · ${found.base}\n${t('The player identity matches an existing device. Its associations will be preserved at the new address.')}`))continue;
        const verified=await identifyPlayer(found.base,{timeout:6000});if(verified.identity!==original.identity)throw new Error(t('Player configuration changed. Reopen it and try again.'));
        await navigator.locks.request(roomLock(original),{ifAvailable:true},async lock=>{
          if(!lock)throw new Error(t('Another tab is changing this player.'));if(await readJournal(original.id))throw new Error(t('Complete playlist recovery before other changes.'));
          config=await updateConfig(latest=>{const target=latest.rooms.find(r=>r.id===original.id);if(!target||target.identity!==found.identity)throw new Error(t('Player configuration changed. Reopen it and try again.'));if(latest.rooms.some(r=>r.id!==target.id&&r.base===found.base))throw new Error(t('Address already assigned to another player.'));target.base=found.base;target.name=name;target.cleanup.forEach(j=>{j.base=found.base;});});runtime.delete(original.id);
        });
      }else if(match.kind==='new')config=await updateConfig(latest=>{if(classifyResult(found,latest.rooms).kind==='new')selectedId=appendPlayer(latest,name,found.base,found.identity).id;});
    }
    ref.adding=false;closeDiscovery();render();void refreshAll();toast(t('Player saved.'));
  }catch(error){if(discovery===ref)$('scan-error').textContent=error.message;}
  finally{ref.adding=false;if(discovery===ref)setDiscoveryBusy(ref);}
}
function stopDiscovery(){discovery?.controller?.abort();}
function closeDiscovery(){if(discovery?.adding)return;stopDiscovery();closeDialog('discovery-dialog');discovery=null;}

function showGate(stage){
  hideToast();stopDiscovery();admitted=false;gateStage=stage;$('app').hidden=true;$('gate').hidden=false;
  for(const video of document.querySelectorAll('video'))video.pause();
  if(stage==='players')wizardRows=config.wizardDraft?.length?structuredClone(config.wizardDraft):wizardRows.length?wizardRows:[{name:'',base:'',identity:''}];
  renderGate();
}
function gateLabel(text,input){const l=node('label');l.append(node('span','',t(text)),input);return l;}
function gateError(error){const el=$('gate-error');if(el)el.textContent=error.message||String(error);else report(error);}
function gateSteps(current){const steps=node('div','wizard-steps');for(let i=1;i<=3;i++)steps.append(node('span',i<=current?'active':''));return steps;}
function renderGate(){
  if(admitted)return;$('gate-language').value=config.language;const body=$('gate-body'),footer=$('gate-footer');body.replaceChildren();footer.replaceChildren();
  if(gateStage==='welcome'){
    body.append(node('span','eyebrow',t('Initial setup')),node('div','gate-symbol','▦'),node('h1','',t('Welcome to Anthias Rooms')),node('p','muted',t('Connect your displays, then add their Anthias players.')));
    const options=node('div','welcome-actions');options.append(button(t('Start setup'),'btn primary',()=>showGate('password')),button(t('Import an existing configuration'),'btn secondary',()=>$('import-file').click()));body.append(options,node('p','hint',t('Configuration only: media files and the local password are not included.')));
    footer.append(button(t('Skip setup'),'text-btn',skipSetup));
  }else if(gateStage==='login'){
    body.append(node('div','gate-symbol','◇'),node('h1','',t('Panel locked')));
    const form=node('form','gate-form'),input=node('input');input.id='gate-password';input.type='password';input.maxLength=128;input.required=true;input.autocomplete='current-password';form.append(gateLabel('Password',input));const error=node('p','inline-error');error.id='gate-error';error.setAttribute('role','alert');form.append(error);body.append(form,node('p','hint',t('Local password is not recoverable. Your configuration backup does not contain it.')));
    const submit=button(t('Unlock'),'btn primary',()=>form.requestSubmit());footer.append(submit);
    action(form,async e=>{e.preventDefault();if(wizardBusy)return;wizardBusy=true;submit.disabled=true;try{security=await login(input.value);input.value='';await routeGate();}catch(error){gateError(error);}finally{wizardBusy=false;submit.disabled=false;}},'submit');setTimeout(()=>input.focus(),40);
  }else if(gateStage==='password'||gateStage==='security'){
    const setup=gateStage==='password';body.append(gateSteps(1),node('span','eyebrow',t(setup?'Set up your panel':'Security')),node('h1','',t('Create your password')));
    body.append(node('p','hint',t(setup?'Local panel protection only. This does not add authentication to Anthias or encrypt its media.':'Your players have been preserved. Choose a local password or explicitly continue without protection.')));
    const form=node('form','gate-form'),first=node('input'),second=node('input');for(const i of [first,second]){i.type='password';i.minLength=8;i.maxLength=128;i.required=true;i.autocomplete='new-password';}first.id='setup-password';second.id='setup-confirm';form.append(gateLabel('New password',first),gateLabel('Confirm password',second),node('small','hint',t('At least 8 characters')));const error=node('p','inline-error');error.id='gate-error';form.append(error);body.append(form);
    if(setup)footer.append(button(t('Back'),'text-btn',()=>showGate('welcome')));else footer.append(button(t('Continue without password'),'text-btn',skipSecurity));
    const submit=button(t('Save password'),'btn primary',()=>form.requestSubmit());footer.append(submit);
    action(form,async e=>{e.preventDefault();if(wizardBusy)return;wizardBusy=true;submit.disabled=true;try{security=await setPassword(first.value,second.value);first.value=second.value='';if(setup)showGate('players');else await routeGate();}catch(error){gateError(error);}finally{wizardBusy=false;submit.disabled=false;}},'submit');
  }else if(gateStage==='players'){
    body.append(gateSteps(2),node('span','eyebrow',t('Initial setup')),node('h1','',t('Choose your players')));
    const tools=node('div','wizard-tools'),count=node('input');count.id='wizard-count';count.type='number';count.min=1;count.max=100;count.value=wizardRows.length||1;
    tools.append(gateLabel('How many players?',count),button(t('Create fields'),'btn secondary',async()=>{const n=Number(count.value);if(!Number.isInteger(n)||n<1||n>100)throw new Error(t('Enter a number from 1 to 100.'));wizardRows=Array.from({length:n},(_,i)=>wizardRows[i]||{name:'',base:'',identity:''});await saveWizardDraft();renderGate();}),button(t('Discover players'),'btn primary',openDiscovery));body.append(tools);
    const rows=node('div','wizard-rows internal-scroll');
    wizardRows.forEach((draft,index)=>{
      const row=node('div','wizard-row'),name=textInput(draft.name,t('Name')),base=textInput(draft.base,'192.168.1.20'),result=node('small');name.maxLength=40;base.maxLength=255;name.setAttribute('aria-label',`${t('Name')} ${index+1}`);base.setAttribute('aria-label',`${t('Address')} ${index+1}`);row.append(node('strong','muted',String(config.nextPlayerNumber+index).padStart(2,'0')),name,base);
      action(name,()=>{draft.name=name.value;void saveWizardDraft();},'change');action(base,()=>{draft.base=base.value;draft.identity='';void saveWizardDraft();},'change');
      const test=button(t('Test connection'),'text-btn',async()=>{try{draft.name=name.value;draft.base=base.value;const address=normalizeBase(base.value);if(!address)throw new Error(t('Player is not configured.'));test.disabled=true;result.textContent=t('Checking…');if(!await chrome.permissions.request({origins:[originPermission(address)]}))throw new Error(t('Permission not granted. No changes saved.'));const found=await identifyPlayer(address,{timeout:20000});draft.base=address;draft.identity=found.identity;base.value=address;result.textContent=`${t('Connected')} · ${found.info.device_model}`;await saveWizardDraft();}catch(error){result.textContent=error.message;}finally{test.disabled=false;}});row.append(test,result);rows.append(row);
    });body.append(rows);const error=node('p','inline-error');error.id='gate-error';body.append(error);
    footer.append(button(t('Skip setup'),'text-btn',skipSetup),button(t('Finish setup'),'btn primary',finishSetup));
  }else if(gateStage==='done'){
    body.append(gateSteps(3),node('div','gate-symbol','✓'),node('h1','',t('Setup complete')),node('p','muted',t('You can add more players at any time from Settings. No content has been changed on the devices.')));footer.append(button(t('Open panel'),'btn primary',admit));
  }
}
async function saveWizardDraft(){const rows=structuredClone(wizardRows);config=await updateConfig(latest=>{latest.wizardDraft=rows;});}
async function finishSetup(){
  if(wizardBusy)return;wizardBusy=true;
  try{
    // Read current fields even when touchscreen users tap Finish without blurring first.
    const rows=Array.from($('gate-body').querySelectorAll('.wizard-row')).map((row,i)=>({name:normalizeName(row.querySelectorAll('input')[0].value),base:normalizeBase(row.querySelectorAll('input')[1].value),identity:wizardRows[i]?.identity||''}));
    if(!rows.length||rows.length>100)throw new Error(t('Enter a number from 1 to 100.'));
    if(rows.some(r=>!r.base))throw new Error(t('Player is not configured.'));
    if(new Set(rows.map(r=>r.base)).size!==rows.length)throw new Error(t('Address already assigned to another player.'));
    if(!await chrome.permissions.request({origins:permissionsFor(rows.map(r=>r.base))}))throw new Error(t('Permission not granted. No changes saved.'));
    config=await updateConfig(latest=>{if(latest.setupComplete)return;for(const r of rows){if(latest.rooms.some(x=>x.base===r.base))continue;appendPlayer(latest,r.name,r.base,r.identity);}latest.setupComplete=true;latest.wizardDraft=null;});
    wizardRows=[];showGate('done');
  }catch(error){gateError(error);}finally{wizardBusy=false;}
}
async function skipSecurity(){
  if(!await confirmAction(t('Skip without password?'),t('The panel will remain unprotected until you enable a password in Settings. No players are added automatically.'),t('Continue without password')))return;
  security=await disablePassword();await routeGate();
}
async function skipSetup(){
  security=await authRecord();
  if(!security?.enabled){if(!await confirmAction(t('Skip without password?'),t('The panel will remain unprotected until you enable a password in Settings. No players are added automatically.'),t('Skip setup')))return;security=await disablePassword();}
  config=await updateConfig(latest=>{latest.setupComplete=true;latest.wizardDraft=null;});wizardRows=[];await routeGate();
}
async function routeGate(){
  security=await authRecord();
  if(security?.enabled&&!hasSession(security)){showGate('login');return;}
  if(!config.setupComplete){showGate(security?'players':'welcome');return;}
  if(!security){showGate('security');return;}
  await admit();
}
async function admit(){
  security=await authRecord();if(!config.setupComplete||!security||(security.enabled&&!hasSession(security))){await routeGate();return;}
  admitted=true;gateStage='';$('gate').hidden=true;$('app').hidden=false;if(!selectedId)selectedId=config.rooms[0]?.id||'';
  for(const r of config.rooms)state(r.id).journal=await readJournal(r.id);
  render();void refreshAll();
  // A migrated player can acquire a stable Balena identity without a content write.
  const unidentified=config.rooms.filter(r=>!r.identity&&r.base);let i=0;
  void (async()=>{while(i<unidentified.length&&admitted){const r=unidentified[i++];if(await chrome.permissions.contains({origins:[originPermission(r.base)]}))await rememberIdentity(r.id);}})();
}
function bindDrop(role){
  const input=$(`${role}-file`),drop=$(`${role}-drop`);let depth=0;
  action($(`pick-${role}`),()=>input.click());
  action(input,e=>{const files=Array.from(e.target.files);e.target.value='';if(files.length)openEditor(role,files);},'change');
  action(drop,e=>{if(e.target.closest('button,video'))return;const r=room();if(!r||operations.has(r.id))return;const {items}=getShown(r,role);if(items.length)openLargePreview(role);else input.click();});
  action(drop,e=>{if(e.target===drop&&['Enter',' '].includes(e.key)){e.preventDefault();const r=room();if(r&&!operations.has(r.id))getShown(r,role).items.length?openLargePreview(role):input.click();}},'keydown');
  drop.addEventListener('dragenter',e=>{e.preventDefault();depth++;if(!operations.has(selectedId))drop.classList.add('drag');});
  drop.addEventListener('dragover',e=>{e.preventDefault();if(e.dataTransfer)e.dataTransfer.dropEffect=operations.has(selectedId)?'none':'copy';});
  drop.addEventListener('dragleave',()=>{depth=Math.max(0,depth-1);if(!depth)drop.classList.remove('drag');});
  action(drop,e=>{e.preventDefault();e.stopPropagation();depth=0;drop.classList.remove('drag');const files=Array.from(e.dataTransfer?.files||[]);if(files.length)openEditor(role,files);},'drop');
}
function bind(){
  for(const key of ['content','settings'])action($(`nav-${key}`),()=>{if(key==='settings')for(const role of ['home','event'])stopPreview($(`${role}-preview`));view=key;render();});
  for(const id of ['add-player','empty-add','settings-add'])action($(id),()=>openPlayer());
  for(const id of ['empty-discover','settings-discover'])action($(id),openDiscovery);
  action($('configure-player'),()=>openPlayer(selectedId));action($('player-form'),savePlayer,'submit');action($('player-name'),updateNameCount,'input');
  action($('room-search'),renderRooms,'input');action($('grant-access'),grantAccess);
  action($('language'),e=>changeLanguage(e.target.value),'change');action($('gate-language'),e=>changeLanguage(e.target.value),'change');
  action($('auto-cleanup'),async e=>{const value=e.target.checked;await requireUnlocked();config=await updateConfig(latest=>{latest.autoCleanup=value;});render();toast(t('Settings saved.'));},'change');
  action($('image-duration'),async e=>{const value=Number(e.target.value);if(!Number.isInteger(value)||value<1||value>86400){e.target.value=config.defaultImageDuration;throw new Error(t('Image duration must be between 1 and 86400 seconds.'));}await requireUnlocked();config=await updateConfig(latest=>{latest.defaultImageDuration=value;});toast(t('Settings saved.'));},'change');
  action($('change-password'),()=>openSecurity('change'));action($('disable-password'),()=>openSecurity('disable'));action($('security-form'),saveSecurity,'submit');
  action($('lock'),()=>{if(operations.size||fleet?.running)throw new Error(t('Finish the current operation first.'));lockSession();for(const d of document.querySelectorAll('dialog[open]'))d.close();editor=null;library=null;showGate('login');});
  action($('refresh'),async()=>{$('refresh').classList.add('refreshing');try{await refreshAll();}finally{$('refresh').classList.remove('refreshing');}});
  action($('toast-close'),hideToast);window.addEventListener('resize',positionToast);
  const noticeObserver=new ResizeObserver(positionToast);for(const id of ['notice-anchor','settings-notice-anchor','toast'])noticeObserver.observe($(id));
  for(const role of ['home','event']){
    bindDrop(role);action($(`edit-${role}`),()=>openEditor(role));action($(`show-${role}`),()=>showRole(role));action($(`${role}-expand`),()=>openLargePreview(role));
    for(const direction of ['prev','next'])action($(`${role}-${direction}`),()=>{const r=room();if(!r)return;const {items}=getShown(r,role);if(!items.length)return;const key=`${r.id}:${role}`,value=previewIndexes.get(key)||0;previewIndexes.set(key,(value+(direction==='next'?1:-1)+items.length)%items.length);renderCard(r,role);});
  }
  action($('editor-close'),closeEditor);action($('editor-add'),()=>$('editor-file').click());
  action($('editor-file'),e=>{const files=Array.from(e.target.files);e.target.value='';if(files.length)appendFiles(files);},'change');
  action($('editor-clear'),async()=>{if(!editor||editor.busy)return;if(!await confirmAction(t('Clear playlist'),t('Clearing a prepared playlist does not delete files or stop current playback.')))return;editor.items=[];renderEditor();});
  action($('editor-save'),()=>saveEditor(false));action($('editor-publish'),()=>saveEditor(true));
  $('editor-list').addEventListener('dragover',e=>{e.preventDefault();if(editor&&!editor.busy&&e.dataTransfer?.types.includes('Files'))$('editor-list').classList.add('drag');});
  $('editor-list').addEventListener('dragleave',e=>{if(!e.currentTarget.contains(e.relatedTarget))$('editor-list').classList.remove('drag');});
  action($('editor-list'),e=>{e.preventDefault();e.stopPropagation();$('editor-list').classList.remove('drag');if(editor&&!editor.busy&&e.dataTransfer?.files.length)appendFiles(e.dataTransfer.files);},'drop');
  $('editor-dialog').addEventListener('cancel',e=>{e.preventDefault();void closeEditor();});
  document.addEventListener('dragover',e=>e.preventDefault());document.addEventListener('drop',e=>e.preventDefault());
  action($('info-memory'),()=>openLibrary(infoRoomId));action($('player-media'),()=>openLibrary(selectedId));action($('library-search'),renderLibrary,'input');
  action($('editor-library'),()=>{if(editor?.role==='home')return openLibrary(editor.roomId,{pickForHome:true});});action($('library-use'),useHomeMedia);
  action($('restore-selected'),openFleet);action($('fleet-go'),runFleet);action($('fleet-select-all'),e=>{if(!fleet)return;fleet.rows.forEach(r=>{if(!r.check.disabled)r.check.checked=e.target.checked;});updateFleetSelection();},'change');
  $('fleet-dialog').addEventListener('cancel',e=>{if(fleet?.running)e.preventDefault();});
  action($('recover'),recover);action($('retry-cleanup'),()=>cleanRoom(selectedId,true));
  action($('scan-go'),()=>startDiscovery(false));action($('scan-deep'),()=>startDiscovery(true));
  for(const id of ['scan-address','scan-subnet','scan-port','scan-protocol'])action($(id),updateDiscoveryNetwork,id==='scan-protocol'?'change':'input');action($('scan-stop'),stopDiscovery);action($('scan-add'),addDiscovered);action($('discovery-close'),closeDiscovery);action($('discovery-done'),closeDiscovery);
  $('discovery-dialog').addEventListener('cancel',e=>{e.preventDefault();closeDiscovery();});
  action($('copy-panel-address'),async()=>{await requireUnlocked();const copied=await copyPanelAddress($('panel-address'));toast(t(copied?'Panel address copied.':'Copy was blocked by the browser. The address is selected: press Ctrl+C or use Copy.'),copied?'success':'warning');});
  action($('export-config'),async()=>{await requireUnlocked();downloadJson('anthias-rooms-config.json',exportConfig(config));});action($('import-config'),()=>$('import-file').click());
  action($('import-file'),e=>{const file=e.target.files[0];e.target.value='';if(file)return importConfigFile(file);},'change');
  action($('diagnostics'),async()=>{await requireUnlocked();const local=await chrome.storage.local.get(null);downloadJson('anthias-rooms-diagnostics.json',{version:'3.0.0',createdAt:new Date().toISOString(),config:exportConfig(config),players:config.rooms.map(r=>({id:r.id,number:r.number,online:state(r.id).online,error:state(r.id).error,operationError:state(r.id).operationError,info:state(r.id).info,assets:state(r.id).assets})),logs,pending:Object.fromEntries(Object.entries(local).filter(([key])=>key.startsWith('hmrJournal:')||key.startsWith('hmrUpload:')||key.startsWith('hmrManualDelete:')))});});
  action($('open-anthias'),()=>{const r=byId(infoRoomId);if(r?.base)chrome.tabs.create({url:r.base});});
  action($('reboot'),()=>rebootPlayer(infoRoomId));action($('quick-reboot'),()=>rebootPlayer(selectedId));
  document.querySelectorAll('[data-close]').forEach(b=>action(b,()=>closeDialog(b.dataset.close)));
  $('player-dialog').addEventListener('cancel',e=>{if(savingPlayer)e.preventDefault();});
  $('library-dialog').addEventListener('close',()=>{library=null;});$('fleet-dialog').addEventListener('close',()=>{if(!fleet?.running)fleet=null;});
  $('preview-dialog').addEventListener('close',()=>{emptyPreview($('large-preview'),'');});
  $('editor-dialog').addEventListener('close',()=>{$('editor-list').querySelectorAll('.preview').forEach(releasePreview);});
  window.addEventListener('beforeunload',e=>{if(operations.size||savingPlayer||editorHasChanges(editor)||discovery?.running||wizardBusy){e.preventDefault();e.returnValue='';}});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&admitted)void refreshAll();});
  chrome.storage.onChanged.addListener(async(changes,area)=>{
    if(area!=='local')return;
    try{
      if(changes.hmrConfig){config=await loadConfig();setLanguage(config.language);translateDOM();if(admitted)render();}
      if(changes.hmrAuthV4){security=await authRecord();if(admitted&&security?.enabled&&!hasSession(security)){for(const d of document.querySelectorAll('dialog[open]'))d.close();showGate('login');}else if(admitted)render();}
    }catch(error){report(error);}
  });
  window.addEventListener('unhandledrejection',e=>{e.preventDefault();report(e.reason);});window.addEventListener('error',e=>{if(e.error)report(e.error);});
}
async function start(){
  try{
    config=await loadConfig();setLanguage(config.language);translateDOM();security=await authRecord();bind();await routeGate();
    setInterval(()=>{if(admitted&&!document.hidden&&!discovery?.running&&room())void refreshRoom(selectedId);},5000);
    setInterval(()=>{if(admitted&&!document.hidden&&!discovery?.running)void refreshAll();},25000);
    setInterval(()=>{if(admitted&&!document.hidden&&config.autoCleanup)for(const r of config.rooms)if(online(r))void cleanRoom(r.id);},15000);
  }catch(error){$('gate-body').replaceChildren(node('h2','',t('Startup failed: {detail}',{detail:error.message})));report(error);}
}
start();
