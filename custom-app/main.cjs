'use strict';
const {app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const {pathToFileURL} = require('node:url');

// Standalone renderer and direct device services. Never launches or embeds vendor applications.
const root = path.resolve(process.resourcesPath, '..', '..');
const stateDir = path.join(root, 'local-state');
fs.mkdirSync(stateDir, {recursive:true});
const testMode = process.argv.includes('--hub-test');
app.setPath('userData', path.join(stateDir, testMode?'electron-test-profile':'electron-profile'));
app.setPath('sessionData', path.join(stateDir, testMode?'test-session':'session'));
app.setAppUserModelId('local.peripheral-hub.custom');
app.setName('外设中心 · 本地定制');
if (testMode) {
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', '58743');
}
const bridgePath = path.join(process.resourcesPath, 'app', 'Bridge.ps1');
const pwsh = path.join(process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
const requestDir = path.join(stateDir, 'bridge');
const reportDir = path.join(stateDir, 'scans');
const undoPath = path.join(stateDir, 'audio-before-changes.json');
fs.mkdirSync(requestDir,{recursive:true});
fs.mkdirSync(reportDir,{recursive:true});
let mainWindow;
let snapshotCache = null;
let initialScan = null;
let chain = Promise.resolve();
let undo = {};
let recoveryWarning = null;
let closeAllowed = false;
let closeInProgress=false,quitRequested=false,tray=null;
let autoSwitchRuntime=null,autoSwitchStarting=false;
const startupOptions={path:process.execPath,args:[],name:'PeripheralHubPublic'};
const {createPreferences}=require('./api/preferences.cjs');
const applicationPreferences=createPreferences({directory:stateDir,startup:{
  read(){if(typeof app.getLoginItemSettings!=='function')throw Object.assign(Error('当前宿主不支持读取Windows启动项。'),{code:'DEPENDENCY_MISSING'});return app.getLoginItemSettings(startupOptions).openAtLogin;},
  write(enabled){if(typeof app.setLoginItemSettings!=='function')throw Object.assign(Error('当前宿主不支持设置Windows启动项。'),{code:'DEPENDENCY_MISSING'});app.setLoginItemSettings({...startupOptions,openAtLogin:enabled});}
},prepareCloseBehavior:async()=>ensureTray()});
function showWindow(){if(mainWindow){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();}}
function requestQuit(){quitRequested=true;if(mainWindow)mainWindow.close();else app.quit();}
function ensureTray(){
  if(tray)return;
  if(typeof Tray!=='function'||!Menu||!nativeImage)throw Object.assign(Error('系统托盘不可用；关闭行为未更改。'),{code:'DEPENDENCY_MISSING'});
  const image=nativeImage.createFromPath(path.join(__dirname,'renderer','assets','tray.png'));
  if(image.isEmpty())throw Error('系统托盘图标无法读取。');
  const next=new Tray(image.resize({width:16,height:16}));
  try{next.setToolTip('外设中心');next.setContextMenu(Menu.buildFromTemplate([{label:'打开外设中心',click:showWindow},{type:'separator'},{label:'退出',click:requestQuit}]));next.on('double-click',showWindow);tray=next;}
  catch(error){next.destroy();throw error;}
}
try {
  if(fs.existsSync(undoPath)){
    const stored=JSON.parse(fs.readFileSync(undoPath,'utf8'));
    if(!stored || typeof stored!=='object' || Array.isArray(stored))throw new Error('Invalid recovery data.');
    for(const [id,value] of Object.entries(stored)){
      if(!value || value.id!==id || !Number.isFinite(value.volume) || value.volume<0 || value.volume>100 || typeof value.muted!=='boolean')throw new Error('Invalid recovery entry.');
    }
    undo=stored;
  }
} catch(error) {
  const backup=undoPath+'.invalid-'+Date.now();
  fs.renameSync(undoPath,backup);
  recoveryWarning='旧恢复记录读取失败，已另存备份；本次修改会创建新记录。';
}
function serialize(work) {
  const job=chain.then(work);
  chain=job.catch(()=>{});
  return job;
}
function persistUndo() {
  const temp=undoPath+'.tmp';
  fs.writeFileSync(temp,JSON.stringify(undo,null,2));
  fs.renameSync(temp,undoPath);
}
function runBridge(action, args={}) {
  return new Promise((resolve,reject)=>{
    if(!fs.existsSync(pwsh)) return reject(new Error('请安装 PowerShell 7 后重新启动。'));
    const id=randomUUID(), requestPath=path.join(requestDir,id+'.request.json'), responsePath=path.join(requestDir,id+'.response.json');
    fs.writeFileSync(requestPath,JSON.stringify((action.startsWith('mouse-profile-')||action.startsWith('headset-')||action==='keyboard-draft-patch')?{...args,action}:{...args,action,projectRoot:root,reportDirectory:reportDir}));
    const service=action==='keyboard-draft-patch'?'AulaDraftBridge.ps1':action.startsWith('mouse-profile-')?'In9ProfileBridge.ps1':action.startsWith('device-')?'DeviceBridge.ps1':action.startsWith('mouse-')?'MouseBridge.ps1':action.startsWith('headset-')?'HeadsetBridge.ps1':'Bridge.ps1';
    const servicePath=path.join(path.dirname(bridgePath),service);
    const child=spawn(pwsh,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',servicePath,'-RequestPath',requestPath,'-ResponsePath',responsePath],{windowsHide:true,stdio:'ignore'});
    let settled=false, timedOut=false;
    const finish=(error,data)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      for(const file of [requestPath,responsePath]){try{fs.unlinkSync(file);}catch{}}
      if(error)reject(error);else resolve(data);
    };
    const timer=setTimeout(()=>{timedOut=true;child.kill();},action==='device-set'||action==='device-restore'?90000:60000);
    child.on('error',error=>finish(error));
    child.on('exit',(code)=>{
      try{
        // Do not release the serialized operation or erase its files until the child exits.
        if(timedOut)throw new Error('设备服务超时并已停止。请先重新读取；若写入中断，恢复页会保留操作前快照。');
        if(!fs.existsSync(responsePath))throw new Error('设备服务未返回结果（退出码 '+code+'）。');
        const response=JSON.parse(fs.readFileSync(responsePath,'utf8').replace(/^\uFEFF/,''));
        if(!response.ok)throw new Error(response.error || '设备服务调用失败。');
        finish(null,response.data);
      }catch(error){finish(error);}
    });
  });
}
function bridge(action,args={},canApply){
  const execute=()=>runBridge(action,args);
  if(!action.startsWith('headset-')||!autoSwitchRuntime?.requiresPause?.())return execute();
  return autoSwitchRuntime.suspend().then(async suspension=>{
    try{
      if(canApply&&!canApply())return null;
      return await execute();
    }finally{
      if(suspension?.owned){
        try{await autoSwitchRuntime.resume();}
        catch(error){recoveryWarning=(recoveryWarning?recoveryWarning+'；':'')+'自动切换恢复失败：'+error.message;}
      }
    }
  });
}
function assertSender(event) {
  if(!mainWindow || event.sender!==mainWindow.webContents || event.senderFrame!==mainWindow.webContents.mainFrame)
    throw new Error('Unknown application frame.');
  if(!event.senderFrame.url.startsWith(pathToFileURL(path.join(__dirname,'renderer')).href+'/'))
    throw new Error('Unexpected application URL.');
}
const localHandlers=new Map();
function register(name,handler){localHandlers.set(name,handler);ipcMain.handle(name,(event,...args)=>{assertSender(event);return handler(...args);});}
async function refresh(){
  snapshotCache=await bridge('snapshot');
  if(recoveryWarning)snapshotCache.warnings.push(recoveryWarning);
  return snapshotCache;
}
function getSnapshot(){
  if(snapshotCache)return serialize(async()=>{
    snapshotCache.audio=await bridge('audio-list');
    return snapshotCache;
  });
  if(!initialScan)initialScan=serialize(refresh).finally(()=>{initialScan=null;});
  return initialScan;
}
function updateAudio(endpoint){
  if(snapshotCache)snapshotCache.audio=snapshotCache.audio.map(item=>item.id===endpoint.id?endpoint:item);
  return endpoint;
}
function validateAudioRequest(payload){
  if(!payload || typeof payload!=='object' || Array.isArray(payload))throw new Error('Invalid audio request.');
  const {id,volume,muted}=payload;
  if(typeof id!=='string' || !id || id.length>2048)throw new Error('Invalid audio endpoint.');
  if(volume!==undefined && (typeof volume!=='number'||!Number.isFinite(volume)||volume<0||volume>100))throw new Error('音量应为 0–100。');
  if(muted!==undefined && typeof muted!=='boolean')throw new Error('静音值应为布尔值。');
  if(volume===undefined && muted===undefined)throw new Error('没有需要应用的音频设置。');
  return {id,volume,muted};
}
register('hub:snapshot',getSnapshot);
register('hub:refresh',()=>serialize(refresh));
register('hub:info',()=>({version:require('./package.json').version+'-preview',mode:'统一界面 · 设备直连',source:'自建界面与设备协议适配器；功能按实测进度开放，非官方版本',preferences:applicationPreferences.peek()}));
register('hub:preferences-read',()=>applicationPreferences.read());
register('hub:preferences-set',payload=>applicationPreferences.set(payload));
const {createExportSaver}=require('./export-files.cjs');
register('hub:export-save',createExportSaver({choosePath:async({fileName,format})=>{
 if(testMode){const directory=path.join(stateDir,'test-exports');await fs.promises.mkdir(directory,{recursive:true});return {canceled:false,filePath:path.join(directory,fileName)};}
 return dialog.showSaveDialog(mainWindow,{title:'保存导出文件',defaultPath:fileName,filters:[{name:format==='psf'?'鼠标官方配置':format==='dct'?'AULA 官方配置':'外设中心 JSON',extensions:[format]}],properties:['showOverwriteConfirmation']});
}}));
register('hub:auto-switch-select-executable',async()=>{
  const selection=await dialog.showOpenDialog(mainWindow,{title:'选择应用程序',filters:[{name:'Windows 应用程序',extensions:['exe']}],properties:['openFile']});
  if(selection.canceled)return {canceled:true,appPath:null,widgetName:null};
  if(!Array.isArray(selection.filePaths)||selection.filePaths.length!==1)throw new Error('请选择一个 EXE 文件。');
  const appPath=path.resolve(selection.filePaths[0]),widgetName=path.basename(appPath,path.extname(appPath));
  if(!path.win32.isAbsolute(appPath)||appPath.length>2048||!/[.]exe$/i.test(appPath)||!widgetName||/[\x00-\x1f]/.test(appPath))throw new Error('所选文件不是有效的 Windows EXE 路径。');
  const stat=fs.statSync(appPath);if(!stat.isFile())throw new Error('所选路径不是普通文件。');
  return {canceled:false,appPath,widgetName};
});
register('hub:auto-switch-executable-icon',async payload=>{
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>key!=='appPath')||typeof payload.appPath!=='string'||payload.appPath.length>2048||!path.win32.isAbsolute(payload.appPath)||!/[.]exe$/i.test(payload.appPath))throw new Error('请选择有效的 Windows EXE 路径。');
  const stat=fs.statSync(payload.appPath);if(!stat.isFile())throw new Error('所选路径不是普通文件。');
  if(typeof app.getFileIcon!=='function')return {dataUrl:null};
  try{const image=await app.getFileIcon(payload.appPath,{size:'normal'}),dataUrl=image&&!image.isEmpty()?image.toDataURL():null;return {dataUrl:typeof dataUrl==='string'&&dataUrl.startsWith('data:image/png;base64,')&&dataUrl.length<=700000?dataUrl:null};}catch{return {dataUrl:null};}
});
register('hub:mouse-read',()=>serialize(()=>bridge('mouse-read')));
register('hub:mouse-set',payload=>{
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>!['setting','value'].includes(key))||Object.keys(payload).length!==2||!['pointerSpeed','wheelLines','horizontalCharacters','doubleClickMs','enhancedPrecision','swapPrimary'].includes(payload.setting)||!Number.isInteger(payload.value))throw new Error('Invalid Windows mouse preference request.');
  const {setting,value}=payload;
  if((setting==='pointerSpeed'&&(value<1||value>20))||(setting==='wheelLines'&&(value!==-1&&(value<0||value>100)))||(setting==='horizontalCharacters'&&(value<0||value>100))||(setting==='doubleClickMs'&&(value<1||value>5000))||(['enhancedPrecision','swapPrimary'].includes(setting)&&![0,1].includes(value)))throw new Error('Mouse preference is outside its valid range.');
  return serialize(()=>bridge('mouse-set',{setting,value}));
});
register('hub:mouse-scroll-set',payload=>{
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>!['verticalLines','horizontalCharacters'].includes(key))||!Object.keys(payload).length||Object.entries(payload).some(([key,value])=>!Number.isInteger(value)||(key==='verticalLines'?(value!==-1&&(value<0||value>100)):(value<0||value>100))))throw new Error('Invalid Windows mouse scroll preferences.');
  return serialize(()=>bridge('mouse-scroll-set',payload));
});
register('hub:mouse-restore',()=>serialize(()=>bridge('mouse-restore')));
register('hub:keyboard-draft-patch',payload=>bridge('keyboard-draft-patch',payload));
for(const suffix of ['status-read','installed-list','archive-installed','preview','read','export','apply','restore']){const action='mouse-profile-'+suffix;register('hub:'+action,payload=>['status-read','apply','restore','archive-installed'].includes(suffix)?serialize(()=>bridge(action,payload)):bridge(action,payload));}
register('hub:headset-detect',()=>serialize(()=>bridge('headset-detect')));
for(const action of ['headset-effects-read','headset-effects-set'])register('hub:'+action,payload=>serialize(()=>bridge(action,payload)));
register('hub:headset-effects-restore',()=>serialize(()=>bridge('headset-effects-restore')));
register('hub:headset-aec-read',payload=>{
  validateHeadset(headsetSchema.obj({endpointId:headsetSchema.string(2048)}),payload,'AEC read');
  if(!/^\{0\.0\.1\.00000000\}\.\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$/.test(payload.endpointId))throw new Error('AEC仅可读取有效的录音端点。');
  const request={endpointId:payload.endpointId};
  return serialize(()=>bridge('headset-aec-read',request));
});
const {S:headsetSchema,validate:validateHeadset}=require('./api/schema.cjs');
const eqPresetRequest=headsetSchema.obj({endpointId:headsetSchema.string(2048),bandsRaw:headsetSchema.array(headsetSchema.int(-20,20),10,10)});
register('hub:headset-eq-preset-apply',payload=>{
  validateHeadset(eqPresetRequest,payload,'EQ preset');
  if(!/^\{0\.0\.0\.00000000\}\.\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$/.test(payload.endpointId))throw new Error('EQ预设仅可应用到有效的播放端点。');
  const request={endpointId:payload.endpointId,bandsRaw:[...payload.bandsRaw]};
  return serialize(()=>bridge('headset-eq-preset-apply',request));
});
for(const suffix of ['list','create','select','delete']){const action='headset-profiles-'+suffix;register('hub:'+action,payload=>serialize(()=>bridge(action,payload)));}
for(const action of ['headset-master-read','headset-master-set','headset-master-restore'])register('hub:'+action,payload=>serialize(()=>bridge(action,payload)));
for(const suffix of ['channels-read','channels-set','balance-read','balance-set','peak-read','sessions-list','sessions-set','format-read','format-list','format-set','default-read','default-set','controls-restore']){const action='headset-audio-'+suffix;register('hub:'+action,payload=>serialize(()=>bridge(action,payload)));}
for(const action of ['headset-info','headset-apo'])register('hub:'+action,payload=>{
  if(!payload||typeof payload!=='object'||typeof payload.endpointId!=='string'||!payload.endpointId||payload.endpointId.length>2048)throw new Error('Invalid audio endpoint.');
  return serialize(()=>bridge(action,{endpointId:payload.endpointId}));
});
register('hub:window',action=>{
  if(!['minimize','maximize','close','quit'].includes(action))throw new Error('Unknown window action.');
  if(action==='minimize')mainWindow.minimize();
  if(action==='maximize'){if(mainWindow.isMaximized())mainWindow.unmaximize();else mainWindow.maximize();}
  const state={maximized:mainWindow.isMaximized()};
  if(action==='close')setImmediate(()=>mainWindow.close());
  if(action==='quit')setImmediate(requestQuit);
  return state;
});
function verifyAudioReadback(actual, expected){
  if(!actual||actual.id!==expected.id||!Number.isFinite(actual.volume)||typeof actual.muted!=='boolean')throw new Error('音频服务返回的读回数据无效，恢复记录已保留。');
  if(expected.volume!==undefined&&Math.abs(actual.volume-expected.volume)>0.5)throw new Error('音量读回与请求值不一致，恢复记录已保留，请重新读取。');
  if(expected.muted!==undefined&&actual.muted!==expected.muted)throw new Error('静音读回与请求值不一致，恢复记录已保留，请重新读取。');
  return actual;
}
register('hub:audio-set',payload=>{
  const args=validateAudioRequest(payload);
  return serialize(async()=>{
    const before=await bridge('audio-read',{id:args.id});
    if(!undo[args.id]){undo[args.id]={id:before.id,name:before.name,volume:before.volume,muted:before.muted,savedAt:new Date().toISOString()};persistUndo();}
    return updateAudio(verifyAudioReadback(await bridge('audio-set',args),args));
  });
});
register('hub:audio-restore',()=>serialize(async()=>{
  let restored=0;const errors=[];
  for(const [id,state] of Object.entries(undo)){
    try{
      updateAudio(verifyAudioReadback(await bridge('audio-set',{id,volume:state.volume,muted:state.muted}),state));
      delete undo[id];persistUndo();restored++;
    }catch(error){errors.push(state.name+'：'+error.message);}
  }
  return {restored,errors};
}));

