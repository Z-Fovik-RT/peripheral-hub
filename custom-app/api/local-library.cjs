'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {TextDecoder}=require('node:util');
const {S,validate}=require('./schema.cjs');
const contracts=new Map(require('./contracts/common.cjs').map(entry=>[entry.id,entry]));

const operationIds=Object.freeze([
  'macros.list','macros.get','macros.save','macros.rename','macros.duplicate','macros.delete',
  'macros.folder.save','macros.folder.delete','macros.import','macros.export','macros.validate',
  'profiles.list','profiles.get','profiles.save','profiles.rename','profiles.duplicate','profiles.delete',
  'profiles.import','profiles.export','profiles.validate','keyboard.profiles.official.inspect'
]);
const filenames=new Map([
  ['aula-f87-pro','keyboard-library-v1.json'],
  ['inphic-in9','mouse-library-v1.json'],
  ['ikf-v11-pro-71','headset-library-v1.json']
]);
const MAX_FILE_BYTES=8*1024*1024,MAX_EXPORT_CHARS=524288;
const macroList=contracts.get('macros.list').result.properties;
const profileList=contracts.get('profiles.list').result.properties;
const nativeSource=S.obj({profileId:S.string(128),recordIndex:S.int(0,127),contentBase64:S.string(524288),sha256:S.string(64)});
const stateSchema=S.obj({schemaVersion:S.enum([1]),deviceId:S.enum([...filenames.keys()]),
  macros:macroList.macros,folders:macroList.folders,profiles:profileList.profiles,aulaDctSources:S.array(nativeSource,0,128)},['schemaVersion','deviceId','macros','folders','profiles']);
const macroEnvelope=S.obj({schemaVersion:S.enum([1]),format:S.enum(['hub-macro-v1']),
  deviceId:S.enum(contracts.get('macros.import').devices),macros:macroList.macros});
const profileEnvelope=S.obj({schemaVersion:S.enum([1]),format:S.enum(['hub-profile-v1']),
  deviceId:S.enum(contracts.get('profiles.import').devices),profile:contracts.get('profiles.get').result});
