'use strict';
(()=>{
 const DEVICE='ikf-v11-pro-71',flows=['render','capture'],labels={render:'播放输出',capture:'麦克风录音'};
 const records=new Map(),cards=new Map();let hooks={},section=null,all=[],selected={render:'',capture:''},visible=false,applying=false,starting=false,timer=null,polling=false,revision=0,status,monitorRequested=false;
 const scalar=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
 const percentage=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100;
 const node=(tag,className,text)=>{const result=document.createElement(tag);if(className)result.className=className;if(text!==undefined)result.textContent=text;return result;};
 const ids=()=>flows.map(flow=>selected[flow]).filter(Boolean);
 const active=()=>visible&&!document.hidden&&ids().length>0;
 const locked=()=>applying||Boolean(hooks.isBusy?.());
 const textError=error=>error?.message||String(error);
 function record(id){if(!records.has(id))records.set(id,{readback:null,sampledAt:null,draftVolume:null,draftMuted:null,volumeDirty:false,muteDirty:false,error:null,ignoreBefore:0});return records.get(id);}
 async function invoke(operation,args={}){const response=await window.hub.features.invoke({apiVersion:1,deviceId:DEVICE,operation,args});if(response?.ok!==true)throw Error(response?.error?.message||'音频服务失败。');return response.data;}
 function resetReadbacks(message){const endpointIds=ids();for(const id of endpointIds){const entry=record(id);entry.readback=null;entry.sampledAt=null;entry.error=message;}const unknown={running:false,source:'windows-system',sequence:0,sampledAt:null,endpointIds,endpoints:endpointIds.map(endpointId=>({endpointId,name:all.find(item=>item.id===endpointId)?.name||null,flow:all.find(item=>item.id===endpointId)?.flow,available:false,identityVerified:false,volume:null,muted:null,channels:null,peaks:null,error:message})),error:message};window.headsetAudio?.acceptMonitor?.(unknown);hooks.onReadback?.(unknown);sync();}
 function paint(flow){
  if(!section)return;const card=cards.get(flow),id=selected[flow],entry=id?record(id):null,readback=entry?.readback,known=Boolean(readback?.available&&readback.identityVerified);
  const candidates=all.filter(item=>item.flow===flow),selection=card.select.value;card.select.replaceChildren();
  if(!candidates.length){const option=node('option','','未检测到'+labels[flow]+'端点');option.value='';card.select.append(option);}
  for(const item of candidates){const option=node('option','',item.name||item.id);option.value=item.id;card.select.append(option);}card.select.value=id||selection;card.select.hidden=candidates.length<2;
  card.name.textContent=all.find(item=>item.id===id)?.name||'当前无目标端点';
  card.range.disabled=locked()||!known;card.mute.disabled=card.range.disabled;card.select.disabled=locked()||starting;
  card.range.value=entry?.draftVolume===null||entry?.draftVolume===undefined?'0':String(entry.draftVolume);
  card.output.textContent=entry?.draftVolume===null||entry?.draftVolume===undefined||!known&&!entry.volumeDirty?'—':(!known?'草稿 ':'')+Math.round(entry.draftVolume)+'%';
  card.mute.indeterminate=!known;card.mute.checked=entry?.draftMuted===true;card.muteText.textContent=known?'静音':'静音状态未知';
  card.readback.textContent=known?'系统读回：'+Number(readback.volume.toFixed(2))+'% · '+(readback.muted?'已静音':'未静音'):'系统读回：未知';
  const peaks=known&&Array.isArray(readback.peaks)&&readback.peaks.length?readback.peaks:null;
  card.meter.hidden=!peaks;card.meter.value=peaks?Math.max(...peaks):0;card.peak.textContent=peaks?(Math.max(...peaks)*100).toFixed(1)+'%':'—';
  const channels=known&&Array.isArray(readback.channels)?readback.channels:null;
  card.balance.disabled=locked()||!channels||channels.length!==2;
  card.balanceText.textContent=channels?.length===2?'实际声道：左 '+(channels[0]*100).toFixed(1)+'% · 右 '+(channels[1]*100).toFixed(1)+'%':channels?'实际 '+channels.length+' 声道，左右平衡不适用':'实际声道：未知';
  card.apply.disabled=locked()||!known||(!entry?.volumeDirty&&!entry?.muteDirty);
  card.note.textContent=entry?.error||(!known?'等待当前 Windows 读回。':entry.volumeDirty||entry.muteDirty?'有未应用的草稿；外部变化只更新系统读回。':'Windows 持续采样 · '+new Date(entry.sampledAt).toLocaleTimeString('zh-CN',{hour12:false}));
  card.note.dataset.error=String(Boolean(entry?.error));
 }
 function sync(){if(!section)return;section.setAttribute('aria-busy',String(applying));for(const flow of flows)paint(flow);const refresh=section.querySelector('#headset-overview-refresh');refresh.disabled=applying||starting;}
 function validate(snapshot){
  if(!snapshot||snapshot.source!=='windows-system'||typeof snapshot.running!=='boolean'||!Number.isSafeInteger(snapshot.sequence)||snapshot.sequence<0||!Array.isArray(snapshot.endpointIds)||snapshot.endpointIds.length>2||!Array.isArray(snapshot.endpoints)||snapshot.endpoints.length>2)throw Error('实时音频监测返回无效来源。');
  if(!snapshot.running)return;
  const expected=ids();if(snapshot.endpointIds.length!==expected.length||expected.some(id=>!snapshot.endpointIds.includes(id))||snapshot.endpoints.length!==expected.length||!Number.isFinite(Date.parse(snapshot.sampledAt)))throw Error('实时音频监测目标已变化。');
  const seen=new Set();for(const item of snapshot.endpoints){if(!item||!expected.includes(item.endpointId)||seen.has(item.endpointId)||!flows.includes(item.flow)||typeof item.available!=='boolean'||typeof item.identityVerified!=='boolean')throw Error('实时音频端点身份无效。');seen.add(item.endpointId);if(item.available&&(item.identityVerified!==true||!percentage(item.volume)||typeof item.muted!=='boolean'))throw Error('实时音频音量读回无效。');if(!item.available&&[item.volume,item.muted,item.channels,item.peaks].some(value=>value!==null))throw Error('断连端点不能保留旧读回。');for(const field of ['channels','peaks'])if(item[field]!==null&&(!Array.isArray(item[field])||item[field].length<1||item[field].length>32||item[field].some(value=>!scalar(value))))throw Error('实时声道或峰值读回无效。');}
 }
 function accept(snapshot){
  validate(snapshot);if(!snapshot.running){resetReadbacks(snapshot.error||'实时监测已停止，旧读回已清除。');status.textContent=snapshot.error||'实时监测已停止。';return false;}
  for(const item of snapshot.endpoints){const entry=record(item.endpointId);if(Date.parse(snapshot.sampledAt)<entry.ignoreBefore)continue;entry.readback=item.available?{...item}:null;entry.sampledAt=item.available?snapshot.sampledAt:null;entry.error=item.error;
   if(item.available){if(!entry.volumeDirty)entry.draftVolume=item.volume;if(!entry.muteDirty)entry.draftMuted=item.muted;}
  }
  window.headsetAudio?.acceptMonitor?.(snapshot);hooks.onReadback?.(snapshot);status.textContent='播放与录音持续反馈；拖动音量或勾选静音只修改草稿，点击对应应用后生效。';sync();return true;
 }
 function schedule(){clearTimeout(timer);timer=null;if(active())timer=setTimeout(()=>{timer=null;void poll();},500);}
 async function poll(){if(!active())return;if(polling){schedule();return;}const token=revision;polling=true;let keep=false;try{const snapshot=await invoke('headset.audio.monitor.read');if(token!==revision)return;keep=accept(snapshot);}catch(error){if(token===revision){resetReadbacks(textError(error));status.textContent='实时读取失败：'+textError(error);}}finally{polling=false;if(keep&&token===revision)schedule();}}
 async function subscribe(){
  clearTimeout(timer);timer=null;const token=++revision;starting=false;if(!active()){try{if(monitorRequested){await invoke('headset.audio.monitor.stop');if(token===revision)monitorRequested=false;}}catch(error){if(section)status.textContent='停止实时监测失败：'+textError(error);}resetReadbacks('实时监测未订阅。');return;}
  starting=true;resetReadbacks('正在连接当前 Windows 音频端点…');status.textContent='正在启动播放与录音持续反馈…';sync();
  try{monitorRequested=true;const snapshot=await invoke('headset.audio.monitor.start',{endpointIds:ids()});if(token!==revision)return;if(accept(snapshot))schedule();}
  catch(error){if(token===revision){resetReadbacks(textError(error));status.textContent='实时监测未启动：'+textError(error);}}
  finally{if(token===revision){starting=false;sync();}}
 }
 async function apply(flow){
  const id=selected[flow],entry=id?record(id):null;if(locked()||!entry?.readback)return;
  const args={endpointId:id};if(entry.volumeDirty)args.volume=entry.draftVolume;if(entry.muteDirty)args.muted=entry.draftMuted;if(Object.keys(args).length===1)return;
  if(Object.hasOwn(args,'volume')&&!percentage(args.volume))return;
  applying=true;sync();hooks.onBusyChange?.();
  try{const actual=await invoke('headset.audio.set',args);if(actual?.id!==id||!percentage(actual.volume)||typeof actual.muted!=='boolean'||Object.hasOwn(args,'volume')&&Math.abs(actual.volume-args.volume)>0.5||Object.hasOwn(args,'muted')&&actual.muted!==args.muted)throw Error('音量或静音未返回匹配的系统读回。');
   entry.readback={...entry.readback,volume:actual.volume,muted:actual.muted,available:true,identityVerified:true};entry.sampledAt=new Date().toISOString();entry.ignoreBefore=Date.now();entry.draftVolume=actual.volume;entry.draftMuted=actual.muted;entry.volumeDirty=false;entry.muteDirty=false;entry.error=null;
   hooks.onReadback?.({running:true,source:'windows-system',sampledAt:entry.sampledAt,endpointIds:[id],endpoints:[{...entry.readback}]});status.textContent=labels[flow]+'已应用并取得实际系统读回。';
  }catch(error){entry.readback=null;entry.sampledAt=null;entry.error='应用未完成：'+textError(error)+'；草稿已保留，请重新读取。';status.textContent=entry.error;}
  finally{applying=false;sync();hooks.onBusyChange?.();}
 }
 function mount(){
  if(section)return;const host=document.getElementById('audio-settings');if(!host)return;section=node('section','headset-overview');section.id='headset-overview';section.setAttribute('aria-label','播放与录音总览');
  const heading=node('div','subheading');heading.append(node('h3','','播放与录音'));const refresh=node('button','secondary-button','重新读取');refresh.id='headset-overview-refresh';refresh.type='button';refresh.addEventListener('click',()=>void subscribe());heading.append(refresh);section.append(heading);
  const grid=node('div','headset-overview-grid');
  for(const flow of flows){const card=node('section','setting-card headset-overview-card');card.id='headset-overview-'+flow;card.setAttribute('aria-label',labels[flow]);card.append(node('h3','',labels[flow]));const name=node('p','headset-overview-name'),select=node('select');select.setAttribute('aria-label',labels[flow]+'端点');select.addEventListener('change',()=>{if(locked())return;selected[flow]=select.value;sync();void subscribe();});const volumeLabel=node('label','headset-overview-volume','音量'),output=node('output',''),range=node('input');range.id='headset-overview-'+flow+'-volume';range.type='range';range.min='0';range.max='100';range.step='1';range.setAttribute('aria-label',labels[flow]+'音量');volumeLabel.append(output,range);range.addEventListener('input',()=>{const entry=record(selected[flow]);if(locked()||!entry.readback)return;entry.draftVolume=Number(range.value);entry.volumeDirty=Math.abs(entry.draftVolume-entry.readback.volume)>0.5;sync();});
   const muteLabel=node('label','headset-overview-mute'),mute=node('input'),muteText=node('span','','静音');mute.type='checkbox';mute.id='headset-overview-'+flow+'-mute';muteLabel.append(mute,muteText);mute.addEventListener('change',()=>{const entry=record(selected[flow]);if(locked()||!entry.readback)return;entry.draftMuted=mute.checked;entry.muteDirty=entry.draftMuted!==entry.readback.muted;sync();});
   const readback=node('p','field-hint'),peakRow=node('div','headset-overview-peak'),meter=node('meter'),peak=node('output');meter.min=0;meter.max=1;meter.setAttribute('aria-label',labels[flow]+'实时峰值');peakRow.append(node('span','','瞬时峰值'),meter,peak);
   const balanceText=node('p','field-hint'),balance=node('button','secondary-button','打开左右平衡');balance.type='button';balance.addEventListener('click',()=>{if(!locked())void window.headsetAudio?.focusEndpoint?.(selected[flow],'balance');});
   const applyButton=node('button','primary-button','应用'+labels[flow]);applyButton.type='button';applyButton.id='headset-overview-'+flow+'-apply';applyButton.addEventListener('click',()=>void apply(flow));const note=node('p','small-note');note.setAttribute('role','status');
   card.append(name,select,volumeLabel,muteLabel,readback,peakRow,balanceText,balance,applyButton,note);cards.set(flow,{card,name,select,range,output,mute,muteText,readback,meter,peak,balance,balanceText,apply:applyButton,note});grid.append(card);
  }
  status=node('p','small-note','打开音频页后读取当前播放和录音状态。');status.id='headset-overview-status';status.setAttribute('role','status');section.append(grid,status);host.prepend(section);sync();
  document.addEventListener('visibilitychange',()=>{if(visible)void subscribe();});window.addEventListener('pagehide',()=>{visible=false;revision++;clearTimeout(timer);void invoke('headset.audio.monitor.stop').catch(()=>{});});
 }
 window.headsetOverview={
  init(options={}){hooks=options;mount();},isBusy:()=>applying,sync,
  setVisible(value){const next=Boolean(value);if(next===visible)return;visible=next;mount();if(section)void subscribe();},
  setEndpoints(values){const next=Array.isArray(values)?values.filter(item=>item&&typeof item.id==='string'&&flows.includes(item.flow)).map(item=>({id:item.id,name:typeof item.name==='string'?item.name:'',flow:item.flow})):[];const before=ids().join('|');all=next;for(const flow of flows)if(!all.some(item=>item.id===selected[flow]&&item.flow===flow))selected[flow]=all.find(item=>item.flow===flow)?.id||'';sync();if(before!==ids().join('|')&&visible)void subscribe();}
 };
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();
