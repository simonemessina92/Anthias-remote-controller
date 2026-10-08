import test from 'node:test';
import assert from 'node:assert/strict';
import {readOrientation,writeOrientation} from '../extension/display-settings.js';
test('orientation writes only rotation and verifies all four supported values',async()=>{
  const settings={screen_rotation:0,shuffle_playlist:true,audio_output:'hdmi'},writes=[];
  const api={settings:async()=>({...settings}),patchSettings:async value=>{writes.push(value);Object.assign(settings,value);}};
  for(const value of [90,180,270,0])assert.equal(await writeOrientation(api,value),value);
  assert.deepEqual(writes,[90,180,270,0].map(screen_rotation=>({screen_rotation})));
  assert.equal(settings.shuffle_playlist,true);assert.equal(settings.audio_output,'hdmi');
});
test('unsupported or unknown orientation never triggers a write',async()=>{
  for(const settings of [{},{screen_rotation:45}]){
    const api={settings:async()=>settings,patchSettings:async()=>assert.fail('must not write')};
    await assert.rejects(readOrientation(api));await assert.rejects(writeOrientation(api,90));
  }
});
test('unchanged orientation does not reload the display',async()=>{
  assert.equal(await writeOrientation({settings:async()=>({screen_rotation:90}),patchSettings:async()=>assert.fail('must not write')},90),90);
});
test('unconfirmed write produces an error without replaying PATCH',async()=>{
  let writes=0;
  await assert.rejects(writeOrientation({settings:async()=>({screen_rotation:0}),patchSettings:async()=>writes++},90),/did not confirm/);
  assert.equal(writes,1);
});