function validateDevice(payload){
  if(!payload || !['aula-f87-pro','inphic-in9'].includes(payload.id))throw new Error('未知设备。');
  return payload.id;
}
register('hub:device-read',payload=>{
  const id=validateDevice(payload);
  return serialize(()=>{return bridge('device-read',{id});});
});
register('hub:device-set',payload=>{
  const id=validateDevice(payload);
  const setting=payload.setting,value=payload.value;
  const allowed={brightness:[0,1,2,3,4],speed:[0,1,2,3,4],colorIndex:[0,1,2,3,4,5,6,7],debounce:[0,1,2,3,4],activeMode:[0,1,2,3,4,5,7,8,10,11,12,13,15,16,17],sleepCode:[0,1,2,3,4,6,8,10,20,30,40]};
  if(id!=='aula-f87-pro'||!Object.hasOwn(allowed,setting)||!Number.isInteger(value)||!allowed[setting].includes(value))throw new Error('键盘参数超出已经验证的范围。');
  return serialize(()=>{return bridge('device-set',{id,setting,value});});
});
for(const action of ['device-keyboard-identity','device-keyboard-matrix','device-keyboard-palette','device-keyboard-snapshot'])register('hub:'+action,payload=>{const id=validateDevice(payload);if(id!=='aula-f87-pro')throw Error('Keyboard operation requires AULA target.');return serialize(()=>bridge(action,{id,layer:payload.layer,modeId:payload.modeId}));});
register('hub:device-restore',payload=>{
  const id=validateDevice(payload);
  return serialize(()=>{return bridge('device-restore',{id});});
});
const {createFeatureApi}=require('./api/service.cjs');
const {createAdapters}=require('./api/adapters.cjs');
const {createAutoSwitchRuntime,createWindowsForegroundObserver}=require('./api/autoswitch-runtime.cjs');
const {createAudioMonitor}=require('./api/audio-monitor.cjs');
const audioMonitor=createAudioMonitor({powershell:pwsh,scriptPath:path.join(__dirname,'HeadsetAudioMonitor.ps1'),projectRoot:root});
register('hub:headset-audio-monitor-start',payload=>audioMonitor.start(payload));
register('hub:headset-audio-monitor-read',()=>audioMonitor.read());
register('hub:headset-audio-monitor-stop',()=>audioMonitor.stop());
autoSwitchRuntime=createAutoSwitchRuntime({
  observeForeground:createWindowsForegroundObserver({powershell:pwsh,scriptPath:path.join(__dirname,'HeadsetAutoSwitchForeground.ps1')}),
  listProfiles:ids=>autoSwitchStarting?bridge('headset-profiles-list',{endpointIds:ids}):serialize(()=>bridge('headset-profiles-list',{endpointIds:ids})),
  applyProfile:(ids,name,canApply)=>serialize(()=>canApply()?bridge('headset-profiles-select',{endpointIds:ids,name},canApply):null)
});
const featureAdapters=createAdapters((name,payload)=>{
  const handler=localHandlers.get(name);
  if(!handler)throw new Error('Missing existing service adapter: '+name);
  return handler(payload);
},{directory:path.join(stateDir,'library'),autoSwitchRuntime});
const featureApi=createFeatureApi(featureAdapters);
const {createAutoSwitch}=require('./api/autoswitch.cjs');
const autoSwitchIconService=createAutoSwitch({directory:path.join(stateDir,'library')});
async function invokeAutoSwitch(operation,args={}){
  const response=await featureApi.invoke({apiVersion:1,deviceId:'ikf-v11-pro-71',operation:'headset.autoSwitch.'+operation,args});
  if(response?.ok!==true)throw new Error(response?.error?.message||'自动切换规则服务失败。');
  return response.data;
}
register('hub:auto-switch-rule-save',payload=>{
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>!['rule','previousApplicationId','iconDataUrl'].includes(key))||!payload.rule||typeof payload.rule!=='object')throw new Error('自动切换规则请求无效。');
  if(payload.iconDataUrl!==undefined&&typeof payload.iconDataUrl!=='string')throw new Error('应用图标数据无效。');
  if(payload.previousApplicationId!==undefined&&typeof payload.previousApplicationId!=='string')throw new Error('待编辑应用路径无效。');
  return serialize(async()=>{
    const existing=await invokeAutoSwitch('list'),previous=payload.previousApplicationId||payload.rule.appPath,oldIcon=existing.rules.find(rule=>rule.appPath===previous)?.icon;
    const rule={...payload.rule};let createdIcon=null;
    if(payload.iconDataUrl){createdIcon=await autoSwitchIconService.saveIcon(payload.iconDataUrl);rule.icon=createdIcon;}
    let result;
    try{result=await invokeAutoSwitch('save',{rule,...(payload.previousApplicationId?{previousApplicationId:payload.previousApplicationId}:{})});}
    catch(error){if(createdIcon)await autoSwitchIconService.deleteIconIfUnreferenced(createdIcon).catch(()=>{});throw error;}
    if(oldIcon&&oldIcon!==rule.icon)await autoSwitchIconService.deleteIconIfUnreferenced(oldIcon).catch(()=>{});
    return result;
  });
});
register('hub:auto-switch-icon-read',payload=>{
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>key!=='icon')||typeof payload.icon!=='string')throw new Error('自动切换图标请求无效。');
  return serialize(async()=>({dataUrl:await autoSwitchIconService.readIcon(payload.icon)}));
});
register('hub:features-list',query=>featureApi.list(query));
register('hub:features-describe',query=>featureApi.describe(query));
register('hub:features-invoke',request=>{
  const contract=featureApi.catalog.find(c=>c.id===request?.operation);
  if(request?.operation==='headset.autoSwitch.setEnabled')return serialize(async()=>{autoSwitchStarting=true;try{return await featureApi.invoke(request);}finally{autoSwitchStarting=false;}});
  if(request?.operation==='headset.autoSwitch.delete')return serialize(async()=>{const listed=await invokeAutoSwitch('list'),icon=listed.rules.find(rule=>rule.appPath===request?.args?.applicationId)?.icon,response=await featureApi.invoke(request);if(response?.ok&&icon)await autoSwitchIconService.deleteIconIfUnreferenced(icon);return response;});
  return contract?.effect==='local'?serialize(()=>featureApi.invoke(request)):featureApi.invoke(request);
});
if(!app.requestSingleInstanceLock())app.quit();
else {
  app.on('before-quit',()=>{quitRequested=true;});
  app.on('second-instance',showWindow);
  app.whenReady().then(async()=>{
    try{await applicationPreferences.load();}catch(error){recoveryWarning=(recoveryWarning?recoveryWarning+'；':'')+error.message;}
    if(applicationPreferences.current().closeBehavior==='minimizeToTray'){try{ensureTray();}catch(error){recoveryWarning=(recoveryWarning?recoveryWarning+'；':'')+error.message;}}
    mainWindow=new BrowserWindow({width:1380,height:820,minWidth:1000,minHeight:650,frame:false,backgroundColor:'#e6e7ed',title:'外设中心 · 玻璃定制版',show:false,
      webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
    mainWindow.setMenuBarVisibility(false);
    mainWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    mainWindow.webContents.on('will-navigate',event=>event.preventDefault());
    mainWindow.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
    mainWindow.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(_details,callback)=>callback({cancel:true}));
    mainWindow.on('ready-to-show',()=>mainWindow.show());
    mainWindow.on('hide',()=>{void audioMonitor.stop().catch(error=>{recoveryWarning='音频状态监听停止失败：'+error.message;});});
    mainWindow.on('close',event=>{
      if(closeAllowed)return;
      event.preventDefault();
      if(!quitRequested&&applicationPreferences.current().closeBehavior==='minimizeToTray'&&tray){mainWindow.hide();return;}
      if(closeInProgress)return;closeInProgress=true;
      Promise.all([autoSwitchRuntime.dispose(),audioMonitor.dispose()]).then(()=>serialize(async()=>{})).then(()=>{if(tray){tray.destroy();tray=null;}closeAllowed=true;mainWindow.close();}).catch(error=>{closeInProgress=false;dialog.showErrorBox('关闭前清理失败',error.message);});
    });
    mainWindow.loadFile(path.join(__dirname,'renderer','index.html'));
    if(testMode)fs.writeFileSync(path.join(stateDir,'test-instance.json'),JSON.stringify({pid:process.pid,port:58743}));
  }).catch(error=>{dialog.showErrorBox('启动失败',error.message);app.quit();});
  app.on('window-all-closed',()=>app.quit());
}
