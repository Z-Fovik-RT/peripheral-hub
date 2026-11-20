'use strict';
(() => {
 const $=id=>document.getElementById(id);
 const TARGETS=[
  {id:'aula-f87-pro',category:'keyboard',brand:'AULA / 狼蛛',name:'F87 / F87 PRO',description:'无线机械键盘',footnote:'系列匹配 · 具体板型待核对',features:[['键位映射','逐键改键与组合键'],['灯光效果','灯效、颜色与亮度'],['连接与电量','内部连接与电量']]},
  {id:'inphic-in9',category:'mouse',brand:'INPHIC / 英菲克',name:'IN9',description:'无线游戏鼠标',footnote:'已匹配本机接收器',features:[['DPI 灵敏度','档位与灵敏度'],['按键分配','自定义固定动作'],['回报率','轮询与性能设置'],['灯光与电量','灯效与电量']]},
  {id:'ikf-v11-pro-71',category:'headset',brand:'iKF',name:'V11 Pro 7.1',description:'USB 游戏耳机',footnote:'音量、声道、应用会话与九项耳机音效'}
 ];
 const state={target:TARGETS[0].id,layout:'stage',snapshot:null,keyboardIdentity:null,busy:null,endpoints:[],flow:'render',selected:{render:'',capture:''},drafts:new Map(),readAt:new Map(),drawer:null,returnFocus:null,info:null,motion:true};
 const panelBusy=(except='')=>['headsetEffects','headsetMaster','headsetAudio','headsetOverview','headsetProfiles','keyboardReads','in9Profiles','localLibrary'].some(name=>name!==except&&Boolean(window[name]?.isBusy()));
 const otherBusy=except=>Boolean(state.busy)||Boolean(window.deviceControls?.isControlBusy())||panelBusy(except);
 let audioQueued=false, audioVersion=0; const audioInvalid=new Set();
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 const text=(v,f='—')=>typeof v==='string'&&v.trim()?v:f;
 const errorText=e=>typeof e?.message==='string'?e.message:typeof e==='string'?e:'本地服务返回未知错误';
 const volumeValue=v=>typeof v==='number'&&Number.isFinite(v)?Math.round(Math.min(100,Math.max(0,v))):null;
 const target=()=>TARGETS.find(t=>t.id===state.target);
 const device=id=>state.snapshot?.devices.find(d=>d.id===id);
 const endpoint=()=>state.endpoints.find(e=>e.id===state.selected[state.flow]&&e.flow===state.flow);
 const timeText=v=>{const d=new Date(v);return Number.isFinite(d.getTime())?d.toLocaleTimeString('zh-CN',{hour12:false}):'尚未读取';};
 function api(method){if(typeof window.hub?.[method]!=='function')throw Error('本地服务尚未连接，请从桌面程序启动。');return window.hub[method].bind(window.hub);}
 function notify(message,kind='success'){$('notice-text').textContent=message;$('notice').className=`notice glass ${kind}`;$('notice').hidden=false;}
 function status(d){return !state.snapshot?'等待扫描':d?.connected?'已连接':'未检测到';}
 function connection(d){return !state.snapshot?'正在读取本地设备状态':d?.connected?text(d.connection,'本地连接'):'连接设备后刷新';}
 function targetView(t){return t.id==='aula-f87-pro'&&state.keyboardIdentity&&device(t.id)?.connected?{...t,name:'F87 PRO',footnote:'PSD 身份已核验 · 固件版本'+text(state.keyboardIdentity.firmware,'未知')}:t;}
 function keyboardIdentityNote(){return state.keyboardIdentity?'F87 PRO 已通过 PSD 身份核验；固件版本'+text(state.keyboardIdentity.firmware,'未知')+'。设置直接读取硬件，逐步开放已验证项。':'F87 / F87 PRO 为系列匹配，需手动读取核验具体型号。设置直接读取硬件，逐步开放已验证项。';}
 function onKeyboardIdentityChange(identity){
  const valid=state.target==='aula-f87-pro'&&device('aula-f87-pro')?.connected&&identity?.identityVerified===true&&identity.model==='F87 PRO'&&typeof identity.psdHex==='string'&&/^03000000010b$/i.test(identity.psdHex);
  const next=valid?{...identity}:null;
  if(!next&&!state.keyboardIdentity)return;
  state.keyboardIdentity=next;
  const t=TARGETS[0],view=targetView(t),card=document.querySelector('[data-device="aula-f87-pro"]');
  if(card){card.querySelector('.card-name').textContent=view.name;card.setAttribute('aria-label',`${t.brand} ${view.name} · ${status(device(t.id))}`);}
  if(state.target===t.id){$('stage-name').textContent=view.name;$('stage-footnote').textContent=view.footnote;$('page-device-name').textContent=view.name;$('private-reported').textContent=keyboardIdentityNote();}
 }
 function invalidateKeyboardIdentity(){window.keyboardReads?.invalidate();onKeyboardIdentityChange(null);}
 function normalizeAudio(audio){const ids=new Set();return (Array.isArray(audio)?audio:[]).filter(e=>e&&typeof e.id==='string'&&e.id&&typeof e.name==='string'&&/ikf/i.test(e.name)&&['render','capture'].includes(e.flow)&&volumeValue(e.volume)!==null&&typeof e.muted==='boolean').filter(e=>{if(ids.has(e.id))return false;ids.add(e.id);return true;}).map(e=>({...e,volume:volumeValue(e.volume)}));}
 function installSnapshot(result){
  if(!result||!Array.isArray(result.devices)||!Array.isArray(result.audio))throw Error('设备扫描结果格式不完整，请重新刷新。');
  invalidateKeyboardIdentity();
  state.snapshot={scannedAt:result.scannedAt,devices:result.devices.filter(d=>d&&TARGETS.some(t=>t.id===d.id)),warnings:Array.isArray(result.warnings)?result.warnings.filter(x=>typeof x==='string'):[]};
  state.endpoints=normalizeAudio(result.audio);state.drafts.clear();state.readAt.clear();audioInvalid.clear();
  window.headsetOverview?.setEndpoints(state.endpoints);
  state.endpoints.forEach(e=>state.readAt.set(e.id,Date.now()));
  for(const flow of ['render','capture']){const list=state.endpoints.filter(e=>e.flow===flow);if(!list.some(e=>e.id===state.selected[flow]))state.selected[flow]=list[0]?.id||'';}
  const count=TARGETS.filter(t=>device(t.id)?.connected).length;
  $('connected-count').textContent=`${count} 台设备已连接`;$('global-status-dot').classList.toggle('connected',count>0);
  $('scan-time').textContent=`最近扫描 ${timeText(result.scannedAt)}`;$('footer-status').textContent='本地连接 · 私有功能适配中';
  const list=$('warnings-list');list.replaceChildren();state.snapshot.warnings.forEach(w=>{const li=document.createElement('li');li.textContent=w;list.append(li);});
  $('warnings-panel').hidden=!state.snapshot.warnings.length;$('warnings-summary').textContent=`扫描提示 · ${state.snapshot.warnings.length} 项`;
  renderCards();renderStage();renderDeviceSettings();renderAudio();
 }
 function setBusy(value){
  state.busy=value;const locked=Boolean(value)||panelBusy();
  $('profiles-nav').disabled=locked;$('lights-nav').disabled=locked||target().category==='headset';
  $('refresh-button').disabled=locked;$('refresh-button').classList.toggle('is-busy',value==='scan');$('refresh-label').textContent=value==='scan'?'正在扫描':'刷新设备';
  $('device-grid').setAttribute('aria-busy',String(value==='scan'));
  $('restore-button').disabled=locked||!state.snapshot;$('restore-label').textContent=value==='restore'?'正在恢复…':'恢复原始状态';
  $('apply-label').textContent=value==='apply'?'正在应用…':'应用更改';
  $('endpoint-select').disabled=locked||!state.endpoints.some(e=>e.flow===state.flow);
  document.querySelectorAll('[data-flow]').forEach(b=>b.disabled=locked);
  $('volume-range').disabled=(locked&&value!=='apply')||!endpoint()||audioInvalid.has(endpoint()?.id);$('mute-toggle').disabled=$('volume-range').disabled;updateDraftStatus();window.deviceControls?.sync();window.headsetEffects?.sync();window.headsetMaster?.sync();window.headsetAudio?.sync();window.headsetOverview?.sync();window.headsetProfiles?.sync();window.keyboardReads?.sync();window.in9Profiles?.sync();
 }
 function renderCards(){
  const fragment=document.createDocumentFragment();
  TARGETS.forEach((t,i)=>{const d=device(t.id),view=targetView(t);const card=$('device-card-template').content.firstElementChild.cloneNode(true);card.dataset.device=t.id;card.setAttribute('aria-label',`${t.brand} ${view.name} · ${status(d)}`);card.setAttribute('aria-pressed',String(t.id===state.target));card.classList.toggle('selected',t.id===state.target);card.classList.toggle('connected',Boolean(d?.connected));card.querySelector('img').src=`./assets/${t.category}.svg`;card.querySelector('.card-brand').textContent=t.brand;card.querySelector('.card-name').textContent=view.name;card.querySelector('.card-status').textContent=status(d);card.querySelector('.card-number').textContent=String(i+1).padStart(2,'0');fragment.append(card);});
  $('device-grid').replaceChildren(fragment);
 }
 function renderStage(animate=false){
  const t=target(),d=device(t.id),view=targetView(t);$('stage-category').textContent=`${t.category.toUpperCase()} / ${t.brand}`;$('stage-name').textContent=view.name;$('stage-description').textContent=t.description;$('stage-status').textContent=status(d);$('stage-status').classList.toggle('offline',!d?.connected);$('stage-connection').textContent=connection(d);$('stage-capability').textContent=t.category==='headset'?(state.endpoints.length?'音量 / 静音已接入':'音频端点未检测到'):'统一设置 / 设备直连';$('stage-footnote').textContent=view.footnote;$('stage-index').textContent=String(TARGETS.indexOf(t)+1).padStart(2,'0');$('stage-image').src=`./assets/${t.category}.svg`;$('stage-image').alt=`${t.description}原创示意图`;$('stage-visual').dataset.category=t.category;$('open-settings').firstChild.textContent=t.category==='headset'?'声音设置':'设备设置';$('lights-nav').disabled=t.category==='headset';$('lights-nav').title=t.category==='headset'?'此耳机尚无已接入的灯光设置':'所选设备灯光设置';
  if(animate&&state.motion&&!reduced.matches){for(const el of [$('stage-copy'),$('stage-image')]){el.getAnimations().forEach(a=>a.cancel());el.animate(el.id==='stage-copy'?[{opacity:0,transform:'translateY(15px)'},{opacity:1,transform:'translateY(0)'}]:[{opacity:0,translate:'45px 10px',scale:.88},{opacity:1,translate:'0 0',scale:1}],{duration:el.id==='stage-copy'?450:700,easing:el.id==='stage-copy'?'cubic-bezier(.22,.8,.24,1)':'cubic-bezier(.2,1.15,.3,1)'});}}
 }
 function selectDevice(id){if(state.busy||window.deviceControls?.isBusy()||!TARGETS.some(t=>t.id===id))return;const changed=state.target!==id;if(changed)invalidateKeyboardIdentity();state.target=id;if(changed)window.keyboardReads?.setDevice(id);renderCards();document.querySelector(`[data-device="${id}"]`)?.focus({preventScroll:true});renderStage(changed);if(!$('device-page').hidden)renderDeviceSettings();if(state.layout==='grid')openDevicePage();}
 function renderDeviceSettings(){
  const t=target(),d=device(t.id);$('page-device-image').src=`./assets/${t.category}.svg`;$('page-device-name').textContent=targetView(t).name;$('page-device-status').textContent=`${status(d)} · ${connection(d)}`;
  $('page-title').textContent=t.category==='headset'?'声音设置':'设备设置';$('page-eyebrow').textContent=t.category.toUpperCase()+' SETTINGS';
  $('in9-hardware').hidden=t.category!=='mouse';$('audio-settings').hidden=t.category!=='headset';
  $('private-reported').textContent=t.category==='keyboard'?keyboardIdentityNote():t.category==='mouse'?'IN9 身份与电量可手动查询；灯光、按键和性能共用所选官方 PSF 草稿，预览并明确确认后才传输。配置值不是硬件读回。':'';
  window.deviceControls?.show(t.id,Boolean(d?.connected));
  syncOverviewVisibility();
 }
 function syncOverviewVisibility(){window.headsetOverview?.setVisible(state.target==='ikf-v11-pro-71'&&!$('device-page').hidden&&!$('page-overview').hidden);}
 function acceptAudioMonitor(sample){
  const stamp=Date.parse(sample?.sampledAt);if(!Array.isArray(sample?.endpoints))return;
  for(const item of sample.endpoints){
   const current=state.endpoints.find(endpoint=>endpoint.id===item.endpointId&&endpoint.flow===item.flow);if(!current||(Number.isFinite(stamp)&&stamp<(state.readAt.get(current.id)||0)))continue;
   if(item.available!==true||item.identityVerified!==true||volumeValue(item.volume)===null||typeof item.muted!=='boolean'){audioInvalid.add(current.id);continue;}
   if(!Number.isFinite(stamp))continue;
   const pending=state.drafts.get(current.id),dirty=pending&&(pending.volume!==current.volume||pending.muted!==current.muted);
   current.volume=volumeValue(item.volume);current.muted=item.muted;state.readAt.set(current.id,stamp);audioInvalid.delete(current.id);
   if(!dirty&&state.busy!=='apply')state.drafts.delete(current.id);
  }
  renderAudioValues();
  setBusy(state.busy);
 }
 function draft(e){if(!state.drafts.has(e.id))state.drafts.set(e.id,{volume:e.volume,muted:e.muted});return state.drafts.get(e.id);}
 function renderAudio(){
  for(const flow of ['render','capture'])$(flow+'-count').textContent=String(state.endpoints.filter(e=>e.flow===flow).length);
  document.querySelectorAll('[data-flow]').forEach(b=>{const active=b.dataset.flow===state.flow;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
  const list=state.endpoints.filter(e=>e.flow===state.flow),select=$('endpoint-select');select.replaceChildren();
  if(!list.length){const o=document.createElement('option');o.value='';o.textContent=`未检测到 iKF ${state.flow==='render'?'播放':'录音'}端点`;select.append(o);}else{list.forEach(e=>{const o=document.createElement('option');o.value=e.id;o.textContent=e.name;select.append(o);});if(!list.some(e=>e.id===state.selected[state.flow]))state.selected[state.flow]=list[0].id;select.value=state.selected[state.flow];}
  $('audio-empty-title').textContent=`未检测到 iKF ${state.flow==='render'?'播放':'录音'}端点`;$('volume-label').textContent=state.flow==='render'?'输出音量':'录音音量';$('mute-description').textContent=state.flow==='render'?'暂停播放声音':'静音此录音端点';renderAudioValues();setBusy(state.busy);
 }
 function renderAudioValues(){const e=endpoint();$('audio-empty').hidden=Boolean(e);$('audio-controls').hidden=!e;if(e){const d=draft(e);$('volume-range').value=String(d.volume);$('volume-output').textContent=String(d.volume);$('mute-toggle').checked=d.muted;$('readback-value').textContent=audioInvalid.has(e.id)?'系统状态未知':`${e.volume}% · ${e.muted?'已静音':'未静音'}`;$('readback-time').textContent=audioInvalid.has(e.id)?'未取得当前读回':timeText(state.readAt.get(e.id));}updateDraftStatus();}
  function updateDraftStatus(){const e=endpoint(),d=e?draft(e):null,dirty=Boolean(d&&(d.volume!==e.volume||d.muted!==e.muted));$('draft-status').textContent=audioInvalid.has(e?.id)?'读取失败，请刷新核对':state.busy==='apply'?'正在同步并读回…':dirty?'正在同步当前选择':'与系统读回一致';$('draft-status').classList.toggle('dirty',dirty);$('apply-button').hidden=true;$('apply-button').disabled=true;}
 async function scan(initial=false){if(state.busy||window.deviceControls?.isBusy())return;invalidateKeyboardIdentity();setBusy('scan');$('footer-status').textContent='正在扫描本地设备…';try{installSnapshot(await api(initial?'snapshot':'refresh')());if(!initial)notify(`已刷新：${TARGETS.filter(t=>device(t.id)?.connected).length} 台设备，${state.endpoints.length} 个音频端点。`);}catch(e){notify(`扫描失败：${errorText(e)}${state.snapshot?'\n当前仍显示上次结果。':''}`,'error');$('footer-status').textContent=state.snapshot?'扫描失败 · 显示上次结果':'本地服务未连接';}finally{setBusy(null);}}
  async function applyAudio(event){
   event?.preventDefault();if((state.busy&&state.busy!=='apply')||panelBusy()||window.deviceControls?.isControlBusy())return;
   const e=endpoint();if(!e||audioInvalid.has(e.id))return;audioQueued=true;if(state.busy==='apply')return;setBusy('apply');
   try{while(audioQueued){audioQueued=false;const d={...draft(e)},version=audioVersion;const payload={id:e.id};if(d.volume!==e.volume)payload.volume=d.volume;if(d.muted!==e.muted)payload.muted=d.muted;if(Object.keys(payload).length===1)continue;
    const r=await api('setAudio')(payload);if(!r||r.id!==e.id||r.flow!==e.flow||typeof r.volume!=='number'||!Number.isFinite(r.volume)||r.volume<0||r.volume>100||typeof r.muted!=='boolean')throw Error('未取得完整的系统读回，请刷新核对。');
    e.volume=volumeValue(r.volume);e.muted=r.muted;state.readAt.set(e.id,Date.now());if(audioVersion===version)state.drafts.delete(e.id);renderAudioValues();
   }}catch(error){audioQueued=false;audioInvalid.add(e.id);notify('声音同步失败：'+errorText(error)+' 请刷新核对，或恢复修改前状态。','error');}finally{setBusy(null);}
  }
 async function restoreAudio(){if(state.busy||panelBusy()||window.deviceControls?.isControlBusy())return;setBusy('restore');try{const result=await api('restoreAudio')();if(!result||!Number.isInteger(result.restored)||result.restored<0||!Array.isArray(result.errors))throw Error('恢复结果格式不完整，请刷新核对。');const errors=result.errors.filter(e=>typeof e==='string');let message=result.restored?`已恢复 ${result.restored} 个音频端点。`:'暂无需要恢复的调整。';try{installSnapshot(await api('snapshot')());}catch(e){errors.push(`恢复后的读取失败：${errorText(e)}`);}if(errors.length)message+='\n'+errors.join('\n');notify(message,errors.length?'warning':'success');}catch(e){notify(`恢复失败：${errorText(e)}`,'error');}finally{setBusy(null);}}
 function openDevicePage(){
  if(!state.drawer)state.returnFocus=document.activeElement;
  renderDeviceSettings();$('workspace').hidden=true;$('device-page').hidden=false;$('app-shell').inert=false;$('close-device-page').focus({preventScroll:true});if(target().category==='headset')window.headsetAudio?.open();
  syncOverviewVisibility();
 }
 async function closeDevicePage(){
  window.headsetVoiceTest?.stop();window.headsetProfiles?.close();$('device-page').hidden=true;$('workspace').hidden=false;$('app-shell').inert=false;
  syncOverviewVisibility();
  if(state.returnFocus?.isConnected)state.returnFocus.focus({preventScroll:true});
  state.returnFocus=null;
 }
 let drawerTransition=0;
 function openDrawer(kind){drawerTransition++;for(const el of [$('settings-drawer'),$('drawer-overlay')])el.getAnimations().forEach(a=>a.cancel());if(!state.drawer)state.returnFocus=document.activeElement;state.drawer=kind;$('device-settings').hidden=true;$('appearance-settings').hidden=kind!=='appearance';$('about-settings').hidden=kind!=='about';$('application-settings').hidden=kind!=='application';$('drawer-title').textContent=kind==='appearance'?'外观':kind==='application'?'应用设置':'关于外设中心';$('drawer-eyebrow').textContent=kind==='appearance'?'APPEARANCE':kind==='application'?'PREFERENCES':'LOCAL CUSTOM';$('drawer-overlay').hidden=false;$('settings-drawer').hidden=false;$('app-shell').inert=true;$('close-settings').focus({preventScroll:true});if(kind==='application')window.applicationSettings?.open();}
 async function closeDrawer(){
  if(!state.drawer)return;
  const token=++drawerTransition,panel=$('settings-drawer'),overlay=$('drawer-overlay');
  for(const el of [panel,overlay])el.getAnimations().forEach(a=>a.cancel());
  if(state.motion&&!reduced.matches){
   const animations=[panel.animate([{opacity:1,transform:'translateX(0) scale(1)'},{opacity:0,transform:'translateX(60px) scale(.985)'}],{duration:210,easing:'cubic-bezier(.4,0,.7,1)',fill:'forwards'}),overlay.animate([{opacity:1},{opacity:0}],{duration:190,fill:'forwards'})];
   await Promise.all(animations.map(a=>a.finished.catch(()=>{})));
   if(token!==drawerTransition)return;
   panel.hidden=true;overlay.hidden=true;animations.forEach(a=>a.cancel());
  }else{panel.hidden=true;overlay.hidden=true;}
  if(token!==drawerTransition)return;
  $('app-shell').inert=false;state.drawer=null;
  if(state.returnFocus?.isConnected)state.returnFocus.focus({preventScroll:true});
 }
 function setLayout(layout){if(!['stage','grid'].includes(layout))return;state.layout=layout;$('workspace').dataset.layoutMode=layout;document.querySelectorAll('[data-layout]').forEach(b=>{const active=b.dataset.layout===layout;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});}
 function syncMotion(){const enabled=state.motion&&!reduced.matches;document.body.classList.toggle('reduce-motion',!enabled);$('motion-toggle').checked=state.motion;$('motion-note').textContent=reduced.matches?'系统已开启“减少动态效果”。':'';}
 async function loadInfo(){try{const info=await api('getInfo')();state.info=info;$('info-version').textContent=text(info.version);$('info-mode').textContent=text(info.mode);$('info-source').textContent=text(info.source);window.applicationSettings?.accept(info.preferences);}catch(e){$('info-version').textContent='未读取';$('info-source').textContent=errorText(e);}}
 document.addEventListener('click',event=>{const card=event.target.closest('[data-device]');if(card)selectDevice(card.dataset.device);const layout=event.target.closest('[data-layout]');if(layout)setLayout(layout.dataset.layout);if(event.target.closest('[data-page-tab]'))syncOverviewVisibility();});
 document.querySelectorAll('[data-flow]').forEach(b=>b.addEventListener('click',()=>{if(!state.busy){state.flow=b.dataset.flow;renderAudio();}}));
 document.querySelectorAll('[data-window]').forEach(b=>b.addEventListener('click',async()=>{try{const r=await api('windowControl')(b.dataset.window);if(b.dataset.window==='maximize')b.setAttribute('aria-label',r?.maximized?'还原窗口':'最大化');}catch(e){notify(`窗口操作失败：${errorText(e)}`,'error');}}));
 $('open-settings').addEventListener('click',openDevicePage);$('close-device-page').addEventListener('click',closeDevicePage);$('appearance-button').addEventListener('click',()=>openDrawer('appearance'));$('app-settings').addEventListener('click',()=>openDrawer('application'));$('brand-about').addEventListener('click',()=>openDrawer('about'));$('support-button').addEventListener('click',()=>openDrawer('about'));$('devices-nav').addEventListener('click',()=>{closeDevicePage();setLayout('stage');});$('close-settings').addEventListener('click',closeDrawer);$('drawer-overlay').addEventListener('click',closeDrawer);
 $('refresh-button').addEventListener('click',()=>scan());$('dismiss-notice').addEventListener('click',()=>{$('notice').hidden=true;});
 $('lights-nav').addEventListener('click',()=>{if(otherBusy()||target().category==='headset')return;openDevicePage();document.querySelector('[data-page-tab="lighting"]').click();});
 $('profiles-nav').addEventListener('click',()=>{void(async()=>{if(otherBusy())return;openDevicePage();if(target().category==='headset'){document.querySelector('[data-page-tab="effects"]').click();return;}if(await window.localLibrary?.openKind('profiles'))document.querySelector('[data-page-tab="library"]').click();})().catch(error=>notify('配置入口未打开：'+errorText(error),'error'));});
 $('endpoint-select').addEventListener('change',()=>{if(!state.busy){state.selected[state.flow]=$('endpoint-select').value;renderAudioValues();setBusy(null);}});
 $('volume-range').addEventListener('input',()=>{const e=endpoint();if((state.busy&&state.busy!=='apply')||!e||audioInvalid.has(e.id))return;draft(e).volume=volumeValue(Number($('volume-range').value));audioVersion++;$('volume-output').textContent=$('volume-range').value;updateDraftStatus();void applyAudio();});
 $('mute-toggle').addEventListener('change',()=>{const e=endpoint();if((state.busy&&state.busy!=='apply')||!e||audioInvalid.has(e.id))return;draft(e).muted=$('mute-toggle').checked;audioVersion++;updateDraftStatus();void applyAudio();});$('audio-form').addEventListener('submit',applyAudio);$('restore-button').addEventListener('click',restoreAudio);
 $('motion-toggle').addEventListener('change',()=>{state.motion=$('motion-toggle').checked;try{localStorage.setItem('hub-motion',String(state.motion));}catch{}window.applicationSettings?.legacyMotion(!state.motion);syncMotion();});reduced.addEventListener('change',syncMotion);
 document.addEventListener('keydown',event=>{if(event.key!=='Escape')return;if(state.drawer){event.preventDefault();closeDrawer();}else if(!$('device-page').hidden){event.preventDefault();closeDevicePage();}});
 try{state.motion=localStorage.getItem('hub-motion')!=='false';}catch{}
 
 window.deviceControls?.init({notify,isBusy:()=>Boolean(state.busy)||panelBusy(),refreshAudio:()=>scan()});
 window.applicationSettings?.init({reduceMotion:!state.motion,onChange(value){state.motion=!value.reduceMotion;try{localStorage.setItem('hub-motion',String(state.motion));}catch{}syncMotion();},onQuit:()=>api('windowControl')('quit')});
 window.headsetOverview?.init({isBusy:()=>otherBusy('headsetOverview'),onBusyChange:()=>setBusy(state.busy),onReadback:acceptAudioMonitor});
  window.headsetMaster?.init({isBusy:()=>otherBusy('headsetMaster'),onBusyChange:()=>setBusy(state.busy)});
  window.headsetEffects?.init({isBusy:()=>otherBusy('headsetEffects'),onBusyChange:()=>setBusy(state.busy)});
 window.headsetAudio?.init({isBusy:()=>otherBusy('headsetAudio'),onBusyChange:()=>setBusy(state.busy)});
  window.headsetProfiles?.init({isBusy:()=>otherBusy('headsetProfiles'),onBusyChange:()=>setBusy(state.busy)});
 window.keyboardReads?.init({isBusy:()=>otherBusy('keyboardReads'),isConnected:()=>Boolean(device('aula-f87-pro')?.connected),onBusyChange:()=>setBusy(state.busy),onIdentityChange:onKeyboardIdentityChange});
 window.in9Profiles?.init({isBusy:()=>otherBusy('in9Profiles'),onBusyChange:()=>setBusy(state.busy)});
  renderCards();renderStage();renderAudio();syncMotion();void loadInfo();void scan(true);
})();
