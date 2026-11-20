'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {validate,S}=require('./schema.cjs');
const contracts=require('./contracts/headset.cjs');
const {parseOfficial,exportOfficial}=require('./eq-custom-format.cjs');
const operationIds=['headset.eq.presets.official.import','headset.eq.presets.official.export','headset.eq.presets.create','headset.eq.presets.list','headset.eq.presets.save','headset.eq.presets.delete','headset.eq.presets.import','headset.eq.presets.export'];
// Numeric preset data transcribed from the supplied EQPreset.json. Units are not established.
const values=[
 [0,0,0,0,0,0,0,0,0,0],[-4,-2,0,2,1,0,3,5,4,-1],[-5,-4,-2,1,0,2,3,5,4,-1],[-6,-4,-3,5,2,0,4,3,2,-2],
 [-5,-3,-1,4,1,0,3,2,2,-1],[-2,0,1,2,1,0,3,4,3,1],[-3,-1,1,3,2,1,4,3,2,0],[-4,-2,-1,3,0,2,4,5,3,1],
 [11,7,3,0,0,-6,-10,-10,-2,-2],[-10,-11,-12,-6,2,8,13,13,11,14],[6,3,-8,-12,-4,3,8,10,10,7],[-13,-8,0,6,14,4,-4,-7,-8,-10]
];
const officialNames=['三角洲','瓦','PUBG','CS2','CF','APEX','PC和平精英','暗区','低音','高音','摇滚','声乐'];
// Keep enabled for stored/exported preset compatibility; applying a preset preserves the endpoint's current flag.
const official=values.map((bandsRaw,i)=>Object.freeze({id:'official-'+i,name:officialNames[i],flow:'render',origin:'official',bandsRaw:Object.freeze(bandsRaw),enabled:true}));
const presetSchema=contracts.find(c=>c.id==='headset.eq.presets.save').args.properties.preset;
const storageSchema=S.obj({schemaVersion:S.enum([1]),presets:S.array(presetSchema,0,244)});
function fault(code,message){const e=new Error(message);e.code=code;return e;}
function userPreset(p){validate(presetSchema,p,'preset');if(p.name.length===0)throw fault('INVALID_ARGUMENT','预设名称不能为空。');if(p.origin!=='user'||p.id.startsWith('official-'))throw fault('CONFLICT','官方预设只读；请另存为用户预设。');}
function createEqPresets({directory,io=fs}){
 if(typeof directory!=='string'||!path.isAbsolute(directory))throw Error('EQ storage directory must be a trusted absolute path.');
 const file=path.join(directory,'eq-presets.json');let chain=Promise.resolve();
 async function load(){
  let bytes;try{const stat=await io.stat(file);if(stat.size>1048576)throw fault('STORAGE_ERROR','EQ预设库超过文件大小上限。');bytes=await io.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return {schemaVersion:1,presets:[]};throw e;}
  try{const state=JSON.parse(bytes);validate(storageSchema,state);const seen=new Set();for(const p of state.presets){userPreset(p);if(seen.has(p.id))throw Error('duplicate id');seen.add(p.id);}return state;}catch(e){throw fault('STORAGE_ERROR','EQ预设库损坏，已保留原文件：'+e.message);}
 }
 async function persist(state){
  validate(storageSchema,state);await io.mkdir(directory,{recursive:true});
  const temp=file+'.'+randomUUID()+'.tmp';let handle;
  try{handle=await io.open(temp,'wx');await handle.writeFile(JSON.stringify(state,null,2),'utf8');await handle.sync();await handle.close();handle=null;await io.rename(temp,file);}
  catch(e){throw fault('STORAGE_ERROR','预设未保存，原文件已保留：'+e.message);}
  finally{if(handle)await handle.close().catch(()=>{});await io.unlink(temp).catch(e=>{if(e.code!=='ENOENT'){};});}
 }
 const handlers={};
 for(const operation of operationIds){const contract=contracts.find(c=>c.id===operation);
  handlers[operation]=({deviceId,args})=>{args=structuredClone(args);const work=chain.then(async()=>{
   if(deviceId!=='ikf-v11-pro-71')throw fault('DEVICE_MISMATCH','EQ预设仅适用于耳机。');
   try{validate(contract.args,args,'args');}catch(e){throw fault('INVALID_ARGUMENT',e.message);}
   const state=await load();let result;
   if(operation==='headset.eq.presets.official.import'){
     const entries=parseOfficial(args.content);
     if(state.presets.length+entries.length>244)throw fault('INVALID_ARGUMENT','导入后超过244项用户设定档上限，原有配置未改变。');
     const incoming=entries.map(entry=>({id:'preset-'+randomUUID(),name:entry.name,flow:'render',origin:'user',bandsRaw:entry.bandsRaw,enabled:true}));
     if(incoming.length){state.presets.push(...incoming);await persist(state);}
     result={imported:incoming.length,presetIds:incoming.map(preset=>preset.id),warnings:['已追加到本应用设定档列表，保留原顺序和同名条目；选择设定档后才改变声音。']};
    }else if(operation==='headset.eq.presets.official.export'){
     const playback=state.presets.filter(preset=>preset.flow==='render');
     result={content:exportOfficial(playback),suggestedName:'EQCustom.json',count:playback.length};
    }else if(operation.endsWith('.list'))result={presets:[...(args.flow==='render'?official:[]),...state.presets.filter(p=>p.flow===args.flow)].map(p=>structuredClone(p))};
   else if(operation.endsWith('.create')){
     let name=args.name;
     if(name.length===0){let number=1;while(state.presets.some(p=>p.flow==='render'&&p.name==='Profile '+number))number++;name='Profile '+number;}
     const preset={id:'preset-'+randomUUID(),name,flow:'render',origin:'user',bandsRaw:[...args.bandsRaw],enabled:true};
     userPreset(preset);state.presets.push(preset);await persist(state);result={preset:structuredClone(preset)};
    }else if(operation.endsWith('.save')){
    userPreset(args.preset);const next=structuredClone(args.preset),index=state.presets.findIndex(p=>p.id===next.id);
    if(index>=0&&state.presets[index].flow!==next.flow)throw fault('CONFLICT','预设方向不能在覆盖保存时改变。');
    if(index<0)state.presets.push(next);else state.presets[index]=next;
    await persist(state);result={saved:true};
   }else if(operation.endsWith('.delete')){
    if(args.presetId.startsWith('official-'))throw fault('CONFLICT','官方预设不能删除。');
    const index=state.presets.findIndex(p=>p.id===args.presetId&&p.flow===args.flow);
    if(index<0)throw fault('NOT_FOUND','未找到用户预设。');state.presets.splice(index,1);await persist(state);result={deleted:true};
   }else if(operation.endsWith('.export')){
    const preset=[...official,...state.presets].find(p=>p.id===args.presetId&&p.flow===args.flow);
    if(!preset)throw fault('NOT_FOUND','未找到此方向的预设。');result={preset:structuredClone(preset)};
   }else{
    const preset=structuredClone(args.preset);preset.id='preset-'+randomUUID();preset.origin='user';userPreset(preset);state.presets.push(preset);await persist(state);
    result={saved:true,warnings:['已作为新的用户预设导入，原预设未覆盖。未应用到音频设备。']};
   }
   validate(contract.result,result,'result');return result;
  });chain=work.catch(()=>{});return work;};
 }
 return handlers;
}
module.exports={createEqPresets,operationIds};
