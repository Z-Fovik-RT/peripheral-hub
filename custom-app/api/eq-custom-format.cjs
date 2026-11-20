'use strict';
const MAX_TEXT=524288,MAX_ITEMS=244;
function invalid(message){const error=new Error('原厂EQ设定档无效：'+message);error.code='INVALID_ARGUMENT';return error;}
// Bounded JSON reader rejects duplicate (including case-variant) properties before
// JSON.parse could silently discard them. No deserialization of types or paths.
function uniqueJson(text){
 if(typeof text!=='string'||text.length>MAX_TEXT||Buffer.byteLength(text,'utf8')>1048576)throw invalid('文件超过1 MiB或文本上限。');
 text=text.replace(/^\uFEFF/,'');let at=0;
 const whitespace=()=>{while(/[\t\n\r ]/.test(text[at]||'~'))at++;};
 const string=()=>{const match=/"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;match.lastIndex=at;const found=match.exec(text);if(!found)throw invalid('字符串格式错误。');at=match.lastIndex;return JSON.parse(found[0]);};
 function value(depth){
  if(depth>8)throw invalid('内容嵌套过深。');whitespace();const token=text[at];
  if(token==='"')return string();
  if(token==='['){at++;whitespace();const result=[];if(text[at]===']'){at++;return result;}while(true){if(result.length>=1024)throw invalid('数组过长。');result.push(value(depth+1));whitespace();if(text[at]===']'){at++;return result;}if(text[at++]!==',')throw invalid('数组格式错误。');}}
  if(token==='{'){at++;whitespace();const result=Object.create(null),seen=new Set();if(text[at]==='}'){at++;return result;}while(true){whitespace();const key=string(),lower=key.toLowerCase();if(seen.has(lower))throw invalid('字段重复：'+key);seen.add(lower);whitespace();if(text[at++]!==':')throw invalid('对象格式错误。');result[key]=value(depth+1);whitespace();if(text[at]==='}'){at++;return result;}if(text[at++]!==',')throw invalid('对象格式错误。');}}
  for(const [literal,result]of [['true',true],['false',false],['null',null]])if(text.startsWith(literal,at)){at+=literal.length;return result;}
  const numeric=/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;numeric.lastIndex=at;const found=numeric.exec(text);if(!found)throw invalid('JSON格式错误。');at=numeric.lastIndex;return Number(found[0]);
 }
 const result=value(0);whitespace();if(at!==text.length)throw invalid('JSON末尾存在多余内容。');return result;
}
function validateEntry(entry,index){
 if(!entry||typeof entry!=='object'||Array.isArray(entry))throw invalid('第'+(index+1)+'项必须是对象。');
 const keys=Object.keys(entry),names=keys.map(key=>key.toLowerCase());
 if(keys.length!==2||!names.includes('name')||!names.includes('eqvalues'))throw invalid('每项只允许Name和EQValues字段。');
 const name=entry[keys[names.indexOf('name')]],bandsRaw=entry[keys[names.indexOf('eqvalues')]];
 if(typeof name!=='string'||name.length===0||name.length>128)throw invalid('第'+(index+1)+'项名称须为1至128字符。');
 if(!Array.isArray(bandsRaw)||bandsRaw.length!==10||bandsRaw.some(value=>!Number.isSafeInteger(value)||value< -20||value>20))throw invalid('第'+(index+1)+'项须有十段−20至20的整数增益。');
 return {name,bandsRaw:[...bandsRaw]};
}
function parseOfficial(text){
 const list=uniqueJson(text);if(!Array.isArray(list)||list.length>MAX_ITEMS)throw invalid('必须为最多244项的设定档列表。');
 return list.map(validateEntry);
}
function exportOfficial(presets){
 if(!Array.isArray(presets)||presets.length>MAX_ITEMS)throw invalid('设定档数量超出上限。');
 const rows=presets.map((preset,index)=>{const clean=validateEntry({Name:preset.name,EQValues:preset.bandsRaw},index);return {Name:clean.name,EQValues:clean.bandsRaw};});
 const content=JSON.stringify(rows,null,2)+'\n';if(content.length>MAX_TEXT||Buffer.byteLength(content,'utf8')>1048576)throw invalid('导出文件过大。');return content;
}
module.exports={parseOfficial,exportOfficial};
