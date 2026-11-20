'use strict';
const path=require('node:path');
const {spawn}=require('node:child_process');
const endpointPattern=/^\{0\.0\.([01])\.00000000\}\.\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i;
const fail=(code,message)=>Object.assign(Error(message),{code});
const scalar=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
function createAudioMonitor({powershell,scriptPath,spawnProcess=spawn,platform=process.platform,clock=Date.now,startupTimeoutMs=20000,stopTimeoutMs=2000,staleAfterMs=3000}={}){
 if(typeof powershell!=='string'||!path.isAbsolute(powershell)||typeof scriptPath!=='string'||!path.isAbsolute(scriptPath))throw TypeError('Trusted absolute monitor worker paths are required.');
 let current=null,generation=0,sequence=0,disposed=false;
 let state={running:false,source:'windows-system',sequence:0,sampledAt:null,endpointIds:[],endpoints:[],error:null};
 const copy=()=>JSON.parse(JSON.stringify(state));
 const message=error=>String(error?.message||error).slice(0,2048);
 function reset(error=null){state={running:false,source:'windows-system',sequence,sampledAt:null,endpointIds:[],endpoints:[],error:error===null?null:message(error)};}
 function validateIds(ids){if(!Array.isArray(ids)||ids.length<1||ids.length>2||ids.some(id=>typeof id!=='string'||!endpointPattern.test(id))||new Set(ids.map(id=>id.toLowerCase())).size!==ids.length)throw fail('INVALID_ARGUMENT','实时音频需要一至两个不同的完整目标端点。');return [...ids];}
 function validateSample(event,ids){
  if(event?.type!=='sample'||event.source!=='windows-system'||typeof event.sampledAt!=='string'||!Number.isFinite(Date.parse(event.sampledAt))||Date.parse(event.sampledAt)>clock()+5000||!Array.isArray(event.endpoints)||event.endpoints.length!==ids.length)throw Error('Invalid audio monitor sample envelope.');
  const found=new Set();
  for(const entry of event.endpoints){
   if(!entry||!ids.includes(entry.endpointId)||found.has(entry.endpointId)||entry.flow!==(endpointPattern.exec(entry.endpointId)[1]==='0'?'render':'capture')||!(entry.name===null||typeof entry.name==='string'&&entry.name.length<=1024)||typeof entry.available!=='boolean'||typeof entry.identityVerified!=='boolean'||!(entry.error===null||typeof entry.error==='string'&&entry.error.length<=2048))throw Error('Invalid audio monitor endpoint identity.');
   found.add(entry.endpointId);
   if(entry.available){if(entry.identityVerified!==true||typeof entry.volume!=='number'||!Number.isFinite(entry.volume)||entry.volume<0||entry.volume>100||typeof entry.muted!=='boolean')throw Error('Invalid audio monitor volume readback.');}
   else if(entry.volume!==null||entry.muted!==null||entry.channels!==null||entry.peaks!==null||entry.identityVerified!==false)throw Error('Disconnected audio monitor endpoints must remain unknown.');
   for(const key of ['channels','peaks'])if(entry[key]!==null&&(!Array.isArray(entry[key])||entry[key].length<1||entry[key].length>32||entry[key].some(value=>!scalar(value))))throw Error('Invalid audio monitor channel or peak values.');
  }
 }
 async function halt(record,error){
  if(current!==record||record.token!==generation)return;
  generation++;reset(error);record.rejectStart(error);
  try{await record.stop();if(current===record)current=null;}catch(stopError){state.error=(state.error+'；停止监测失败：'+message(stopError)).slice(0,2048);}
 }
 function read(){
  if(current&&state.running&&state.sampledAt&&clock()-Date.parse(state.sampledAt)>staleAfterMs)void halt(current,Error('音频监测读值超时，旧状态已清除。'));
  return copy();
 }
 async function stop(){
  generation++;const previous=current;reset();
  if(previous){previous.resolveStart(copy());try{await previous.stop();if(current===previous)current=null;}catch(error){state.error=message(error);throw error;}}
  return read();
 }
 async function start({endpointIds}={}){
  if(disposed)throw fail('DEVICE_NOT_READY','实时音频监测服务已关闭。');
  if(platform!=='win32')throw fail('DEPENDENCY_MISSING','实时音频监测仅支持 Windows。');
  const ids=validateIds(endpointIds),signature=ids.join('|');
  if(current&&!current.stopping&&current.signature===signature){if(!state.running)return current.started;const cached=read();if(cached.running)return cached;}
  const token=++generation,previous=current;reset();
  if(previous){previous.resolveStart(copy());await previous.stop();if(current===previous)current=null;}
  if(token!==generation)return read();
  let resolveStart,rejectStart,resolveClosed,settled=false,closed=false,ready=false,buffer='',stderr='',startup,stopPromise=null;
  const started=new Promise((resolve,reject)=>{resolveStart=value=>{if(!settled){settled=true;resolve(value);}};rejectStart=error=>{if(!settled){settled=true;reject(error);}};});
  const closure=new Promise(resolve=>{resolveClosed=resolve;});
  let child;
  try{child=spawnProcess(powershell,['-NoLogo','-NoProfile','-NonInteractive','-File',scriptPath,'-EndpointIdsBase64',Buffer.from(JSON.stringify(ids),'utf8').toString('base64')],{windowsHide:true,stdio:['pipe','pipe','pipe'],shell:false});}
  catch(error){reset(error);throw error;}
  const record={token,signature,started,stopping:false,resolveStart,rejectStart,stop(){
   if(stopPromise)return stopPromise;record.stopping=true;clearTimeout(startup);
   stopPromise=(async()=>{if(closed)return;try{child.stdin.end('stop\n');}catch{}
    let timer;await Promise.race([closure,new Promise(resolve=>{timer=setTimeout(()=>{try{child.kill();}catch{}resolve();},stopTimeoutMs);})]);clearTimeout(timer);
    if(!closed){let last;try{await Promise.race([closure,new Promise((_,reject)=>{last=setTimeout(()=>reject(Error('Audio monitor worker did not exit.')),stopTimeoutMs);})]);}finally{clearTimeout(last);}}
   })().catch(error=>{stopPromise=null;throw error;});return stopPromise;
  }};
  current=record;
  const workerError=error=>{if(!record.stopping&&current===record&&token===generation)void halt(record,error);};
  startup=setTimeout(()=>workerError(fail('DEPENDENCY_MISSING','音频监测启动或首帧读取超时。')),startupTimeoutMs);
  child.stdin.on('error',()=>{});child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-1024);});
  child.stdout.on('data',chunk=>{
   if(record.stopping||current!==record||token!==generation)return;
   buffer+=chunk;if(buffer.length>262144){workerError(Error('Audio monitor output exceeds the bounded buffer.'));return;}
   let at;while((at=buffer.indexOf('\n'))>=0){if(record.stopping||current!==record||token!==generation)return;const line=buffer.slice(0,at).trim();buffer=buffer.slice(at+1);if(!line)continue;
    try{const event=JSON.parse(line);if(!ready){if(event.type!=='ready'||event.source!=='windows-system'||JSON.stringify(event.endpointIds)!==JSON.stringify(ids))throw Error('Invalid audio monitor worker handshake.');ready=true;}
     else{validateSample(event,ids);if(sequence>=Number.MAX_SAFE_INTEGER)throw Error('Audio monitor sequence exhausted.');state={running:true,source:'windows-system',sequence:++sequence,sampledAt:event.sampledAt,endpointIds:[...ids],endpoints:event.endpoints,error:null};clearTimeout(startup);resolveStart(read());}
    }catch(error){workerError(error);return;}
   }
  });
  child.on('error',error=>{closed=true;resolveClosed();clearTimeout(startup);workerError(error);});
  child.on('close',(code,signal)=>{closed=true;resolveClosed();clearTimeout(startup);workerError(Error('音频监测进程已退出：'+(signal||code)+(stderr?'；'+stderr.trim():'')));});
  return started;
 }
 return Object.freeze({start,read,stop,async dispose(){disposed=true;return stop();}});
}
module.exports={createAudioMonitor};
