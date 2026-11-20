'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {S,validate}=require('./schema.cjs');
const preferenceSchema=S.obj({language:S.enum(['zh-CN','en-US']),startOnLogin:S.bool,closeBehavior:S.enum(['exit','minimizeToTray']),reduceMotion:S.bool});
const patchSchema=S.obj(preferenceSchema.properties,[]);
const defaults=Object.freeze({language:'zh-CN',startOnLogin:false,closeBehavior:'exit',reduceMotion:false});
const fail=(code,message)=>Object.assign(Error(message),{code});
const queues=new Map();
function createPreferences({directory,startup,prepareCloseBehavior,io=fs}={}){
 if(typeof directory!=='string'||!path.isAbsolute(directory))throw TypeError('A trusted preferences directory is required.');
 const root=path.resolve(directory),filename=path.join(root,'application-preferences.json'),queueKey=process.platform==='win32'?root.toLowerCase():root;let cached={...defaults},configured=false;
 const enqueue=run=>{const job=(queues.get(queueKey)||Promise.resolve()).then(run),settled=job.catch(()=>{});queues.set(queueKey,settled);void settled.then(()=>{if(queues.get(queueKey)===settled)queues.delete(queueKey);});return job;};
 async function load(){
  try{
   let info;try{info=await io.lstat(filename);}catch(error){if(error.code==='ENOENT'){cached={...defaults};configured=false;return;}throw error;}
   if(!info.isFile()||info.isSymbolicLink()||info.size>8192)throw Error('Preference storage is not a bounded regular file.');
   const data=JSON.parse(await io.readFile(filename,'utf8'));validate(S.obj({schemaVersion:S.enum([1]),preferences:preferenceSchema}),data);
   cached={...data.preferences};configured=true;
  }catch(error){throw fail('STORAGE_ERROR','应用偏好无法读取；原文件已保留。'+error.message);}
 }
 async function startupState(){
  if(!startup||typeof startup.read!=='function')throw fail('DEPENDENCY_MISSING','当前宿主未连接系统启动项服务。');
  const result=await startup.read();if(typeof result!=='boolean')throw fail('READBACK_MISMATCH','系统未返回有效的启动项状态。');return result;
 }
 async function write(value){
  const temporary=path.join(directory,'.preferences-'+randomUUID()+'.tmp');let handle;
  try{await io.mkdir(directory,{recursive:true});handle=await io.open(temporary,'wx',0o600);await handle.writeFile(JSON.stringify({schemaVersion:1,preferences:value}),'utf8');await handle.sync();await handle.close();handle=null;await io.rename(temporary,filename);}
  catch(error){throw fail('STORAGE_ERROR','应用偏好保存失败；原文件未截断。'+error.message);}
  finally{if(handle)await handle.close().catch(()=>{});await io.unlink(temporary).catch(()=>{});}
 }
 return Object.freeze({
  load:()=>enqueue(load),current:()=>({...cached}),peek:()=>configured?{...cached}:null,
  read:()=>enqueue(async()=>{await load();return {...cached,startOnLogin:await startupState(),configured};}),
  set:patch=>enqueue(async()=>{
   try{validate(patchSchema,patch);if(!Object.keys(patch).length)throw Error('At least one preference is required.');}catch(error){throw fail('INVALID_ARGUMENT',error.message);}
   if(patch.language==='en-US')throw fail('UNVERIFIED','英文界面尚未完整翻译，当前仅支持简体中文。');
   await load();const before={...cached,startOnLogin:await startupState()},next={...before,...patch};let previousStartup=null,changedStartup=false;
   if(next.closeBehavior==='minimizeToTray'){if(typeof prepareCloseBehavior!=='function')throw fail('DEPENDENCY_MISSING','系统托盘服务未连接。');await prepareCloseBehavior(next.closeBehavior);}
   try{
    if(Object.hasOwn(patch,'startOnLogin')){
     previousStartup=await startupState();
     if(previousStartup!==patch.startOnLogin){
      if(typeof startup.write!=='function')throw fail('DEPENDENCY_MISSING','当前宿主不支持设置启动项。');
      changedStartup=true;await startup.write(patch.startOnLogin);
      if(await startupState()!==patch.startOnLogin)throw fail('READBACK_MISMATCH','系统启动项读回与选择不一致。');
     }
    }
    await write(next);cached=next;configured=true;return {saved:true};
   }catch(error){
    if(changedStartup){try{await startup.write(previousStartup);if(await startupState()!==previousStartup)throw Error('启动项恢复读回不一致');}catch(restoreError){throw fail('READBACK_MISMATCH',error.message+'；启动项恢复未完成：'+restoreError.message);}}
    cached=before;throw error;
   }
  })
 });
}
module.exports={createPreferences};
