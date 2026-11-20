'use strict';
const {S}=require('../schema.cjs');
const K=['aula-f87-pro'],M=['inphic-in9'],out=[];
const code=S.int(0,255),id=S.string(128),rgb=S.obj({r:code,g:code,b:code}),verified=S.obj({verified:S.bool});
const layers=S.int(0,3),mode=S.int(0,255),value=S.int(0,4),warnings=S.array(S.text(2048),0,128);
const action=S.union(
 S.obj({kind:S.enum(['none','default'])}),
 S.obj({kind:S.enum(['key']),usage:S.int(0,65535),modifiers:S.array(S.enum(['leftCtrl','leftShift','leftAlt','leftMeta','rightCtrl','rightShift','rightAlt','rightMeta']),0,8)}),
 S.obj({kind:S.enum(['consumer']),usage:S.int(0,65535)}),
 S.obj({kind:S.enum(['mouse']),button:S.enum(['left','right','middle','back','forward','doubleClick','wheelUp','wheelDown','wheelLeft','wheelRight'])}),
 S.obj({kind:S.enum(['command']),command:S.enum(['dpiUp','dpiDown','dpiCycle','dpiLock','lightingCycle','pollingCycle','lockWin','copy','paste','cut','undo','redo','selectAll','switchWindow','closeWindow','showDesktop','browser','mail','calculator'])}),
 S.obj({kind:S.enum(['rapidFire']),button:S.enum(['left','right','middle']),count:S.int(1,255),intervalMs:S.int(1,65535)})
);
function add(id,title,devices,effect,args,result,ids,availability='unverified',reason='接口已定义；协议或实际回读/恢复尚未验证。',evidence='static-protocol'){
 out.push({id,title,devices,effect,args,result,auditIds:ids,availability,reason,evidence});
}
function pair(prefix,title,devices,readArgs,state,writeArgs,ids,options={}){
 add(prefix+'.read','读取'+title,devices,'read',readArgs,state,ids,options.availability||'unverified',options.reason,options.evidence);
 add(prefix+'.set','设置'+title,devices,'write',writeArgs,S.obj({state,verified:S.bool}),ids,options.availability||'unverified',options.reason,options.evidence);
}
const identity=S.obj({family:S.text(128),model:S.nullable(S.text(128)),firmware:S.nullable(S.text(128)),connection:S.enum(['wired','wireless','unknown']),receiverId:S.nullable(id),identityVerified:S.bool});
add('keyboard.identity.read','读取键盘型号与固件',K,'read',S.empty,identity,['A01']);
add('keyboard.connection.read','读取键盘与接收器状态',K,'read',S.empty,S.obj({receiverPresent:S.bool,keyboardReady:S.nullable(S.bool),rawState:S.nullable(code)}),['A01']);
add('keyboard.battery.read','查询键盘电量适用性',K,'read',S.empty,S.obj({percent:S.nullable(S.int(0,100)),charging:S.nullable(S.bool)}),['A01'],'disabled','本型号官方profile的ShowPower=0；保留接口，不宣称设备提供电量。','target-confirmed');
add('keyboard.lighting.modes.list','列出键盘灯效与各模式参数能力',K,'local',S.empty,S.obj({modes:S.array(S.obj({id:mode,name:S.string(128),brightness:S.bool,speed:S.bool,color:S.bool,multicolor:S.bool}),0,64)}),['A02','A09'],'planned');
const lighting=S.obj({modeId:mode,brightness:value,speed:value,colorIndex:S.int(0,7),enabled:S.bool,custom:S.bool});
add('keyboard.lighting.read','读取键盘灯光配置',K,'read',S.empty,lighting,['A02','A03','A04','A05','A06','A09']);
add('keyboard.lighting.mode.set','切换键盘灯效',K,'write',S.obj({modeId:mode}),S.obj({modeId:mode,verified:S.bool}),['A02']);
add('keyboard.lighting.brightness.set','应用键盘常亮亮度',K,'write',S.obj({value}),S.obj({brightness:value,verified:S.bool}),['A03','A04'],'implemented','仅常亮mode=1可写；后端检查实时能力、pending与身份。历史实测通过，最新strict传输仍需键盘就绪后复验。','static-protocol');
add('keyboard.lighting.speed.set','设置键盘当前灯效速度',K,'write',S.obj({value}),S.obj({value,verified:S.bool}),['A05']);
add('keyboard.lighting.color.set','设置键盘调色板索引或多彩',K,'write',S.obj({colorIndex:S.int(0,7)}),S.obj({colorIndex:S.int(0,7),verified:S.bool}),['A06']);
add('keyboard.lighting.enabled.set','开关键盘灯效',K,'write',S.obj({enabled:S.bool}),S.obj({enabled:S.bool,verified:S.bool}),['A09']);
const palette=S.array(rgb,7,7),paletteMode=S.enum([1,2,4,5,7,8,10,11,12,13]);
pair('keyboard.palette','每模式RGB调色板',K,S.obj({modeId:paletteMode}),S.obj({modeId:mode,colors:palette}),S.obj({modeId:paletteMode,colors:palette}),['A07']);
const perKey=S.array(S.obj({keyId:id,color:rgb}),0,128);
pair('keyboard.lighting.custom','自定义逐键RGB',K,S.obj({groupId:code}),S.obj({groupId:code,keys:perKey}),S.obj({groupId:code,keys:perKey}),['A08']);
add('keyboard.colors.favorites.list','读取本地收藏颜色',K,'local',S.empty,S.obj({colors:S.array(S.obj({id,name:S.string(60),color:rgb}),0,256)}),['A07'],'implemented','设备隔离的本地AULA收藏；不写键盘。','local-verified');
add('keyboard.colors.favorites.save','保存本地收藏颜色',K,'local',S.obj({id,name:S.string(60),color:rgb}),S.obj({saved:S.bool}),['A07'],'implemented','仅原子保存RGB收藏到本地AULA库；不修改配置或设备。','local-verified');
add('keyboard.colors.favorites.delete','删除本地收藏颜色',K,'local',S.obj({id}),S.obj({deleted:S.bool}),['A07'],'implemented','仅删除本地AULA收藏项；不修改配置或设备。','local-verified');
pair('keyboard.sleep','键盘休眠',K,S.empty,S.obj({enabled:S.bool,seconds:S.int(0,7650)}),S.obj({enabled:S.bool,seconds:S.int(0,7650)}),['A10']);
pair('keyboard.debounce','键盘防抖档位',K,S.empty,S.obj({rawCode:value}),S.obj({rawCode:value}),['A11']);
pair('keyboard.tap','Tap开关与灵敏度',K,S.empty,S.obj({enabled:S.bool,sensitivityRaw:code}),S.obj({enabled:S.bool,sensitivityRaw:code}),['A12'],{evidence:'generic-only',reason:'共享配置中有Tap线索；该固件行为和范围未确认。'});
pair('keyboard.systemMode','键盘系统模式',K,S.empty,S.obj({mode:S.enum(['windows','mac'])}),S.obj({mode:S.enum(['windows','mac'])}),['A12']);
const binding=S.obj({keyId:id,action});
pair('keyboard.bindings','四层按键映射',K,S.obj({layer:layers}),S.obj({layer:layers,bindings:S.array(binding,0,128)}),S.obj({layer:layers,bindings:S.array(binding,1,128)}),['A13','A14']);
add('keyboard.binding.set','设置单个键位动作',K,'write',S.obj({layer:layers,keyId:id,action}),verified,['A13','A14']);
add('keyboard.bindings.validate','校验键盘映射与动作适用性',K,'local',S.obj({layer:layers,bindings:S.array(binding,1,128)}),S.obj({valid:S.bool,issues:warnings}),['A13','A14'],'planned');
add('keyboard.music.modes.list','音乐灯效模式',K,'local',S.empty,S.obj({modes:S.array(S.obj({id,name:S.string(128)}),0,64)}),['A18'],'planned');
add('keyboard.music.start','启动音频驱动的灯光流',K,'write',S.obj({modeId:id,audioEndpointId:S.string(2048),sensitivity:S.num(0,1)}),S.obj({sessionId:id}),['A18'],'planned','仅接口；持续音频分析与灯光流未实现。','target-confirmed');
add('keyboard.music.stop','停止音乐灯光流',K,'write',S.obj({sessionId:id}),S.obj({stopped:S.bool}),['A18'],'planned');
add('mouse.identity.read','鼠标身份、电量与传感器',M,'read',S.empty,S.obj({family:S.string(128),sensor:S.string(128),batteryPercent:S.nullable(S.int(0,100)),charging:S.nullable(S.bool)}),['I01'],'planned','真实信息查询已有device.read入口，此专用接口待适配。','hardware-verified');
const dpiValues=[...Array.from({length:49},(_,i)=>200+i*100),5500,6000,6400,7000,7500,8000,8500,9000,9500,10000];
const dpiStage=S.obj({dpi:S.enum(dpiValues),enabled:S.bool,color:rgb});
const dpiState=S.obj({stages:S.array(dpiStage,6,6),activeStage:S.int(0,5),source:S.enum(['hardware','local-profile'])});
pair('mouse.dpi','鼠标六档DPI',M,S.empty,dpiState,S.obj({stages:S.array(dpiStage,6,6),activeStage:S.int(0,5)}),['I02','I03','I04'],{reason:'官方此版本DPI值来自本地PSF/传感器默认表；没有已证实的完整硬件回读与恢复。'});
add('mouse.dpi.options.list','支持的DPI逻辑选项',M,'local',S.empty,S.obj({values:S.array(S.int(200,10000),59,59)}),['I02'],'planned');
add('mouse.dpi.stage.set','选择当前DPI档',M,'write',S.obj({index:S.int(0,5)}),verified,['I03']);
add('mouse.dpi.mask.set','启用DPI档位',M,'write',S.obj({enabled:S.array(S.bool,6,6)}),verified,['I03']);
add('mouse.dpi.color.set','设置单档DPI指示颜色',M,'write',S.obj({index:S.int(0,5),color:rgb}),verified,['I04']);
add('mouse.status.read','读取当前档序号和回报率状态',M,'read',S.empty,S.obj({pollingHz:S.enum([125,250,500,1000]),activeEnabledOrdinal:S.int(0,5),observedAt:S.string(64)}),['I03','I05'],'unverified','COL06未取得有效状态帧；序号不是DPI实际值。');
pair('mouse.polling','鼠标回报率',M,S.empty,S.obj({hz:S.enum([125,250,500,1000])}),S.obj({hz:S.enum([125,250,500,1000])}),['I05']);
const mouseLighting=S.obj({zoneId:code,modeCode:code,enabled:S.bool,brightnessCode:code,speedCode:code,directionCode:code,colors:S.array(rgb,0,16)});
pair('mouse.lighting','鼠标灯光区域和参数',M,S.obj({zoneId:code}),mouseLighting,mouseLighting,['I06','I07']);
add('mouse.lighting.modes.list','鼠标灯效能力目录',M,'local',S.empty,S.obj({modes:S.array(S.obj({modeCode:code,name:S.string(128),zones:S.array(code,0,16)}),0,64)}),['I06','I07'],'planned');
const mouseBinding=S.obj({button:S.enum(['left','right','middle','back','forward','dpi']),action});
pair('mouse.bindings','鼠标六键映射',M,S.empty,S.obj({bindings:S.array(mouseBinding,6,6)}),S.obj({bindings:S.array(mouseBinding,6,6)}),['I08','I09','I10','I11','I12']);
add('mouse.binding.set','设置单个鼠标按键动作',M,'write',mouseBinding,verified,['I08','I09','I10','I11','I12']);
add('mouse.bindings.validate','校验唯一按键与至少一个左键',M,'local',S.obj({bindings:S.array(mouseBinding,6,6)}),S.obj({valid:S.bool,issues:warnings}),['I12'],'planned');
pair('mouse.sleep','鼠标休眠代码',M,S.empty,S.obj({rawCode:code}),S.obj({rawCode:code}),['I16']);
pair('mouse.motion','移动关灯与移动唤醒',M,S.empty,S.obj({moveClosesLight:S.bool,motionWakeup:S.bool}),S.obj({moveClosesLight:S.bool,motionWakeup:S.bool}),['I17']);
pair('mouse.liftOff','鼠标LOD高度代码',M,S.empty,S.obj({rawCode:code}),S.obj({rawCode:code}),['I18']);
pair('mouse.debounce','鼠标去抖代码',M,S.empty,S.obj({rawCode:code}),S.obj({rawCode:code}),['I19']);
pair('mouse.angleSnap','角度捕捉',M,S.empty,S.obj({enabled:S.bool}),S.obj({enabled:S.bool}),['I18'],{reason:'PSF保存字段存在，等价本地Feature写路径未确认。'});
for(const [prefix,devices,resetId,firmwareIds]of [['keyboard',K,'A19',['A01','A20']],['mouse',M,'I21',['I22']]]){
 add(prefix+'.factoryReset','恢复出厂默认',devices,'destructive',S.obj({scope:S.enum(['device'])}),verified,[resetId],'disabled','危险操作仅声明接口；未验证且不允许通过本接口执行。');
 add(prefix+'.onboard.clear','清空板载配置',devices,'destructive',S.obj({scope:S.enum(['all'])}),verified,[resetId],'disabled','清空板载配置不作为试探操作。');
 add(prefix+'.firmware.read','读取固件版本',devices,'read',S.empty,S.obj({version:S.nullable(S.string(128)),hardwareRevision:S.nullable(id)}),firmwareIds);
}
for(const entry of out){
 if(['keyboard.lighting.read','keyboard.lighting.mode.set','keyboard.lighting.brightness.set','keyboard.lighting.speed.set','keyboard.lighting.color.set','keyboard.lighting.enabled.set','keyboard.sleep.read','keyboard.sleep.set','keyboard.debounce.read','keyboard.debounce.set'].includes(entry.id)){
  entry.availability='implemented';entry.evidence='hardware-verified';entry.reason='当前接收器上已逐项写入、完整128字节读回并恢复原始SHA-256；14普通灯效及关闭、亮度/速度/颜色/去抖、0与30秒起休眠。仍由运行时状态、能力和恢复记录决定是否允许写入。';
  if(entry.id==='keyboard.lighting.read')entry.result=S.obj({...lighting.properties,brightness:S.nullable(value),speed:S.nullable(value),colorIndex:S.nullable(S.int(0,7))});
 }
}
for(const entry of out)if(['keyboard.identity.read','keyboard.palette.read'].includes(entry.id)){
 entry.availability='implemented';
 if(entry.id==='keyboard.identity.read'){entry.evidence='hardware-verified';entry.reason='当前无线固件真实完整10字节身份已验证。';entry.result=S.obj({...identity.properties,psdHex:S.string(12),extraHex:S.string(8)});}
 else{entry.evidence='static-protocol';entry.reason='读取后按实际长度保留490或512字节；历史设备响应为490字节，512字节布局仅有静态/原厂输出证据。无论长度均不作为写入恢复基准。';entry.result=S.obj({modeId:paletteMode,blockComplete:S.bool,actualLength:S.enum([490,512]),markerPresent:S.bool,writeBaselineEligible:S.enum([false]),identityVerified:S.enum([true]),psdHex:S.string(12),containerId:S.string(64),rawContentBase64:S.string(684),colors:palette});}
}
const paletteRead=out.find(entry=>entry.id==='keyboard.palette.read');
add('keyboard.bindings.snapshot.read','读取所选层实际矩阵记录',K,'read',S.obj({layer:layers}),S.obj({layer:layers,matrixComplete:S.enum([false]),blockComplete:S.bool,actualLength:S.enum([504,512]),markerPresent:S.bool,rawContentBase64:S.string(684),writeBaselineEligible:S.enum([false]),identityVerified:S.enum([true]),psdHex:S.string(12),containerId:S.string(64),records:S.array(S.obj({index:S.int(0,127),rawHex:S.string(8),kind:S.enum(['keyboard','consumer','empty-or-disabled','unknown']),modifiers:S.nullable(code),primaryUsage:S.nullable(code),secondaryUsage:S.nullable(code),consumerUsage:S.nullable(S.int(0,65535))}),126,128)}),['A13','A14'],'implemented','保留设备实际返回的504或512字节所选层数据，绝不补齐；blockComplete只表示单层数据块长度完整，matrixComplete仍为false，四层整体与隐藏状态尚未形成可恢复快照。512字节路径有静态协议依据，需真机复验；所有结果writeBaselineEligible=false。','static-protocol');
const snapshotBlock=lengths=>S.obj({attempted:S.bool,actualLength:S.nullable(S.enum(lengths)),blockComplete:S.bool,markerPresent:S.nullable(S.bool),rawContentBase64:S.nullable(S.text(684))});
add('keyboard.configuration.snapshot.read','同会话读取四层矩阵与调色板',K,'read',S.empty,S.obj({containerId:S.string(64),instanceId:S.nullable(S.text(512)),identityBeforePsdHex:S.nullable(S.string(12)),identityAfterAttempted:S.bool,identityAfterPsdHex:S.nullable(S.string(12)),identityStable:S.nullable(S.bool),snapshotComplete:S.bool,writeBaselineEligible:S.enum([false]),matrices:S.array(S.obj({layer:layers,...snapshotBlock([504,512]).properties}),4,4),palette:snapshotBlock([490,512]),failedCommand:S.nullable(S.enum([5,65,73])),failedSelector:S.nullable(layers),failureMessage:S.nullable(S.text(2048)),readAt:S.string(64)}),['A13','A14'],'implemented','通过一次HID会话读取PSD、四层矩阵与调色板，并保留首个失败前已收到的实际字节。完整读取不代表标记/语义有效，也不构成写入恢复基线；必须结合每块长度和marker判断。','static-protocol');
module.exports=out;
