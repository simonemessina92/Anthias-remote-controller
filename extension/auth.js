import {t} from './i18n.js';
const KEY='hmrAuthV4', SESSION='hmrSessionV4', ITERATIONS=600000;
const to64 = bytes => btoa(String.fromCharCode(...bytes));
const from64 = text => Uint8Array.from(atob(text),c=>c.charCodeAt(0));
export function validatePassword(password,confirmation) {
  if(typeof password!=='string'||password.length<8||password.length>128) throw new Error(t('Use 8 to 128 characters.'));
  if(password!==confirmation) throw new Error(t('Passwords do not match.'));
}
export async function makeVerifier(password) {
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:ITERATIONS,hash:'SHA-256'},key,256);
  return {enabled:true,salt:to64(salt),hash:to64(new Uint8Array(bits)),iterations:ITERATIONS,revision:crypto.randomUUID(),failures:0,blockedUntil:0};
}
export async function verifyPassword(password,record) {
  if(!record?.enabled||typeof password!=='string'||password.length>128) return false;
  if(!Number.isInteger(record.iterations)||record.iterations<100000||record.iterations>1500000) throw new Error(t('Invalid password verifier.'));
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
  const bits=new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',salt:from64(record.salt),iterations:record.iterations,hash:'SHA-256'},key,256));
  const expected=from64(record.hash);let diff=bits.length^expected.length;
  for(let i=0;i<bits.length;i++) diff|=bits[i]^(expected[i]||0);
  return diff===0;
}
export async function authRecord() { return (await chrome.storage.local.get(KEY))[KEY] || null; }
export function hasSession(record) { return !record?.enabled || sessionStorage.getItem(SESSION)===record.revision; }
export function lockSession() { sessionStorage.removeItem(SESSION); }
export function acceptSession(record) { if(record?.enabled) sessionStorage.setItem(SESSION,record.revision); }
export async function login(password) {
  return navigator.locks.request('hmr-auth-v4',async()=>{
    const record=await authRecord();
    if(!record?.enabled) return record;
    const seconds=Math.ceil(((record.blockedUntil||0)-Date.now())/1000);
    if(seconds>0) throw new Error(t('Try again in {seconds} seconds.',{seconds}));
    if(!await verifyPassword(password,record)) {
      record.failures=(record.failures||0)+1;
      record.blockedUntil=record.failures>=5?Date.now()+Math.min(300000,30000*Math.pow(2,record.failures-5)):0;
      await chrome.storage.local.set({[KEY]:record});throw new Error(t('Incorrect password.'));
    }
    record.failures=0;record.blockedUntil=0;acceptSession(record);await chrome.storage.local.set({[KEY]:record});return record;
  });
}
export async function setPassword(password,confirmation,current='') {
  validatePassword(password,confirmation);
  return navigator.locks.request('hmr-auth-v4',async()=>{
    const old=await authRecord();if(old?.enabled&&!await verifyPassword(current,old)) throw new Error(t('Incorrect password.'));
    const record=await makeVerifier(password);acceptSession(record);await chrome.storage.local.set({[KEY]:record});return record;
  });
}
export async function disablePassword(current='') {
  return navigator.locks.request('hmr-auth-v4',async()=>{
    const old=await authRecord();if(old?.enabled&&!await verifyPassword(current,old))throw new Error(t('Incorrect password.'));
    const record={enabled:false,revision:crypto.randomUUID()};lockSession();await chrome.storage.local.set({[KEY]:record});return record;
  });
}
