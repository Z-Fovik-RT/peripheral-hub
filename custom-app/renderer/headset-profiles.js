'use strict';
(()=>{
 const DEVICE_ID='ikf-v11-pro-71';
 let hooks={},busy=false,ready=false,receipt=null,endpoints=[],timer=null,revision=0;
 let section,picker,menu,nameInput,saveButton,status,pendingDelete=null;
 const el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
 const blocked=()=>busy||Boolean(hooks.isBusy?.());
 const label=name=>name==='Default'?'默认配置':name==='Current'?'当前设置':name;
 async function invoke(suffix,args={}){
  const result=await window.hub.features.invoke({apiVersion:1,deviceId:DEVICE_ID,operation:'headset.profiles.'+suffix,args:{endpointIds:[...endpoints],...args}});
  if(result?.ok!==true)throw Error(result?.error?.message||'全局配置服务未返回成功结果。');
  const data=result.data;
  const validSource=data?.source==='sdk'&&data.scope==='licensed-effects'||data?.source==='windows-effect-store'&&data.scope==='target-effects';
  if(data?.verified!==true||!validSource||!Array.isArray(data.profiles)||!data.profiles.length||typeof data.currentName!=='string'||new Set(data.profiles.map(p=>p.name)).size!==data.profiles.length||!Array.isArray(data.snapshot)||data.snapshot.length!==endpoints.length||endpoints.some(id=>!data.snapshot.some(target=>target.endpointId===id)))throw Error('全局配置结果不完整。');
  return data;
 }
 function sync(){
  if(!section)return;const locked=blocked()||!endpoints.length;
  picker.disabled=locked||!ready;nameInput.disabled=locked||!ready;saveButton.disabled=locked||!ready||nameInput.value.length===0;
  picker.textContent=receipt?label(receipt.currentName):'全局配置';
  for(const button of menu.querySelectorAll('button'))button.disabled=locked;
  for(const radio of menu.querySelectorAll('input'))radio.disabled=locked;
 }
 function close(){const hadPendingDelete=pendingDelete!==null;pendingDelete=null;if(menu){menu.hidden=true;picker.setAttribute('aria-expanded','false');if(hadPendingDelete)paint();}}
 function paint(){
  menu.replaceChildren();
  const hasSavedCurrent=Boolean(receipt?.profiles.some(profile=>profile.name==='Current'));
  const entries=receipt?[...(hasSavedCurrent?[]:[{name:'Current',isDefault:true,virtual:true}]),...receipt.profiles]:[];
  for(const [index,profile] of entries.entries()){
   const row=el('div','headset-profile-row');row.dataset.profileName=profile.name;if(profile.virtual)row.dataset.virtual='true';
   const selectLabel=el('label','headset-profile-choice'),radio=el('input');radio.type='radio';radio.name='headset-global-profile';radio.value=profile.name;radio.checked=profile.name===receipt.currentName;radio.id='headset-global-choice-'+index;
   radio.addEventListener('change',()=>{if(radio.checked)void run('select',{name:profile.name});});selectLabel.append(radio,el('span','',profile.name==='Current'&&!profile.virtual?'当前设置（档案）':label(profile.name)));row.append(selectLabel);
   if(!profile.isDefault){ 
    const remove=el('button','headset-profile-remove','删除');remove.type='button';remove.dataset.profileDelete=profile.name;remove.setAttribute('aria-label','删除全局配置 '+profile.name);
    remove.addEventListener('click',()=>{if(blocked())return;pendingDelete=profile.name;paint();sync();});row.append(remove);
    if(pendingDelete===profile.name){const confirm=el('div','headset-profile-confirm');confirm.setAttribute('role','group');confirm.setAttribute('aria-label','确认删除 '+profile.name);confirm.append(el('span','','删除此配置？'));const yes=el('button','secondary-button','确定'),no=el('button','secondary-button','取消');yes.type=no.type='button';yes.dataset.profileConfirm=profile.name;no.dataset.profileCancel=profile.name;yes.addEventListener('click',()=>{if(pendingDelete===profile.name)void run('delete',{name:profile.name});});no.addEventListener('click',()=>{pendingDelete=null;paint();sync();});confirm.append(yes,no);row.append(confirm);}
   }
   menu.append(row);
  }
  sync();
 }
 function accept(data){receipt=data;ready=true;window.headsetAutoSwitch?.setEndpoints?.([...endpoints]);window.headsetAutoSwitch?.setProfiles(data.profiles);paint();}
 async function run(action,args){
  if(blocked()||!endpoints.length)return;
  clearTimeout(timer);timer=null;revision++;busy=true;close();sync();hooks.onBusyChange?.();status.textContent=action==='create'?'正在保存当前音效…':action==='delete'?'正在删除配置…':'正在切换并核对全部音效…';
  let success=false,cleanupError=null;
  try{const data=await invoke(action,args);if(action!=='delete'&&data.applied!==true)throw Error('配置服务未确认完成。');if(action==='delete'){try{await window.headsetAutoSwitch?.rebindDeletedProfile(args.name,data.profiles);}catch(error){cleanupError=error;}}accept(data);if(action==='create')nameInput.value='';status.textContent=action==='create'?'已保存并选中「'+label(data.currentName)+'」。':action==='delete'?cleanupError?'配置已删除，但自动切换规则回绑失败：'+cleanupError.message:'配置已删除；引用规则已回绑到默认配置。':'已切换到「'+label(data.currentName)+'」，全部音效已读回。';success=true;}
  catch(error){if(action!=='create'){receipt=null;window.headsetAutoSwitch?.setProfiles(null);ready=false;}paint();status.textContent='操作未完成：'+error.message+(action==='create'?' 请修改名称后重试。':' 请重新读取当前音效。');}
  finally{busy=false;sync();hooks.onBusyChange?.();}
  if(success){window.headsetVoiceTest?.stop();window.headsetMaster?.invalidate('配置已更新，正在核对总开关与实际音效组合。');window.headsetEffects?.invalidate('全局配置已更新，正在重新读取音效。');window.headsetEffects?.open();}
  else if(action!=='create'){window.headsetEffects?.invalidate('全局配置操作失败，请重新读取音效并检查恢复快照。');window.headsetMaster?.invalidate('全局配置未完成，请重新读取总开关。');}
 }
 async function read(){
  if(blocked()||!endpoints.length)return;
  const generation=revision;busy=true;sync();hooks.onBusyChange?.();
  try{const data=await invoke('list');if(generation!==revision)return;accept(data);status.textContent='保存当前音效为新配置；选择配置立即生效。';}
  catch(error){if(generation!==revision)return;ready=false;receipt=null;window.headsetAutoSwitch?.setProfiles(null);paint();status.textContent='配置读取失败：'+error.message;}
  finally{busy=false;sync();hooks.onBusyChange?.();}
 }
 function schedule(){clearTimeout(timer);timer=setTimeout(()=>{timer=null;if(!blocked())void read();else schedule();},500);}
 function mount(){
  if(section)return;
  const host=document.getElementById('headset-effects');if(!host)return;
  section=el('section','headset-global-profiles setting-card glass');section.id='headset-global-profiles';section.setAttribute('aria-label','耳机全局配置');
  const heading=el('div','subheading');heading.append(el('h3','','全局配置'));picker=el('button','secondary-button','全局配置');picker.type='button';picker.id='headset-global-picker';picker.setAttribute('aria-expanded','false');picker.setAttribute('aria-controls','headset-global-options');heading.append(picker);
  menu=el('div','headset-profile-menu');menu.id='headset-global-options';menu.hidden=true;picker.addEventListener('click',()=>{if(picker.disabled)return;if(!menu.hidden){close();return;}menu.hidden=false;picker.setAttribute('aria-expanded','true');});
  const form=el('form','headset-profile-save'),labelNode=el('label','','保存当前配置');nameInput=el('input');nameInput.id='headset-global-name';nameInput.type='text';nameInput.maxLength=128;nameInput.autocomplete='off';nameInput.placeholder='配置名称';labelNode.append(nameInput);
  saveButton=el('button','primary-button','新增配置');saveButton.id='headset-global-create';saveButton.type='submit';form.append(labelNode,saveButton);form.addEventListener('submit',event=>{event.preventDefault();if(!saveButton.disabled)void run('create',{name:nameInput.value});});nameInput.addEventListener('input',sync);
  status=el('p','small-note','读取耳机音效后显示全局配置。');status.id='headset-global-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  section.append(heading,menu,form,status,el('p','small-note','配置覆盖当前目标端点已验证的播放和录音音效。手动调整后显示“当前设置”，原配置保留。'));
  host.querySelector(':scope > .subheading')?.insertAdjacentElement('afterend',section);window.headsetAutoSwitch?.init();window.headsetAutoSwitch?.setProfiles(receipt?.profiles||null);sync();
 }
 window.headsetProfiles={init(options={}){hooks=options;mount();sync();},isBusy:()=>busy,sync,close,
  acceptEndpoints(ids){const next=ids.filter(Boolean);if(next.join('|')!==endpoints.join('|')){endpoints=next;receipt=null;window.headsetAutoSwitch?.setEndpoints?.([...endpoints]);window.headsetAutoSwitch?.setProfiles(null);ready=false;revision++;close();sync();}schedule();},
  effectsChanged(){if(endpoints.length)schedule();},
  invalidate(){clearTimeout(timer);timer=null;revision++;ready=false;receipt=null;window.headsetAutoSwitch?.setEndpoints?.([]);window.headsetAutoSwitch?.setProfiles(null);close();sync();}
 };
})();
