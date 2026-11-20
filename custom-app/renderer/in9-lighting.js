'use strict';
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.In9LightingColors=api;
})(typeof window==='object'?window:null,function(){
  const reasons={
    2:'当前模式使用前七槽中已选且非黑的颜色；黑色按现有协议不加入颜色帧。',
    3:'当前模式只使用第一色，且原厂发送逻辑不使用其选中标记；其余槽只保存在本地 PSF。',
    6:'当前模式使用前七槽；未选中的槽按现有协议发送黑色。',
    7:'当前模式只使用前两色，未选中的槽发送黑色；其余槽只保存在本地 PSF。'
  };
  // Match the native parser's nonempty mode rows while keeping exact source offsets.
  function matrix(raw,color){
    if(typeof raw!=='string'||!raw.length||raw.length>8192||/[\r\n\0]/.test(raw))throw Error('颜色矩阵缺失、超长或含无效分隔字符。');
    const rows=[...raw.matchAll(/[^;]+/g)];
    if(rows.length!==10)throw Error('需要完整的十个模式行；不补齐或裁掉未知行。');
    return rows.map(row=>{
      const tokens=row[0].split('|');let offset=row.index;
      if(tokens.length!==10)throw Error('每个模式都需要完整十槽；不补齐或裁掉未知槽。');
      return tokens.map(token=>{
        const item={start:offset,end:offset+token.length,raw:token};offset=item.end+1;
        if(color){
          if(!/^[0-9a-f]{6}$/i.test(token))throw Error('颜色槽必须为完整六位 RRGGBB；未知颜色保持只读。');
          item.value='#'+token.toUpperCase();
        }else{
          if(!/^[\t ]*[0-9a-f]{1,2}[\t ]*$/i.test(token))throw Error('发现未知颜色选择标记；只接受明确的十六进制 0 或 1。');
          const value=parseInt(token.trim(),16);
          if(value!==0&&value!==1)throw Error('发现未知颜色选择标记；只接受明确的十六进制 0 或 1。');
          item.value=value===1;
        }
        return item;
      });
    });
  }
  function examine(fixedRaw,selectedRaw,mode){
    const view={editable:false,reason:'',colors:null,selected:null,preservedSlotCount:3,extraSelectedCount:0};
    try{
      if(!Number.isInteger(mode)||mode<0||mode>9)throw Error('需要明确的原始灯效模式编号 0 至 9。');
      const colorRows=matrix(fixedRaw,true),flagRows=matrix(selectedRaw,false);
      view.colors=colorRows[mode].slice(0,7).map(cell=>cell.value);
      view.selected=flagRows[mode].slice(0,7).map(cell=>cell.value);
      view.extraSelectedCount=flagRows[mode].slice(7).filter(cell=>cell.value).length;
      if(view.extraSelectedCount)throw Error('后三个保留槽仍有 '+view.extraSelectedCount+' 个选中色，超出七色编辑范围；保持只读，不裁剪原始选择。');
      if(!Object.hasOwn(reasons,mode))throw Error('此模式的现有发送路径不使用颜色矩阵，保持只读。');
      view.editable=true;view.reason=reasons[mode];
      return {view,colorRows,flagRows};
    }catch(error){view.reason=error.message;return {view};}
  }
  function getMode(fixedRaw,selectedRaw,mode){return examine(fixedRaw,selectedRaw,mode).view;}
  function replaceCells(raw,changes){
    for(const change of changes.sort((a,b)=>b.start-a.start))raw=raw.slice(0,change.start)+change.value+raw.slice(change.end);
    return raw;
  }
  function patchMode(fixedRaw,selectedRaw,mode,colors7,selected7){
    const result=examine(fixedRaw,selectedRaw,mode);
    if(!result.view.editable)throw Error(result.view.reason);
    if(!Array.isArray(colors7)||colors7.length!==7||Array.from(colors7).some(value=>typeof value!=='string'||!/^#[0-9a-f]{6}$/i.test(value)))throw Error('必须明确提供七个 #RRGGBB 颜色。');
    if(!Array.isArray(selected7)||selected7.length!==7||Array.from(selected7).some(value=>typeof value!=='boolean'))throw Error('必须明确提供七个布尔选择值。');
    const colorChanges=[],flagChanges=[];
    for(let i=0;i<7;i++){
      const color=result.colorRows[mode][i],flag=result.flagRows[mode][i];
      if(color.value!==colors7[i].toUpperCase())colorChanges.push({...color,value:colors7[i].slice(1).toUpperCase()});
      if(flag.value!==selected7[i])flagChanges.push({...flag,value:flag.raw.replace(/[0-9a-f]+/i,token=>(selected7[i]?'1':'0').padStart(token.length,'0'))});
    }
    return {fixedRaw:replaceCells(fixedRaw,colorChanges),selectedRaw:replaceCells(selectedRaw,flagChanges)};
  }
  return Object.freeze({getMode,patchMode});
});
