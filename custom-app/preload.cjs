'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('hub',Object.freeze({
  features:Object.freeze({
    list:(query={})=>ipcRenderer.invoke('hub:features-list',query),
    describe:operation=>ipcRenderer.invoke('hub:features-describe',{operation}),
    invoke:request=>ipcRenderer.invoke('hub:features-invoke',request)
  }),
  snapshot:()=>ipcRenderer.invoke('hub:snapshot'),
  refresh:()=>ipcRenderer.invoke('hub:refresh'),
  setAudio:request=>ipcRenderer.invoke('hub:audio-set',request),
  restoreAudio:()=>ipcRenderer.invoke('hub:audio-restore'),
  getInfo:()=>ipcRenderer.invoke('hub:info'),
  saveExport:request=>ipcRenderer.invoke('hub:export-save',request),
  selectAutoSwitchExecutable:()=>ipcRenderer.invoke('hub:auto-switch-select-executable'),
  getAutoSwitchExecutableIcon:request=>ipcRenderer.invoke('hub:auto-switch-executable-icon',request),
  saveAutoSwitchRule:request=>ipcRenderer.invoke('hub:auto-switch-rule-save',request),
  readAutoSwitchIcon:request=>ipcRenderer.invoke('hub:auto-switch-icon-read',request),
  readMouse:()=>ipcRenderer.invoke('hub:mouse-read'),
  setMouse:request=>ipcRenderer.invoke('hub:mouse-set',request),
  setMouseScroll:request=>ipcRenderer.invoke('hub:mouse-scroll-set',request),
  restoreMouse:()=>ipcRenderer.invoke('hub:mouse-restore'),
  readDevice:request=>ipcRenderer.invoke('hub:device-read',request),
  setDevice:request=>ipcRenderer.invoke('hub:device-set',request),
  restoreDevice:request=>ipcRenderer.invoke('hub:device-restore',request),
  windowControl:action=>ipcRenderer.invoke('hub:window',action)
}));
