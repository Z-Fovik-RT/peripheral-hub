'use strict';
const path=require('node:path');
const {spawn}=require('node:child_process');
const endpointPattern=/^\{0\.0\.[01]\.00000000\}\.\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i;
const fail=(code,message)=>Object.assign(Error(message),{code});
function validPath(value){return typeof value==='string'&&value.length>0&&value.length<=2048&&!/[\x00-\x1f]/.test(value)&&path.win32.isAbsolute(value);}
function createAutoSwitchRuntime({observeForeground,listProfiles,applyProfile,settleMs=500,clock=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}={}){
 if(typeof observeForeground!=='function'||typeof listProfiles!=='function'||typeof applyProfile!=='function')throw TypeError('Automatic switching requires a foreground observer and verified profile services.');
 if(!Number.isInteger(settleMs)||settleMs<100||settleMs>10000)throw TypeError('Invalid foreground settling interval.');
 let readRules=null,observer=null,timer=null,active=null,controls=Promise.resolve(),disposed=false,suspended=false,generation=0,revision=0,processedRevision=-1,lastEventAt=0;
 let value={enabled:false,state:'disabled',source:'windows-foreground',endpointIds:[],foregroundPath:null,lastMatchedPath:null,lastProfileName:null,lastAppliedAt:null,lastError:null};
 const status=()=>({...value,endpointIds:[...value.endpointIds]});
 function clearPending(){if(timer!==null){clearTimer(timer);timer=null;}}
 function validReceipt(receipt,ids){
  const validSource=receipt?.source==='sdk'&&receipt.scope==='licensed-effects'||receipt?.source==='windows-effect-store'&&receipt.scope==='target-effects';
  if(receipt?.verified!==true||!validSource||!Array.isArray(receipt.profiles)||!Array.isArray(receipt.snapshot)||receipt.snapshot.length!==ids.length||ids.some(id=>!receipt.snapshot.some(item=>item.endpointId===id))||typeof receipt.currentName!=='string')throw fail('READBACK_MISMATCH','全局配置读回不完整；自动切换已停止。');
  if(receipt.profiles.some(item=>!item||typeof item.name!=='string'||item.name.length<1||item.name.length>128)||new Set(receipt.profiles.map(item=>item.name)).size!==receipt.profiles.length||(receipt.currentName!=='Current'&&!receipt.profiles.some(item=>item.name===receipt.currentName)))throw fail('READBACK_MISMATCH','全局配置列表无效。');
  return receipt;
 }
 function checkRules(rules,receipt){
  if(!Array.isArray(rules)||rules.length<1||rules.length>256)throw fail('INVALID_ARGUMENT','请先保存至少一条应用关联规则。');
  for(const rule of rules){if(!rule||!validPath(rule.appPath)||typeof rule.bindingProfileName!=='string'||rule.bindingProfileName==='Current'||!receipt.profiles.some(profile=>profile.name===rule.bindingProfileName))throw fail('NOT_FOUND','应用关联指向不存在的配置或虚拟“当前设置”，请先修正规则。');}
 }
 async function stopObserver(){const old=observer;if(old){await old.stop();if(observer===old)observer=null;}}
 async function halt(error){
  value.enabled=false;suspended=false;value.state='error';value.lastError=String(error?.message||error).slice(0,2048);generation++;clearPending();
  try{await stopObserver();}catch(stopError){value.lastError=(value.lastError+'；观察器停止失败：'+stopError.message).slice(0,2048);}
 }
 function schedule(){
  clearPending();if(!value.enabled||suspended)return;
  const delay=Math.max(0,settleMs-(clock()-lastEventAt));
  timer=setTimer(()=>{timer=null;if(!value.enabled||active)return;const token=generation,event=revision;processedRevision=event;
   active=applyCandidate(token,event).catch(error=>halt(error)).finally(()=>{active=null;if(value.enabled&&revision!==processedRevision)schedule();});
  },delay);
 }
 function receive(sample){
  if(!value.enabled||(suspended&&sample?.reconcile!==true))return;
  const next=sample?.path===null?null:sample?.path;
  if(next!==null&&!validPath(next)){void halt(fail('INVALID_RESPONSE','前台观察器返回了无效应用路径。'));return;}
  if(next===value.foregroundPath){if(sample?.reconcile===true&&!suspended&&revision!==processedRevision)schedule();return;}
  value.foregroundPath=next;lastEventAt=clock();revision++;schedule();
 }
 async function applyCandidate(token,event){
  const stillCurrent=()=>value.enabled&&generation===token&&revision===event;
  const foreground=value.foregroundPath;if(!foreground||suspended||!stillCurrent())return;
  const rules=await readRules();if(!stillCurrent())return;
  const rule=rules.find(item=>item.appPath===foreground);if(!rule){value.state='watching';value.lastMatchedPath=null;return;}
  const ids=[...value.endpointIds],receipt=validReceipt(await listProfiles(ids),ids);if(!stillCurrent())return;
  checkRules(rules,receipt);value.lastMatchedPath=rule.appPath;
  if(receipt.currentName===rule.bindingProfileName){value.lastProfileName=rule.bindingProfileName;value.state='watching';return;}
  value.state='applying';
  const result=await applyProfile(ids,rule.bindingProfileName,stillCurrent);
  if(result===null&&!stillCurrent())return;
  const actual=validReceipt(result,ids);
  if(actual.applied!==true||actual.currentName!==rule.bindingProfileName)throw fail('READBACK_MISMATCH','自动切换未返回所选配置的成功读回。');
  value.lastProfileName=rule.bindingProfileName;value.lastAppliedAt=new Date(clock()).toISOString();
  if(value.enabled)value.state='watching';
 }
  function enqueue(action){const result=controls.then(action);controls=result.catch(()=>{});return result;}
  async function startObserver(token){
   const next=await observeForeground({onForeground:sample=>{if(token===generation&&(!suspended||sample?.reconcile===true))receive(sample);},onError:error=>{if(token===generation&&value.enabled&&!suspended)void halt(error);}});
   if(!next||typeof next.stop!=='function')throw fail('DEPENDENCY_MISSING','前台观察器未返回生命周期控制器。');
   if(token!==generation||!value.enabled||suspended){await next.stop();return false;}
   observer=next;value.state='watching';return true;
  }
 return Object.freeze({
  setRuleReader(reader){if(readRules&&readRules!==reader)throw Error('Automatic switching already has a rule store.');if(typeof reader!=='function')throw TypeError('Rule reader required.');readRules=reader;},
  status,
  requiresPause(){return observer!==null;},
  setEnabled({enabled,endpointIds}={}){
   if(typeof enabled!=='boolean')return Promise.reject(fail('INVALID_ARGUMENT','启用状态必须是布尔值。'));
   if(enabled&&disposed)return Promise.reject(fail('DEVICE_NOT_READY','自动切换服务已关闭。'));
   if(enabled&&(!Array.isArray(endpointIds)||endpointIds.length<1||endpointIds.length>2||endpointIds.some(id=>typeof id!=='string'||!endpointPattern.test(id))||new Set(endpointIds.map(id=>id.toLowerCase())).size!==endpointIds.length))return Promise.reject(fail('INVALID_ARGUMENT','请选择一至两个不同的目标耳机端点。'));
   const token=++generation;clearPending();value.enabled=false;
   return enqueue(async()=>{
    try{await stopObserver();if(active)await active;}catch(error){value.state='error';value.lastError='前台观察器清理失败：'+error.message;throw error;}
    if(token!==generation)return {enabled:false};
    if(!enabled){suspended=false;value.state='disabled';value.endpointIds=[];value.foregroundPath=null;return {enabled:false};}
    if(!readRules)throw fail('DEPENDENCY_MISSING','自动切换规则存储未连接。');
    value.state='starting';value.endpointIds=[...endpointIds];value.foregroundPath=null;value.lastMatchedPath=null;value.lastError=null;
    try{
     const rules=await readRules(),receipt=validReceipt(await listProfiles([...endpointIds]),endpointIds);checkRules(rules,receipt);
     if(token!==generation)return {enabled:false};
    value.enabled=true;processedRevision=-1;suspended=false;
    const started=await startObserver(token);if(!started)return {enabled:false};return {enabled:true};
    }catch(error){await halt(error);throw error;}
   });
  },
  suspend(){return enqueue(async()=>{if(suspended)return {owned:false};const current=observer;if(!current)return {owned:false};if(typeof current.pause!=='function')throw fail('DEPENDENCY_MISSING','前台观察器不支持安全暂停。');clearPending();suspended=true;if(value.enabled)value.state='starting';try{await current.pause();return {owned:true};}catch(error){await halt(error);throw error;}});},
  resume(){return enqueue(async()=>{if(!value.enabled||!suspended)return {resumed:false};const current=observer;if(!current||typeof current.resume!=='function'){const error=fail('DEPENDENCY_MISSING','前台观察器不支持安全恢复。');await halt(error);throw error;}const token=generation;suspended=false;value.state='starting';try{await current.resume();if(token!==generation||!value.enabled){suspended=true;return {resumed:false};}value.state='watching';if(revision!==processedRevision)schedule();return {resumed:true};}catch(error){suspended=false;await halt(error);throw error;}});},
  rulesChanged(){revision++;value.lastMatchedPath=null;lastEventAt=clock();if(value.enabled&&!suspended)schedule();},
  async dispose(){disposed=true;suspended=false;await this.setEnabled({enabled:false});}
 });
}
function createWindowsForegroundObserver({powershell,scriptPath,spawnProcess=spawn,platform=process.platform,startupTimeoutMs=15000,stopTimeoutMs=2000,lifecycleTimeoutMs=30000}={}){
 if(typeof powershell!=='string'||!path.isAbsolute(powershell)||typeof scriptPath!=='string'||!path.isAbsolute(scriptPath))throw TypeError('Trusted absolute foreground worker paths are required.');
 return ({onForeground,onError})=>new Promise((resolve,reject)=>{
  if(platform!=='win32'){reject(fail('DEPENDENCY_MISSING','前台应用监听仅支持 Windows。'));return;}
  let child,ready=false,stopping=false,buffer='',stderr='',startup=null,stopPromise=null,closed=false,resolveClosed,commandId=0,pendingCommand=null;
  const closure=new Promise(done=>{resolveClosed=done;});
  function error(problem){if(stopping)return;if(!ready){reject(problem);void stop();}else onError(problem);}
  function send(command,allowStopping=false){
   if(closed||(!ready&&command!=='stop')||(stopping&&!allowStopping))return Promise.reject(fail('DEVICE_NOT_READY','Windows 前台观察器未就绪。'));
   if(pendingCommand)return Promise.reject(fail('CONFLICT','Windows 前台观察器已有生命周期命令正在处理。'));
   const id=++commandId;
   return new Promise((resolveCommand,rejectCommand)=>{
    const timer=setTimeout(()=>{if(pendingCommand?.id!==id)return;pendingCommand=null;rejectCommand(fail('DEPENDENCY_MISSING','Windows 前台观察器生命周期操作超时。'));try{child.kill();}catch{}},lifecycleTimeoutMs);
    pendingCommand={id,command,timer,resolve:resolveCommand,reject:rejectCommand};
    try{child.stdin.write(JSON.stringify({command,requestId:id})+'\n');}catch(problem){clearTimeout(timer);pendingCommand=null;rejectCommand(problem);}
   });
  }
  function stop(){
   if(stopPromise)return stopPromise;stopping=true;clearTimeout(startup);
   stopPromise=(async()=>{
    if(!closed&&child&&ready)await send('stop',true);
    else if(!closed&&child)try{child.stdin.end();}catch{}
    if(!closed&&child&&ready)try{child.stdin.end();}catch{}
    let timeout;await Promise.race([closure,new Promise(done=>{timeout=setTimeout(()=>{try{child?.kill();}catch{}done();},stopTimeoutMs);})]);clearTimeout(timeout);
    if(!closed)await Promise.race([closure,new Promise((_,failStop)=>{const last=setTimeout(()=>failStop(Error('Foreground worker did not exit.')),stopTimeoutMs);closure.then(()=>clearTimeout(last));})]);
   })();return stopPromise;
  }
  try{child=spawnProcess(powershell,['-NoLogo','-NoProfile','-NonInteractive','-File',scriptPath],{windowsHide:true,stdio:['pipe','pipe','pipe'],shell:false});}catch(problem){reject(problem);return;}
  child.stdin.on('error',()=>{});
  startup=setTimeout(()=>error(fail('DEPENDENCY_MISSING','Windows 前台观察器启动超时。')),startupTimeoutMs);
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-1024);});
  child.stdout.on('data',chunk=>{
   buffer+=chunk;if(buffer.length>65536){error(Error('Foreground worker output exceeds limit.'));return;}
   let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at).trim();buffer=buffer.slice(at+1);if(!line)continue;
    try{
     const event=JSON.parse(line);
     if(!ready){if(event.type!=='ready'||event.source!=='windows-foreground')throw Error('Invalid foreground worker handshake.');ready=true;clearTimeout(startup);resolve({pause:()=>send('pause'),resume:()=>send('resume'),stop});continue;}
     if(event.type==='foreground'&&(event.path===null||validPath(event.path))&&Number.isInteger(event.pid)&&event.pid>=0&&typeof event.reconcile==='boolean'){if(!stopping)onForeground({path:event.path,pid:event.pid,reconcile:event.reconcile});continue;}
     const responseCommand={paused:'pause',resumed:'resume',stopped:'stop'}[event.type];
     if(responseCommand&&pendingCommand&&pendingCommand.command===responseCommand&&event.requestId===pendingCommand.id){clearTimeout(pendingCommand.timer);const pending=pendingCommand;pendingCommand=null;pending.resolve();if(event.type==='stopped')stopping=true;continue;}
     if(event.type==='error'&&typeof event.message==='string')throw Error('Windows foreground worker failed: '+event.message);
     throw Error('Invalid foreground worker event.');
    }catch(problem){error(problem);}
   }
  });
  child.on('error',problem=>{closed=true;resolveClosed();clearTimeout(startup);if(pendingCommand){clearTimeout(pendingCommand.timer);pendingCommand.reject(problem);pendingCommand=null;}error(problem);});
  child.on('close',(code,signal)=>{closed=true;resolveClosed();clearTimeout(startup);if(pendingCommand){clearTimeout(pendingCommand.timer);pendingCommand.reject(Error('Foreground worker exited during '+pendingCommand.command));pendingCommand=null;}if(!stopping)error(Error('Windows 前台观察器已退出：'+(signal||code)+(stderr?'；'+stderr.trim():'')));});
 });
}
module.exports={createAutoSwitchRuntime,createWindowsForegroundObserver};
