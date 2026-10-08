const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES?process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright':'playwright');
const fs=require('fs'),assert=require('assert');
(async()=>{
 const host={url:process.env.AR_BROWSER_URL,base:process.env.AR_BROWSER_BASE};
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const report=[];
 for(const size of [[360,800],[390,844],[768,1024],[1024,768],[1920,1080]]){
  const context=await browser.newContext({viewport:{width:size[0],height:size[1]}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(host.url);await page.waitForSelector('#gate-password');await page.fill('#gate-password','Password123');await page.getByRole('button',{name:'Unlock',exact:true}).click();
  await page.waitForSelector('#app:not([hidden])');await page.waitForFunction(()=>document.querySelector('#event-preview img')?.naturalWidth>0);
  assert(await page.locator('#event-preview img').evaluate(e=>e.naturalWidth>0),'video thumbnail absent');
  const overflow=await page.evaluate(()=>({w:innerWidth,sw:document.documentElement.scrollWidth}));assert(overflow.sw<=overflow.w+1,JSON.stringify(overflow));
  await page.click('#nav-settings');const heading=await page.locator('.settings-heading h1').boundingBox();assert(heading.width>90,'Settings squeezed');
  await page.getByRole('button',{name:'Screen orientation',exact:true}).click();await page.waitForFunction(()=>!document.getElementById('orientation-save').disabled);
  await page.selectOption('#orientation-select','90');await page.click('#orientation-save');await page.waitForFunction(()=>!document.getElementById('orientation-dialog').open);
  await page.getByRole('button',{name:'Screen orientation',exact:true}).click();await page.waitForFunction(()=>!document.getElementById('orientation-save').disabled);assert.equal(await page.inputValue('#orientation-select'),'90');await page.click('#orientation-dialog [data-close]');
  await page.click('#settings-discover');
  // Exercise the same enrollment classifier used by the wizard and the scan.
  await page.route('**/ar/scan',async route=>{await route.fulfill({json:{id:'browser-scan'}});});
  await page.route('**/ar/scan?id=browser-scan',async route=>{await route.fulfill({json:{done:true,total:1,checked:1,results:[{base:host.base,identity:'mock-identity-1',info:{device_model:'Synthetic player',anthias_version:'v2026.9.0'}}],errors:{},unresolved:[],elapsedMs:100}});});
  await page.fill('#scan-address','192.168.10.0');await page.fill('#scan-subnet','24');await page.click('#scan-go');
  await page.waitForSelector('.already-enrolled');assert(await page.locator('.already-enrolled input[type=checkbox]').isDisabled());assert(await page.locator('#scan-add').isDisabled());assert((await page.locator('.already-enrolled').innerText()).includes('Already enrolled'));
  await page.click('#discovery-done');await page.click('#nav-content');await page.click('#refresh');await page.waitForFunction(()=>document.getElementById('toast-text').textContent==='Players and previews refreshed.');
  await page.waitForFunction(()=>document.querySelector('#event-preview img')?.naturalWidth>0);assert(await page.locator('#event-preview img').evaluate(e=>e.naturalWidth>0));
  if(process.env.AR_BROWSER_SCREENSHOTS)await page.screenshot({path:`${process.env.AR_BROWSER_SCREENSHOTS}/anthias-${size[0]}.png`,fullPage:true});
  assert.deepEqual(errors,[]);report.push({viewport:size,thumbnail:true,orientationReadWrite:true,refresh:true,noHorizontalOverflow:true,settingsHeadingWidth:heading.width});await context.close();
 }
 await browser.close();console.log(JSON.stringify(report));
})().catch(e=>{console.error(e);process.exit(1)});
