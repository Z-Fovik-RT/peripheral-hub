'use strict';
const {randomUUID,createHash}=require('node:crypto');
const path=require('node:path');
const {S,validate}=require('./schema.cjs');
const API_VERSION=1;
const DEVICE_IDS=['aula-f87-pro','inphic-in9','ikf-v11-pro-71','application'];
const requestSchema=S.obj({apiVersion:S.enum([API_VERSION]),deviceId:S.enum(DEVICE_IDS),operation:S.string(160),args:S.obj({})});
function freeze(value){if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function loadCatalog(){
 const entries=[...require('./contracts/common.cjs').filter(entry=>!entry.id.startsWith('macros.')),...require('./contracts/input.cjs'),...require('./contracts/keyboard-draft.cjs'),...require('./contracts/mouse-profile.cjs'),...require('./contracts/headset.cjs'),...require('./contracts/audio-monitor.cjs')];
 const ids=new Set();
 for(const entry of entries){
  if(!/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)+$/.test(entry.id)||ids.has(entry.id))throw new Error('Duplicate or invalid operation id: '+entry.id);
  if(!entry.devices?.length||entry.devices.some(d=>!DEVICE_IDS.includes(d)))throw new Error('Invalid operation device: '+entry.id);
  if(!['read','write','local','destructive'].includes(entry.effect)||!['implemented','planned','unverified','disabled'].includes(entry.availability))throw new Error('Invalid operation policy: '+entry.id);
  if(entry.effect==='destructive'&&entry.availability!=='disabled')throw new Error('Destructive operations must remain disabled: '+entry.id);
  if(!entry.args||!entry.result||!entry.title||!entry.reason||!entry.auditIds)throw new Error('Incomplete operation contract: '+entry.id);
  ids.add(entry.id);
 }
 return freeze(entries);
}
function semanticCheck(operation,args,deviceId){
 if(['headset.audio.set','headset.audio.sessions.set'].includes(operation)&&!Object.hasOwn(args,'volume')&&!Object.hasOwn(args,'muted'))throw new Error('At least volume or muted must be supplied.');
 if(['app.preferences.set','system.mouse.scroll.set'].includes(operation)&&!Object.keys(args).length)throw new Error('At least one preference must be supplied.');
 if(operation!=='profiles.validate'&&args.profile&&Object.hasOwn(args.profile,'deviceId')&&args.profile.deviceId!==deviceId)throw new Error('Profile device does not match request device.');
 if(operation==='mouse.dpi.set'&&(!args.stages.some(s=>s.enabled)||!args.stages[args.activeStage].enabled))throw new Error('At least one DPI stage and the active stage must be enabled.');
 if(operation==='mouse.dpi.mask.set'&&!args.enabled.some(Boolean))throw new Error('At least one DPI stage must remain enabled.');
 if(['mouse.bindings.set','mouse.bindings.validate'].includes(operation)){
  if(new Set(args.bindings.map(b=>b.button)).size!==6)throw new Error('Each of six buttons must appear exactly once.');
  if(!args.bindings.some(b=>(b.action.kind==='mouse'&&b.action.button==='left')||(b.button==='left'&&b.action.kind==='default')))throw new Error('At least one left-click binding must remain.');
 }
 if(['keyboard.bindings.set','keyboard.bindings.validate'].includes(operation)&&new Set(args.bindings.map(b=>b.keyId)).size!==args.bindings.length)throw new Error('Key identifiers must be unique.');
 if(operation==='keyboard.sleep.set'&&(args.seconds%30!==0||(args.enabled?args.seconds===0:args.seconds!==0)))throw new Error('Sleep uses 30-second increments; disabled sleep has zero seconds.');
 const effectLimits={brilliant:{levelRaw:[0,10]},dynamicBass:{levelRaw:[0,10],cutoffRaw:[100,400,[100,150,200,300,400]]},smartVolume:{levelRaw:[0,100],modeRaw:[0,1]},voiceClarity:{levelRaw:[0,10],noiseSuppressionRaw:[0,20,[0,5,10,15,20]]},'mic.magicVoice':{selectionRaw:[0,3]},'mic.nr':{levelRaw:[6,40]}};
 if(operation==='headset.audio.balance.set'&&[args.state.leftRaw,args.state.rightRaw].some(v=>v<0||v>1))throw new Error('Balance scalars must be within 0..1.');
 if(operation==='headset.audio.channels.set'&&args.state.channels.some((v,i)=>v.channelRaw!==i||v.volumeRaw<0||v.volumeRaw>1))throw new Error('Supply all channels in order with scalar volumes 0..1.');
 if(operation==='headset.eq.set'&&args.state.bandsRaw.some(v=>v< -20||v>20))throw new Error('EQ bands must be within -20..20 dB.');
 for(const [feature,fields]of Object.entries(effectLimits))if(operation==='headset.'+feature+'.set')for(const [key,[min,max,allowed]]of Object.entries(fields))if(args.state[key]<min||args.state[key]>max||allowed&&!allowed.includes(args.state[key]))throw new Error('Value outside official UI range: '+key);
 if(operation==='headset.virtualSpeaker.set'&&new Set(args.state.speakers.map(s=>s.channel)).size!==8)throw new Error('Eight distinct speaker channels are required.');
}
function createFeatureApi(handlers={},catalog=loadCatalog()){
 const byId=new Map(catalog.map(c=>[c.id,c]));
 for(const entry of catalog)if(entry.availability==='implemented'&&typeof handlers[entry.id]!=='function')throw new Error('Implemented operation has no adapter: '+entry.id);
 for(const id of Object.keys(handlers))if(byId.get(id)?.availability!=='implemented')throw new Error('Unexpected adapter outside enabled catalog: '+id);
 const capability=entry=>({...entry,canInvoke:entry.availability==='implemented',deviceReadiness:'not-probed',apiVersion:API_VERSION});
 const list=(query={})=>{
  validate(S.obj({deviceId:S.enum(DEVICE_IDS)},[]),query);
  return {apiVersion:API_VERSION,deviceReadiness:'not-probed',operations:catalog.filter(c=>!query.deviceId||c.devices.includes(query.deviceId)).map(capability)};
 };
 const describe=query=>{
  validate(S.obj({operation:S.string(160)}),query);
  const entry=byId.get(query.operation);return entry?capability(entry):null;
 };
 async function invoke(request){
  const requestId=randomUUID();
  const base={apiVersion:API_VERSION,requestId,deviceId:typeof request?.deviceId==='string'?request.deviceId:null,operation:typeof request?.operation==='string'?request.operation:null};
  const fail=(code,message,retryable=false)=>({...base,ok:false,error:{code,message,retryable}});
  let entry;
  try{
   // Envelope is closed; args are validated against the operation-specific schema below.
   if(!request||typeof request!=='object'||Array.isArray(request)||![Object.prototype,null].includes(Object.getPrototypeOf(request)))throw new Error('Request must be a plain object');
   if(!Object.hasOwn(request,'args'))throw new Error('args is required');
   validate(requestSchema, {...request,args:{}});
   const size=Buffer.byteLength(JSON.stringify(request),'utf8');if(size>(request.operation.startsWith('mouse.profile.')?1600000:1048576))throw new Error('Request exceeds the operation size limit.');
   entry=byId.get(request.operation);
   if(!entry)return fail('UNKNOWN_OPERATION','Unknown operation.');
   if(!entry.devices.includes(request.deviceId))return fail('DEVICE_MISMATCH','Operation does not belong to this device.');
   validate(entry.args,request.args,'args');
   semanticCheck(entry.id,request.args,request.deviceId);
  }catch(error){return fail('INVALID_ARGUMENT',error.message);}
  if(entry.availability==='disabled')return fail('DISABLED_OPERATION',entry.reason);
  if(entry.availability==='planned')return fail('NOT_IMPLEMENTED',entry.reason);
  if(entry.availability==='unverified')return fail('UNVERIFIED',entry.reason);
  let actual;
  try{actual=await handlers[entry.id]({deviceId:request.deviceId,args:request.args});}
  catch(error){const code=['UNVERIFIED','DEVICE_NOT_READY','READBACK_MISMATCH','DEPENDENCY_MISSING','INVALID_ARGUMENT','DEVICE_MISMATCH','UNSUPPORTED_FORMAT','NOT_FOUND','CONFLICT','STORAGE_ERROR'].includes(error.code)?error.code:'ADAPTER_ERROR';return fail(code,error.message||'Device adapter failed.',code==='DEVICE_NOT_READY');}
  try{
       if(entry.id==='mouse.profile.statusRead'&&(actual.source!=='live-hardware-feature20'||actual.scope!=='identity-power-activity'||actual.hardwareReadback!==true||actual.writePerformed!==false||!Number.isFinite(Date.parse(actual.readAt))))throw new Error('IN9 live status response is not a valid identity/power/activity-only Feature20 result.');
    if(entry.id==='mouse.profile.installedList'){
     if(actual.found!==true){if(actual.found!==false||actual.source!==null||actual.directory!==null||actual.profileCount!==0||actual.profiles?.length!==0)throw new Error('Installed profile not-found response is inconsistent.');}
     else{
      if(typeof actual.directory!=='string'||!Number.isInteger(actual.profileCount)||actual.profileCount<1||actual.profileCount>5||!Array.isArray(actual.profiles)||actual.profiles.length!==actual.profileCount)throw new Error('Installed profile directory or count mismatch.');
      const normalize=value=>path.win32.normalize(value).replace(/[\\/]+$/,'').toLowerCase();
      const appDataConfig=process.env.APPDATA?path.win32.join(process.env.APPDATA,'GamingMouseData20230908A','config'):null;
      const root=normalize(actual.directory),approved=actual.source==='official-install'?['D:\\Program Files\\Inphic IN9 Gaming Mouse\\config','C:\\Program Files\\Inphic IN9 Gaming Mouse\\config']:actual.source==='official-user-data'&&appDataConfig?[appDataConfig]:actual.source==='bundled-defaults'?[path.resolve(__dirname,'..','in9-default-profiles')]:[];
      if(!approved.some(directory=>normalize(directory)===root))throw new Error('IN9 profile source does not match its fixed resource directory.');
      const expected=new Set(['default0.psf','default1.psf','default2.psf','default3.psf','default4.psf']);
      for(const item of actual.profiles){if(!expected.delete(String(item.file).toLowerCase()))throw new Error('Unexpected or duplicate installed profile filename.');if(typeof item.path!=='string'||normalize(item.path)!==path.win32.join(root,item.file.toLowerCase()))throw new Error('Installed profile path is outside the fixed directory or does not match its filename.');if(typeof item.contentBase64!=='string'||typeof item.contentSha256!=='string')throw new Error('Installed profile content identity is missing.');const digest=createHash('sha256').update(Buffer.from(item.contentBase64,'base64')).digest('hex').toUpperCase();if(digest!==item.contentSha256.toUpperCase())throw new Error('Installed profile content hash mismatch.');}
      if(actual.source==='bundled-defaults'&&expected.size)throw new Error('Bundled profile template set is incomplete.');
     }
    }
    if(entry.id==='mouse.profile.archiveInstalled'){
     if(actual.hardwareReadback!==false||actual.sourceFilesModified!==false||!Number.isFinite(Date.parse(actual.createdAt))||!Array.isArray(actual.files)||actual.files.length>64)throw new Error('IN9 archive provenance or file list is invalid.');
     if(!actual.archiveCreated){if(actual.archiveId!==null||actual.archiveRelativeDirectory!==null||actual.files.length)throw new Error('Empty IN9 archive result must not claim an archive.');}
     else{
      if(typeof actual.archiveId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actual.archiveId)||actual.archiveRelativeDirectory!==('local-state/vendor-config-archives/in9/'+actual.archiveId)||!actual.files.length)throw new Error('IN9 archive identity or destination is invalid.');
      const archivePaths=new Set();let archiveBytes=0;
      for(const file of actual.files){
       const allowedName=/^(?:[A-Za-z0-9_. -]{1,124}\.psf|config\.ini|MacroLibraryFile\.mlf)$/i;
        const relative=/^source-(\d+)\/([A-Za-z0-9_. -]{1,128})$/i.exec(String(file.relativePath));
       const psf=/\.psf$/i.test(String(file.fileName));
        if(!['official-user-data','official-install'].includes(file.source)||typeof file.fileName!=='string'||!allowedName.test(file.fileName)||!/^[A-Za-z0-9_. -]{1,128}$/.test(file.fileName)||!relative||relative[2]!==file.fileName||file.relativePath!==`source-${relative[1]}/${file.fileName}`||archivePaths.has(file.relativePath))throw new Error('IN9 archive file path or name is invalid.');
       if(!Number.isInteger(file.byteLength)||file.byteLength<1||file.byteLength>8388608||!/^[0-9a-f]{64}$/i.test(file.sha256))throw new Error('IN9 archive file metadata is invalid.');
       if((psf||file.fileName.toLowerCase()==='config.ini')&&file.byteLength>1048576)throw new Error('IN9 PSF/INI archive file exceeds its 1 MiB cap.');
       archivePaths.add(file.relativePath);archiveBytes+=file.byteLength;if(archiveBytes>33554432)throw new Error('IN9 archive exceeds its 32 MiB cap.');
      }
     }
    }
    validate(entry.result,actual,'result');
   if(entry.id.startsWith('headset.profiles.')&&!((actual.source==='sdk'&&actual.scope==='licensed-effects')||(actual.source==='windows-effect-store'&&actual.scope==='target-effects')))throw Error('Global profile source and effect scope do not match.');
   if(entry.id.startsWith('headset.audio.monitor.')){
    if(actual.running){if(!Number.isFinite(Date.parse(actual.sampledAt))||actual.endpointIds.length<1||actual.endpoints.length!==actual.endpointIds.length||new Set(actual.endpointIds).size!==actual.endpointIds.length)throw Error('Running audio monitor has no coherent timestamp or endpoint set.');}
    else if(actual.sampledAt!==null||actual.endpointIds.length||actual.endpoints.length)throw Error('Stopped audio monitor must clear its current readback.');
    if(entry.id==='headset.audio.monitor.start'&&actual.running&&(actual.endpointIds.length!==request.args.endpointIds.length||actual.endpointIds.some(id=>!request.args.endpointIds.some(value=>value.toLowerCase()===id.toLowerCase()))))throw Error('Audio monitor response belongs to different endpoints.');
    const seen=new Set();for(const endpoint of actual.endpoints){const match=/^\{0\.0\.([01])\.00000000\}\.\{[0-9a-f-]{36}\}$/i.exec(endpoint.endpointId);if(!match||seen.has(endpoint.endpointId)||!actual.endpointIds.includes(endpoint.endpointId)||endpoint.flow!==(match[1]==='0'?'render':'capture'))throw Error('Audio monitor endpoint identity or flow mismatch.');seen.add(endpoint.endpointId);if(endpoint.available){if(endpoint.identityVerified!==true||endpoint.volume===null||endpoint.muted===null)throw Error('Available audio monitor values must have verified identity.');}else if(endpoint.identityVerified!==false||['volume','muted','channels','peaks'].some(key=>endpoint[key]!==null))throw Error('Unavailable audio monitor values must remain unknown.');}
   }
   if(['device.read','device.restore'].includes(entry.id)&&actual.id!==request.deviceId)throw new Error('Response belongs to a different device.');
   if(entry.id==='device.read'&&request.deviceId==='aula-f87-pro'&&actual.source==='hardware'){const mode=(actual.settings.supportedModes||[]).find(item=>item.id===actual.settings.modeRaw);if(mode&&mode.hasSpeed!==true&&actual.settings.speed!==null)throw new Error('Current AULA mode does not expose a readable speed value.');if(mode&&mode.hasColor!==true&&actual.settings.colorIndex!==null)throw new Error('Current AULA mode does not expose a readable color value.');}
   if(entry.id==='keyboard.configuration.snapshot.read'){
    if(actual.writeBaselineEligible!==false||actual.matrices.length!==4||actual.matrices.some((block,index)=>block.layer!==index))throw new Error('AULA snapshot must retain four ordered layers and remain ineligible as a write baseline.');
    const inspectBlock=(block,kind)=>{
     if(block.blockComplete!==(block.actualLength===512))throw new Error('AULA '+kind+' completeness does not match its actual length.');
     if(block.rawContentBase64===null){if(block.actualLength!==null||block.blockComplete||block.markerPresent!==null)throw new Error('Missing AULA '+kind+' bytes must remain unknown.');return;}
     if(!(kind==='palette'?[490,512]:[504,512]).includes(block.actualLength))throw new Error('AULA '+kind+' actualLength is outside its response contract.');
     if(!block.attempted||typeof block.rawContentBase64!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(block.rawContentBase64))throw new Error('AULA '+kind+' raw payload is invalid.');
     const raw=Buffer.from(block.rawContentBase64,'base64');if(raw.length!==block.actualLength)throw new Error('AULA '+kind+' payload length differs from actualLength.');
     const marker=block.actualLength===512&&(kind==='palette'?raw[506]===0x5a&&raw[507]===0xa5:raw[508]===0&&raw[509]===0&&raw[510]===0x5a&&raw[511]===0xa5);
     if(block.markerPresent!== (block.actualLength===512?marker:null))throw new Error('AULA '+kind+' marker status differs from retained bytes.');
    };
    for(const block of actual.matrices)inspectBlock(block,'matrix');inspectBlock(actual.palette,'palette');
    if(actual.identityAfterPsdHex!==null&&!actual.identityAfterAttempted)throw new Error('AULA final PSD cannot exist without the final identity query.');
    if(actual.identityStable===true&&(actual.identityBeforePsdHex!=='03000000010B'||actual.identityAfterPsdHex!=='03000000010B'))throw new Error('Stable AULA identity must match the verified F87 PRO PSD on both sides.');
    if(actual.snapshotComplete!== (actual.identityStable===true&&actual.matrices.every(block=>block.blockComplete)&&actual.palette.blockComplete))throw new Error('AULA snapshotComplete must reflect the complete same-session raw read only.');
   }
    if(entry.id==='headset.audio.set'&&(actual.id!==request.args.endpointId||(Object.hasOwn(request.args,'volume')&&Math.abs(actual.volume-request.args.volume)>0.5)||(Object.hasOwn(request.args,'muted')&&actual.muted!==request.args.muted)))throw new Error('Audio endpoint/readback mismatch.');
   if(entry.id.startsWith('headset.')&&entry.id.endsWith('.set')&&request.args.state){
    if(actual.applied!==true||actual.verified!==true||actual.support!=='supported'||!actual.state)throw new Error('Effect setter did not return a verified applied state.');
    if(entry.id==='headset.audio.channels.set'){
      const expected=request.args.state.channels,readback=actual.state.channels;
      if(expected.length!==readback.length||expected.some((v,i)=>v.channelRaw!==readback[i].channelRaw||Math.abs(v.volumeRaw-readback[i].volumeRaw)>0.001))throw new Error('Channel readback mismatch.');
     }else if(entry.id==='headset.audio.balance.set'){
      if(['leftRaw','rightRaw'].some(k=>Math.abs(actual.state[k]-request.args.state[k])>0.001))throw new Error('Balance readback mismatch.');
     }else for(const [key,value]of Object.entries(request.args.state))if(JSON.stringify(actual.state[key])!==JSON.stringify(value))throw new Error('Effect readback mismatch: '+key);
   }
   
    
    if(entry.id==='headset.master.set'&&(actual.applied!==true||actual.verified!==true||actual.state.enabled!==request.args.enabled||(!request.args.enabled&&actual.state.effects.some(effect=>effect.enabled))))throw new Error('Master effect switch readback mismatch.');
    if(entry.id==='system.mouse.set'&&actual.settings[request.args.setting]!==request.args.value)throw new Error('System preference readback mismatch.');
    if(entry.id==='system.mouse.precision.set'&&actual.settings.enhancedPrecision!==request.args.enabled)throw new Error('Enhanced-precision readback mismatch.');
    if(entry.id==='system.mouse.buttons.set'&&actual.settings.swapPrimary!==request.args.swapPrimary)throw new Error('Primary-button swap readback mismatch.');
    if(entry.id==='system.mouse.scroll.set'&&((Object.hasOwn(request.args,'verticalLines')&&actual.settings.wheelLines!==request.args.verticalLines)||(Object.hasOwn(request.args,'horizontalCharacters')&&actual.settings.horizontalCharacters!==request.args.horizontalCharacters)))throw new Error('Scroll preference readback mismatch.');
   if(entry.id.startsWith('headset.')&&Object.hasOwn(actual,'endpointId')&&Object.hasOwn(request.args,'endpointId')&&actual.endpointId!==request.args.endpointId)throw new Error('Diagnostic response belongs to a different endpoint.');
  }
  catch(error){return fail('INVALID_RESPONSE','Adapter response failed contract validation: '+error.message);}
  return {...base,ok:true,data:actual,meta:{observedAt:new Date().toISOString(),implementation:'implemented',effect:entry.effect,evidence:entry.evidence}};
 }
 return Object.freeze({list,describe,invoke,catalog});
}
module.exports={API_VERSION,DEVICE_IDS,loadCatalog,createFeatureApi};
