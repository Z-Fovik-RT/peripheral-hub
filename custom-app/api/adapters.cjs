'use strict';
// Reuse the same validated, serialized, backed-up paths as the existing UI.
const {validate}=require('./schema.cjs');
const presetApplyArgs=require('./contracts/headset.cjs').find(c=>c.id==='headset.eq.presets.apply').args;
function createAdapters(call,{directory,autoSwitchRuntime}={}){
 if(!directory)throw Error('A trusted local library directory is required.');
 const local=Object.fromEntries(Object.entries({...require('./local-library.cjs').createLocalLibrary({directory}),...require('./eq-presets.cjs').createEqPresets({directory}),...require('./autoswitch.cjs').createAutoSwitch({directory,runtime:autoSwitchRuntime}),...require('./color-favorites.cjs').createColorFavorites({directory})}).filter(([operation])=>!operation.startsWith('macros.')));
 return {
  ...local,
  'app.preferences.read':()=>call('hub:preferences-read'),
  'app.preferences.set':({args})=>call('hub:preferences-set',args),
  'device.read':({deviceId})=>call('hub:device-read',{id:deviceId}),
  'device.restore':({deviceId})=>call('hub:device-restore',{id:deviceId}),
  'keyboard.identity.read':({deviceId})=>call('hub:device-keyboard-identity',{id:deviceId}),
  'keyboard.bindings.snapshot.read':({deviceId,args})=>call('hub:device-keyboard-matrix',{id:deviceId,...args}),
  'keyboard.configuration.snapshot.read':({deviceId})=>call('hub:device-keyboard-snapshot',{id:deviceId}),
  'keyboard.palette.read':({deviceId,args})=>call('hub:device-keyboard-palette',{id:deviceId,...args}),
  'keyboard.draft.patch':({args})=>call('hub:keyboard-draft-patch',args),
  'keyboard.lighting.brightness.set':async({deviceId,args})=>{
   const response=await call('hub:device-set',{id:deviceId,setting:'brightness',value:args.value});
   if(response?.source!=='hardware'||response.settings?.brightness!==args.value){const error=new Error('Keyboard brightness readback did not match request.');error.code='READBACK_MISMATCH';throw error;}
   return {brightness:response.settings.brightness,verified:true};
  },
  ...Object.fromEntries([['keyboard.lighting.mode.set','activeMode','modeId'],['keyboard.lighting.speed.set','speed','value'],['keyboard.lighting.color.set','colorIndex','colorIndex'],['keyboard.debounce.set','debounce','rawCode']].map(([operation,setting,key])=>[operation,async({deviceId,args})=>{const response=await call('hub:device-set',{id:deviceId,setting,value:args[key]});const value=response?.settings?.[setting==='activeMode'?'modeRaw':setting];if(response.source!=='hardware'||value!==args[key])throw Object.assign(Error('Keyboard readback mismatch.'),{code:'READBACK_MISMATCH'});return setting==='debounce'?{state:{rawCode:value},verified:true}:{[key]:value,verified:true};}])),
  'keyboard.sleep.read':async({deviceId})=>{const r=await call('hub:device-read',{id:deviceId});if(r.source!=='hardware')throw Object.assign(Error('Keyboard is not ready.'),{code:'DEVICE_NOT_READY'});return {enabled:r.settings.sleepCode!==0,seconds:r.settings.sleepSeconds};},
  'keyboard.sleep.set':async({deviceId,args})=>{const value=args.enabled?args.seconds/30:0;const r=await call('hub:device-set',{id:deviceId,setting:'sleepCode',value});if(r.source!=='hardware'||r.settings.sleepCode!==value)throw Object.assign(Error('Sleep readback mismatch.'),{code:'READBACK_MISMATCH'});return {state:{enabled:value!==0,seconds:r.settings.sleepSeconds},verified:true};},
  'keyboard.debounce.read':async({deviceId})=>{const r=await call('hub:device-read',{id:deviceId});if(r.source!=='hardware')throw Object.assign(Error('Keyboard is not ready.'),{code:'DEVICE_NOT_READY'});return {rawCode:r.settings.debounce};},
  'keyboard.lighting.read':async({deviceId})=>{const r=await call('hub:device-read',{id:deviceId});if(r.source!=='hardware')throw Object.assign(Error('Keyboard is not ready.'),{code:'DEVICE_NOT_READY'});const s=r.settings;return {modeId:s.modeRaw,brightness:s.brightness,speed:s.speed,colorIndex:s.colorIndex,enabled:s.modeRaw!==0,custom:s.modeRaw===21};},
  'keyboard.lighting.enabled.set':async({deviceId,args})=>{const r=await call('hub:device-set',{id:deviceId,setting:'activeMode',value:args.enabled?1:0});if(r.source!=='hardware'||(r.settings.modeRaw!==0)!==args.enabled)throw Object.assign(Error('Lighting enable readback mismatch.'),{code:'READBACK_MISMATCH'});return {enabled:args.enabled,verified:true};},
     'mouse.profile.statusRead':({args})=>call('hub:mouse-profile-status-read',args),
   'mouse.profile.installedList':({args})=>call('hub:mouse-profile-installed-list',args),
   ...Object.fromEntries(['preview','read','export','apply','restore'].map(operation=>['mouse.profile.'+operation,({args})=>call('hub:mouse-profile-'+operation,args)])),
   'mouse.profile.archiveInstalled':({args})=>call('hub:mouse-profile-archive-installed',args),
  'system.mouse.read':()=>call('hub:mouse-read'),
  'system.mouse.set':({args})=>call('hub:mouse-set',args),
  'system.mouse.restore':()=>call('hub:mouse-restore'),
  'system.mouse.precision.set':({args})=>call('hub:mouse-set',{setting:'enhancedPrecision',value:args.enabled?1:0}),
  'system.mouse.buttons.set':({args})=>call('hub:mouse-set',{setting:'swapPrimary',value:args.swapPrimary?1:0}),
  'system.mouse.scroll.set':({args})=>call('hub:mouse-scroll-set',args),
  'headset.audio.list':async()=>({endpoints:(await call('hub:snapshot')).audio.map(endpoint=>({id:endpoint.id,name:endpoint.name,flow:endpoint.flow,volume:endpoint.volume,muted:endpoint.muted}))}),
  'headset.audio.set':({args})=>call('hub:audio-set',{id:args.endpointId,...(Object.hasOwn(args,'volume')?{volume:args.volume}:{}),...(Object.hasOwn(args,'muted')?{muted:args.muted}:{})}),
  'headset.audio.restore':()=>call('hub:audio-restore'),
  ...Object.fromEntries(['start','read','stop'].map(action=>['headset.audio.monitor.'+action,({args})=>call('hub:headset-audio-monitor-'+action,args)])),
  ...Object.fromEntries(['balance.read','balance.set','channels.read','channels.set','peak.read','sessions.list','sessions.set','format.read','format.list','format.set','default.read','default.set','controls.restore'].map(operation=>['headset.audio.'+operation,({args})=>call('hub:headset-audio-'+operation.replaceAll('.','-'),args)])),
  'headset.device.detect':()=>call('hub:headset-detect'),
  'headset.device.info.read':({args})=>call('hub:headset-info',args),
  'headset.apo.binding.read':({args})=>call('hub:headset-apo',args),
  'headset.mic.aec.read':({args})=>{
   try{validate(require('./contracts/headset.cjs').find(c=>c.id==='headset.mic.aec.read').args,args,'AEC read');if(!/^\{0\.0\.1\.00000000\}\.\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$/.test(args.endpointId))throw Error('AEC requires a capture endpoint.');}catch(error){throw Object.assign(error,{code:'INVALID_ARGUMENT'});}
   return call('hub:headset-aec-read',{endpointId:args.endpointId});
  },
   ...Object.fromEntries(['eq','surround71','brilliant','dynamicBass','smartVolume','voiceClarity','surroundMax','mic.magicVoice','mic.nr'].flatMap(feature=>['read','set'].map(action=>['headset.'+feature+'.'+action,({args})=>call('hub:headset-effects-'+action,{...args,feature})]))),
  ...Object.fromEntries(['read','set','restore'].map(action=>['headset.master.'+action,({args})=>call('hub:headset-master-'+action,args)])),
  ...Object.fromEntries(['list','create','select','delete'].map(action=>['headset.profiles.'+action,({args})=>call('hub:headset-profiles-'+action,args)])),
  'headset.effects.restore':()=>call('hub:headset-effects-restore'),
  'headset.eq.presets.apply':async({deviceId,args})=>{
   try{validate(presetApplyArgs,args,'args');}catch(error){throw Object.assign(error,{code:'INVALID_ARGUMENT'});}
    if(args.flow!=='render')throw Object.assign(Error('录音十段EQ尚未确认，不能应用播放预设到录音端点。'),{code:'UNVERIFIED'});
   const {preset}=await local['headset.eq.presets.export']({deviceId,args:{presetId:args.presetId,flow:args.flow}});
   if(preset.bandsRaw.some(v=>v< -20||v>20))throw Object.assign(Error('预设超出官方EQ范围−20至20dB。'),{code:'INVALID_ARGUMENT'});
   const r=await call('hub:headset-eq-preset-apply',{endpointId:args.endpointId,bandsRaw:preset.bandsRaw});
   if(r?.applied!==true||r.verified!==true||r.support!=='supported'||!['sdk','windows-effect-store'].includes(r.source)||r.endpointId!==args.endpointId||typeof r.preservedEnabled!=='boolean'||r.state?.enabled!==r.preservedEnabled||JSON.stringify(r.state.bandsRaw)!==JSON.stringify(preset.bandsRaw))throw Object.assign(Error('EQ预设读回不一致。'),{code:'READBACK_MISMATCH'});
   return {applied:true,verified:true,warnings:[]};
  },
  'app.version.read':()=>call('hub:info')
 };
}
module.exports={createAdapters};
