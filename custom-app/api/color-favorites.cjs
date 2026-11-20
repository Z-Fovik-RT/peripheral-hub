'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {S,validate}=require('./schema.cjs');
const colorSchema=S.obj({r:S.int(0,255),g:S.int(0,255),b:S.int(0,255)}),colorRecord=S.obj({id:S.string(128),name:S.string(60),color:colorSchema});
const fileSchema=S.obj({schemaVersion:S.enum([1]),deviceId:S.enum(['aula-f87-pro']),colors:S.array(colorRecord,0,256)});
const queues=new Map(),fail=(code,message)=>Object.assign(Error(message),{code});
function createColorFavorites({directory,io=fs}={}){
 if(typeof directory!=='string'||!path.isAbsolute(directory)||directory.includes('\0'))throw fail('INVALID_ARGUMENT','Favorite color storage requires a trusted absolute directory.');
 const root=path.resolve(directory),filename=path.join(root,'aula-colors-v1.json'),key=process.platform==='win32'?root.toLowerCase():root;
 async function read(){try{let info;try{info=await io.lstat(filename);}catch(error){if(error.code==='ENOENT')return [];throw error;}if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)throw Error('Favorite color storage must be a bounded regular file.');const data=JSON.parse(await io.readFile(filename,'utf8'));validate(fileSchema,data);if(new Set(data.colors.map(item=>item.id)).size!==data.colors.length)throw Error('Favorite color IDs must be unique.');return data.colors;}catch(error){throw fail('STORAGE_ERROR','Cannot read favorite colors; the original file was preserved. '+error.message);}}
 async function write(colors){const temporary=path.join(root,'.colors-'+randomUUID()+'.tmp');let handle;try{await io.mkdir(root,{recursive:true});handle=await io.open(temporary,'wx',0o600);await handle.writeFile(JSON.stringify({schemaVersion:1,deviceId:'aula-f87-pro',colors}),'utf8');await handle.sync();await handle.close();handle=null;await io.rename(temporary,filename);}catch(error){throw fail('STORAGE_ERROR','Favorite color save failed; the previous file was not truncated. '+error.message);}finally{if(handle)await handle.close().catch(()=>{});await io.unlink(temporary).catch(()=>{});}}
 function enqueue(run){const pending=(queues.get(key)||Promise.resolve()).then(run),settled=pending.catch(()=>{});queues.set(key,settled);void settled.then(()=>{if(queues.get(key)===settled)queues.delete(key);});return pending;}
 return Object.freeze({
  'keyboard.colors.favorites.list':({deviceId})=>enqueue(async()=>{if(deviceId!=='aula-f87-pro')throw fail('DEVICE_MISMATCH','AULA color favorites belong to the keyboard.');return {colors:await read()};}),
  'keyboard.colors.favorites.save':({deviceId,args})=>enqueue(async()=>{if(deviceId!=='aula-f87-pro')throw fail('DEVICE_MISMATCH','AULA color favorites belong to the keyboard.');try{validate(colorRecord,args);}catch(error){throw fail('INVALID_ARGUMENT',error.message);}const colors=await read(),index=colors.findIndex(item=>item.id===args.id);if(index<0&&colors.length>=256)throw fail('INVALID_ARGUMENT','Favorite color capacity reached.');if(index<0)colors.push(args);else colors[index]=args;validate(fileSchema,{schemaVersion:1,deviceId,colors});await write(colors);return {saved:true};}),
  'keyboard.colors.favorites.delete':({deviceId,args})=>enqueue(async()=>{if(deviceId!=='aula-f87-pro')throw fail('DEVICE_MISMATCH','AULA color favorites belong to the keyboard.');try{validate(S.obj({id:S.string(128)}),args);}catch(error){throw fail('INVALID_ARGUMENT',error.message);}const colors=await read(),next=colors.filter(item=>item.id!==args.id);if(next.length===colors.length)throw fail('NOT_FOUND','Favorite color does not exist.');await write(next);return {deleted:true};})
 });
}
module.exports={createColorFavorites};
