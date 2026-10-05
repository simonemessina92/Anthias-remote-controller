import {rpc,clearTabSession} from './vps-adapter.js';
import {t} from './i18n.js';
let active=false;
export function validatePassword(password,confirmation){if(typeof password!=='string'||password.length<8||password.length>128)throw new Error(t('Use 8 to 128 characters.'));if(password!==confirmation)throw new Error(t('Passwords do not match.'));}
export async function authRecord(){const a=await rpc('/ar/auth/status');active=a.authenticated;return a.enabled?a:null;}
export function hasSession(record){return Boolean(record&&active);}
export async function lockSession(){active=false;try{await rpc('/ar/auth/logout',{});}finally{clearTabSession();}}

export function acceptSession(){}
export async function login(password){const a=await rpc('/ar/auth/login',{password});active=true;return a;}
export async function setPassword(password,confirmation,current=''){
 validatePassword(password,confirmation);
 const bootstrap=document.getElementById('setup-key')?.value||'';
 const a=await rpc('/ar/auth/password',{password,confirmation,current,bootstrap});active=true;return a;
}
export async function disablePassword(){throw new Error(t('Cloud access requires a password.'));}
