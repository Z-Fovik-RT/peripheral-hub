'use strict';
(()=>{
  const DEVICE='ikf-v11-pro-71',pngDataPrefix=String.fromCharCode(100,97,116,97,58,105,109,97,103,101,47,112,110,103,59,98,97,115,101,54,52,44);let host=null,profiles=[],profilesKnown=false,rules=[],busy=false,editingPath=null,endpoints=[],confirmedTargets=[],targetChanges=Promise.resolve(),runtime=null,poll=null,polling=false,lastApplied=null,pendingEnable=null,pendingIconDataUrl=null,pendingIconPath=null;
 const $=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
 async function invoke(operation,args={}){const r=await window.hub.features.invoke({apiVersion:1,deviceId:DEVICE,operation:'headset.autoSwitch.'+operation,args});if(!r?.ok)throw Error(r?.error?.message||'规则服务失败。');if(operation==='setEnabled'){if(polling)await polling;runtime={...runtime,enabled:r.data.enabled};if(args.enabled&&r.data.enabled!==true)throw Error('启用请求已取消，请重新核对目标端点。');}return r.data;}
 function status(message){host.querySelector('#headset-auto-switch-status').textContent=message;}
  function setIconPreview(dataUrl){const preview=host.querySelector('#headset-auto-switch-icon-preview'),valid=typeof dataUrl==='string'&&dataUrl.startsWith(pngDataPrefix)&&dataUrl.length<=700000;preview.src=valid?dataUrl:'';preview.hidden=!valid;}
  function clearIconPreview(){pendingIconDataUrl=null;pendingIconPath=null;setIconPreview(null);}
  async function loadRuleIcon(image,icon){if(typeof icon!=='string'||!icon||typeof window.hub?.readAutoSwitchIcon!=='function')return;try{const result=await window.hub.readAutoSwitchIcon({icon});if(typeof result?.dataUrl==='string'&&result.dataUrl.startsWith(pngDataPrefix)&&result.dataUrl.length<=700000){image.src=result.dataUrl;image.hidden=false;}}catch{}}
 function sync(){for(const element of host.querySelectorAll('input,select,button'))element.disabled=busy;const toggle=host.querySelector('#headset-auto-switch-enabled');if(toggle){toggle.checked=pendingEnable??(runtime?.enabled===true);toggle.disabled=busy||(!toggle.checked&&(!endpoints.length||!profilesKnown||!rules.length));}}
 function paintRuntime(){const output=host.querySelector('#headset-auto-switch-runtime-status');if(!output)return;const labels={disabled:'已停止',starting:'正在启动',watching:'正在监听前台应用',applying:'正在切换并核对音效',error:'因错误停止'};output.textContent=(labels[runtime?.state]||'尚未读取运行状态')+(runtime?.lastProfileName?'；最近匹配配置：'+runtime.lastProfileName:'')+(runtime?.lastAppliedAt?'；上次应用：'+new Date(runtime.lastAppliedAt).toLocaleString():'')+(runtime?.lastError?'；'+runtime.lastError:'');const path=host.querySelector('#headset-auto-switch-foreground');path.textContent=runtime?.foregroundPath?'前台：'+runtime.foregroundPath:'';sync();}
 function schedulePoll(){clearTimeout(poll);poll=null;if(runtime?.enabled)poll=setTimeout(()=>{poll=null;if(!document.hidden)void readRuntime();else schedulePoll();},2000);}
 function readRuntime(){if(!host)return Promise.resolve();if(polling)return polling;polling=(async()=>{try{runtime=await invoke('status');const changed=runtime.lastAppliedAt&&runtime.lastAppliedAt!==lastApplied;if(changed&&lastApplied!==null){window.headsetVoiceTest?.stop();window.headsetMaster?.invalidate('应用关联已切换配置，正在核对实际音效。');window.headsetEffects?.invalidate('应用关联已切换配置，正在重新读取音效。');window.headsetEffects?.open();}lastApplied=runtime.lastAppliedAt||'';paintRuntime();}catch(error){host.querySelector('#headset-auto-switch-runtime-status').textContent='运行状态读取失败：'+error.message;}finally{polling=false;schedulePoll();}})();return polling;}
  function cancelEdit(){editingPath=null;host.querySelector('#headset-auto-switch-name').value='';host.querySelector('#headset-auto-switch-path').value='';host.querySelector('#headset-auto-switch-profile').value=profiles.find(item=>item.name==='Default')?.name||'';host.querySelector('#headset-auto-switch-save').textContent='保存规则';host.querySelector('#headset-auto-switch-cancel').hidden=true;clearIconPreview();}
  function paint(){const list=host.querySelector('#headset-auto-switch-rules');list.replaceChildren();for(const rule of rules){const row=$('div','headset-auto-switch-row'),icon=$('img','headset-auto-switch-rule-icon');icon.alt='';icon.hidden=true;void loadRuleIcon(icon,rule.icon);const details=$('div','');const profileExists=profiles.some(item=>item.name===rule.bindingProfileName);details.append($('strong','',rule.widgetName),$('code','',rule.appPath),$('span',profilesKnown&&!profileExists?'small-note headset-auto-switch-invalid':'small-note','配置：'+rule.bindingProfileName+(!profilesKnown?'（配置列表尚未确认）':profileExists?'':'（配置已不存在；不会自动应用）')));const actions=$('div','headset-auto-switch-actions'),edit=$('button','secondary-button','编辑');edit.type='button';edit.addEventListener('click',()=>{editingPath=rule.appPath;host.querySelector('#headset-auto-switch-name').value=rule.widgetName;host.querySelector('#headset-auto-switch-path').value=rule.appPath;host.querySelector('#headset-auto-switch-profile').value=rule.bindingProfileName;host.querySelector('#headset-auto-switch-save').textContent='保存修改';host.querySelector('#headset-auto-switch-cancel').hidden=false;clearIconPreview();if(rule.icon)void loadRuleIcon(host.querySelector('#headset-auto-switch-icon-preview'),rule.icon);});const remove=$('button','secondary-button','删除');remove.type='button';remove.setAttribute('aria-label','删除规则 '+rule.widgetName);remove.addEventListener('click',()=>void run(async()=>{await invoke('delete',{applicationId:rule.appPath});rules=rules.filter(item=>item.appPath!==rule.appPath);if(editingPath===rule.appPath)cancelEdit();paint();status('规则及未引用图标已删除。');}));actions.append(edit,remove);row.append(icon,details,actions);list.append(row);}if(!rules.length)list.append($('p','empty-state','尚未保存应用关联。'));sync();}
 async function run(action){if(busy)return;busy=true;sync();try{await action();}catch(error){status('操作未完成：'+error.message);}finally{busy=false;sync();}}
 async function refresh(){if(!host)return;await run(async()=>{const data=await invoke('list');rules=data.rules;paint();status('本地规则已读取；精确路径预览不会切换音效。');await readRuntime();});}
  function mount(){
    if(host)return;const parent=document.getElementById('headset-effects');if(!parent)return;
    host=$('section','setting-card glass headset-auto-switch');host.id='headset-auto-switch';
    const heading=$('div','subheading');heading.append($('h3','','应用关联'));
    const note=$('p','small-note','启用后，切到精确匹配完整 EXE 路径的应用时，会应用关联的耳机全局配置；无匹配时保持当前音效。关闭程序后停止，下次启动需重新启用。规则保存在本应用内，与原厂文件不互通。');
    const enableLabel=$('label','headset-auto-switch-toggle'),enable=$('input');enable.type='checkbox';enable.id='headset-auto-switch-enabled';enableLabel.append(enable,$('span','','启用自动切换'));
    enable.addEventListener('change',()=>{const next=enable.checked;pendingEnable=next;void run(async()=>{await invoke('setEnabled',{enabled:next,...(next?{endpointIds:[...endpoints]}:{})});await readRuntime();status(next?'自动切换已启用；窗口关闭后停止。':'自动切换已停止，当前音效保持不变。');}).finally(()=>{pendingEnable=null;sync();});});
    const runtimeStatus=$('p','small-note');runtimeStatus.id='headset-auto-switch-runtime-status';runtimeStatus.setAttribute('role','status');runtimeStatus.setAttribute('aria-live','polite');
    const foreground=$('code','headset-auto-switch-foreground');foreground.id='headset-auto-switch-foreground';
    const form=$('form','headset-auto-switch-form'),name=$('input');name.id='headset-auto-switch-name';name.maxLength=256;name.placeholder='显示名称';
    const pathField=$('div','headset-auto-switch-path-field'),appPath=$('input'),browse=$('button','secondary-button','浏览 EXE');appPath.id='headset-auto-switch-path';appPath.maxLength=2048;appPath.placeholder='完整 EXE 路径';browse.id='headset-auto-switch-browse';browse.type='button';browse.setAttribute('aria-label','浏览并选择 EXE 文件');
    browse.addEventListener('click',()=>void run(async()=>{
      if(typeof window.hub?.selectAutoSwitchExecutable!=='function')throw Error('当前宿主未提供 EXE 文件选择。');
      const selected=await window.hub.selectAutoSwitchExecutable();if(!selected||selected.canceled)return;
      if(typeof selected.appPath!=='string'||typeof selected.widgetName!=='string')throw Error('文件选择服务返回无效结果。');
      appPath.value=selected.appPath;if(!name.value.trim())name.value=selected.widgetName;clearIconPreview();
      if(typeof window.hub?.getAutoSwitchExecutableIcon==='function'){
        const result=await window.hub.getAutoSwitchExecutableIcon({appPath:selected.appPath});
        if(typeof result?.dataUrl==='string'&&result.dataUrl.startsWith(pngDataPrefix)){pendingIconDataUrl=result.dataUrl;pendingIconPath=selected.appPath;setIconPreview(result.dataUrl);}
      }
      status('已载入 EXE 路径；保存规则后才会写入本地列表。');
    }));
    const iconPreview=$('img','headset-auto-switch-icon-preview');iconPreview.id='headset-auto-switch-icon-preview';iconPreview.alt='所选应用图标';iconPreview.hidden=true;
    pathField.append(appPath,browse);const select=$('select');select.id='headset-auto-switch-profile';
    const save=$('button','primary-button','保存规则');save.id='headset-auto-switch-save';save.type='submit';
    const cancel=$('button','secondary-button','取消');cancel.id='headset-auto-switch-cancel';cancel.type='button';cancel.hidden=true;cancel.addEventListener('click',cancelEdit);
    form.append(name,pathField,iconPreview,select,save,cancel);
    form.addEventListener('submit',event=>{event.preventDefault();void run(async()=>{
      const profile=profiles.find(item=>item.name===select.value&&item.name!=='Current');if(!profile)throw Error('请选择当前存在的已保存全局配置。');
      const widgetName=name.value.trim(),fullPath=appPath.value.trim();if(!widgetName||!fullPath)throw Error('显示名称和完整路径不能为空。');
      if(!/^[A-Za-z]:\\/.test(fullPath)&&!/^\\\\/.test(fullPath))throw Error('请输入完整 Windows 路径。');
      const previous=editingPath,existing=rules.find(rule=>rule.appPath===previous),samePath=existing?.appPath===fullPath;
      const rule={widgetName,appPath:fullPath,bindingProfileName:profile.name,icon:samePath?(existing?.icon||''):''};
      const request={rule,...(previous?{previousApplicationId:previous}:{}),...(pendingIconDataUrl&&pendingIconPath===fullPath?{iconDataUrl:pendingIconDataUrl}:{})};
      if(typeof window.hub?.saveAutoSwitchRule!=='function')throw Error('当前宿主未提供图标规则保存服务。');
      await window.hub.saveAutoSwitchRule(request);cancelEdit();const data=await invoke('list');rules=data.rules;paint();status('规则已保存到本地。');
    });});
    const previewForm=$('form','headset-auto-switch-preview'),previewPath=$('input');previewPath.id='headset-auto-switch-preview-path';previewPath.maxLength=2048;previewPath.placeholder='输入完整路径进行精确预览';
    const previewButton=$('button','secondary-button','预览');previewButton.type='submit';const output=$('p','small-note','预览仅作比较，不会应用配置。');output.id='headset-auto-switch-preview-result';
    previewForm.append(previewPath,previewButton);previewForm.addEventListener('submit',event=>{event.preventDefault();void run(async()=>{const result=await invoke('preview',{applicationId:previewPath.value});output.textContent=result.matched?'精确匹配：'+result.rule.widgetName+' → '+result.rule.bindingProfileName+'（未应用）':'无完整路径匹配（未应用）';});});
    const list=$('div','headset-auto-switch-list');list.id='headset-auto-switch-rules';const state=$('p','small-note');state.id='headset-auto-switch-status';
    host.append(heading,note,enableLabel,runtimeStatus,foreground,form,previewForm,output,list,state);parent.append(host);window.addEventListener('pagehide',()=>clearTimeout(poll));sync();
  }
 function updateProfiles(next){profilesKnown=Array.isArray(next);profiles=profilesKnown?next:[];const select=host?.querySelector('#headset-auto-switch-profile');if(!select)return;const value=select.value;select.replaceChildren();for(const item of profiles.filter(item=>item.name!=='Current')){const option=$('option','',item.name==='Default'?'默认配置':item.name);option.value=item.name;select.append(option);}select.value=profiles.some(item=>item.name===value&&item.name!=='Current')?value:(editingPath?'':profiles.find(item=>item.name==='Default')?.name||'');paint();}
 async function rebindDeletedProfile(profileName,profileList){const fallback=Array.isArray(profileList)?profileList.find(item=>item&&item.name==='Default'):null;if(!fallback)return {updated:0};const result=await invoke('rebind',{profileName,fallbackProfileName:fallback.name});if(Number.isInteger(result?.updated)&&result.updated>0){const data=await invoke('list');rules=data.rules;paint();}return result;}
 function setEndpoints(ids){endpoints=Array.isArray(ids)?ids.filter(id=>typeof id==='string'&&id):[];if(endpoints.length)confirmedTargets=[...endpoints];if(host)sync();}
 function targetsChanged(ids){
  const next=Array.isArray(ids)?ids.filter(id=>typeof id==='string'&&id):[],signature=values=>values.map(id=>id.toLowerCase()).sort().join('|');
  const action=targetChanges.then(async()=>{
   if(signature(next)===signature(confirmedTargets)){setEndpoints(next);return;}
   if(runtime?.enabled||pendingEnable===true){await invoke('setEnabled',{enabled:false});await readRuntime();}
   confirmedTargets=[...next];setEndpoints(next);updateProfiles(null);
   if(host)status('目标端点已改变；核对配置后可重新启用自动切换。');
  });targetChanges=action.catch(()=>{});return action;
 }
  window.headsetAutoSwitch={init(){mount();void refresh();},setProfiles(values){updateProfiles(values);},setEndpoints,targetsChanged,rebindDeletedProfile,refresh};
})();
