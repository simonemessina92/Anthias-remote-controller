import {proxyUrl,tabHeaders} from './vps-adapter.js';
import {t,getLanguage} from './i18n.js';
import {mediaUrl,mediaKind,assetId} from './api.js';
const MAX_BYTES=160*1024*1024;
const blobs=new Map();
let dbPromise;
function db() {
  if (!globalThis.indexedDB) return Promise.reject(new Error(t('Preview cache unavailable')));
  if (!dbPromise) dbPromise=new Promise((resolve,reject)=>{
    const req=indexedDB.open('hmr-previews-v2',1);
    req.onupgradeneeded=()=>req.result.createObjectStore('thumbs');
    req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
  });
  return dbPromise;
}
async function thumbGet(key) {try {return await new Promise(async(resolve,reject)=>{
  try {const store=(await db()).transaction('thumbs','readonly').objectStore('thumbs'),req=store.get(key); req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);}catch(e){reject(e);}
});}catch{return null;}}
async function thumbPut(key,blob) {try {const database=await db();await new Promise((resolve,reject)=>{const tx=database.transaction('thumbs','readwrite');tx.objectStore('thumbs').put(blob,key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}catch{/* Preview caching must never prevent publishing. */}}
export function previewKey(base,asset) {return `${base}|${asset.asset_id}|${asset.uri}`;}
export async function forgetPreview(base,id) {
  for (const [key,value] of blobs) if(key.startsWith(`${base}|${id}|`)){blobs.delete(key);}
  try {const database=await db();const tx=database.transaction('thumbs','readwrite'),store=tx.objectStore('thumbs');const req=store.openCursor();req.onsuccess=()=>{const cursor=req.result;if(cursor){if(String(cursor.key).startsWith(`${base}|${id}|`))cursor.delete();cursor.continue();}};}catch{}
}
function makeThumbnail(blob,kind) {
  return new Promise((resolve,reject)=>{
    const media=document.createElement(kind==='video'?'video':'img'),url=URL.createObjectURL(blob);
    let timer,done=false;
    const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);if(kind==='video'){media.pause();media.removeAttribute('src');media.load();}URL.revokeObjectURL(url);error?reject(error):resolve(result);};
    const capture=()=>{try {const w=media.videoWidth||media.naturalWidth,h=media.videoHeight||media.naturalHeight;if(!w||!h)return finish(new Error(t('Dimensions unavailable')));const canvas=document.createElement('canvas');const scale=Math.min(1280/w,1280/h,1);canvas.width=Math.round(w*scale);canvas.height=Math.round(h*scale);canvas.getContext('2d').drawImage(media,0,0,canvas.width,canvas.height);canvas.toBlob(result=>result?finish(null,result):finish(new Error(t('Preview unavailable'))),'image/jpeg',0.86);}catch(e){finish(e);}};
    timer=setTimeout(()=>finish(new Error(t('Preview unavailable'))),12000);
    media.onerror=()=>finish(new Error(t('Format not supported in browser')));
    if(kind==='video'){media.muted=true;media.preload='auto';media.onloadeddata=()=>{if(media.duration>0.3){media.onseeked=capture;media.currentTime=Math.min(0.3,media.duration/3);}else capture();};}else media.onload=capture;
    media.src=url;
  });
}
export async function cacheUploadedPreview(base,asset,file) {
  try {const blob=await makeThumbnail(file,mediaKind(asset));await thumbPut(previewKey(base,asset),blob);}catch{}
}
async function boundedResponse(response,maxBytes,signal) {
  if(!response.ok) throw new Error(`Preview: HTTP ${response.status}`);
  if(Number(response.headers.get('Content-Length')||0)>maxBytes) {await response.body?.cancel();throw new Error('VIDEO_LARGE');}
  const reader=response.body.getReader(),parts=[];let size=0;
  while(true){if(signal.aborted){await reader.cancel();throw new Error(t('Read cancelled'));}const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw new Error('VIDEO_LARGE');}parts.push(value);}
  return new Blob(parts,{type:response.headers.get('Content-Type')||'application/octet-stream'});
}
async function fetchBlob(base,asset) {
  const key=previewKey(base,asset);
  if(blobs.has(key))return blobs.get(key);
  const promise=(async()=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),90000);
    try {
      let blob;
      try {
        const response=await fetch(mediaUrl(base,asset),{headers:tabHeaders(),credentials:'same-origin',cache:'default',redirect:'error',signal:controller.signal});
        if(response.headers.get('Content-Type')?.includes('text/html')){await response.body?.cancel();throw new Error(t('Player did not return media.'));}
        blob=await boundedResponse(response,MAX_BYTES,controller.signal);
      } catch(error) {
        // The documented JSON content endpoint is a bounded fallback for images only.
        // Never duplicate a multi-GB video in JSON/base64 in the player or browser.
        if(mediaKind(asset)!=='image'||controller.signal.aborted)throw error;
        const response=await fetch(proxyUrl(base,`/api/v2/assets/${assetId(asset.asset_id)}/content`),{headers:{...tabHeaders(),Accept:'application/json'},credentials:'same-origin',redirect:'error',signal:controller.signal});
        const raw=await boundedResponse(response,32*1024*1024,controller.signal),data=JSON.parse(await raw.text());
        if(data.type!=='file'||typeof data.content!=='string')throw new Error(t('Image content unavailable.'));
        const binary=atob(data.content),parts=[];for(let i=0;i<binary.length;i+=65536)parts.push(Uint8Array.from(binary.slice(i,i+65536),c=>c.charCodeAt(0)));
        const ext=asset.uri.split('.').pop().toLowerCase(),type=({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp'})[ext]||'image/jpeg';
        blob=new Blob(parts,{type});
      }
      return blob;
    }finally{clearTimeout(timer);}
  })();
  blobs.set(key,promise);
  // Only selected room previews enter this cache; keep at most 3 files.
  while(blobs.size>3)blobs.delete(blobs.keys().next().value);
  try{return await promise;}catch(e){blobs.delete(key);throw e;}
}
// DOM containers own their object URLs and preview players. The shared file/thumbnail
// caches do not own playback: a pending fetch can never resurrect a closed preview.
const localThumbnails = new WeakMap();
export function stopPreview(container) { container?._stopPreview?.(); }
export function releasePreview(container) {
  container.dataset.key = '';
  container._stopPreview = null;
  clearContainer(container);
}
function clearContainer(container) {
  if (container._objectURL) URL.revokeObjectURL(container._objectURL);
  container._objectURL = null;
  container.querySelectorAll('video').forEach(video => {
    video.pause(); video.removeAttribute('src'); video.load();
  });
  container.replaceChildren(); container.removeAttribute('title');
}
function text(container, label, detail = '') {
  const block = document.createElement('div'); block.className = 'preview-empty';
  const symbol = document.createElement('span'); symbol.className = 'preview-symbol'; symbol.textContent = '▣';
  const title = document.createElement('strong'); title.textContent = label; block.append(symbol, title);
  if (detail) { const small = document.createElement('span'); small.textContent = detail; block.append(small); }
  container.append(block); return block;
}
function mountBlob(container, blob, kind, {controls = false} = {}) {
  clearContainer(container);
  const url = URL.createObjectURL(blob); container._objectURL = url;
  const media = document.createElement(kind === 'video' ? 'video' : 'img');
  if (kind === 'video') {
    media.controls = controls; media.muted = true; media.preload = 'metadata'; media.playsInline = true;
    media.disablePictureInPicture = true; media.disableRemotePlayback = true;
    media.setAttribute('controlsList', 'nodownload noremoteplayback');
    media.setAttribute('aria-label', t('Video preview'));
  } else { media.alt = t('Preview'); media.draggable = false; }
  media.src = url; container.append(media); return media;
}
export async function showLocalPreview(container, file, kind) {
  const key = `local:${file.name}:${file.size}:${file.lastModified}:${getLanguage()}`;
  if (container.dataset.key === key) return;
  releasePreview(container); container.dataset.key = key;
  if (kind !== 'video') { mountBlob(container, file, 'image'); return; }
  // Editor rows are still images only. An off-DOM video extracts one thumbnail;
  // its native controls/context menu never enter the playlist editor.
  text(container, t('Video'));
  if (!localThumbnails.has(file)) {
    localThumbnails.set(file, makeThumbnail(file, 'video').catch(() => null));
  }
  const thumbnail = await localThumbnails.get(file);
  if (container.dataset.key === key && thumbnail) mountBlob(container, thumbnail, 'image');
}
export function emptyPreview(container, label = t('No content selected'), detail = '') {
  const key = `empty:${label}:${detail}`;
  if (container.dataset.key === key) return;
  releasePreview(container); container.dataset.key = key; text(container, label, detail);
}
export async function showAssetPreview(container, base, asset, {compact = false} = {}) {
  if (!asset || !mediaKind(asset)) { emptyPreview(container, asset ? t('Web content') : t('No content selected')); return; }
  const key = previewKey(base, asset) + `|${asset.is_processing}|${compact}|${getLanguage()}`;
  if (container.dataset.key === key) return;
  releasePreview(container); container.dataset.key = key;
  if (asset.is_processing) { text(container, t('Processing…')); return; }
  text(container, t('Loading preview…'));
  const valid = () => container.dataset.key === key;
  const video = mediaKind(asset) === 'video';
  try {
    let thumbnail = await thumbGet(previewKey(base, asset)), mediaBlob = null;
    if (!valid()) return;
    if (!thumbnail && compact && video) { clearContainer(container); text(container, t('Video')); return; }
    if (!thumbnail) {
      mediaBlob = await fetchBlob(base, asset); if (!valid()) return;
      if (video) {
        try { thumbnail = await makeThumbnail(mediaBlob, 'video'); await thumbPut(previewKey(base, asset), thumbnail); } catch {}
      } else {
        thumbnail = mediaBlob; void cacheUploadedPreview(base, asset, mediaBlob);
      }
    }
    if (!valid()) return;
    let ticket = 0;
    const still = () => {
      if (!valid()) return;
      ticket++;
      if (thumbnail) mountBlob(container, thumbnail, 'image');
      else { clearContainer(container); text(container, t('Video')); }
      container.dataset.playing = 'false';
      if (video && !compact) {
        const play = document.createElement('button');
        play.type = 'button'; play.className = 'preview-play'; play.textContent = '▶ ' + t('Video preview');
        play.addEventListener('click', () => { void startVideo(); }); container.append(play);
      }
    };
    const stopButton = () => {
      const stop = document.createElement('button'); stop.type = 'button'; stop.className = 'preview-stop';
      stop.textContent = '■ ' + t('Stop preview'); stop.addEventListener('click', still); container.append(stop);
    };
    const startVideo = async () => {
      const current = ++ticket;
      clearContainer(container); text(container, t('Loading…')); stopButton();
      try {
        const blob = mediaBlob || await fetchBlob(base, asset);
        if (!valid() || current !== ticket) return;
        const player = mountBlob(container, blob, 'video', {controls: true});
        container.dataset.playing = 'true'; stopButton();
        player.addEventListener('ended', still, {once: true});
        player.addEventListener('error', () => {
          if (!valid() || current !== ticket) return;
          still(); container.title = t('Format not supported in browser');
        }, {once: true});
        player.play().catch(() => { /* Native Play remains available if autoplay is blocked. */ });
      } catch {
        if (!valid() || current !== ticket) return;
        still(); container.title = t('Preview unavailable');
      }
    };
    container._stopPreview = still;
    still();
  } catch (error) {
    if (!valid()) return; clearContainer(container);
    const block = text(container, error.message === 'VIDEO_LARGE' ? t('Video stored on player') : t('Preview unavailable'));
    if (!compact) {
      const open = document.createElement('button'); open.type = 'button'; open.className = 'btn secondary';
      open.textContent = t('Open preview on player'); open.onclick = () => chrome.tabs.create({url: mediaUrl(base, asset)}); block.append(open);
    }
    container.title = error.message === 'VIDEO_LARGE' ? t('Video exceeds 160 MB. Open preview on the player.') : error.message;
  }
}
