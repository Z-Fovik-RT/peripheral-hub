'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {S,validate}=require('./schema.cjs');
const text=S.text(2048),name=S.string(256),profile=S.string(128),icon=S.text(256);
const ruleSchema=S.obj({widgetName:name,appPath:text,bindingProfileName:profile,icon});
const listResult=S.obj({enabled:S.enum([false]),rules:S.array(ruleSchema,0,256)});
const queues=new Map();
const fail=(code,message)=>Object.assign(Error(message),{code});
const iconNamePattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/i;
const pngSignature=Buffer.from([137,80,78,71,13,10,26,10]);
const maxIconBytes=512*1024;
const pngDataUrlPrefix=String.fromCharCode(100,97,116,97,58,105,109,97,103,101,47,112,110,103,59,98,97,115,101,54,52,44);
function validateRule(rule){validate(ruleSchema,rule,'rule');if(!rule.widgetName.trim())throw fail('INVALID_ARGUMENT','规则名称不能为空。');if(!rule.appPath.trim()||!path.win32.isAbsolute(rule.appPath))throw fail('INVALID_ARGUMENT','应用路径必须是完整的 Windows 路径。');if(!rule.bindingProfileName.trim())throw fail('INVALID_ARGUMENT','必须指定现有配置名称。');if(rule.icon&&!/^[^\\/:*?"<>|]+\.png$/i.test(rule.icon))throw fail('INVALID_ARGUMENT','图标字段仅接受 PNG 文件名。');}
function createAutoSwitch({directory,runtime}={}){
 if(typeof directory!=='string'||!path.isAbsolute(directory)||directory.includes('\0'))throw fail('INVALID_ARGUMENT','自动切换目录必须是受信任的绝对路径。');
 const root=path.resolve(directory),filename=path.join(root,'headset-autoswitch.json'),iconDirectory=path.join(root,'headset-autoswitch-icons'),key=process.platform==='win32'?root.toLowerCase():root;
 async function read(){let data;try{data=JSON.parse(await fs.readFile(filename,'utf8'));}catch(error){if(error.code==='ENOENT')return [];throw fail('STORAGE_ERROR','自动切换规则损坏或无法读取；原文件已保留。 '+error.message);}if(!Array.isArray(data)||data.length>256)throw fail('STORAGE_ERROR','自动切换规则格式或数量无效。');for(const rule of data)try{validateRule(rule);}catch(error){throw fail('STORAGE_ERROR','自动切换规则含有无效项目；原文件已保留。 '+error.message);}return data;}
 async function write(rules){await fs.mkdir(root,{recursive:true});const temp=path.join(root,'.autoswitch-'+randomUUID()+'.tmp');let handle;try{handle=await fs.open(temp,'wx',0o600);await handle.writeFile(JSON.stringify(rules),'utf8');await handle.sync();await handle.close();handle=null;await fs.rename(temp,filename);}catch(error){throw fail('STORAGE_ERROR','规则保存失败；原配置未被截断。 '+error.message);}finally{if(handle)await handle.close().catch(()=>{});await fs.unlink(temp).catch(()=>{});}}
 function enqueue(run){const pending=(queues.get(key)||Promise.resolve()).then(run),settled=pending.then(()=>{},()=>{});queues.set(key,settled);void settled.then(()=>{if(queues.get(key)===settled)queues.delete(key);});return pending;}
 async function ensureIconDirectory(){
  await fs.mkdir(root,{recursive:true});
  const rootStat=await fs.lstat(root);if(rootStat.isSymbolicLink()||!rootStat.isDirectory())throw fail('STORAGE_ERROR','自动切换存储目录不是普通目录。');
  try{await fs.mkdir(iconDirectory);}catch(error){if(error.code!=='EEXIST')throw fail('STORAGE_ERROR','图标目录创建失败。 '+error.message);}
  const stat=await fs.lstat(iconDirectory);if(stat.isSymbolicLink()||!stat.isDirectory())throw fail('STORAGE_ERROR','图标目录不是普通目录。');
 }
 function validateIconName(iconName){if(typeof iconName!=='string'||!iconNamePattern.test(iconName)||path.basename(iconName)!==iconName||/[\\/]/.test(iconName))throw fail('INVALID_ARGUMENT','图标文件名无效。');return iconName;}
 function decodePngDataUrl(dataUrl){
  if(typeof dataUrl!=='string'||dataUrl.length>Math.ceil(maxIconBytes/3)*4+pngDataUrlPrefix.length||!dataUrl.startsWith(pngDataUrlPrefix))throw fail('INVALID_ARGUMENT','PNG图标数据无效或过大。');
  const base64=dataUrl.slice(pngDataUrlPrefix.length);if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))throw fail('INVALID_ARGUMENT','PNG图标Base64编码无效。');
  const bytes=Buffer.from(base64,'base64');if(bytes.length<33||bytes.length>maxIconBytes||bytes.toString('base64')!==base64||!bytes.subarray(0,8).equals(pngSignature)||bytes.readUInt32BE(8)!==13||bytes.toString('ascii',12,16)!=='IHDR')throw fail('INVALID_ARGUMENT','PNG图标文件头无效。');
  return bytes;
 }
 async function saveIconFile(dataUrl){
  const bytes=decodePngDataUrl(dataUrl);await ensureIconDirectory();const iconName=randomUUID()+'.png',target=path.join(iconDirectory,iconName),temp=path.join(iconDirectory,'.'+randomUUID()+'.tmp');let handle;
  try{handle=await fs.open(temp,'wx',0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;await fs.rename(temp,target);return iconName;}
  catch(error){throw fail('STORAGE_ERROR','图标保存失败；原有图标未修改。 '+error.message);}
  finally{if(handle)await handle.close().catch(()=>{});await fs.unlink(temp).catch(()=>{});}
 }
 async function readIconFile(iconName){
  validateIconName(iconName);await ensureIconDirectory();const target=path.join(iconDirectory,iconName);let stat;
  try{stat=await fs.lstat(target);}catch(error){if(error.code==='ENOENT')return null;throw fail('STORAGE_ERROR','图标读取失败。 '+error.message);}
  if(stat.isSymbolicLink()||!stat.isFile()||stat.size>maxIconBytes)return null;
  let bytes;try{bytes=await fs.readFile(target);}catch(error){throw fail('STORAGE_ERROR','图标读取失败。 '+error.message);}
  if(bytes.length<33||!bytes.subarray(0,8).equals(pngSignature)||bytes.readUInt32BE(8)!==13||bytes.toString('ascii',12,16)!=='IHDR')return null;
  return pngDataUrlPrefix+bytes.toString('base64');
 }
 async function deleteIconIfUnreferenced(iconName){
  validateIconName(iconName);const rules=await read();if(rules.some(rule=>rule.icon===iconName))return false;
  await ensureIconDirectory();const target=path.join(iconDirectory,iconName);let stat;
  try{stat=await fs.lstat(target);}catch(error){if(error.code==='ENOENT')return false;throw fail('STORAGE_ERROR','图标清理失败。 '+error.message);}
  if(stat.isSymbolicLink()||!stat.isFile())return false;
  try{await fs.unlink(target);return true;}catch(error){if(error.code==='ENOENT')return false;throw fail('STORAGE_ERROR','图标清理失败。 '+error.message);}
 }
 if(runtime)runtime.setRuleReader(()=>enqueue(read));
 const enabled=()=>runtime?.status().enabled===true;
 const changed=()=>runtime?.rulesChanged();
 const operations={
  'headset.autoSwitch.list':()=>enqueue(async()=>({enabled:enabled(),rules:await read()})),
  'headset.autoSwitch.save':({args})=>enqueue(async()=>{const rule={...args.rule};validateRule(rule);const rules=await read(),previous=args.previousApplicationId;const index=previous?rules.findIndex(item=>item.appPath===previous):rules.findIndex(item=>item.appPath===rule.appPath);if(previous&&index<0)throw fail('NOT_FOUND','待编辑的自动切换规则不存在。');if(rules.some((item,i)=>i!==index&&item.widgetName===rule.widgetName))throw fail('CONFLICT','规则名称已存在。');if(rules.some((item,i)=>i!==index&&item.appPath===rule.appPath))throw fail('CONFLICT','完整应用路径已存在。');if(index<0&&rules.length>=256)throw fail('INVALID_ARGUMENT','规则数量已达到本地上限256。');if(index<0)rules.push(rule);else rules[index]=rule;await write(rules);changed();return {saved:true};}),
  'headset.autoSwitch.delete':({args})=>enqueue(async()=>{const rules=await read(),next=rules.filter(rule=>rule.appPath!==args.applicationId);if(next.length===rules.length)throw fail('NOT_FOUND','自动切换规则不存在。');await write(next);changed();return {deleted:true};}),
  'headset.autoSwitch.preview':({args})=>enqueue(async()=>{const rules=await read(),match=rules.find(rule=>rule.appPath===args.applicationId)||null;return {enabled:enabled(),matched:match!==null,rule:match};}),
  'headset.autoSwitch.status':()=>runtime?runtime.status():{enabled:false,state:'disabled',source:'windows-foreground',endpointIds:[],foregroundPath:null,lastMatchedPath:null,lastProfileName:null,lastAppliedAt:null,lastError:null},
  'headset.autoSwitch.setEnabled':({args})=>{if(!runtime){if(args.enabled)throw fail('DEPENDENCY_MISSING','自动切换运行服务未连接。');return {enabled:false};}return runtime.setEnabled(args);},
   'headset.autoSwitch.rebind':({args})=>enqueue(async()=>{if(!args.profileName.trim()||!args.fallbackProfileName.trim())throw fail('INVALID_ARGUMENT','配置名称不能为空。');const rules=await read();let updated=0;const next=rules.map(rule=>{if(rule.bindingProfileName!==args.profileName)return rule;updated++;return {...rule,bindingProfileName:args.fallbackProfileName};});if(updated){await write(next);changed();}return {updated};})
  };
 Object.defineProperties(operations,{
  saveIcon:{value:dataUrl=>enqueue(()=>saveIconFile(dataUrl))},
  readIcon:{value:iconName=>enqueue(async()=>{validateIconName(iconName);const rules=await read();if(!rules.some(rule=>rule.icon===iconName))return null;return readIconFile(iconName);})},
  deleteIconIfUnreferenced:{value:iconName=>enqueue(()=>deleteIconIfUnreferenced(iconName))}
 });
 return Object.freeze(operations);
}
module.exports={createAutoSwitch};
