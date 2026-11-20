'use strict';
// JSON Schema subset used for both runtime validation and generated TypeScript.
const S={
 string:(maxLength=256)=>({type:'string',minLength:1,maxLength}),
 text:(maxLength=65536)=>({type:'string',maxLength}),
 int:(minimum,maximum)=>({type:'integer',...(minimum===undefined?{}:{minimum}),...(maximum===undefined?{}:{maximum})}),
 num:(minimum,maximum)=>({type:'number',...(minimum===undefined?{}:{minimum}),...(maximum===undefined?{}:{maximum})}),
 bool:{type:'boolean'},
 enum:values=>({enum:values}),
 array:(items,minItems=0,maxItems=1024)=>({type:'array',items,minItems,maxItems}),
 obj:(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false}),
 union:(...anyOf)=>({anyOf}),
 nullable:schema=>({anyOf:[schema,{type:'null'}]})
};
S.empty=S.obj({});
function validate(schema,value,path='$',depth=0){
 if(depth>40)throw new Error(path+': nesting limit exceeded');
 if(schema.anyOf){if(schema.anyOf.some(s=>{try{validate(s,value,path,depth+1);return true;}catch{return false;}}))return;throw new Error(path+': no matching allowed shape');}
 if(schema.enum){if(!schema.enum.some(v=>v===value))throw new Error(path+': value is not in the allowed list');return;}
 if(schema.type==='null'){if(value!==null)throw new Error(path+': expected null');return;}
 if(schema.type==='object'){
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new Error(path+': expected a plain object');
  for(const key of Object.keys(value))if(!Object.hasOwn(schema.properties,key))throw new Error(path+'.'+key+': unexpected field');
  for(const key of schema.required||[])if(!Object.hasOwn(value,key))throw new Error(path+'.'+key+': required');
  for(const [key,item]of Object.entries(value))validate(schema.properties[key],item,path+'.'+key,depth+1);
 }else if(schema.type==='array'){
  if(!Array.isArray(value)||value.length<schema.minItems||value.length>schema.maxItems)throw new Error(path+': invalid array length');
  for(let i=0;i<value.length;i++)validate(schema.items,value[i],path+'['+i+']',depth+1);
 }else if(schema.type==='string'){
  if(typeof value!=='string'||value.length<(schema.minLength||0)||value.length>schema.maxLength)throw new Error(path+': invalid string length');
 }else if(schema.type==='boolean'){
  if(typeof value!=='boolean')throw new Error(path+': expected boolean');
 }else if(schema.type==='integer'||schema.type==='number'){
  if(typeof value!=='number'||!Number.isFinite(value)||(schema.type==='integer'&&!Number.isSafeInteger(value))||(schema.minimum!==undefined&&value<schema.minimum)||(schema.maximum!==undefined&&value>schema.maximum))throw new Error(path+': number outside allowed range');
 }else throw new Error(path+': unknown schema type');
}
module.exports={S,validate};
