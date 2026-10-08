const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES?process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright':'playwright');
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert');
(async()=>{
 const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'ar-extension-')),profile=fs.mkdtempSync(path.join(os.tmpdir(),'ar-profile-'));
 fs.cpSync(process.env.AR_EXTENSION_DIR,fixture,{recursive:true});
 const manifest=JSON.parse(fs.readFileSync(path.join(fixture,'manifest.json')));manifest.host_permissions=['http://127.0.0.1/*']; // test-only permission; production manifest is unchanged
 fs.writeFileSync(path.join(fixture,'manifest.json'),JSON.stringify(manifest));
 const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,args:['--no-sandbox',`--disable-extensions-except=${fixture}`,`--load-extension=${fixture}`]});
 try{
  let worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const id=worker.url().split('/')[2];assert.equal(id,'cfhcncajkcblicinnngdhfmnmnlfhign');
  await worker.evaluate(async base=>{
   await chrome.storage.local.set({hmrConfig:{schema:4,language:'en',setupComplete:true,nextPlayerNumber:2,autoCleanup:false,defaultImageDuration:15,rooms:[{id:'local-room',number:1,name:'Room',base,identity:'mock-identity-1',playlists:{home:[],event:[]},lastPublished:null,homeHistory:[],eventHistory:[],uploadedIds:[],managedEventIds:[],cleanup:[]}]},hmrAuthV4:{enabled:false,revision:'test'}});
  },process.env.AR_BROWSER_BASE);
  const local=await context.newPage(),errors=[];local.on('pageerror',e=>errors.push(e.message));await local.goto(`chrome-extension://${id}/panel.html`);await local.waitForSelector('#app:not([hidden])');
  const getRoom=page=>page.evaluate(async()=>{const {loadConfig}=await import('./storage.js');return (await loadConfig()).rooms[0];});
  async function refreshed(page){await page.click('#refresh');await page.waitForFunction(()=>!document.getElementById('refresh').disabled);}
  async function sharedFrom(target,source){const r=await getRoom(source);await target.waitForFunction(async expected=>{const {loadConfig}=await import('./storage.js');const actual=(await loadConfig()).rooms[0];return actual.sharedRevision===expected.sharedRevision&&JSON.stringify(actual.playlists)===JSON.stringify(expected.playlists)&&JSON.stringify(actual.lastPublished)===JSON.stringify(expected.lastPublished);},{sharedRevision:r.sharedRevision,playlists:r.playlists,lastPublished:r.lastPublished});}
  async function waitRoom(page,role,duration){await page.waitForFunction(async({role,duration})=>{const {loadConfig}=await import('./storage.js');return (await loadConfig()).rooms[0]?.playlists[role]?.[0]?.duration===duration;},{role,duration});}
  async function editor(page,role,duration,publish){await page.click('#edit-'+role);await page.waitForSelector('#editor-list input[type=number]');await page.locator('#editor-list input[type=number]').first().fill(String(duration));await page.click(publish?'#editor-publish':'#editor-save');try{await page.waitForFunction(()=>!document.getElementById('editor-dialog').open,{},{timeout:10000});}catch(error){console.error({role,duration,publish,editorError:await page.locator('#editor-error').innerText(),toast:await page.locator('#toast-text').innerText(),progress:await page.locator('#editor-progress-text').innerText(),room:await getRoom(page),errors});throw error;}}
  await local.waitForFunction(async()=>{const {loadConfig}=await import('./storage.js');const r=(await loadConfig()).rooms[0];return r.playlists.home.length===1&&r.playlists.event.length===1;});
  const report={extensionId:id,nativePreviews:true,viewports:[]};await local.waitForFunction(()=>document.querySelector('#home-preview img')?.naturalWidth>0);
  for(const [width,height] of [[360,800],[390,844],[768,1024],[1024,768],[1920,1080]]){
   await local.setViewportSize({width,height});await local.click('#edit-home');await local.waitForSelector('#editor-list .editor-row');
   const boxes=await local.locator('#editor-list .editor-row').first().evaluate(row=>{const box=s=>{const r=row.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};};return {label:box('.item-label'),timing:box('.timing'),tools:box('.item-tools')};});
   const separate=(a,b)=>a.x+a.w<=b.x+1||b.x+b.w<=a.x+1||a.y+a.h<=b.y+1||b.y+b.h<=a.y+1;assert(separate(boxes.label,boxes.timing));assert(separate(boxes.label,boxes.tools));
   await local.click('#editor-close');assert(await local.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));report.viewports.push(width);
  }
  await local.click('#nav-settings');await local.getByRole('button',{name:'Screen orientation',exact:true}).click();await local.waitForFunction(()=>!document.getElementById('orientation-save').disabled);await local.selectOption('#orientation-select','90');await local.click('#orientation-save');await local.waitForFunction(()=>!document.getElementById('orientation-dialog').open);
  await local.getByRole('button',{name:'Screen orientation',exact:true}).click();await local.waitForFunction(()=>!document.getElementById('orientation-save').disabled);assert.equal(await local.inputValue('#orientation-select'),'90');await local.click('#orientation-dialog [data-close]');report.orientation=true;
  // Enrollment UI uses the real classifier, without scanning a public subnet.
  const discovery=await local.evaluate(async base=>{const {classifyResult}=await import('./discovery.js');const {loadConfig}=await import('./storage.js');return classifyResult({base,identity:'mock-identity-1'},(await loadConfig()).rooms).kind;},process.env.AR_BROWSER_BASE);assert.equal(discovery,'existing');
  await local.click('#nav-content');await local.click('#refresh');await local.waitForFunction(()=>document.getElementById('toast-text').textContent==='Players and previews refreshed.');report.refresh=true;
  if(process.env.AR_BROWSER_URL){
   const remote=await context.newPage();remote.on('pageerror',e=>errors.push(e.message));await remote.goto(process.env.AR_BROWSER_URL);await remote.waitForSelector('#gate-password');await remote.fill('#gate-password','Password123');await remote.getByRole('button',{name:'Unlock',exact:true}).click();try{await remote.waitForSelector('#app:not([hidden])');}catch(error){console.error({errors,gate:await remote.locator('#gate').innerText()});throw error;}
   await editor(local,'home',23,true);await refreshed(remote);await sharedFrom(remote,local);await waitRoom(remote,'home',23);assert.equal((await getRoom(remote)).lastPublished.role,'home');
   await editor(remote,'event',17,true);await refreshed(local);await sharedFrom(local,remote);await waitRoom(local,'event',17);let r=await getRoom(local);assert.equal(r.lastPublished.role,'event');assert.equal(r.playlists.home[0].duration,23);
   // An open editor must reject a revision written by the other controller.
   await local.click('#edit-home');await local.locator('#editor-list input[type=number]').fill('24');await editor(remote,'home',29,false);await local.click('#editor-save');await local.waitForFunction(()=>document.getElementById('editor-error').textContent.includes('changed'));await local.click('#editor-close');await local.click('#confirm-yes');
   await refreshed(local);await sharedFrom(local,remote);await waitRoom(local,'home',29);await local.click('#show-home');await local.click('#confirm-yes');await local.waitForFunction(()=>document.getElementById('toast-text').textContent.includes('published'));await refreshed(remote);await sharedFrom(remote,local);await waitRoom(remote,'home',29);assert.equal((await getRoom(remote)).lastPublished.role,'home');
   const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOuoAAAAASUVORK5CYII=','base64');
   async function upload(page,role,duration){await page.locator('#'+role+'-file').setInputFiles({name:role+'-fresh.png',mimeType:'image/png',buffer:png});await page.waitForSelector('#editor-list input[type=number]');await page.locator('#editor-list input[type=number]').fill(String(duration));await page.click('#editor-publish');await page.waitForFunction(()=>!document.getElementById('editor-dialog').open,{},{timeout:20000});}
   await upload(local,'home',41);await refreshed(remote);await sharedFrom(remote,local);await waitRoom(remote,'home',41);
   await upload(remote,'event',13);await refreshed(local);await sharedFrom(local,remote);await waitRoom(local,'event',13);
   await local.click('#show-home');await local.click('#confirm-yes');await local.waitForFunction(()=>document.getElementById('toast-text').textContent.includes('published'));await refreshed(remote);await sharedFrom(remote,local);
   // Manual media deletion is propagated to the other controller's associations.
   await local.click('#player-media');await local.waitForSelector('#library-list .library-row');assert(!(await local.locator('#library-list').innerText()).includes('Controller state'));const eventId=(await getRoom(local)).playlists.event[0].id;await local.locator(`#library-list .library-row[data-asset="${eventId}"] button`).click();await local.click('#confirm-yes');await local.waitForFunction(async()=>{const {loadConfig}=await import('./storage.js');return (await loadConfig()).rooms[0].playlists.event.length===0;});await local.click('#library-dialog [data-close]');await refreshed(remote);await sharedFrom(remote,local);assert.equal((await getRoom(remote)).playlists.event.length,0);
   report.nativeUpload=true;report.vpsUpload=true;report.manualDeletionPropagated=true;
   report.localToCloud=true;report.cloudToLocal=true;report.staleEditorRejected=true;report.homeRestored=true;
   await remote.close();
  }
  assert.deepEqual(errors,[]);console.log(JSON.stringify(report));
 }finally{await context.close();fs.rmSync(fixture,{recursive:true,force:true});fs.rmSync(profile,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exit(1)});
