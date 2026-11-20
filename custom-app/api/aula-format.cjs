'use strict';
const {createHash}=require('node:crypto');
const {TextDecoder,isDeepStrictEqual}=require('node:util');
const {validate}=require('./schema.cjs');
const profileSchema=require('./contracts/common.cjs').find(entry=>entry.id==='profiles.get').result;
const RECORD_BYTES=0x33FC,KEY_BASE=0x38,LAYER_BYTES=0x900,KEY_BYTES=16,NAME_OFFSET=8,NAME_BYTES=40,TAG=0xFCAA1245;
const matrixIndices=[0,12,18,24,30,36,42,48,54,60,66,72,78,1,7,13,19,25,31,37,43,49,55,61,67,73,79,84,90,96,2,8,14,20,26,32,38,44,50,56,62,68,74,80,86,85,91,97,3,9,15,21,27,33,39,45,51,57,63,69,81,92,98,4,10,16,22,28,34,40,46,52,58,64,82,94,83,5,11,17,35,53,59,65,89,95,101];
// Installed G5 virtual-key conversion table, independently covered against the saved PE evidence.
const vkPairs=[[226,100],[27,41],[112,58],[113,59],[114,60],[115,61],[116,62],[117,63],[118,64],[119,65],[120,66],[121,67],[122,68],[123,69],[65,4],[66,5],[67,6],[68,7],[69,8],[70,9],[71,10],[72,11],[73,12],[74,13],[75,14],[76,15],[77,16],[78,17],[79,18],[80,19],[81,20],[82,21],[83,22],[84,23],[85,24],[86,25],[87,26],[88,27],[89,28],[90,29],[49,30],[50,31],[51,32],[52,33],[53,34],[54,35],[55,36],[56,37],[57,38],[48,39],[9,43],[20,57],[13,40],[8,42],[32,44],[219,47],[221,48],[220,49],[186,51],[222,52],[188,54],[190,55],[191,56],[192,53],[187,46],[189,45],[44,70],[145,71],[19,72],[45,73],[36,74],[33,75],[46,76],[35,77],[34,78],[38,82],[40,81],[37,80],[39,79],[97,89],[98,90],[99,91],[100,92],[101,93],[102,94],[103,95],[104,96],[105,97],[96,98],[107,87],[109,86],[106,85],[111,84],[144,83],[253,88],[110,99],[162,224],[160,225],[164,226],[91,227],[163,228],[161,229],[165,230],[92,231],[93,101],[194,133],[193,135],[195,137],[216,50],[218,138],[215,136],[235,139]];
const vkToHid=new Map([[0,0],...vkPairs]),hidToVk=new Map([[0,0],...vkPairs.map(([vk,hid])=>[hid,vk])]);
const modifiers=['leftCtrl','leftShift','leftAlt','leftMeta','rightCtrl','rightShift','rightAlt','rightMeta'];
const mouseButtons=['left','right','middle','back','forward'];
const modeIds=[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,21,0];
const fail=(code,message)=>Object.assign(Error(message),{code});
const sha=buffer=>createHash('sha256').update(buffer).digest('hex');
const clone=value=>JSON.parse(JSON.stringify(value));
function nameAt(record){
 const raw=record.subarray(NAME_OFFSET,NAME_OFFSET+NAME_BYTES);let end=-1;
 for(let index=0;index<raw.length;index+=2)if(raw[index]===0&&raw[index+1]===0){end=index;break;}
 if(end<0)throw fail('UNSUPPORTED_FORMAT','Official profile name is not terminated within its 40-byte field.');
 let name;try{name=new TextDecoder('utf-16le',{fatal:true,ignoreBOM:true}).decode(raw.subarray(0,end));}catch{throw fail('UNSUPPORTED_FORMAT','Official profile name contains malformed UTF-16.');}
 if(!name.trim())throw fail('UNSUPPORTED_FORMAT','Official profile name is empty.');return name;
}
function assignmentFromWire(wire){
 if(wire[0]===0){
  if(wire[2]&&wire[3])return null;
  if(!wire[1]&&!wire[2]&&!wire[3])return null;
  return {kind:'key',usage:wire[3]||wire[2],modifiers:modifiers.filter((_,index)=>wire[1]&(1<<index))};
 }
 if(wire[0]===2&&wire[1]===0)return {kind:'consumer',usage:(wire[2]<<8)|wire[3]};
 if(wire[0]===1&&wire[1]>=1&&wire[1]<=5&&wire[2]===1&&wire[3]===0)return {kind:'mouseButton',button:mouseButtons[wire[1]-1]};
 return null;
}
function assignmentFromRecord(record){
 const header=record.readUInt32LE(0),kind=header>>>24;
 if(!header)return null;
 if(kind===2){
  const primary=record[5],secondary=record[6];
  if(primary>=1&&primary<=5)return assignmentFromWire(record.subarray(8,12));
  if(!vkToHid.has(primary)||!vkToHid.has(secondary))return null;
  return assignmentFromWire(Buffer.from([0,record[4],vkToHid.get(secondary),vkToHid.get(primary)]));
 }
 if(kind===9){const wire=Buffer.from(record.subarray(8,12));if((header&0xFFFFFF)!==0)wire.reverse();return assignmentFromWire(wire);}
 if(kind===1){const code=header&0xFFFFFF;if(code>=0x11&&code<=0x15)return {kind:'mouseButton',button:mouseButtons[code-0x11]};}
 return null;
}
function lightingAt(record){
 const modeIndex=record.readUInt32LE(0x243C);if(modeIndex>=modeIds.length)return null;
 const offset=0x2F88+modeIndex*36;if(record[offset]>4||record[offset+1]>4)return null;
 return {modeId:modeIds[modeIndex],brightnessCode:record[offset+1],speedCode:record[offset],colors:Array.from({length:7},(_,index)=>({r:record[offset+4+index*4],g:record[offset+5+index*4],b:record[offset+6+index*4]}))};
}
function parseOfficialDct(buffer){
 if(!Buffer.isBuffer(buffer)||buffer.length<4+RECORD_BYTES||buffer.length>4+128*RECORD_BYTES||(buffer.length-4)%RECORD_BYTES!==0)throw fail('UNSUPPORTED_FORMAT','Expected the official active-ID header followed by exact 0x33FC-byte AULA profile records.');
 const contentHash=sha(buffer),activeProfileId=buffer.readUInt32LE(0),profiles=[],ids=new Set();
 for(let index=0;index<(buffer.length-4)/RECORD_BYTES;index++){
  const record=buffer.subarray(4+index*RECORD_BYTES,4+(index+1)*RECORD_BYTES),officialId=record.readUInt32LE(4);
  if(record.readUInt32LE(0)!==TAG||officialId===0||ids.has(officialId))throw fail('UNSUPPORTED_FORMAT','Official DCT record tag/ID is invalid or duplicated.');ids.add(officialId);
  // This identifies the supported layout, not physical hardware identity or a recovery baseline.
  if(matrixIndices.some((matrixIndex,key)=>record[KEY_BASE+key*KEY_BYTES+12]!==matrixIndex||record[KEY_BASE+key*KEY_BYTES+13]!==matrixIndex))throw fail('UNSUPPORTED_FORMAT','Official DCT does not carry the supported F87 PRO 87-key layout signature.');
  const name=nameAt(record),bindings=[],opaqueBindings=[],warnings=[];let opaque=0,empty=0;
  for(let layer=0;layer<4;layer++)for(let key=0;key<87;key++){
   const offset=KEY_BASE+layer*LAYER_BYTES+key*KEY_BYTES,raw=record.subarray(offset,offset+KEY_BYTES),assignment=assignmentFromRecord(raw);
   if(assignment)bindings.push({layer,keyId:'K'+(key+1),assignment});else if(raw.readUInt32LE(0)){opaque++;opaqueBindings.push({layer,keyId:'K'+(key+1),rawHex:raw.toString('hex').toUpperCase(),byteOffset:4+index*RECORD_BYTES+offset});}else empty++;
  }
  if(opaque)warnings.push(opaque+' nonempty physical-key records contain special, Fn, two-key or unresolved macro actions; their exact bytes stay in the original DCT and are not invented as empty mappings.');
  if(empty)warnings.push(empty+' zero-header physical-key records are preserved without assuming whether the firmware treats them as disabled or inherited.');
  warnings.push('Only the 87 physical keys across four layers are projected; the remaining 57 slots per layer and all other unknown bytes remain in the source DCT. This local file is not a hardware snapshot.');
  const lighting=lightingAt(record),profile={schemaVersion:1,id:'aula-dct-'+contentHash.slice(0,16)+'-'+index,name,deviceId:'aula-f87-pro',bindings,macroIds:[]};
  if(lighting)profile.lighting=lighting;else warnings.push('The selected lighting-mode record has unknown fields; no lighting values were fabricated.');
  validate(profileSchema,profile,'officialProfile');profiles.push({index,officialId,name,profile,warnings,opaqueBindings});
 }
 return {activeProfileId,profiles,...(!ids.has(activeProfileId)?{warnings:['The active ID does not identify a stored record; no active record was assumed.']}:{})};
}
function semanticAssignment(assignment){
 if(assignment.kind==='key')return {kind:'key',usage:assignment.usage,modifiers:[...assignment.modifiers].sort()};return assignment;
}
function encodeAssignment(output,offset,assignment){
 if(assignment.kind==='key'){
  if(!hidToVk.has(assignment.usage)||new Set(assignment.modifiers).size!==assignment.modifiers.length)throw fail('UNSUPPORTED_FORMAT','The requested HID usage/modifier combination has no exact official G5 conversion.');
  const mask=assignment.modifiers.reduce((value,name)=>value|(1<<modifiers.indexOf(name)),0);
  if(assignment.usage===0&&mask===0)throw fail('UNSUPPORTED_FORMAT','An empty key action cannot be assumed to mean disable or inherit.');
  output.writeUInt32LE(0x02000000,offset);output[offset+4]=mask;output[offset+5]=hidToVk.get(assignment.usage);output[offset+6]=0;return;
 }
 if(assignment.kind==='consumer'){
  // Installed type9/selector1 is the exact endian-conversion path used by real FN1 records.
  output.writeUInt32LE(0x09000001,offset);Buffer.from([assignment.usage&255,assignment.usage>>>8,0,2]).copy(output,offset+8);return;
 }
 if(assignment.kind==='mouseButton'){
  const button=mouseButtons.indexOf(assignment.button);if(button<0)throw fail('UNSUPPORTED_FORMAT','Unknown mouse button.');
  output.writeUInt32LE((0x01000000|0x11+button)>>>0,offset);return;
 }
 throw fail('UNSUPPORTED_FORMAT','This assignment cannot be exported exactly to the proven official DCT fields: '+assignment.kind);
}
function patchOfficialDct(buffer,recordIndex,profile){
 const parsed=parseOfficialDct(buffer);
 if(!Number.isInteger(recordIndex)||recordIndex<0||recordIndex>=parsed.profiles.length)throw fail('INVALID_ARGUMENT','Official DCT record index is outside the file.');
 validate(profileSchema,profile,'profile');if(profile.deviceId!=='aula-f87-pro')throw fail('INVALID_ARGUMENT','Official DCT belongs to AULA F87 PRO.');
 const name=profile.name;
 if(!name.trim()||name.length>19||name.includes('\0'))throw fail('UNSUPPORTED_FORMAT','The official profile name permits at most 19 UTF-16 code units and no NUL.');
 const encodedName=Buffer.from(name,'utf16le');try{if(new TextDecoder('utf-16le',{fatal:true,ignoreBOM:true}).decode(encodedName)!==name)throw Error();}catch{throw fail('INVALID_ARGUMENT','Profile name contains malformed UTF-16.');}
 for(const key of ['macroIds','dpiStages','audioEqRaw'])if(profile[key]?.length)throw fail('UNSUPPORTED_FORMAT','No exact official DCT export is proven for nonempty '+key+'.');
 const baseline=parsed.profiles[recordIndex].profile,output=Buffer.from(buffer),recordOffset=4+recordIndex*RECORD_BYTES;
 if(name!==baseline.name){output.fill(0,recordOffset+NAME_OFFSET,recordOffset+NAME_OFFSET+NAME_BYTES);encodedName.copy(output,recordOffset+NAME_OFFSET);}
 const originalBindings=new Map(baseline.bindings.map(binding=>[binding.layer+':'+binding.keyId,binding.assignment])),desired=new Map();
 for(const binding of profile.bindings||[]){
  const number=Number(binding.keyId.slice(1));if(!Number.isInteger(number)||binding.keyId!=='K'+number||number<1||number>87)throw fail('UNSUPPORTED_FORMAT','Only the official 87 physical key IDs can be exported.');
  const key=binding.layer+':'+binding.keyId;if(desired.has(key))throw fail('INVALID_ARGUMENT','Duplicate physical key/layer binding.');desired.set(key,binding.assignment);
  const previous=originalBindings.get(key);if(previous&&isDeepStrictEqual(semanticAssignment(previous),semanticAssignment(binding.assignment)))continue;
  encodeAssignment(output,recordOffset+KEY_BASE+binding.layer*LAYER_BYTES+(number-1)*KEY_BYTES,binding.assignment);
 }
 for(const key of originalBindings.keys())if(!desired.has(key))throw fail('UNSUPPORTED_FORMAT','Removing a known binding has no proven default/inherit representation: '+key);
 if(Boolean(profile.lighting)!==Boolean(baseline.lighting))throw fail('UNSUPPORTED_FORMAT','Adding or removing an unknown lighting state is not an exact DCT edit.');
 if(profile.lighting){
  const before=baseline.lighting,after=profile.lighting;
  if(after.modeId!==before.modeId)throw fail('UNSUPPORTED_FORMAT','Changing official mode selectors needs additional evidence; the original mode is preserved.');
  if(!Number.isInteger(after.speedCode)||after.speedCode<0||after.speedCode>4||!Number.isInteger(after.brightnessCode)||after.brightnessCode<0||after.brightnessCode>4||!Array.isArray(after.colors)||after.colors.length!==7)throw fail('UNSUPPORTED_FORMAT','Official selected-mode export requires speed/brightness codes 0..4 and all seven RGB colors.');
  const offset=recordOffset+0x2F88+modeIds.indexOf(before.modeId)*36;output[offset]=after.speedCode;output[offset+1]=after.brightnessCode;
  after.colors.forEach((color,index)=>{output[offset+4+index*4]=color.r;output[offset+5+index*4]=color.g;output[offset+6+index*4]=color.b;});
 }
 return output;
}
module.exports={parseOfficialDct,patchOfficialDct};
