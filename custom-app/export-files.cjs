'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
const MAX_BYTES=2*1024*1024;
function validateExport(request){
 if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).sort().join(',')!=='contentBase64,format,suggestedName')throw Error('Invalid export request.');
 const {format,suggestedName,contentBase64}=request;
 if(!['psf','json','dct'].includes(format)||typeof suggestedName!=='string'||suggestedName.length>200||typeof contentBase64!=='string'||contentBase64.length<4||contentBase64.length>4*Math.ceil(MAX_BYTES/3)||!/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64))throw Error('Invalid export content or format.');
 const bytes=Buffer.from(contentBase64,'base64');if(!bytes.length||bytes.length>MAX_BYTES||bytes.toString('base64')!==contentBase64)throw Error('Invalid export encoding.');
 if(format==='psf'&&bytes.length>1048576)throw Error('PSF export exceeds1MiB.');
 if(format==='dct')require('./api/aula-format.cjs').parseOfficialDct(bytes);
 if(format==='json'){const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);JSON.parse(text);}
 let name=path.win32.basename(suggestedName).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').replace(/\.(?:json|psf|dct)$/i,'').slice(0,120)||'peripheral-hub-export';
 if(/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name))name='export-'+name;
 return {bytes,format,fileName:name+'.'+format};
}
function createExportSaver({choosePath}){
 if(typeof choosePath!=='function')throw Error('Export save dialog is required.');
 return async request=>{
  const {bytes,format,fileName}=validateExport(request),selection=await choosePath({fileName,format});
  if(selection.canceled||!selection.filePath)return {saved:false,canceled:true,fileName,byteLength:0};
  const target=path.resolve(selection.filePath),temporary=path.join(path.dirname(target),'.hub-export-'+randomUUID()+'.tmp');let handle;
  try{handle=await fs.open(temporary,'wx');await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;await fs.rename(temporary,target);}
  finally{if(handle)await handle.close();await fs.rm(temporary,{force:true});}
  return {saved:true,canceled:false,fileName:path.basename(target),byteLength:bytes.length};
 };
}
module.exports={validateExport,createExportSaver};
