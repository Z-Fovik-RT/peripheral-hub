'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.in9Actions = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  // Static evidence: reference/inphic-in9/app/Inphic IN9 GM.exe; never executed here.
  // Main VA 462BDA/462BF2/462C02 -> tables 62036F/62035F/62034F.
  // DPI handlers 464F58/464F6E -> 62038F/62038B; menu 15 is a submenu, not 500000.
  // Media VA 46613C..466163 -> 6203B3/6203A7/62039B;
  // office VA 466C2C..466C53 -> 6203D7/6203CB/6203BF;
  // window VA 4686DC..468703 -> 6203F7/6203EF/6203E7. Tuples are literal PSF bytes.
  const groups = Object.freeze([
    ['mouse', '鼠标按键', [
      ['mouse.left', '左键', '100100'], ['mouse.right', '右键', '100200'],
      ['mouse.middle', '中键', '100400'], ['mouse.forward', '前进', '101000'],
      ['mouse.back', '后退', '100800'], ['mouse.triple', '三连发', '303203'],
      ['mouse.lightingCycle', '灯效切换', '600400'], ['mouse.disabled', '禁用', '000000']
    ]],
    ['dpi', 'DPI', [
      ['dpi.increase', 'DPI +', '400200'], ['dpi.decrease', 'DPI −', '400300'],
      ['dpi.cycle', 'DPI 循环', '400100']
    ]],
    ['media', '多媒体', [
      ['media.player', '播放器', '808301'], ['media.previous', '上一首', '80B600'],
      ['media.next', '下一首', '80B500'], ['media.stop', '停止', '80B700'],
      ['media.playPause', '播放 / 暂停', '80CD00'], ['media.mute', '静音', '80E200'],
      ['media.volumeUp', '音量 +', '80E900'], ['media.volumeDown', '音量 −', '80EA00'],
      ['media.mail', '邮件', '808A01'], ['media.calculator', '计算器', '809201']
    ]],
    ['office', '文字办公', [
      ['office.copy', '复制', '700106'], ['office.paste', '粘贴', '700119'],
      ['office.cut', '剪切', '70011B'], ['office.selectAll', '全选', '700104'],
      ['office.new', '新建', '700111'], ['office.save', '保存', '700116'],
      ['office.print', '打印', '700113'], ['office.open', '打开', '700808'],
      ['office.undo', '撤销', '70011D']
    ]],
    ['window', '视窗', [
      ['window.computer', '我的电脑', '809401'], ['window.close', '关闭窗口', '70043D'],
      ['window.desktop', '显示桌面', '700807'], ['window.run', '运行', '700815'],
      ['window.minimize', '最小化', '700851'], ['window.maximize', '最大化', '700852']
    ]]
  ].map(([id, label, rows]) => Object.freeze({
    id, label, actions: Object.freeze(rows.map(([actionId, actionLabel, valueHex]) => Object.freeze({id: actionId, label: actionLabel, valueHex})))
  })));
  const actions = Object.freeze(groups.flatMap(group => group.actions));
  const byId = new Map(actions.map(action => [action.id, action]));
  const byHex = new Map(actions.map(action => [action.valueHex, action]));
  // A disabled selected option can retain this sentinel; it is never a writable action.
  const CURRENT_VALUE = '__in9_preserve_current__';
  function normalized(valueHex) {
    if (typeof valueHex !== 'string' || !/^[A-Fa-f0-9]{6}$/.test(valueHex)) throw new TypeError('Expected exactly three PSF action bytes.');
    return valueHex.toUpperCase();
  }
  function findById(id) { return typeof id === 'string' ? byId.get(id) || null : null; }
  function findByHex(valueHex) { return byHex.get(normalized(valueHex)) || null; }
  function describeCurrent(valueHex) {
    const action = findByHex(valueHex);
    const keyboard = decodeKeyboardBinding(valueHex);
    const fire=decodeRapidFireBinding(valueHex),lock=decodeDpiLockBinding(valueHex);
    return Object.freeze({
      value: action ? action.id : CURRENT_VALUE,
      label: action ? action.label : keyboard ? `键盘 · ${keyboardLabel(keyboard.usage,keyboard.modifiers)}（保留）` : fire ? `火力键 · 间隔 ${fire.interval} / ${fire.count===0?'按住持续':fire.count+' 次'}（保留）` : lock ? `DPI 锁定 · ${lock.dpi}（保留）` : macroLoop(valueHex) ? '当前已存宏（保留）' : `当前原值 · ${valueHex}（未映射，只读保留）`,
      valueHex, mapped: Boolean(action), readOnly: !action
    });
  }
  function resolveSelection(selection, currentValueHex) {
    const current = normalized(currentValueHex);
    if (selection === CURRENT_VALUE && !byHex.has(current)) return currentValueHex;
    const action = findById(selection);
    if (!action) throw new TypeError('Choose an official fixed action or preserve the unmapped current value.');
    // Retaining an existing mapped action must not normalize its original PSF text.
    return action.valueHex === current ? currentValueHex : action.valueHex;
  }
  // Official dialog rows: release=1, any-key=4, fixed count=2 (1..255).
  function macroLoop(valueHex) {
    const raw = normalized(valueHex); if (!raw.startsWith('90')) return null;
    const packed = parseInt(raw.slice(2, 4), 16), mode = packed >> 4, count = parseInt(raw.slice(4), 16);
    if (![1, 2, 4].includes(mode) || (mode === 2 ? count < 1 : count !== 0)) return null;
    return Object.freeze({slot: packed & 15, mode, count});
  }
  function withMacroLoop(valueHex, mode, count) {
    const current = macroLoop(valueHex);
    if (!current || ![1, 2, 4].includes(mode) || !Number.isInteger(count) || (mode === 2 ? count < 1 || count > 255 : count !== 0)) throw new TypeError('请选择已确认的宏循环方式及1–255次数。');
    const next = '90' + ((mode << 4) | current.slot).toString(16).padStart(2, '0').toUpperCase() + count.toString(16).padStart(2, '0').toUpperCase();
    return next === normalized(valueHex) ? valueHex : next;
  }
  // The official combo dialog reads VK->HID at620238 (437EF3) and writes
  // 70 / mask / usage. Ctrl=1, Shift=2, Alt=4, Win=8 (437C2A..437C9C).
  const keyboardUsages = Object.freeze([...Array.from({length:98},(_,i)=>i+4),129,130,131,133,135,136,137,138,139,144,145]);
  const namedKeys = Object.freeze({40:'Enter',41:'Escape',42:'Backspace',43:'Tab',44:'Space',45:'-',46:'=',47:'[',48:']',49:'\\',50:'HID 0x32',51:';',52:"'",53:'`',54:',',55:'.',56:'/',57:'Caps Lock',70:'Print Screen',71:'Scroll Lock',72:'Pause',73:'Insert',74:'Home',75:'Page Up',76:'Delete',77:'End',78:'Page Down',79:'→',80:'←',81:'↓',82:'↑',83:'Num Lock',84:'小键盘 /',85:'小键盘 *',86:'小键盘 -',87:'小键盘 +',88:'小键盘 Enter',98:'小键盘 0',99:'小键盘 .',100:'Intl \\',101:'菜单键'});
  const keyboardKeys = Object.freeze(keyboardUsages.map(usage=>Object.freeze({usage,label:usage>=4&&usage<=29?String.fromCharCode(65+usage-4):usage>=30&&usage<=38?String(usage-29):usage===39?'0':usage>=58&&usage<=69?'F'+(usage-57):usage>=89&&usage<=97?'小键盘 '+(usage-88):namedKeys[usage]||'HID 0x'+usage.toString(16).toUpperCase()})));
  const keyCodes = Object.freeze({
    Enter:40,Escape:41,Backspace:42,Tab:43,Space:44,Minus:45,Equal:46,BracketLeft:47,BracketRight:48,
    Backslash:49,Semicolon:51,Quote:52,Backquote:53,Comma:54,Period:55,Slash:56,CapsLock:57,
    PrintScreen:70,ScrollLock:71,Pause:72,Insert:73,Home:74,PageUp:75,Delete:76,End:77,PageDown:78,
    ArrowRight:79,ArrowLeft:80,ArrowDown:81,ArrowUp:82,NumLock:83,NumpadDivide:84,NumpadMultiply:85,
    NumpadSubtract:86,NumpadAdd:87,NumpadEnter:88,Numpad1:89,Numpad2:90,Numpad3:91,Numpad4:92,
    Numpad5:93,Numpad6:94,Numpad7:95,Numpad8:96,Numpad9:97,Numpad0:98,NumpadDecimal:99,
    IntlBackslash:100,ContextMenu:101,ControlLeft:224,ShiftLeft:225,AltLeft:226,MetaLeft:227,
    ControlRight:228,ShiftRight:229,AltRight:230,MetaRight:231
  });
  function keyboardUsageForCode(code) {
    if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3)-65+4;
    if (/^Digit[0-9]$/.test(code)) return Number(code.slice(5)) ? Number(code.slice(5))+29 : 39;
    if (/^F([1-9]|1[0-2])$/.test(code)) return 57+Number(code.slice(1));
    return Object.hasOwn(keyCodes,code) ? keyCodes[code] : null;
  }
  function keyboardBinding(usage,modifiers) {
    if(!Number.isInteger(usage)||!keyboardUsages.includes(usage)||!Number.isInteger(modifiers)||modifiers<0||modifiers>15)throw new TypeError('请选择官方键表中的键，以及 Ctrl / Shift / Alt / Win 组合。');
    return '70'+modifiers.toString(16).padStart(2,'0').toUpperCase()+usage.toString(16).padStart(2,'0').toUpperCase();
  }
  function decodeKeyboardBinding(valueHex) {
    const raw=normalized(valueHex);if(!raw.startsWith('70'))return null;
    const modifiers=parseInt(raw.slice(2,4),16),usage=parseInt(raw.slice(4),16);
    return modifiers<=15&&keyboardUsages.includes(usage)?Object.freeze({usage,modifiers}):null;
  }
  function keyboardLabel(usage,modifiers) {
    keyboardBinding(usage,modifiers);
    return [...['Ctrl','Shift','Alt','Win'].filter((_,index)=>(modifiers&(1<<index))!==0),keyboardKeys.find(item=>item.usage===usage).label].join(' + ');
  }
  function rapidFireBinding(interval,count) {
    if(!Number.isInteger(interval)||interval<5||interval>255||!Number.isInteger(count)||count<0||count>255)throw new TypeError('火力间隔原值须为 5–255，次数须为 0–255；0 表示按住持续。');
    return '30'+interval.toString(16).padStart(2,'0').toUpperCase()+count.toString(16).padStart(2,'0').toUpperCase();
  }
  function decodeRapidFireBinding(valueHex) {
    const raw=normalized(valueHex),interval=parseInt(raw.slice(2,4),16),count=parseInt(raw.slice(4),16);
    return raw.startsWith('30')&&interval>=5?Object.freeze({interval,count}):null;
  }
  const dpiLockOptions=Object.freeze(Array.from({length:11},(_,i)=>(i+2)*100));
  function dpiLockBinding(dpi) {
    if(!dpiLockOptions.includes(dpi))throw new TypeError('请选择官方 DPI 锁定菜单中的 200–1200 档位。');
    return '50'+(dpi/100-1).toString(16).padStart(2,'0').toUpperCase()+'00';
  }
  function decodeDpiLockBinding(valueHex) {
    const raw=normalized(valueHex),code=parseInt(raw.slice(2,4),16);
    return raw.startsWith('50')&&raw.endsWith('00')&&code>=1&&code<=11?Object.freeze({dpi:(code+1)*100}):null;
  }
  return Object.freeze({groups, actions, CURRENT_VALUE, findById, findByHex, describeCurrent, resolveSelection, macroLoop, withMacroLoop,keyboardKeys,keyboardUsageForCode,keyboardBinding,decodeKeyboardBinding,keyboardLabel,rapidFireBinding,decodeRapidFireBinding,dpiLockOptions,dpiLockBinding,decodeDpiLockBinding});
});