// One promise chain per trusted directory also serializes separate factories in this process.
// This is not an inter-process lock; the application must own its library directory.
const queues=new Map();
function fail(code,message){const error=new Error(message);error.code=code;return error;}
function copy(value){return JSON.parse(JSON.stringify(value));}
function check(schema,value,code='INVALID_ARGUMENT',label='args'){
  try{validate(schema,value,label);}catch(error){throw fail(code,error.message);}
}
function issuesCollector(){
  const issues=[];
  return {issues,add:message=>{if(issues.length<128)issues.push(message.slice(0,2048));}};
}
function nameIssues(name,label,add){if(!name.trim())add(label+': name must contain non-whitespace characters.');}
function repeatIssues(repeat,label,add){
  if((repeat.mode==='count')!==Object.hasOwn(repeat,'count'))add(label+': repeat count is required only for count mode.');
}
function macroIssues(macro,deviceId,folderIds,add){
  const label='Macro '+JSON.stringify(macro.id);
  nameIssues(macro.name,label,add);
  if(deviceId==='aula-f87-pro'&&macro.name.length>30)add(label+': keyboard name exceeds 30 UTF-16 code units.');
  repeatIssues(macro.repeat,label,add);
  if(macro.folderId!==null&&!folderIds.has(macro.folderId))add(label+': folder does not exist.');
  const held=new Set();
  macro.events.forEach((event,index)=>{
    let token,down;
    if(event.kind==='keyDown'||event.kind==='keyUp'){token='key:'+event.code;down=event.kind==='keyDown';}
    else if(event.kind==='consumerDown'||event.kind==='consumerUp'){token='consumer:'+event.code;down=event.kind==='consumerDown';}
    else if(event.kind==='mouseDown'||event.kind==='mouseUp'){token='mouse:'+event.button;down=event.kind==='mouseDown';}
    else return; // Delay units and numeric values are preserved verbatim; no execution or conversion.
    if(down){if(held.has(token))add(label+': event '+index+' repeats a down event for '+token+'.');held.add(token);}
    else{if(!held.has(token))add(label+': event '+index+' has no matching down event for '+token+'.');held.delete(token);}
  });
  for(const token of held)add(label+': missing up event for '+token+'.');
}
function profileIssues(profile,deviceId,macroIds,add){
  const label='Profile '+JSON.stringify(profile.id);
  nameIssues(profile.name,label,add);
  if(profile.deviceId!==deviceId)add(label+': device does not match request device.');
  const declared=new Set();
  for(const id of profile.macroIds||[]){
    if(declared.has(id))add(label+': duplicate macro reference '+JSON.stringify(id)+'.');
    declared.add(id);
    if(!macroIds.has(id))add(label+': referenced macro '+JSON.stringify(id)+' does not exist.');
  }
  const keys=new Map();
  for(const binding of profile.bindings||[]){
    let layers=keys.get(binding.keyId);
    if(!layers){layers=new Set();keys.set(binding.keyId,layers);}
    if(layers.has(binding.layer))add(label+': duplicate key/layer mapping '+JSON.stringify(binding.keyId)+'/'+binding.layer+'.');
    layers.add(binding.layer);
    if(binding.assignment.kind==='macro'){
      repeatIssues(binding.assignment.repeat,label+' binding '+JSON.stringify(binding.keyId),add);
      if(!macroIds.has(binding.assignment.macroId))add(label+': binding references missing macro '+JSON.stringify(binding.assignment.macroId)+'.');
    }
  }
}
function stateIssues(state){
  const {issues,add}=issuesCollector();
  if(state.aulaDctSources){
    if(state.deviceId!=='aula-f87-pro')add('Official AULA sources cannot belong to another device.');
    const ids=new Set();
    for(const source of state.aulaDctSources){
      if(ids.has(source.profileId)||!state.profiles.some(profile=>profile.id===source.profileId))add('Official source must reference one unique existing profile.');ids.add(source.profileId);
      try{const decoded=decodeDct(source.contentBase64);if(createHash('sha256').update(decoded.bytes).digest('hex')!==source.sha256||!decoded.parsed.profiles[source.recordIndex])throw Error('Official source hash or record index mismatch.');const profile=state.profiles.find(item=>item.id===source.profileId);if(profile)require('./aula-format.cjs').patchOfficialDct(decoded.bytes,source.recordIndex,profile);}catch(error){add('Official source is invalid: '+error.message);}
    }
  }
  for(const [label,records] of [['macro',state.macros],['folder',state.folders],['profile',state.profiles]]){
    const ids=new Set();
    for(const record of records){if(ids.has(record.id))add('Duplicate '+label+' ID '+JSON.stringify(record.id)+'.');ids.add(record.id);}
  }
  const folders=new Map(state.folders.map(folder=>[folder.id,folder]));
  for(const folder of state.folders){
    nameIssues(folder.name,'Folder '+JSON.stringify(folder.id),add);
    if(folder.parentId!==null&&!folders.has(folder.parentId))add('Folder '+JSON.stringify(folder.id)+': parent does not exist.');
    const ancestors=new Set([folder.id]);
    let next=folder.parentId;
    while(next!==null&&folders.has(next)){
      if(ancestors.has(next)){add('Folder '+JSON.stringify(folder.id)+': parent cycle.');break;}
      ancestors.add(next);next=folders.get(next).parentId;
    }
  }
  if(state.deviceId==='ikf-v11-pro-71'&&(state.macros.length||state.folders.length))add('Headset snapshots cannot contain macros or macro folders.');
  for(const macro of state.macros)macroIssues(macro,state.deviceId,folders,add);
  const macros=new Set(state.macros.map(macro=>macro.id));
  for(const profile of state.profiles)profileIssues(profile,state.deviceId,macros,add);
  return issues;
}
function assertState(state,deviceId,code){
  check(stateSchema,state,code,'library');
  if(state.deviceId!==deviceId)throw fail(code,'Library snapshot belongs to a different device.');
  const issues=stateIssues(state);
  if(issues.length)throw fail(code,issues.join('\n'));
}
function requireRecord(records,id,label){
  const record=records.find(item=>item.id===id);
  if(!record)throw fail('NOT_FOUND',label+' does not exist: '+JSON.stringify(id));
  return record;
}
function upsert(records,record){const index=records.findIndex(item=>item.id===record.id);if(index<0)records.push(record);else records[index]=record;}
function uniqueId(records){let id;do{id=randomUUID();}while(records.some(item=>item.id===id));return id;}
function uniqueSelection(ids){if(new Set(ids).size!==ids.length)throw fail('INVALID_ARGUMENT','IDs must not be repeated.');}
function parseImport(content,schema,format,deviceId){
  let data;
  try{data=JSON.parse(content);}catch{throw fail('INVALID_ARGUMENT','Import content must be valid JSON.');}
  if(data&&typeof data.format==='string'&&data.format!==format)throw fail('UNSUPPORTED_FORMAT','Only '+format+' imports are supported.');
  check(schema,data,'INVALID_ARGUMENT','import');
  if(data.deviceId!==deviceId)throw fail('INVALID_ARGUMENT','Import device does not match request device.');
  return data;
}
function exported(data,suggestedName){
  const content=JSON.stringify(data,null,2);
  if(content.length>MAX_EXPORT_CHARS)throw fail('INVALID_ARGUMENT','Export exceeds 524288 characters; export fewer or smaller records.');
  return {content,suggestedName};
}
function decodeDct(content){
  if(typeof content!=='string'||!content.length||content.length>524288||content.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(content))throw fail('INVALID_ARGUMENT','Official DCT content must be bounded canonical Base64.');
  const bytes=Buffer.from(content,'base64');if(bytes.toString('base64')!==content)throw fail('INVALID_ARGUMENT','Official DCT Base64 is not canonical.');
  return {bytes,parsed:require('./aula-format.cjs').parseOfficialDct(bytes)};
}
async function readState(filename,deviceId){
  let handle;
  try{
    let info;
    try{info=await fs.lstat(filename);}catch(error){if(error.code==='ENOENT')return {schemaVersion:1,deviceId,macros:[],folders:[],profiles:[]};throw error;}
    if(!info.isFile()||info.isSymbolicLink())throw new Error('Library snapshot must be a regular file.');
    if(info.size>MAX_FILE_BYTES)throw new Error('Library snapshot exceeds 8 MiB.');
    handle=await fs.open(filename,'r');
    info=await handle.stat();
    if(!info.isFile()||info.size>MAX_FILE_BYTES)throw new Error('Library snapshot is not a regular file within 8 MiB.');
    // Bounded reads also enforce the cap if an external writer grows the file after stat.
    const chunks=[];let total=0;
    while(total<=MAX_FILE_BYTES){
      const chunk=Buffer.allocUnsafe(Math.min(65536,MAX_FILE_BYTES+1-total));
      const {bytesRead}=await handle.read(chunk,0,chunk.length,null);
      if(!bytesRead)break;
      chunks.push(chunk.subarray(0,bytesRead));total+=bytesRead;
    }
    if(total>MAX_FILE_BYTES)throw new Error('Library snapshot exceeds 8 MiB.');
    const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,total));
    const state=JSON.parse(text);
    assertState(state,deviceId,'STORAGE_ERROR');
    return state;
  }catch(error){throw fail('STORAGE_ERROR','Cannot read valid library snapshot; original file was preserved. '+error.message);}
  finally{if(handle)await handle.close();}
}
async function writeState(directory,filename,state){
  const content=JSON.stringify(state);
  if(Buffer.byteLength(content,'utf8')>MAX_FILE_BYTES)throw fail('INVALID_ARGUMENT','Library snapshot exceeds 8 MiB.');
  // No caller-controlled ID is ever used in a filename. Never truncate the live file.
  const temporary=path.join(directory,'.local-library-'+randomUUID()+'.tmp');
  let handle,created=false;
  try{
    await fs.mkdir(directory,{recursive:true});
    handle=await fs.open(temporary,'wx',0o600);created=true;
    await handle.writeFile(content,'utf8');await handle.sync();await handle.close();handle=null;
    await fs.rename(temporary,filename);created=false;
  }catch(error){throw fail('STORAGE_ERROR','Library save failed; the previous snapshot was not truncated. '+error.message);}
  finally{
    if(handle)await handle.close().catch(()=>{});
    if(created)await fs.unlink(temporary).catch(()=>{});
  }
}
function createLocalLibrary({directory}={}){
  if(typeof directory!=='string'||!path.isAbsolute(directory)||directory.includes('\0'))throw fail('INVALID_ARGUMENT','Library directory must be a trusted absolute path.');
  const root=path.resolve(directory),queueKey=process.platform==='win32'?root.toLowerCase():root;
  // Factory construction does no filesystem IO. Reads do not create directories either.
  const handlers={},pendingSources=new Map();
  for(const operation of operationIds){
    const contract=contracts.get(operation);
    handlers[operation]=async request=>{
      let deviceId,args;
      try{
        if(request&&typeof request.args?.format==='string'&&(operation.endsWith('.import')||operation.endsWith('.export'))){
          const supported=operation.startsWith('macros.')?'hub-macro-v1':'hub-profile-v1';
          if(request.args.format!==supported&&!(operation.startsWith('profiles.')&&request.deviceId==='aula-f87-pro'&&request.args.format==='aula-native'))throw fail('UNSUPPORTED_FORMAT','Only '+supported+' or the supported AULA DCT profile format is available.');
        }
        check(S.obj({deviceId:S.enum(contract.devices),args:contract.args}),request);
        deviceId=request.deviceId;args=copy(request.args);check(contract.args,args);
      }catch(error){if(error.code)throw error;throw fail('INVALID_ARGUMENT',error.message);}
      const run=async()=>{
        const filename=path.join(root,filenames.get(deviceId));
        const state=await readState(filename,deviceId);
        let result,changed=false;
        switch(operation){
          case 'keyboard.profiles.official.inspect':{
            const {bytes,parsed}=decodeDct(args.contentBase64),selected=Number.isInteger(args.recordIndex)?parsed.profiles[args.recordIndex]:null;if(Number.isInteger(args.recordIndex)&&!selected)throw fail('INVALID_ARGUMENT','Official DCT record index is outside the file.');result={activeProfileId:parsed.activeProfileId,sourceSha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length,profiles:parsed.profiles.map(item=>({index:item.index,officialId:item.officialId,name:item.name,knownBindings:item.profile.bindings?.length||0,warnings:item.warnings})),warnings:parsed.warnings||[],selectedRecordIndex:selected?.index??null,opaqueBindings:selected?.opaqueBindings||[]};break;
          }
          case 'macros.list':result={macros:state.macros,folders:state.folders};break;
          case 'macros.get':result=requireRecord(state.macros,args.id,'Macro');break;
          case 'macros.save':upsert(state.macros,args.macro);changed=true;result={saved:true};break;
          case 'macros.rename':requireRecord(state.macros,args.id,'Macro').name=args.name;changed=true;result={saved:true};break;
          case 'macros.duplicate':{
            const macro=copy(requireRecord(state.macros,args.id,'Macro'));macro.id=uniqueId(state.macros);macro.name=args.name;
            state.macros.push(macro);changed=true;result={id:macro.id};break;
          }
          case 'macros.delete':{
            uniqueSelection(args.ids);const selected=new Set(args.ids);
            for(const id of selected)requireRecord(state.macros,id,'Macro');
            for(const profile of state.profiles){
              if((profile.macroIds||[]).some(id=>selected.has(id))||(profile.bindings||[]).some(binding=>binding.assignment.kind==='macro'&&selected.has(binding.assignment.macroId)))throw fail('CONFLICT','Macro is referenced by profile '+JSON.stringify(profile.id)+'.');
            }
            state.macros=state.macros.filter(macro=>!selected.has(macro.id));changed=true;result={deleted:selected.size};break;
          }
          case 'macros.folder.save':upsert(state.folders,args);changed=true;result={saved:true};break;
          case 'macros.folder.delete':
            requireRecord(state.folders,args.id,'Folder');
            if(state.macros.some(macro=>macro.folderId===args.id)||state.folders.some(folder=>folder.parentId===args.id))throw fail('CONFLICT','Folder is not empty.');
            state.folders=state.folders.filter(folder=>folder.id!==args.id);changed=true;result={saved:true};break;
          case 'macros.import':{
            const data=parseImport(args.content,macroEnvelope,'hub-macro-v1',deviceId);
            const ids=new Set(state.macros.map(macro=>macro.id));
            for(const macro of data.macros){if(ids.has(macro.id))throw fail('CONFLICT','Imported macro ID already exists or is duplicated: '+JSON.stringify(macro.id));ids.add(macro.id);}
            state.macros.push(...data.macros);changed=data.macros.length>0;
            result={macros:data.macros,warnings:['Imported macros are saved atomically to this device\'s local library. Folder references must already exist; no hardware was changed.']};break;
          }
          case 'macros.export':
            uniqueSelection(args.ids);
            result=exported({schemaVersion:1,format:'hub-macro-v1',deviceId,macros:args.ids.map(id=>requireRecord(state.macros,id,'Macro'))},'hub-macros.json');break;
          case 'macros.validate':{
            const {issues,add}=issuesCollector();macroIssues(args.macro,deviceId,new Set(state.folders.map(folder=>folder.id)),add);
            result={valid:issues.length===0,issues,estimatedBytes:null};break;
          }
          case 'profiles.list':result={profiles:state.profiles,activeId:null,officialSourceIds:(state.aulaDctSources||[]).map(source=>source.profileId)};break;
          case 'profiles.get':result=requireRecord(state.profiles,args.id,'Profile');break;
          case 'profiles.save':{
            if(args.sourceProfileId&&deviceId!=='aula-f87-pro')throw fail('INVALID_ARGUMENT','Original DCT sources only apply to the AULA profile library.');
            const sourceId=args.sourceProfileId||args.profile.id;
            if(args.sourceProfileId&&!pendingSources.has(sourceId)&&!state.profiles.some(item=>item.id===sourceId))throw fail('NOT_FOUND','Source profile does not exist.');
            upsert(state.profiles,args.profile);const origin=pendingSources.get(sourceId)||state.aulaDctSources?.find(item=>item.profileId===sourceId),source=origin?{...origin,profileId:args.profile.id}:null;
            if(source){state.aulaDctSources=state.aulaDctSources||[];const index=state.aulaDctSources.findIndex(item=>item.profileId===args.profile.id);if(index<0)state.aulaDctSources.push(source);else state.aulaDctSources[index]=source;}
            changed=true;result={saved:true};break;
          }
          case 'profiles.rename':requireRecord(state.profiles,args.id,'Profile').name=args.name;changed=true;result={saved:true};break;
          case 'profiles.duplicate':{
            const profile=copy(requireRecord(state.profiles,args.id,'Profile'));profile.id=uniqueId(state.profiles);profile.name=args.name;
            const source=state.aulaDctSources?.find(item=>item.profileId===args.id);if(source)state.aulaDctSources.push({...source,profileId:profile.id});
            state.profiles.push(profile);changed=true;result={id:profile.id};break;
          }
          case 'profiles.delete':
            requireRecord(state.profiles,args.id,'Profile');state.profiles=state.profiles.filter(profile=>profile.id!==args.id);if(state.aulaDctSources)state.aulaDctSources=state.aulaDctSources.filter(item=>item.profileId!==args.id);changed=true;result={saved:true};break;
          case 'profiles.import':{
            if(args.format==='aula-native'){
              const {bytes,parsed}=decodeDct(args.content),recordIndex=args.recordIndex??0,item=parsed.profiles[recordIndex];
              if(!item)throw fail('INVALID_ARGUMENT','The selected official profile record does not exist.');
              if(pendingSources.size>=32&&!pendingSources.has(item.profile.id))throw fail('INVALID_ARGUMENT','Too many pending native imports; save a staged profile before importing another file.');
              pendingSources.set(item.profile.id,{profileId:item.profile.id,recordIndex,contentBase64:args.content,sha256:createHash('sha256').update(bytes).digest('hex')});
              result={profile:copy(item.profile),warnings:[...item.warnings,...(parsed.warnings||[]),'Staged only. Explicitly save this profile to persist its original DCT; no device settings were changed.']};break;
            }
            if(args.recordIndex!==undefined)throw fail('INVALID_ARGUMENT','recordIndex is only valid for an official AULA DCT.');
            const data=parseImport(args.content,profileEnvelope,'hub-profile-v1',deviceId);
            const {issues,add}=issuesCollector();profileIssues(data.profile,deviceId,new Set(state.macros.map(macro=>macro.id)),add);
            if(issues.length)throw fail('INVALID_ARGUMENT',issues.join('\n'));
            result={profile:data.profile,warnings:['Staged only: this profile has not been saved or applied. Review it, then explicitly save it; saving an existing ID replaces that local profile.']};break;
          }
          case 'profiles.export':{
            const profile=requireRecord(state.profiles,args.id,'Profile');
            if(args.format==='aula-native'){
              const source=state.aulaDctSources?.find(item=>item.profileId===args.id);if(!source)throw fail('UNSUPPORTED_FORMAT','This profile has no saved original DCT; missing bytes cannot be synthesized.');
              const {bytes}=decodeDct(source.contentBase64),output=require('./aula-format.cjs').patchOfficialDct(bytes,source.recordIndex,profile);result={content:output.toString('base64'),suggestedName:'profile.dct'};break;
            }
            result=exported({schemaVersion:1,format:'hub-profile-v1',deviceId,profile},'hub-profile.json');break;
          }
          case 'profiles.validate':{
            const {issues,add}=issuesCollector();profileIssues(args.profile,deviceId,new Set(state.macros.map(macro=>macro.id)),add);
            result={valid:issues.length===0,issues};break;
          }
          default:throw fail('INVALID_ARGUMENT','Unknown local library operation.');
        }
        if(changed)assertState(state,deviceId,'INVALID_ARGUMENT');
        check(contract.result,result,'INVALID_RESPONSE','result');
        if(changed){await writeState(root,filename,state);if(operation==='profiles.save')pendingSources.delete(args.sourceProfileId||args.profile.id);}
        return result;
      };
      const pending=(queues.get(queueKey)||Promise.resolve()).then(run);
      const settled=pending.then(()=>{},()=>{});queues.set(queueKey,settled);
      void settled.then(()=>{if(queues.get(queueKey)===settled)queues.delete(queueKey);});
      return pending;
    };
  }
  return Object.freeze(handlers);
}
module.exports={createLocalLibrary,operationIds};
