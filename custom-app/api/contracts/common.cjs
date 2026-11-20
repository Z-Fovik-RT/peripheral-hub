'use strict';
const {S}=require('../schema.cjs');
const keyboard='aula-f87-pro',mouse='inphic-in9',headset='ikf-v11-pro-71';
const input=[keyboard,mouse],all=[...input,headset];
const text=S.text(2048),id=S.string(128),name=S.string(60);
const endpoint=S.obj({id:S.string(2048),name:S.text(1024),flow:S.enum(['render','capture']),volume:S.num(0,100),muted:S.bool});
const rgb=S.obj({r:S.int(0,255),g:S.int(0,255),b:S.int(0,255)});
const assignment=S.union(
 S.obj({kind:S.enum(['none','default'])}),
 S.obj({kind:S.enum(['key']),usage:S.int(0,65535),modifiers:S.array(S.enum(['leftCtrl','leftShift','leftAlt','leftMeta','rightCtrl','rightShift','rightAlt','rightMeta']),0,8)}),
 S.obj({kind:S.enum(['consumer']),usage:S.int(0,65535)}),
 S.obj({kind:S.enum(['mouseButton']),button:S.enum(['left','right','middle','back','forward'])}),
 S.obj({kind:S.enum(['command']),command:S.enum(['dpiUp','dpiDown','dpiCycle','dpiLock','lightingCycle','pollingCycle','wheelUp','wheelDown','wheelLeft','wheelRight','doubleClick','lockWin'])}),
 S.obj({kind:S.enum(['macro']),macroId:id,repeat:S.obj({mode:S.enum(['once','count','whileHeld','toggle']),count:S.int(1,65535)},['mode'])})
);
const event=S.union(
 S.obj({kind:S.enum(['keyDown','keyUp','consumerDown','consumerUp']),code:S.int(0,65535)}),
 S.obj({kind:S.enum(['mouseDown','mouseUp']),button:S.enum(['left','right','middle','back','forward'])}),
 S.obj({kind:S.enum(['delay']),duration:S.int(0,1048575),unit:S.enum(['milliseconds','deviceTicks'])}),
 S.obj({kind:S.enum(['move']),x:S.int(-32768,32767),y:S.int(-32768,32767)}),
 S.obj({kind:S.enum(['wheel']),vertical:S.int(-127,127),horizontal:S.int(-127,127)})
);
const macro=S.obj({id,name,folderId:S.nullable(id),events:S.array(event,0,4096),repeat:S.obj({mode:S.enum(['once','count','whileHeld','toggle']),count:S.int(1,65535)},['mode'])});
const mapping=S.obj({layer:S.int(0,3),keyId:id,assignment});
const profile=S.obj({schemaVersion:S.enum([1]),id,name,deviceId:S.enum(all),bindings:S.array(mapping,0,512),macroIds:S.array(id,0,512),lighting:S.obj({modeId:S.int(0,255),brightnessCode:S.int(0,255),speedCode:S.int(0,255),colors:S.array(rgb,0,128)},[]),dpiStages:S.array(S.int(1,100000),0,6),audioEqRaw:S.array(S.int(),0,10)},['schemaVersion','id','name','deviceId']);
const result=S.obj({saved:S.bool});
const warnings=S.array(text,0,128);
const settings=S.obj({brightness:S.nullable(S.int(0,4)),modeRaw:S.int(0,255),modeName:S.nullable(S.text(128)),activeMode:S.int(0,255),speed:S.nullable(S.int(0,15)),colorIndex:S.nullable(S.int(0,15)),sleepCode:S.int(0,255),sleepSeconds:S.nullable(S.num(0)),debounce:S.int(0,255),signatureValid:S.bool,supportedModes:S.array(S.obj({id:S.int(0,255),name:S.text(128),hasSpeed:S.bool,hasColor:S.bool,readOnly:S.bool},['id','name','hasSpeed','hasColor']),0,64),sleepOptions:S.array(S.obj({code:S.int(0,40),seconds:S.int(0,1200)}),0,11)},[]);
const deviceSnapshot=S.obj({id:S.enum(all),source:S.enum(['hardware','hardware-status','hardware-info']),settings,info:S.obj({batteryPercent:S.nullable(S.int(0,100)),sensorName:S.text(128),family:S.text(128),charging:S.bool,activityFlagRaw:S.int(0,255)},['sensorName','family']),connection:S.obj({receiverResponded:S.bool,keyboardReady:S.bool,rawState:S.int(0,1)}),capabilities:S.obj({readable:S.array(S.string(64),0,128),writable:S.array(S.string(64),0,128)},['writable']),canRestore:S.bool,recoveryPending:S.bool,restoreKind:S.enum(['pending-operation','first-snapshot']),warnings,readAt:S.string(64),verification:S.string(128),restoredFrom:S.enum(['pending-operation','first-snapshot'])},['id','source','settings','warnings','readAt']);
const mouseSnapshot=S.obj({source:S.enum(['windows-system']),scope:S.enum(['all-mice']),settings:S.obj({pointerSpeed:S.int(1,20),wheelLines:S.int(-1,100),horizontalCharacters:S.int(0,100),doubleClickMs:S.int(1,5000),enhancedPrecision:S.bool,swapPrimary:S.bool,mouseAcceleration:S.obj({threshold1:S.int(0,2147483647),threshold2:S.int(0,2147483647),mode:S.int(0,2)})}),canRestore:S.bool,readAt:S.string(64),verification:S.string(64),restored:S.int(0,32),errors:S.array(text,0,32)},['source','scope','settings','canRestore','readAt']);
const out=[];
function add(id,title,devices,effect,args,res,availability='planned',auditIds=[],reason='接口已定义，适配器尚未实现。',evidence='target-confirmed'){
 out.push({id,title,devices,effect,args,result:res,availability,auditIds,reason,evidence});
}
add('device.read','读取当前已接入的设备状态',input,'read',S.empty,deviceSnapshot,'implemented',['A01','I01'],'读取严格设备回应；可能只返回接收器就绪状态，不推断完整配置。','hardware-verified');
add('device.restore','恢复键盘已保存快照',[keyboard],'write',S.empty,deviceSnapshot,'implemented',['A03'],'需要身份匹配的快照；pending优先、严格回读，键盘未就绪时拒绝。','static-protocol');
add('system.mouse.read','读取 Windows 鼠标参数',[mouse],'read',S.empty,mouseSnapshot,'implemented',['I20'],'Windows 主机设置，影响当前用户的全部鼠标；与 IN9 板载 DPI 独立。主机原生值与无 Win32 的假后端均有覆盖，真实环境复验待做。','local-verified');
add('system.mouse.set','应用 Windows 鼠标参数',[mouse],'write',S.union(...[['pointerSpeed',1,20],['wheelLines',-1,100],['horizontalCharacters',0,100],['doubleClickMs',1,5000]].map(([setting,min,max])=>S.obj({setting:S.enum([setting]),value:S.int(min,max)}))),mouseSnapshot,'implemented',['I20'],'Windows 主机设置，影响当前用户的全部鼠标；写前持久化完整基线，写后读回，失败恢复即时完整前态。桥接账本/拒写/回滚有假后端测试，真实 Win32 写入本轮未测。','local-verified');
add('system.mouse.restore','恢复 Windows 鼠标参数',[mouse],'write',S.empty,mouseSnapshot,'implemented',['I20'],'恢复应用第一次修改前的完整 Windows 主机快照；局部失败保留恢复记录，实际设置未在本轮真实 Win32 验收。','local-verified');
add('system.mouse.precision.set','提高指针精确度',[mouse],'write',S.obj({enabled:S.bool}),mouseSnapshot,'implemented',['I20'],'Windows 主机设置，影响当前用户的全部鼠标；只改 SPI_GET/SETMOUSE 加速项，保存并恢复原始三元组；实际设置未在本轮真实 Win32 验收。','local-verified');
add('system.mouse.buttons.set','左右手按钮偏好',[mouse],'write',S.obj({swapPrimary:S.bool}),mouseSnapshot,'implemented',['I20'],'Windows 主机设置，影响当前用户的全部鼠标；会切换主/次点击功能并持久化完整恢复基线；实际设置未在本轮真实 Win32 验收。','local-verified');
add('system.mouse.scroll.set','水平和垂直滚动偏好',[mouse],'write',S.obj({verticalLines:S.int(-1,100),horizontalCharacters:S.int(0,100)},[]),mouseSnapshot,'implemented',['I20'],'Windows 主机设置，影响当前用户的全部鼠标；可单独或同时设置，-1 表示垂直整页滚动；桥接故障回滚有假后端测试，真实 Win32 写入本轮未测。','local-verified');
const macroAudit=['A15','A16','I13','I14'];
add('macros.list','本地宏列表',input,'local',S.empty,S.obj({macros:S.array(macro,0,512),folders:S.array(S.obj({id,name,parentId:S.nullable(id)}),0,128)}),'planned',macroAudit);
add('macros.get','读取本地宏',input,'local',S.obj({id}),macro,'planned',macroAudit);
add('macros.save','新增或编辑结构化宏',input,'local',S.obj({macro}),result,'planned',macroAudit,'键盘名称按UTF-16代码单元不超过30；不执行或上传输入动作。');
for(const [action,args,res]of [
 ['rename',S.obj({id,name}),result],['duplicate',S.obj({id,name}),S.obj({id})],['delete',S.obj({ids:S.array(id,1,512)}),S.obj({deleted:S.int(0,512)})],
 ['folder.save',S.obj({id,name,parentId:S.nullable(id)}),result],['folder.delete',S.obj({id}),result],
 ['import',S.obj({format:S.enum(['hub-macro-v1','aula-native','in9-native']),content:S.text(524288)}),S.obj({macros:S.array(macro,0,512),warnings})],
 ['export',S.obj({ids:S.array(id,1,512),format:S.enum(['hub-macro-v1','aula-native','in9-native'])}),S.obj({content:S.text(524288),suggestedName:S.string(128)})],
 ['validate',S.obj({macro}),S.obj({valid:S.bool,issues:S.array(text,0,128),estimatedBytes:S.nullable(S.int(0))})],
 ['record.start',S.obj({captureScope:S.enum(['focused-editor']),includePointerMovement:S.bool}),S.obj({sessionId:id})],
 ['record.stop',S.obj({sessionId:id}),S.obj({events:S.array(event,0,4096)})]
])add('macros.'+action,'宏：'+action,input,'local',args,res,'planned',macroAudit);
add('macros.upload','上传板载宏',input,'write',S.obj({macro,slot:S.int(0,255)}),S.obj({slot:S.int(0,255),verified:S.bool}),'unverified',macroAudit,'容量、分片、单位转换和完整恢复尚未完成验证。','static-protocol');
add('macros.download','读取板载宏',input,'read',S.obj({slot:S.int(0,255)}),S.obj({macro,verified:S.bool}),'unverified',macroAudit,'不得用本地草稿代替板载读取。','static-protocol');
add('macros.bind','将宏绑定到按键',input,'write',S.obj({mapping}),S.obj({verified:S.bool}),'unverified',macroAudit,'设备写入未验证。','static-protocol');
const profileAudit=['A17','I15'];
for(const [action,args,res]of [
 ['list',S.empty,S.obj({profiles:S.array(profile,0,128),activeId:S.nullable(id),officialSourceIds:S.array(id,0,128)},['profiles','activeId'])],['get',S.obj({id}),profile],['save',S.obj({profile,sourceProfileId:id},['profile']),result],
 ['rename',S.obj({id,name}),result],['duplicate',S.obj({id,name}),S.obj({id})],['delete',S.obj({id}),result],
 ['import',S.obj({format:S.enum(['hub-profile-v1','aula-native','in9-psf']),content:S.text(524288),recordIndex:S.int(0,127)},['format','content']),S.obj({profile,warnings})],
 ['export',S.obj({id,format:S.enum(['hub-profile-v1','aula-native','in9-psf'])}),S.obj({content:S.text(524288),suggestedName:S.string(128)})],
 ['validate',S.obj({profile}),S.obj({valid:S.bool,issues:S.array(text,0,128)})],
 ['linkApplication',S.obj({profileId:id,applicationId:S.string(1024),enabled:S.bool}),result]
])add('profiles.'+action,'配置：'+action,all,'local',args,res,'planned',profileAudit);
const aulaOpaqueBinding=S.obj({layer:S.int(0,3),keyId:S.string(4),rawHex:S.string(32),byteOffset:S.int(0,393215)});
add('keyboard.profiles.official.inspect','检查官方AULA DCT配置目录',[keyboard],'local',S.obj({contentBase64:S.string(524288),recordIndex:S.int(0,28)},['contentBase64']),S.obj({activeProfileId:S.int(0,4294967295),sourceSha256:S.string(64),byteLength:S.int(13312,393216),profiles:S.array(S.obj({index:S.int(0,127),officialId:S.int(0,4294967295),name:S.string(19),knownBindings:S.int(0,348),warnings}),1,29),warnings,selectedRecordIndex:S.nullable(S.int(0,28)),opaqueBindings:S.array(aulaOpaqueBinding,0,348)}),'implemented',['A17'],'精确解析官方DCT本地文件并列出记录；可只读检查指定记录未识别动作的层、键位、原始16字节和文件偏移。原始字节不会被解释、编辑或写入设备；文件不是硬件快照。','local-verified');
add('profiles.apply','将配置应用到设备',all,'write',S.obj({id}),S.obj({applied:S.bool,verified:S.bool,warnings}),'unverified',profileAudit,'只声明接口；不能把保存本地文件当作设备应用。');
add('recovery.list','列出恢复快照',all,'local',S.empty,S.obj({snapshots:S.array(S.obj({id,createdAt:S.string(64),scope:S.string(128),deviceBound:S.bool,pending:S.bool}),0,1024)}));
add('recovery.restore','恢复指定快照',all,'write',S.obj({snapshotId:id}),S.obj({verified:S.bool,warnings}),'unverified',[],'具体范围、身份与完整回读均需验证；不允许传入任意文件路径。');
const preferences=S.obj({language:S.enum(['zh-CN','en-US']),startOnLogin:S.bool,closeBehavior:S.enum(['exit','minimizeToTray']),reduceMotion:S.bool},[]);
add('app.preferences.read','读取应用偏好',['application'],'local',S.empty,S.obj({...preferences.properties,configured:S.bool}),'implemented',['A21','I22'],'读取本地偏好及当前Windows启动项；损坏配置保留并明确报错。','local-verified');
add('app.preferences.set','修改应用偏好',['application'],'write',preferences,result,'implemented',['A21','I22'],'开机启动写后核对，退出/托盘关闭与减少动效原子保存；英文尚未完整翻译，拒绝启用。','local-verified');
add('app.version.read','软件版本信息',['application'],'read',S.empty,S.obj({version:S.string(64),mode:S.text(128),source:text,preferences:S.nullable(S.obj(preferences.properties))},['version','mode','source']),'implemented',['A20','I22'],'返回自建程序版本及已保存的界面偏好。');
add('app.updates.check','查询自建程序更新',['application'],'read',S.empty,S.obj({available:S.bool,version:S.nullable(S.string(64)),notes:text}),'planned',['A20']);
add('app.updates.install','安装自建程序更新',['application'],'destructive',S.obj({version:S.string(64)}),S.obj({installed:S.bool}),'disabled',['A20'],'更新安装接口保留，不执行下载或替换程序。');
const localOperations=new Set(['macros.list','macros.get','macros.save','macros.rename','macros.duplicate','macros.delete','macros.folder.save','macros.folder.delete','macros.import','macros.export','macros.validate','profiles.list','profiles.get','profiles.save','profiles.rename','profiles.duplicate','profiles.delete','profiles.import','profiles.export','profiles.validate']);
for(const entry of out)if(localOperations.has(entry.id)){entry.availability='implemented';entry.evidence='local-verified';entry.reason='本地宏/配置库已实现；设备隔离、原子保存和语义校验。导入导出仅支持Hub v1格式，原厂格式返回UNSUPPORTED_FORMAT；不会应用或执行硬件动作。';}
for(const entry of out)if(['profiles.import','profiles.export'].includes(entry.id))entry.reason='Hub v1配置；AULA另支持保留原始DCT的官方配置迁移和有限已证字段导出。DCT先暂存，明确保存才入库；其他原厂格式仍不支持，不写设备。';
module.exports=out;
