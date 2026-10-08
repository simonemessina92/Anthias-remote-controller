import {t} from './i18n.js';
export const ROTATIONS=[0,90,180,270];
export async function readOrientation(api){
  const settings=await api.settings();
  const value=Number(settings?.screen_rotation);
  if(settings?.screen_rotation===undefined||!ROTATIONS.includes(value))throw new Error(t('Screen orientation is not supported by this player.'));
  return value;
}
export async function writeOrientation(api,value){
  if(!ROTATIONS.includes(value))throw new Error(t('Invalid screen orientation.'));
  const previous=await readOrientation(api);
  if(previous===value)return value;
  await api.patchSettings({screen_rotation:value});
  if(await readOrientation(api)!==value)throw new Error(t('The player did not confirm the new orientation. Refresh before retrying.'));
  return value;
}
