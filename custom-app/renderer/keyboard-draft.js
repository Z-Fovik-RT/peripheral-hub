'use strict';
(() => {
  const DEVICE='aula-f87-pro',modes=[1,2,4,5,7,8,10,11,12,13],matrices=new Map();
  let deviceId='',palette=null,mounted=false,busy=false,layer=0;
  const ui={};
  const node=(tag,className,text)=>{const value=document.createElement(tag);if(className)value.className=className;if(text!==undefined)value.textContent=text;return value;};
  const bytes=content=>{if(typeof content!=='string'||!content.length||content.length>684||! /^[A-Za-z0-9+/]+={0,2}$/.test(content)||content.length%4)throw Error('原始数据不是有效的 Base64。');const raw=atob(content),result=Uint8Array.from(raw,char=>char.charCodeAt(0));if(btoa(raw)!==content)throw Error('原始 Base64 格式不规范。');return result;};
  const encode=data=>btoa(String.fromCharCode(...data));
  const digest=async data=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),value=>value.toString(16).padStart(2,'0')).join('').toUpperCase();
  const changes=(before,after)=>Array.from(after,(_,index)=>index).filter(index=>before[index]!==after[index]);
  const selected=kind=>kind==='matrix'?matrices.get(layer):palette;
  const message=(kind,text,error=false)=>{if(!ui[kind])return;ui[kind].status.textContent=text;ui[kind].status.dataset.error=String(error);};
  function validateBlock(data,kind){
    if(![kind==='matrix'?504:490,512].includes(data.length))throw Error(kind==='matrix'?'矩阵文件必须恰好为 504 或 512 字节。':'色板文件必须恰好为 490 或 512 字节。');
    if(data.length===512&&(kind==='matrix'?data[508]!==0||data[509]!==0||data[510]!==0x5A||data[511]!==0xA5:data[506]!==0x5A||data[507]!==0xA5))throw Error('完整 512 字节块缺少对应标记；保留原草稿。');
  }
  function install(kind,content,label,targetLayer=layer,confirmed=false){
    const raw=bytes(content);validateBlock(raw,kind);
    const existing=kind==='matrix'?matrices.get(targetLayer):palette;
    const next={baseline:content,content,label,pending:null};
    if(existing?.content===content){message(kind,'新来源字节与当前草稿一致；已保留当前编辑。');return true;}
    if(existing&&(existing.content!==existing.baseline||existing.formDirty)&&existing.content!==content&&!confirmed){
      existing.pending=next;
      message(kind,'收到新来源；当前草稿有修改，未覆盖。采用新来源会替换'+(kind==='matrix'?'此层':'色板')+'草稿。');
      sync();return false;
    }
    if(kind==='matrix')matrices.set(targetLayer,next);else palette=next;
    if(kind==='matrix'&&targetLayer!==layer){message(kind,'已保留第 '+targetLayer+' 层来源；当前层未更改。');sync();return true;}
    paint(kind);message(kind,'已载入'+label+'；仅本地编辑，未发送设备。');return true;
  }
  function currentKey(){return window.HUB_KEYBOARD_LAYOUT?.keys?.find(key=>key.id===ui.matrix.key.value);}
  function sync(){
    if(!mounted)return;
    for(const kind of ['matrix','palette']){
      const panel=ui[kind],entry=selected(kind);panel.details.hidden=deviceId!==DEVICE;panel.details.setAttribute('aria-busy',String(busy));
      for(const input of panel.details.querySelectorAll('input,select,button'))input.disabled=busy||deviceId!==DEVICE;
      panel.apply.disabled=busy||deviceId!==DEVICE||!entry;panel.export.disabled=busy||deviceId!==DEVICE||!entry;
      panel.replace.hidden=!entry?.pending;panel.replace.disabled=busy||!entry?.pending;
      panel.source.textContent=entry?entry.label+' · '+bytes(entry.content).length+' 字节 · '+(entry.content===entry.baseline?'尚无修改':'存在本地修改'):'等待导入原始 .bin 或手动读取设备';
    }
  }
  function paint(kind){
    if(!mounted)return;const entry=selected(kind);
    if(kind==='matrix'){
      const key=currentKey(),data=entry?bytes(entry.content):null,offset=key?.matrixIndex*4;
      ui.matrix.raw.textContent=data&&key?Array.from(data.slice(offset,offset+4),value=>value.toString(16).padStart(2,'0')).join(' ').toUpperCase():'尚无此层原始记录';
      if(data&&key){ui.matrix.modifiers.value=data[offset+1];ui.matrix.primary.value=data[offset+3];ui.matrix.secondary.value=data[offset+2];ui.matrix.consumer.value=(data[offset+2]<<8)|data[offset+3];}
    }else{
      const data=entry?bytes(entry.content):null,mode=Number(ui.palette.mode.value);
      ui.palette.colors.forEach((input,index)=>{const offset=21*mode+index*3;input.value=data?'#'+Array.from(data.slice(offset,offset+3),value=>value.toString(16).padStart(2,'0')).join(''):'#000000';});
    }
    sync();
  }
  function integer(input,min,max,label){const value=Number(input.value);if(input.value.trim()===''||!Number.isInteger(value)||value<min||value>max)throw Error(label+'超出可用范围。');return value;}
  async function patch(kind,change){
    const entry=selected(kind);if(busy||!entry||deviceId!==DEVICE)return false;
    busy=true;sync();message(kind,'正在校验本地草稿…');
    try{
      const before=bytes(entry.content),source=entry.content,result=await window.hub.features.invoke({apiVersion:1,deviceId:DEVICE,operation:'keyboard.draft.patch',args:{contentBase64:source,patch:change}});
      if(!result?.ok)throw Error(result?.error?.message||'本地草稿服务未返回成功。');
      const data=result.data,after=bytes(data?.contentBase64),offset=kind==='matrix'?window.HUB_KEYBOARD_LAYOUT.keys.find(key=>key.id===change.keyId).matrixIndex*4:21*change.modeId+change.colorIndex*3;
      const actual=changes(before,after),allowed=kind==='matrix'?4:3;
      const expected=change.kind==='keyboard'?[0,change.modifiers,change.secondaryUsage,change.primaryUsage]:change.kind==='consumer'?[2,0,change.consumerUsage>>8,change.consumerUsage&255]:[change.r,change.g,change.b];
      if(data.source!=='local-draft'||data.hardwareIO!==false||data.writeBaselineEligible!==false||data.blockKind!==kind||data.layer!==(kind==='matrix'?change.layer:null)||data.actualLength!==before.length||after.length!==before.length||data.completeBlockProvided!==(before.length===512)||data.originalSha256!==await digest(before)||data.sha256!==await digest(after)||JSON.stringify(data.changedOffsets)!==JSON.stringify(actual)||actual.some(index=>index<offset||index>=offset+allowed)||expected.some((value,index)=>after[offset+index]!==value))throw Error('草稿返回值越界或来源校验失败；原草稿已保留。');
      if(selected(kind)!==entry||entry.content!==source)throw Error('来源已经变化，忽略迟到结果。');
      entry.content=data.contentBase64;entry.formDirty=false;paint(kind);message(kind,'本地校验完成，修改 '+actual.length+' 个字节；未发送设备，尚不能作为恢复基线。');return true;
    }catch(error){message(kind,'编辑未完成：'+error.message,true);return false;}
    finally{busy=false;sync();}
  }
  async function exportDraft(kind){
    const entry=selected(kind);if(!entry||busy)return;
    try{
      const content=bytes(entry.content),original=bytes(entry.baseline),record={schemaVersion:1,deviceId:DEVICE,source:'local-draft',blockKind:kind,layer:kind==='matrix'?layer:null,sourceLabel:entry.label,actualLength:content.length,contentBase64:entry.content,baselineBase64:entry.baseline,sha256:await digest(content),originalSha256:await digest(original),changedOffsets:changes(original,content),hardwareIO:false,writeBaselineEligible:false};
      const url=URL.createObjectURL(new Blob([JSON.stringify(record,null,2)],{type:'application/json'})),anchor=node('a');anchor.href=url;anchor.download='aula-'+kind+(kind==='matrix'?'-layer'+layer:'')+'-draft.json';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      message(kind,'已导出 JSON 草稿；其中包含原始字节和修改后字节，未发送设备。');
    }catch(error){message(kind,'导出失败：'+error.message,true);}
  }
  function field(labelText,control){const label=node('label','aula-draft-field');label.append(node('span','',labelText),control);return label;}
  function number(id,min,max,value=0){const input=node('input');input.type='number';input.id=id;input.min=String(min);input.max=String(max);input.step='1';input.value=String(value);return input;}
  function select(id,options){const input=node('select');input.id=id;for(const [value,label]of options){const option=node('option','',label);option.value=String(value);input.append(option);}return input;}
  function button(id,text,action){const input=node('button','secondary-button',text);input.type='button';input.id=id;input.addEventListener('click',action);return input;}
  function panel(kind,title,host){
    const details=node('details','aula-draft');details.id='aula-draft-'+kind;details.append(node('summary','',title));
    const body=node('div','aula-draft-body'),source=node('p','source-label'),status=node('p','small-note');status.id='aula-draft-'+kind+'-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    body.append(node('p','small-note','本地原始字节草稿。设备实际返回长度会原样保留；完整块也不代表四层快照、设备身份或恢复能力已验证。'),source);
    const file=node('input');file.type='file';file.accept='.bin';file.id='aula-draft-'+kind+'-file';
    file.addEventListener('change',()=>void(async()=>{const selectedFile=file.files?.[0],targetLayer=layer;if(!selectedFile||busy)return;try{if(!/\.bin$/i.test(selectedFile.name))throw Error('请选择原始 .bin 文件。');if(![kind==='matrix'?504:490,512].includes(selectedFile.size))throw Error('原始块长度不符；未覆盖已有草稿。');install(kind,encode(new Uint8Array(await selectedFile.arrayBuffer())),'导入文件：'+selectedFile.name,targetLayer);}catch(error){message(kind,'导入失败：'+error.message,true);}finally{file.value='';}})());
    body.append(field('导入原始 .bin',file));
    const replace=button('aula-draft-'+kind+'-replace','采用新来源（替换当前草稿）',()=>{const entry=selected(kind);if(!busy&&entry?.pending)install(kind,entry.pending.content,entry.pending.label,layer,true);});replace.hidden=true;body.append(replace);
    const result={details,body,source,status,file,replace};details.append(body);host.append(details);ui[kind]=result;return result;
  }
  function mount(){
    if(mounted)return;const keys=document.getElementById('page-keys'),lighting=document.getElementById('page-lighting');if(!keys||!lighting)return;
    const matrix=panel('matrix','四层按键原始草稿',keys),palettePanel=panel('palette','七色 RGB 原始草稿',lighting),layout=window.HUB_KEYBOARD_LAYOUT?.keys||[];
    matrix.layer=select('aula-draft-layer',[[0,'默认层'],[1,'FN1 层'],[2,'FN2 层'],[3,'Tap 层']]);matrix.layer.addEventListener('change',()=>{layer=Number(matrix.layer.value);paint('matrix');message('matrix','已切换本地层草稿；没有读取或发送设备。');});
    matrix.key=select('aula-draft-key',layout.map(key=>[key.id,key.label+' · '+key.id]));matrix.key.addEventListener('change',()=>paint('matrix'));
    matrix.kind=select('aula-draft-action',[['keyboard','键盘键 / 组合键'],['consumer','多媒体 Consumer']]);
    const selectors=node('div','aula-draft-grid');selectors.append(field('编辑层',matrix.layer),field('物理按键',matrix.key),field('动作类别',matrix.kind));matrix.body.append(selectors);
    matrix.raw=node('code','aula-draft-raw');matrix.body.append(matrix.raw);
    const keyboard=node('div','aula-draft-grid'),consumer=node('div','aula-draft-grid');
    matrix.modifiers=number('aula-draft-modifiers',0,255);matrix.primary=number('aula-draft-primary',0,255,4);matrix.secondary=number('aula-draft-secondary',0,255);
    keyboard.append(field('修饰键位掩码 0–255',matrix.modifiers),field('主键 HID Usage 0–255',matrix.primary),field('副键 HID Usage 0–255',matrix.secondary));
    matrix.consumer=number('aula-draft-consumer',0,65535,233);consumer.append(field('Consumer Usage 0–65535',matrix.consumer));
    function showAction(){keyboard.hidden=matrix.kind.value!=='keyboard';consumer.hidden=matrix.kind.value!=='consumer';}matrix.kind.addEventListener('change',showAction);showAction();
    for(const group of [keyboard,consumer])group.addEventListener('input',()=>{const entry=selected('matrix');if(entry)entry.formDirty=true;});
    matrix.body.append(keyboard,consumer,node('p','small-note','普通键格式 00 / 修饰位 / 副键 / 主键。'));
    matrix.apply=button('aula-draft-matrix-apply','校验并更新本地草稿',()=>{try{const kind=matrix.kind.value,change={kind,layer,keyId:matrix.key.value};if(kind==='keyboard')Object.assign(change,{modifiers:integer(matrix.modifiers,0,255,'修饰位'),primaryUsage:integer(matrix.primary,0,255,'主键'),secondaryUsage:integer(matrix.secondary,0,255,'副键')});if(kind==='consumer')change.consumerUsage=integer(matrix.consumer,0,65535,'Consumer Usage');void patch('matrix',change);}catch(error){message('matrix',error.message,true);}});
    matrix.export=button('aula-draft-matrix-export','导出 JSON 草稿',()=>void exportDraft('matrix'));const matrixActions=node('div','aula-draft-actions');matrixActions.append(matrix.apply,matrix.export);matrix.body.append(matrixActions,matrix.status);
    palettePanel.mode=select('aula-draft-palette-mode',modes.map(mode=>[mode,'模式 '+mode]));palettePanel.mode.addEventListener('change',()=>paint('palette'));palettePanel.body.append(field('编辑模式（不切换设备灯效）',palettePanel.mode));
    const colors=node('div','aula-draft-colors');palettePanel.colors=Array.from({length:7},(_,index)=>{const color=node('input');color.type='color';color.value='#000000';color.id='aula-draft-palette-color-'+index;color.setAttribute('aria-label','草稿颜色 '+(index+1));color.addEventListener('input',()=>{const entry=selected('palette');if(entry)entry.formDirty=true;});colors.append(field('颜色 '+(index+1),color));return color;});
    palettePanel.body.append(colors);
    palettePanel.apply=button('aula-draft-palette-apply','校验并更新七色草稿',()=>void(async()=>{
      const entry=selected('palette');if(!entry||busy)return;
      const modeId=Number(palettePanel.mode.value),before=bytes(entry.content),updates=palettePanel.colors.map((input,colorIndex)=>{const hex=input.value.slice(1);return {kind:'palette',modeId,colorIndex,r:parseInt(hex.slice(0,2),16),g:parseInt(hex.slice(2,4),16),b:parseInt(hex.slice(4,6),16)};}).filter(change=>{const offset=21*modeId+change.colorIndex*3;return before[offset]!==change.r||before[offset+1]!==change.g||before[offset+2]!==change.b;});
      if(!updates.length){message('palette','七个颜色与当前草稿一致；未发送设备。');return;}
      for(const update of updates)if(!await patch('palette',update))return;
      message('palette','七色草稿已校验，更新 '+updates.length+' 个颜色；未发送设备。');
    })());
    palettePanel.export=button('aula-draft-palette-export','导出 JSON 草稿',()=>void exportDraft('palette'));const paletteActions=node('div','aula-draft-actions');paletteActions.append(palettePanel.apply,palettePanel.export);palettePanel.body.append(paletteActions,palettePanel.status);
    mounted=true;paint('matrix');paint('palette');
  }
  function captureMatrix(data){
    try{
      if(!data||!Number.isInteger(data.layer)||data.layer<0||data.layer>3||![504,512].includes(data.actualLength)||data.blockComplete!==(data.actualLength===512)||data.matrixComplete!==false||data.writeBaselineEligible!==false||typeof data.rawContentBase64!=='string')throw Error('实际矩阵来源长度或恢复状态无效，不能创建原始字节草稿。');
      const raw=bytes(data.rawContentBase64);
      if(raw.length!==data.actualLength)throw Error('矩阵原始字节与实际长度不一致。');
      return install('matrix',encode(raw),'硬件已捕获'+data.actualLength+'字节 · 第 '+data.layer+' 层',data.layer);
    }catch(error){message('matrix',error.message,true);return false;}
  }
  function capturePalette(data){
    try{
      if(!data||![490,512].includes(data.actualLength)||data.blockComplete!==(data.actualLength===512)||data.writeBaselineEligible!==false||typeof data.rawContentBase64!=='string'||bytes(data.rawContentBase64).length!==data.actualLength)throw Error('没有与实际长度一致的原始色板；七个颜色值只读，不补造其余数据。');
      return install('palette',data.rawContentBase64,'硬件已捕获 '+data.actualLength+' 字节');
    }catch(error){message('palette',error.message,true);return false;}
  }
  window.keyboardDrafts={captureMatrix,capturePalette,setDevice(value){deviceId=typeof value==='string'?value:value?.id||'';mount();sync();},isBusy:()=>busy};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();
