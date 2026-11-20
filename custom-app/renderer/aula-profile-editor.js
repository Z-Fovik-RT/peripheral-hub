'use strict';
(() => {
  const DEVICE='aula-f87-pro',modifierNames=['leftCtrl','leftShift','leftAlt','leftMeta','rightCtrl','rightShift','rightAlt','rightMeta'],modifierLabels=['左 Ctrl','左 Shift','左 Alt','左 Win','右 Ctrl','右 Shift','右 Alt','右 Win'];
  const media=[[0xCD,'播放 / 暂停'],[0xB5,'下一曲'],[0xB6,'上一曲'],[0xB7,'停止'],[0xE2,'静音'],[0xE9,'音量增加'],[0xEA,'音量减小'],[0x183,'媒体播放器'],[0x18A,'邮件'],[0x192,'计算器'],[0x194,'文件浏览器'],[0x223,'浏览器主页'],[0x224,'浏览器后退'],[0x225,'浏览器前进']];
  const usages=[0,100,41,...Array.from({length:12},(_,i)=>58+i),...Array.from({length:26},(_,i)=>4+i),...Array.from({length:10},(_,i)=>30+i),43,57,40,42,44,47,48,49,51,52,54,55,56,53,46,45,70,71,72,73,74,75,76,77,78,82,81,80,79,89,90,91,92,93,94,95,96,97,98,87,86,85,84,83,88,99,224,225,226,227,228,229,230,231,101,133,135,137,50,138,136,139];
  const paletteModes=new Set([1,2,4,5,7,8,10,11,12,13]),ordinaryModes=new Set([1,2,3,4,5,7,8,10,11,12,13,15,16,17]);
  const clone=value=>JSON.parse(JSON.stringify(value));
  let profile=null,official=false,host=null,onChange=null,isBusy=()=>false,revision=0,layer=0,mappingDirty=false,lightingDirty=false,editingId='',editingLayer=0,editingKey='',favoriteBusy=false,favoriteItems=[];
  const pendingBindings=new Map(),pendingLighting=new Map(),views=new Map();
  const ui={};
  const node=(tag,className,text)=>{const value=document.createElement(tag);if(className)value.className=className;if(text!==undefined)value.textContent=text;return value;};
  const field=(text,control)=>{const label=node('label','aula-profile-field');label.append(node('span','',text),control);return label;};
  function select(id,options){const control=node('select');control.id=id;for(const [value,text]of options){const option=node('option','',text);option.value=String(value);control.append(option);}return control;}
  function usageLabel(usage){if(usage===0)return '仅修饰键';if(usage>=4&&usage<=29)return String.fromCharCode(65+usage-4);if(usage>=30&&usage<=38)return String(usage-29);if(usage>=58&&usage<=69)return 'F'+(usage-57);const labels={39:'0',40:'Enter',41:'Esc',42:'Backspace',43:'Tab',44:'Space',45:'-',46:'=',47:'[',48:']',49:'\\',50:'Non-US #',51:';',52:"'",53:'`',54:',',55:'.',56:'/',57:'Caps Lock',70:'Print Screen',71:'Scroll Lock',72:'Pause',73:'Insert',74:'Home',75:'Page Up',76:'Delete',77:'End',78:'Page Down',79:'右方向',80:'左方向',81:'下方向',82:'上方向',83:'Num Lock',101:'Application',224:'左 Ctrl Usage',225:'左 Shift Usage',226:'左 Alt Usage',227:'左 Win Usage',228:'右 Ctrl Usage',229:'右 Shift Usage',230:'右 Alt Usage',231:'右 Win Usage'};return labels[usage]||'HID Usage '+usage;}
  function message(text,error=false){if(!host)return;ui.status.textContent=text;ui.status.dataset.error=String(error);}
  function favoriteMessage(text,error=false){if(!ui.favoriteStatus)return;ui.favoriteStatus.textContent=text;ui.favoriteStatus.dataset.error=String(error);}
  function favoriteColorHex(color){return '#'+[color.r,color.g,color.b].map(value=>value.toString(16).padStart(2,'0')).join('').toUpperCase();}
  function favoriteColor(){const index=Number(ui.favoriteSlot?.value||0),color=ui.colors?.[index];if(!color)return null;const hex=color.value.slice(1);if(!/^[0-9a-f]{6}$/i.test(hex))return null;return {r:parseInt(hex.slice(0,2),16),g:parseInt(hex.slice(2,4),16),b:parseInt(hex.slice(4,6),16)};}
  async function favoriteInvoke(operation,args={}){
    if(typeof window.hub?.features?.invoke!=='function')throw Error('收藏色服务尚未就绪。');
    const result=await window.hub.features.invoke({apiVersion:1,deviceId:DEVICE,operation,args});if(!result?.ok)throw Error(result?.error?.message||'收藏色操作失败。');return result.data;
  }
  function paintFavorites(){
    if(!ui.favoriteList)return;ui.favoriteList.replaceChildren();if(!favoriteItems.length){ui.favoriteEmpty.hidden=false;return;}ui.favoriteEmpty.hidden=true;
    for(const item of favoriteItems){const row=node('div','aula-profile-favorite-row'),swatch=node('button','aula-profile-favorite-swatch');swatch.type='button';swatch.style.backgroundColor=favoriteColorHex(item.color);swatch.setAttribute('aria-label','使用收藏色 '+item.name);swatch.addEventListener('click',()=>{if(favoriteBusy||!ui.colors.length)return;const index=Number(ui.favoriteSlot.value);ui.colors[index].value=favoriteColorHex(item.color);lightingDirty=true;message('已将收藏色放入颜色 '+(index+1)+' 草稿；点击“更新配置草稿”后才写入配置。');sync();});const name=node('span','aula-profile-favorite-name',item.name),remove=node('button','aula-profile-favorite-delete','删除');remove.type='button';remove.addEventListener('click',()=>void deleteFavorite(item));row.append(swatch,name,remove);ui.favoriteList.append(row);}
  }
  async function refreshFavorites(){
    if(profile?.deviceId!==DEVICE||typeof window.hub?.features?.invoke!=='function')return;
    const token=revision;favoriteBusy=true;favoriteMessage('正在读取本地收藏色…');sync();try{const result=await favoriteInvoke('keyboard.colors.favorites.list');if(token!==revision)return;favoriteItems=Array.isArray(result.colors)?result.colors:[];paintFavorites();favoriteMessage('本地收藏色已读取；仅保存在此电脑。');}catch(error){if(token===revision)favoriteMessage('收藏色读取失败：'+error.message,true);}finally{if(token===revision){favoriteBusy=false;sync();}}
  }
  async function saveFavorite(){
    if(favoriteBusy||profile?.deviceId!==DEVICE)return;const name=ui.favoriteName.value.trim(),color=favoriteColor();if(!name){message('请输入收藏色名称。',true);return;}if(!color){message('当前颜色无效，无法收藏。',true);return;}
    const existing=favoriteItems.find(item=>item.name===name),id=existing?.id||crypto.randomUUID(),token=revision;favoriteBusy=true;favoriteMessage('正在保存收藏色…');sync();try{const result=await favoriteInvoke('keyboard.colors.favorites.save',{id,name,color});if(token!==revision)return;if(result.saved!==true)throw Error('收藏色服务未确认保存。');const list=await favoriteInvoke('keyboard.colors.favorites.list');if(token!==revision)return;favoriteItems=list.colors;paintFavorites();favoriteMessage('收藏色已保存到本地；未写入 DCT 配置，也未发送设备。');}catch(error){if(token===revision)favoriteMessage('收藏色保存失败：'+error.message,true);}finally{if(token===revision){favoriteBusy=false;sync();}}
  }
  async function deleteFavorite(item){
    if(favoriteBusy||profile?.deviceId!==DEVICE)return;const token=revision;favoriteBusy=true;favoriteMessage('正在删除收藏色…');sync();try{const result=await favoriteInvoke('keyboard.colors.favorites.delete',{id:item.id});if(token!==revision)return;if(result.deleted!==true)throw Error('收藏色服务未确认删除。');favoriteItems=favoriteItems.filter(entry=>entry.id!==item.id);paintFavorites();favoriteMessage('收藏色已从本地列表删除；当前 DCT 草稿不受影响。');}catch(error){if(token===revision)favoriteMessage('收藏色删除失败：'+error.message,true);}finally{if(token===revision){favoriteBusy=false;sync();}}
  }
  const bindingCacheKey=()=>JSON.stringify([editingId,editingLayer,editingKey]);
  const lightingCacheKey=()=>JSON.stringify([profile?.id,profile?.lighting?.modeId]);
  function stashBinding(){if(!host||!mappingDirty||!editingId)return;pendingBindings.set(bindingCacheKey(),{action:ui.action.value,usage:ui.usage.value,consumer:ui.consumer.value,media:ui.media.value,mouse:ui.mouse.value,modifiers:ui.modifiers.map(control=>control.checked)});}
  function stashLighting(){if(!host||!lightingDirty||!profile?.id)return;pendingLighting.set(lightingCacheKey(),{brightness:ui.brightness.value,speed:ui.speed.value,colors:ui.colors.map(control=>control.value)});}
  function currentBinding(){return profile?.bindings?.find(binding=>binding.layer===layer&&binding.keyId===ui.key.value)||null;}
  function canLight(){return Boolean(profile?.lighting&&Number.isInteger(profile.lighting.modeId)&&Number.isInteger(profile.lighting.brightnessCode)&&Number.isInteger(profile.lighting.speedCode)&&Array.isArray(profile.lighting.colors)&&profile.lighting.colors.length===7&&profile.lighting.colors.every(color=>color&&['r','g','b'].every(key=>Number.isInteger(color[key])&&color[key]>=0&&color[key]<=255)));}
  function sync(){
    if(!host)return;const active=profile?.deviceId===DEVICE,locked=!active||typeof onChange!=='function'||Boolean(isBusy())||Boolean(window.localLibrary?.isBusy?.()),favoriteLocked=locked||favoriteBusy;host.hidden=!active;
    for(const control of host.querySelectorAll('input,select,button'))control.disabled=locked;
    if(ui.favoriteName)ui.favoriteName.disabled=favoriteLocked;if(ui.favoriteSlot)ui.favoriteSlot.disabled=favoriteLocked;if(ui.favoriteSave)ui.favoriteSave.disabled=favoriteLocked;if(ui.favoriteList)for(const control of ui.favoriteList.querySelectorAll('button'))control.disabled=favoriteLocked;
    ui.lightFields.hidden=!canLight();ui.lightMissing.hidden=canLight();
    if(canLight()){
      const mode=profile.lighting.modeId;ui.brightness.disabled=locked||!ordinaryModes.has(mode);ui.speed.disabled=locked||!ordinaryModes.has(mode)||mode===1;
      for(const color of ui.colors)color.disabled=locked||!paletteModes.has(mode);
      ui.lightHint.textContent=mode===1?'常亮模式没有速度参数。':!ordinaryModes.has(mode)?'当前模式参数保持原样。':!paletteModes.has(mode)?'当前模式颜色固定；原始色板保持原样。':'保留当前模式和其他模式的原始字段。';
    }
    ui.source.textContent=official?'来源：官方 DCT 的本地配置投影；未知动作仍由原始文件保留。':'来源：本地 Hub 配置草稿。';
  }
  function showAction(){for(const kind of ['keyboard','media','consumer','mouseButton'])ui.groups[kind].hidden=ui.action.value!==kind;}
  function paintBinding(){
    if(!host)return;stashBinding();const binding=currentBinding(),assignment=binding?.assignment;mappingDirty=false;
    ui.action.value='';ui.usage.value='4';ui.consumer.value='233';ui.media.value='205';ui.mouse.value='left';ui.modifiers.forEach(control=>control.checked=false);
    if(assignment?.kind==='key'&&usages.includes(assignment.usage)&&Array.isArray(assignment.modifiers)&&assignment.modifiers.every(name=>modifierNames.includes(name))){ui.action.value='keyboard';ui.usage.value=String(assignment.usage);ui.modifiers.forEach((control,index)=>control.checked=assignment.modifiers.includes(modifierNames[index]));}
    if(assignment?.kind==='consumer'&&Number.isInteger(assignment.usage)&&assignment.usage>=0&&assignment.usage<=65535){ui.consumer.value=String(assignment.usage);const known=media.some(([usage])=>usage===assignment.usage);ui.action.value=known?'media':'consumer';if(known)ui.media.value=String(assignment.usage);}
    if(assignment?.kind==='mouseButton'&&['left','right','middle','back','forward'].includes(assignment.button)){ui.action.value='mouseButton';ui.mouse.value=assignment.button;}
    editingId=profile?.id||'';editingLayer=layer;editingKey=ui.key.value;
    const cached=pendingBindings.get(bindingCacheKey());
    if(cached){ui.action.value=cached.action;ui.usage.value=cached.usage;ui.consumer.value=cached.consumer;ui.media.value=cached.media;ui.mouse.value=cached.mouse;ui.modifiers.forEach((control,index)=>control.checked=cached.modifiers[index]);mappingDirty=true;}
    ui.mappingState.textContent=cached?'此键保留着尚未更新到配置草稿的输入。':binding?(ui.action.value?'当前动作已载入。':'此键含只读的旧动作数据；只有明确选择新动作后才替换。'):official?'此键没有可投影的映射；原文件中的空记录或未知动作保持原样，选择新动作后才替换。':'此键尚无本地映射；选择动作后创建草稿。';
    showAction();sync();
  }
  function paintLighting(){
    if(!canLight()){lightingDirty=false;sync();return;}
    lightingDirty=false;
    ui.mode.textContent='当前模式 '+profile.lighting.modeId+'（模式保持不变）';ui.brightness.value=String(profile.lighting.brightnessCode);ui.speed.value=String(profile.lighting.speedCode);
    ui.brightnessValue.textContent=ui.brightness.value;ui.speedValue.textContent=ui.speed.value;
    ui.colors.forEach((control,index)=>control.value='#'+['r','g','b'].map(key=>profile.lighting.colors[index][key].toString(16).padStart(2,'0')).join(''));
    const cached=pendingLighting.get(lightingCacheKey());if(cached){ui.brightness.value=cached.brightness;ui.speed.value=cached.speed;ui.colors.forEach((control,index)=>control.value=cached.colors[index]);ui.brightnessValue.textContent=cached.brightness;ui.speedValue.textContent=cached.speed;lightingDirty=true;}sync();
  }
  function selectedAssignment(){
    const kind=ui.action.value;
    if(kind==='keyboard'){
      const usage=Number(ui.usage.value),selected=modifierNames.filter((_,index)=>ui.modifiers[index].checked);
      if(!usages.includes(usage)||usage===0&&!selected.length)throw Error('请选择一个有效 HID 键，或至少一个修饰键。');
      return {kind:'key',usage,modifiers:selected};
    }
    if(kind==='consumer'||kind==='media'){
      const raw=(kind==='media'?ui.media:ui.consumer).value,usage=Number(raw);
      if(raw.trim()===''||!Number.isInteger(usage)||usage<0||usage>65535)throw Error('Consumer Usage 必须为 0–65535 的整数。');return {kind:'consumer',usage};
    }
    if(kind==='mouseButton'){if(!['left','right','middle','back','forward'].includes(ui.mouse.value))throw Error('请选择有效鼠标键。');return {kind:'mouseButton',button:ui.mouse.value};}
    throw Error('请先明确选择要设置的动作类别。');
  }
  function commit(){
    if(!profile||profile.deviceId!==DEVICE||typeof onChange!=='function'||isBusy()||window.localLibrary?.isBusy?.())return;
    try{
      const next=clone(profile);
      if(mappingDirty){
        if(!Number.isInteger(layer)||layer<0||layer>3)throw Error('当前层无效，原配置已保留。');
        const assignment=selectedAssignment(),keyId=ui.key.value;
        if(!window.HUB_KEYBOARD_LAYOUT.keys.some(key=>key.id===keyId))throw Error('当前物理键未在官方布局中。');
        if(!Array.isArray(next.bindings))next.bindings=[];const matches=next.bindings.map((binding,index)=>({binding,index})).filter(item=>item.binding.layer===layer&&item.binding.keyId===keyId);
        if(matches.length>1)throw Error('当前键位存在重复映射，原配置已保留。');
        if(matches.length)next.bindings[matches[0].index]={...matches[0].binding,assignment};else next.bindings.push({layer,keyId,assignment});
      }
      if(lightingDirty&&canLight()){
        const mode=profile.lighting.modeId;
        if(ordinaryModes.has(mode)){next.lighting.brightnessCode=Number(ui.brightness.value);if(mode!==1)next.lighting.speedCode=Number(ui.speed.value);}
        if(paletteModes.has(mode))next.lighting.colors=ui.colors.map(control=>{const hex=control.value.slice(1);if(!/^[0-9a-f]{6}$/i.test(hex))throw Error('RGB 颜色无效。');return {r:parseInt(hex.slice(0,2),16),g:parseInt(hex.slice(2,4),16),b:parseInt(hex.slice(4,6),16)};});
      }
      if(JSON.stringify(next)===JSON.stringify(profile)){pendingBindings.delete(bindingCacheKey());pendingLighting.delete(lightingCacheKey());mappingDirty=false;lightingDirty=false;paintBinding();paintLighting();message('配置没有变化；未保存或应用设备。');return;}
      const currentRevision=revision,committedBindingKey=bindingCacheKey(),committedLightingKey=lightingCacheKey();onChange(clone(next));if(revision===currentRevision)profile=next;pendingBindings.delete(committedBindingKey);pendingLighting.delete(committedLightingKey);mappingDirty=false;lightingDirty=false;paintBinding();paintLighting();message('已更新配置草稿；尚未保存到本地库，也未应用设备。');
    }catch(error){message('草稿未更新：'+error.message,true);}
  }
  function mount(){
    if(host)return;const parent=document.getElementById('library-profile-note');if(!parent)return;
    host=node('div','aula-profile-editor');host.id='aula-profile-editor';host.append(node('h4','','AULA 配置内容'));
    ui.source=node('p','small-note');host.append(ui.source,node('p','small-note','设备应用未开放。'));
    const selectors=node('div','aula-profile-grid');ui.layer=select('aula-profile-layer',[[0,'默认层'],[1,'FN1 层'],[2,'FN2 层'],[3,'Tap 层']]);ui.key=select('aula-profile-key',(window.HUB_KEYBOARD_LAYOUT?.keys||[]).map(key=>[key.id,key.label+' · '+key.id]));
    ui.action=select('aula-profile-action',[['','选择动作'],['keyboard','普通键 / 修饰组合'],['media','多媒体'],['consumer','Consumer Usage'],['mouseButton','鼠标键']]);selectors.append(field('编辑层',ui.layer),field('物理键',ui.key),field('动作类别',ui.action));host.append(selectors);
    ui.mappingState=node('p','small-note');host.append(ui.mappingState);ui.groups={};
    const keyboard=node('div','aula-profile-action-fields');ui.usage=select('aula-profile-usage',[...new Set(usages)].map(usage=>[usage,usageLabel(usage)]));keyboard.append(field('HID 键',ui.usage));const modifierGroup=node('div','aula-profile-modifiers');ui.modifiers=modifierNames.map((name,index)=>{const control=node('input');control.type='checkbox';control.id='aula-profile-modifier-'+name;const label=node('label');label.append(control,node('span','',modifierLabels[index]));modifierGroup.append(label);return control;});keyboard.append(modifierGroup);ui.groups.keyboard=keyboard;
    const mediaGroup=node('div','aula-profile-action-fields');ui.media=select('aula-profile-media',media);mediaGroup.append(field('多媒体动作',ui.media));ui.groups.media=mediaGroup;
    const consumerGroup=node('div','aula-profile-action-fields');ui.consumer=node('input');ui.consumer.type='number';ui.consumer.id='aula-profile-consumer';ui.consumer.min='0';ui.consumer.max='65535';ui.consumer.step='1';consumerGroup.append(field('Consumer Usage',ui.consumer));ui.groups.consumer=consumerGroup;
    const mouse=node('div','aula-profile-action-fields');ui.mouse=select('aula-profile-mouse',[['left','左键'],['right','右键'],['middle','中键'],['back','后退键'],['forward','前进键']]);mouse.append(field('鼠标键',ui.mouse));ui.groups.mouseButton=mouse;
    for(const group of Object.values(ui.groups)){const mark=()=>{mappingDirty=true;message('有尚未更新的键位输入；配置草稿尚未更改。');};group.addEventListener('input',mark);group.addEventListener('change',mark);host.append(group);}
    ui.layer.addEventListener('change',()=>{layer=Number(ui.layer.value);paintBinding();});ui.key.addEventListener('change',paintBinding);ui.action.addEventListener('change',()=>{mappingDirty=Boolean(ui.action.value);if(!mappingDirty)pendingBindings.delete(bindingCacheKey());showAction();});
    const lighting=node('div','aula-profile-lighting');lighting.append(node('h4','','当前模式灯光'));ui.lightMissing=node('p','small-note','当前配置没有可编辑的已确认灯光数据。');ui.lightFields=node('div','aula-profile-light-fields');ui.mode=node('p','small-note');ui.lightHint=node('p','small-note');ui.lightFields.append(ui.mode);
    const ranges=node('div','aula-profile-grid');
    for(const [key,text]of [['brightness','亮度'],['speed','速度']]){const control=node('input');control.type='range';control.min='0';control.max='4';control.step='1';control.value='0';control.id='aula-profile-'+key;ui[key]=control;ui[key+'Value']=node('output','','0');const label=field(text,control);label.append(ui[key+'Value']);ranges.append(label);control.addEventListener('input',()=>{ui[key+'Value'].textContent=control.value;lightingDirty=true;});}
    ui.lightFields.append(ranges);const colors=node('div','aula-profile-colors');ui.colors=Array.from({length:7},(_,index)=>{const control=node('input');control.type='color';control.value='#000000';control.id='aula-profile-color-'+index;control.setAttribute('aria-label','配置颜色 '+(index+1));control.addEventListener('input',()=>lightingDirty=true);colors.append(field('颜色 '+(index+1),control));return control;});ui.lightFields.append(colors,ui.lightHint);
    const favorites=node('div','aula-profile-favorites');favorites.append(node('h5','','本地收藏色'));const favoriteControls=node('div','aula-profile-favorite-controls');ui.favoriteSlot=select('aula-profile-favorite-slot',Array.from({length:7},(_,index)=>[index,'颜色 '+(index+1)]));ui.favoriteName=node('input');ui.favoriteName.type='text';ui.favoriteName.id='aula-profile-favorite-name';ui.favoriteName.maxLength=60;ui.favoriteName.placeholder='收藏名称';ui.favoriteSave=node('button','secondary-button','收藏当前颜色');ui.favoriteSave.type='button';ui.favoriteSave.id='aula-profile-favorite-save';ui.favoriteSave.addEventListener('click',()=>void saveFavorite());favoriteControls.append(field('写入颜色',ui.favoriteSlot),field('名称',ui.favoriteName),ui.favoriteSave);ui.favoriteList=node('div','aula-profile-favorite-list');ui.favoriteList.id='aula-profile-favorite-list';ui.favoriteEmpty=node('p','small-note','尚无本地收藏色。');ui.favoriteStatus=node('p','small-note');ui.favoriteStatus.id='aula-profile-favorite-status';ui.favoriteStatus.setAttribute('role','status');ui.favoriteStatus.setAttribute('aria-live','polite');favorites.append(favoriteControls,ui.favoriteList,ui.favoriteEmpty,ui.favoriteStatus);ui.lightFields.append(favorites);lighting.append(ui.lightMissing,ui.lightFields);host.append(lighting);
    ui.update=node('button','secondary-button','更新配置草稿');ui.update.type='button';ui.update.id='aula-profile-update';ui.update.addEventListener('click',commit);ui.status=node('p','small-note');ui.status.id='aula-profile-editor-status';ui.status.setAttribute('role','status');ui.status.setAttribute('aria-live','polite');host.append(ui.update,ui.status);parent.append(host);sync();
  }
  window.aulaProfileEditor={
    init(options={}){onChange=typeof options.onChange==='function'?options.onChange:null;isBusy=typeof options.isBusy==='function'?options.isBusy:()=>false;mount();sync();},
    setProfile(value,options={}){
      stashBinding();stashLighting();if(profile?.id&&ui.key)views.set(profile.id,{layer,key:ui.key.value});
      const same=profile?.id&&value?.id===profile.id;revision++;try{profile=value&&value.deviceId===DEVICE?clone(value):null;}catch{profile=null;}
      official=options.officialSource===true;favoriteItems=[];paintFavorites();mount();if(!host)return;
      if(!same){const view=views.get(profile?.id);layer=view?.layer||0;ui.layer.value=String(layer);ui.key.value=view?.key||window.HUB_KEYBOARD_LAYOUT?.keys?.[0]?.id||'';}
      paintBinding();paintLighting();message(profile?(mappingDirty||lightingDirty?'保留尚未更新的输入；配置草稿尚未更改。':'本地配置已载入；设备应用未开放。'):'');if(profile)void refreshFavorites();
    },
    sync
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();
