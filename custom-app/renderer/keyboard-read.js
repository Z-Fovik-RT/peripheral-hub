'use strict';
(() => {
  const DEVICE_ID = 'aula-f87-pro';
  const layerNames = ['默认层', 'FN1 层', 'FN2 层', 'Tap 层'];
  const supportedModes = new Set([0, 1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 15, 16, 17, 21]);
  const paletteReadableModes = new Set([1, 2, 4, 5, 7, 8, 10, 11, 12, 13]);
  const records = {identity: null, matrix: new Map(), palette: new Map(), snapshot: null};
  const initialMessages = {identity: '尚未读取设备身份。', matrix: '点击读取当前层，显示设备实际返回的按键动作。', palette: '选择模式后手动读取七个真实 RGB 颜色。', snapshot: '读取PSD、四层矩阵和调色板，保留每块实际长度。'};
  const messages = {...initialMessages};
  const errors = {identity: false, matrix: false, palette: false, snapshot: false};
  const cards = new Map();
  let hooks = {}, busy = false, mounted = false, deviceId = '', deviceRevision = 0;
  let modeSelect, layerSelect, paletteMode = '', lastHardwareMode = '';
  const errorText = error => typeof error?.message === 'string' ? error.message : String(error || '键盘服务异常');
  function readFailureMessage(kind, error) {
    const message=errorText(error);
    if(kind==='matrix'&&/sequence|out of order|missing/i.test(message))
      return '读取失败：无线矩阵分片序号不连续；有限只读重试已耗尽，本层部分数据已丢弃，不能用于恢复。请待设备稳定后再手动重试。';
    return '读取失败：'+message+' 旧读回已清除，请检查连接状态后重试。';
  }

  const byte = value => Number.isInteger(value) && value >= 0 && value <= 255;
  const nullableByte = value => value === null || byte(value);
  const hex = (value, digits = 2) => '0x' + value.toString(16).toUpperCase().padStart(digits, '0');
  const time = stamp => new Date(stamp).toLocaleTimeString('zh-CN', {hour12: false});
  const isTarget = () => deviceId === DEVICE_ID;
  const blocked = () => busy || Boolean(hooks.isBusy?.());
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function readButton(id, text, action) {
    const node = element('button', 'secondary-button', text);
    node.type = 'button'; node.id = id;
    node.addEventListener('click', () => { void action(); });
    return node;
  }
  function currentLayer() {
    const raw = layerSelect?.value;
    return /^[0-3]$/.test(raw || '') ? Number(raw) : null;
  }
  function setBusy(value) {
    busy = value; sync(); hooks.onBusyChange?.(value);
  }
  function publishIdentity(value) {
    records.identity = value;
    hooks.onIdentityChange?.(value ? {...value} : null);
  }
  function invalidate() {
    deviceRevision++;
    records.matrix.clear(); records.palette.clear();
    records.snapshot = null;
    Object.assign(messages, initialMessages);
    for (const kind of Object.keys(errors)) errors[kind] = false;
    paletteMode = ''; lastHardwareMode = ''; busy = false;
    publishIdentity(null);
    if (mounted) {paintIdentity(); paintMatrix(); paintPalette(); paintSnapshot();}
    sync(); hooks.onBusyChange?.(false);
  }
  async function invoke(operation, args = {}) {
    if (typeof window.hub?.features?.invoke !== 'function') throw Error('键盘读取服务尚未就绪，请重启应用。');
    const result = await window.hub.features.invoke({apiVersion: 1, deviceId: DEVICE_ID, operation, args});
    if (result?.ok !== true) throw Error(result?.error?.message || '键盘服务没有返回成功结果。');
    return result.data;
  }
  function validateIdentity(result) {
    const nullableText = value => value === null || typeof value === 'string';
    if (!result || typeof result.family !== 'string' || !result.family.trim() || result.model !== 'F87 PRO' || !nullableText(result.firmware) || !['wired', 'wireless', 'unknown'].includes(result.connection) || !nullableText(result.receiverId) || result.identityVerified !== true || typeof result.psdHex !== 'string' || !/^03000000010b$/i.test(result.psdHex) || typeof result.extraHex !== 'string' || !/^[0-9a-f]{8}$/i.test(result.extraHex)) throw Error('设备身份未验证，或缺少匹配 F87 PRO 的完整 PSD / Extra 原始字节。');
    return {...result, readAt: Date.now()};
  }
  function validateMatrix(result, layer) {
    if (!result || result.layer !== layer || result.matrixComplete !== false || ![504,512].includes(result.actualLength) || result.blockComplete !== (result.actualLength===512) || result.writeBaselineEligible !== false || result.identityVerified!==true || !/^03000000010b$/i.test(result.psdHex||'') || !/^[0-9a-f-]{36}$/i.test(result.containerId||'') || typeof result.markerPresent!=='boolean' || !Array.isArray(result.records) || result.records.length !== result.actualLength/4 || typeof result.rawContentBase64!=='string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.rawContentBase64) || atob(result.rawContentBase64).length!==result.actualLength) throw Error('矩阵响应缺少已核验身份、真实长度或原始字节；单层完整不等于四层快照。');
    const allowed = new Set(['keyboard', 'consumer', 'empty-or-disabled', 'unknown']);
    const clean = result.records.map(item => {
      if (!item || !Number.isInteger(item.index) || item.index < 0 || item.index > 127 || typeof item.rawHex !== 'string' || !/^[0-9a-f]{8}$/i.test(item.rawHex) || !allowed.has(item.kind) || !nullableByte(item.modifiers) || !nullableByte(item.primaryUsage) || !nullableByte(item.secondaryUsage) || !(item.consumerUsage === null || (Number.isInteger(item.consumerUsage) && item.consumerUsage >= 0 && item.consumerUsage <= 65535))) throw Error('矩阵记录缺少有效索引、四字节原值或动作字段。');
      if (item.kind === 'keyboard' && (!byte(item.modifiers) || !byte(item.primaryUsage) || !byte(item.secondaryUsage))) throw Error('键盘动作的修饰键或 Usage 不完整。');
      if (item.kind === 'consumer' && !Number.isInteger(item.consumerUsage)) throw Error('媒体动作缺少 Usage。');
      return {...item, rawHex: item.rawHex.toUpperCase()};
    }).sort((a, b) => a.index - b.index);
    if (clean.some((item, index) => item.index !== index)) throw Error('矩阵索引必须从 0 到 125 连续且唯一。');
    return {layer,matrixComplete:false,blockComplete:result.blockComplete,actualLength:result.actualLength,markerPresent:result.markerPresent,rawContentBase64:result.rawContentBase64,writeBaselineEligible:false,identityVerified:true,psdHex:result.psdHex,containerId:result.containerId,records:clean,readAt:Date.now()};
  }
  function validatePalette(result, modeId) {
    if (!result || result.modeId !== modeId || ![490,512].includes(result.actualLength) || result.blockComplete !== (result.actualLength===512) || result.writeBaselineEligible !== false || result.identityVerified!==true || !/^03000000010b$/i.test(result.psdHex||'') || !/^[0-9a-f-]{36}$/i.test(result.containerId||'') || typeof result.markerPresent!=='boolean' || !Array.isArray(result.colors) || result.colors.length !== 7 || result.colors.some(color => !color || !byte(color.r) || !byte(color.g) || !byte(color.b)) || typeof result.rawContentBase64!=='string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.rawContentBase64) || atob(result.rawContentBase64).length!==result.actualLength) throw Error('调色板缺少已核验身份、真实长度或原始字节。');
    return {modeId,blockComplete:result.blockComplete,actualLength:result.actualLength,markerPresent:result.markerPresent,writeBaselineEligible:false,identityVerified:true,psdHex:result.psdHex,containerId:result.containerId,colors:result.colors.map(({r,g,b})=>({r,g,b})),rawContentBase64:result.rawContentBase64,readAt:Date.now()};
  }
  function validateConfigurationSnapshot(result) {
    const nullableHex=value=>value===null||typeof value==='string'&&/^[0-9a-f]{12}$/i.test(value);
    if(!result||!/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(result.containerId||'')||!(result.instanceId===null||typeof result.instanceId==='string')||!nullableHex(result.identityBeforePsdHex)||!nullableHex(result.identityAfterPsdHex)||!(result.identityStable===null||typeof result.identityStable==='boolean')||typeof result.identityAfterAttempted!=='boolean'||typeof result.snapshotComplete!=='boolean'||result.writeBaselineEligible!==false||!Array.isArray(result.matrices)||result.matrices.length!==4||!result.palette||!(result.failedCommand===null||[5,65,73].includes(result.failedCommand))||!(result.failedSelector===null||Number.isInteger(result.failedSelector)&&result.failedSelector>=0&&result.failedSelector<=3)||!(result.failureMessage===null||typeof result.failureMessage==='string')||typeof result.readAt!=='string') throw Error('同会话快照缺少设备身份、固定层数或只读状态。');
    const validateBlock=(block,kind,index)=>{
      const lengths=kind==='palette'?[490,512]:[504,512];
      if(!block||typeof block.attempted!=='boolean'||!(block.actualLength===null||lengths.includes(block.actualLength))||typeof block.blockComplete!=='boolean'||block.blockComplete!==(block.actualLength===512)||!(block.markerPresent===null||typeof block.markerPresent==='boolean')||!(block.rawContentBase64===null||typeof block.rawContentBase64==='string'))throw Error('同会话快照的'+kind+'块形状无效。');
      if(kind==='matrix'&&block.layer!==index)throw Error('矩阵层顺序无效。');
      if(block.rawContentBase64===null){if(block.actualLength!==null||block.blockComplete||block.markerPresent!==null)throw Error('未收到的快照块不能伪造长度或标记。');return {...block};}
      if(!block.attempted||!/^[A-Za-z0-9+/]+={0,2}$/.test(block.rawContentBase64))throw Error('快照块原始字节编码无效。');
      const raw=atob(block.rawContentBase64);if(raw.length!==block.actualLength)throw Error('快照块原始长度与设备返回长度不一致。');
      const marker=block.actualLength===512&&(kind==='palette'?raw.charCodeAt(506)===0x5a&&raw.charCodeAt(507)===0xa5:raw.charCodeAt(508)===0&&raw.charCodeAt(509)===0&&raw.charCodeAt(510)===0x5a&&raw.charCodeAt(511)===0xa5);
      if(block.markerPresent!==(block.actualLength===512?marker:null))throw Error('快照块标记状态与原始字节不一致。');
      return {...block};
    };
    const matrices=result.matrices.map((block,index)=>validateBlock(block,'matrix',index)),palette=validateBlock(result.palette,'palette',0);
    if(result.identityAfterPsdHex!==null&&!result.identityAfterAttempted)throw Error('末尾PSD读回缺少对应查询状态。');
    if(result.identityStable===true&&(!result.identityAfterAttempted||result.identityBeforePsdHex!=='03000000010B'||result.identityAfterPsdHex!=='03000000010B'))throw Error('PSD稳定状态未匹配F87 PRO前后身份。');
    if(result.snapshotComplete!==(result.identityStable===true&&matrices.every(block=>block.blockComplete)&&palette.blockComplete))throw Error('完整状态不能替代每层实际长度和PSD复核。');
    return {...result,matrices,palette,readAt:Date.parse(result.readAt)};
  }
  function layoutKeys() {
    const keys = window.HUB_KEYBOARD_LAYOUT?.keys;
    if (!Array.isArray(keys) || keys.length !== 87 || keys.some(key => !key || typeof key.id !== 'string' || typeof key.label !== 'string' || !Number.isInteger(key.matrixIndex) || key.matrixIndex < 0 || key.matrixIndex > 125) || new Set(keys.map(key => key.matrixIndex)).size !== 87) throw Error('87 键布局缺少唯一、有效的矩阵索引，无法对应实际动作。');
    return keys;
  }
  function usageText(usage) {
    if (usage === 0) return '';
    if (usage >= 4 && usage <= 29) return String.fromCharCode(65 + usage - 4);
    if (usage >= 30 && usage <= 38) return String(usage - 29);
    if (usage >= 58 && usage <= 69) return 'F' + (usage - 57);
    if (usage >= 104 && usage <= 115) return 'F' + (usage - 91);
    const names = {39: '0', 40: 'Enter', 41: 'Esc', 42: 'Backspace', 43: 'Tab', 44: 'Space', 45: '-', 46: '=', 47: '[', 48: ']', 49: '\\', 50: 'Non-US #', 51: ';', 52: "'", 53: '`', 54: ',', 55: '.', 56: '/', 57: 'Caps Lock', 70: 'Print Screen', 71: 'Scroll Lock', 72: 'Pause', 73: 'Insert', 74: 'Home', 75: 'Page Up', 76: 'Delete', 77: 'End', 78: 'Page Down', 79: '→', 80: '←', 81: '↓', 82: '↑', 83: 'Num Lock', 84: 'Num /', 85: 'Num *', 86: 'Num -', 87: 'Num +', 88: 'Num Enter', 89: 'Num 1', 90: 'Num 2', 91: 'Num 3', 92: 'Num 4', 93: 'Num 5', 94: 'Num 6', 95: 'Num 7', 96: 'Num 8', 97: 'Num 9', 98: 'Num 0', 99: 'Num .', 100: 'Non-US \\', 101: 'Application', 102: 'Power', 103: 'Num =', 224: '左 Ctrl', 225: '左 Shift', 226: '左 Alt', 227: '左 Win', 228: '右 Ctrl', 229: '右 Shift', 230: '右 Alt', 231: '右 Win'};
    return names[usage] || '键盘 Usage ' + hex(usage);
  }
  function actionText(item) {
    if (item.kind === 'empty-or-disabled') return '空记录 / 禁用（设备未区分）';
    if (item.kind === 'unknown') return '未解析动作 · 保留原始记录';
    if (item.kind === 'consumer') {
      const labels = {0x30: '电源', 0x32: '休眠', 0xB0: '播放', 0xB1: '暂停', 0xB5: '下一曲', 0xB6: '上一曲', 0xB7: '停止', 0xCD: '播放 / 暂停', 0xE2: '静音', 0xE9: '音量增加', 0xEA: '音量减小', 0x183: '媒体播放器', 0x18A: '邮件', 0x192: '计算器', 0x194: '文件浏览器', 0x221: '搜索', 0x223: '浏览器主页', 0x224: '浏览器后退', 0x225: '浏览器前进', 0x226: '浏览器停止', 0x227: '浏览器刷新', 0x22A: '书签'};
      return (labels[item.consumerUsage] || '媒体动作') + ' · Consumer ' + hex(item.consumerUsage, 4);
    }
    const modifiers = ['左 Ctrl', '左 Shift', '左 Alt', '左 Win', '右 Ctrl', '右 Shift', '右 Alt', '右 Win'].filter((_, index) => item.modifiers & (1 << index));
    const usages = [item.primaryUsage, item.secondaryUsage].filter(usage => usage !== 0).map(usageText);
    return [...modifiers, ...usages].join(' + ') || '键盘记录 · 无修饰键或 Usage';
  }
  function rawText(rawHex) { return rawHex.match(/../g).join(' '); }
  function paintIdentity() {
    const card = cards.get('identity'); if (!card) return;
    card.body.replaceChildren();
    if (records.identity) {
      const data = records.identity, facts = element('dl', 'keyboard-read-facts');
      const connection = {wired: '有线', wireless: '无线', unknown: '未知'}[data.connection];
      for (const [label, value] of [['系列', data.family], ['型号', data.model ?? '设备未提供'], ['固件', data.firmware ?? '设备未提供'], ['连接', connection], ['接收器 ID', data.receiverId ?? '设备未提供']]) {
        const row = element('div'); row.append(element('dt', '', label), element('dd', '', value)); facts.append(row);
      }
      card.body.append(facts);
      if (data.psdHex || data.extraHex) {
        const details = element('details', 'keyboard-read-raw'); details.append(element('summary', '', '设备身份原始字节'));
        if (data.psdHex) details.append(element('p', '', 'PSD · ' + rawText(data.psdHex)));
        if (data.extraHex) details.append(element('p', '', 'Extra · ' + rawText(data.extraHex)));
        card.body.append(details);
      }
    }
  }
  function matrixRow(label, item, keyId) {
    const row = element('tr'); row.dataset.matrixIndex = String(item.index);
    if (keyId) row.dataset.keyId = keyId;
    row.append(element('th', '', label), element('td', 'keyboard-read-index', String(item.index)), element('td', item.kind === 'unknown' ? 'keyboard-read-unknown' : '', actionText(item)), element('td', 'keyboard-read-hex', rawText(item.rawHex)));
    row.firstChild.scope = 'row'; return row;
  }
  function matrixTable(rows) {
    const scroll = element('div', 'keyboard-read-table-scroll'), table = element('table', 'keyboard-read-table');
    const head = element('thead'), headers = element('tr');
    for (const text of ['按键', '矩阵', '实际读回动作', '原始 4 字节']) {const th = element('th', '', text); th.scope = 'col'; headers.append(th);}
    head.append(headers); const body = element('tbody'); for (const row of rows) body.append(row);
    table.append(head, body); scroll.append(table); return scroll;
  }
  function paintMatrix() {
    const card = cards.get('matrix'); if (!card) return;
    card.body.replaceChildren();
    const data = records.matrix.get(currentLayer());
    if (!data) return;
    try {
      const keys = layoutKeys(), mapped = new Set(keys.map(key => key.matrixIndex));
      const rows = keys.map(key => matrixRow(key.label, data.records[key.matrixIndex], key.id));
      const note = element('p', 'small-note', layerNames[data.layer] + ' · 本层实际读回 '+data.records.length+' 条 / '+data.actualLength+' 字节；其他层需分别读取，当前未形成四层完整快照；'+(data.blockComplete?'长度完整，尾部标记'+(data.markerPresent?'存在':'未找到'):'隐藏尾部未读取')+'，不能作为恢复基线。');
      card.body.append(note, matrixTable(rows));
      const extra = element('details', 'keyboard-read-extra'); extra.append(element('summary', '', '查看布局外的 ' + (data.records.length - keys.length) + ' 条矩阵记录'));
      extra.append(matrixTable(data.records.filter(item => !mapped.has(item.index)).map(item => matrixRow('未映射布局', item)))); card.body.append(extra);
    } catch (error) {card.body.append(element('p', 'keyboard-read-error', errorText(error)));}
  }
  function isPaletteModeOption(option) {
    const id=Number(option?.value);
    return Boolean(option&&!option.disabled&&/^\d+$/.test(option.value)&&supportedModes.has(id)&&paletteReadableModes.has(id)&&option.dataset?.paletteReadable==='true');
  }
  function availableModes() {
    const existing = document.getElementById('mode-select');
    if (!existing) return [];
    return [...existing.options].filter(isPaletteModeOption).map(option => ({id: Number(option.value), name: option.textContent}));
  }
  function syncModes() {
    if (!modeSelect) return;
    const options = availableModes(), hardwareMode = document.getElementById('mode-select')?.value || '';
    if (hardwareMode !== lastHardwareMode && options.some(mode => String(mode.id) === hardwareMode)) paletteMode = hardwareMode;
    lastHardwareMode = hardwareMode;
    const signature = JSON.stringify(options);
    if (modeSelect.dataset.options !== signature) {
      modeSelect.replaceChildren(); const empty = element('option', '', '选择模式'); empty.value = ''; modeSelect.append(empty);
      for (const mode of options) {const option = element('option', '', mode.name); option.value = String(mode.id); modeSelect.append(option);}
      modeSelect.dataset.options = signature;
    }
    modeSelect.value = paletteMode;
  }
  function paintPalette() {
    const card = cards.get('palette'); if (!card) return;
    card.body.replaceChildren();
    const data = records.palette.get(Number(paletteMode)); if (paletteMode === '' || !data) return;
    card.body.append(element('p', 'small-note', '模式 ' + data.modeId + ' · 无线接口实际读回 '+data.actualLength+' 字节 · 显示七个 RGB 颜色；'+(data.blockComplete?'长度完整，尾部标记'+(data.markerPresent?'存在':'未找到'):'隐藏尾部未读取')+'，不能作为恢复基线。'));
    const colors = element('div', 'keyboard-read-colors');
    data.colors.forEach((color, index) => {
      const item = element('div', 'keyboard-read-color'), swatch = element('span', 'keyboard-read-swatch');
      swatch.style.backgroundColor = `rgb(${color.r}, ${color.g}, ${color.b})`;
      const colorHex = '#' + [color.r, color.g, color.b].map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase();
      swatch.setAttribute('aria-label', '颜色 ' + (index + 1) + ' ' + colorHex);
      item.append(swatch, element('strong', '', '颜色 ' + (index + 1)), element('code', '', colorHex), element('small', '', `${color.r}, ${color.g}, ${color.b}`)); colors.append(item);
    });
    card.body.append(colors);
  }
  function paintSnapshot() {
    const card=cards.get('snapshot');if(!card)return;card.body.replaceChildren();const data=records.snapshot;if(!data)return;
    const facts=element('dl','keyboard-read-facts keyboard-read-snapshot-facts');
    for(const [label,value] of [['接收器 ContainerId',data.containerId],['设备 InstanceId',data.instanceId||'未提供'],['读取状态',data.snapshotComplete?'全部配置块达到完整长度 · 前后PSD一致':'部分读取或身份复核未完成'],['写入基线','不可用']]){const row=element('div');row.append(element('dt','',label),element('dd','',value));facts.append(row);}
    card.body.append(facts);
    const identity=element('p','small-note','PSD 前：'+(data.identityBeforePsdHex||'未取得')+' · PSD 后：'+(data.identityAfterAttempted?(data.identityAfterPsdHex||'查询失败'):'未查询')+' · 稳定：'+(data.identityStable===null?'未知':data.identityStable?'是':'否'));
    card.body.append(identity);
    const note=element('p','small-note','此为同一 HID 会话的原始只读读取。完整长度不等于标记有效、动作已解释或可安全恢复；本结果不会进入可写草稿。');card.body.append(note);
    const table=element('div','keyboard-read-table-scroll keyboard-read-snapshot-blocks'),grid=element('table','keyboard-read-table'),head=element('thead'),header=element('tr');
    for(const label of ['数据块','实际长度','尾部标记','原始字节']){const th=element('th','',label);th.scope='col';header.append(th);}head.append(header);const body=element('tbody');
    const rows=[...data.matrices.map(block=>({label:layerNames[block.layer]+' 矩阵',kind:'matrix',block})),{label:'RGB 调色板',kind:'palette',block:data.palette}];
    for(const {label,kind,block} of rows){const row=element('tr'),name=element('th','',label),length=element('td','',block.actualLength===null?(block.attempted?'查询未返回':'未尝试'):block.actualLength+' 字节'),marker=element('td','',block.actualLength===null?'未知':block.actualLength===512?(block.markerPresent?'存在':'未找到'):'尾部标记位置未返回'),rawCell=element('td');name.scope='row';
      if(block.rawContentBase64){const details=element('details','keyboard-read-raw'),summary=element('summary','','查看原始字节');let raw='';for(const char of atob(block.rawContentBase64))raw+=char.charCodeAt(0).toString(16).padStart(2,'0').toUpperCase()+' ';details.append(summary,element('code','keyboard-read-raw-bytes',raw.trim()));rawCell.append(details);}else rawCell.textContent='无数据';row.append(name,length,marker,rawCell);body.append(row);}
    grid.append(head,body);table.append(grid);card.body.append(table);
    if(data.failedCommand!==null)card.body.append(element('p','keyboard-read-error','首次失败：命令 '+hex(data.failedCommand)+(data.failedSelector===null?'':' · 选择器 '+hex(data.failedSelector))+' · '+(data.failureMessage||'设备查询未完成。')));
  }
  async function read(kind) {
    if (!isTarget() || blocked() || hooks.isConnected?.() === false) return;
    const revision = deviceRevision;
    const layer = currentLayer(), modeId = paletteMode === '' ? null : Number(paletteMode);
    if (kind === 'matrix' && layer === null) return;
    if (kind === 'palette' && (modeId === null || !availableModes().some(mode => mode.id === modeId))) return;
    if (kind === 'identity') publishIdentity(null);
    if (kind === 'matrix') records.matrix.delete(layer);
    if (kind === 'palette') records.palette.delete(modeId);
    if (kind === 'snapshot') records.snapshot = null;
    messages[kind] = '正在读取设备回应…'; errors[kind] = false; paintIdentity(); paintMatrix(); paintPalette(); paintSnapshot(); setBusy(true);
    try {
      let result;
      if (kind === 'identity') result = validateIdentity(await invoke('keyboard.identity.read'));
      if (kind === 'matrix') result = validateMatrix(await invoke('keyboard.bindings.snapshot.read', {layer}), layer);
      if (kind === 'palette') result = validatePalette(await invoke('keyboard.palette.read', {modeId}), modeId);
      if (kind === 'snapshot') result = validateConfigurationSnapshot(await invoke('keyboard.configuration.snapshot.read'));
      if (revision !== deviceRevision) return;
      if (kind === 'identity') publishIdentity(result);
      if (kind === 'matrix') {records.matrix.set(layer, result); window.keyboardDrafts?.captureMatrix(result);}
      if (kind === 'palette') {records.palette.set(modeId, result); window.keyboardDrafts?.capturePalette(result);}
      if (kind === 'snapshot') records.snapshot = result;
      messages[kind] = kind === 'identity' ? '已读取并验证设备身份。' : '已读取真实硬件快照；本面板只读，此快照不能作为写入基线。';
      if(kind==='snapshot'){messages.snapshot=result.failedCommand!==null?'读取在首个失败处停止，已保留此前实际返回的块；不能用作恢复基线。':result.snapshotComplete?'已收到全部配置块并复核PSD；只读结果仍不可作为写入基线。':'已保留每块实际返回长度；短块未补齐，不能作为写入基线。';errors.snapshot=result.failedCommand!==null;}
    } catch (error) { if (revision === deviceRevision) {
      messages[kind] = readFailureMessage(kind, error);
      errors[kind] = true;
    } }
    finally {if (revision === deviceRevision) {paintIdentity(); paintMatrix(); paintPalette(); paintSnapshot(); setBusy(false);}}
  }
  function sync() {
    if (!mounted) return;
    const previousMode = paletteMode;
    syncModes();
    if (previousMode !== paletteMode) paintPalette();
    const locked = blocked(), active = isTarget();
    for (const [kind, card] of cards) {
      card.section.hidden = !active; card.section.setAttribute('aria-busy', String(busy));
      const data = kind === 'identity' ? records.identity : kind === 'matrix' ? records.matrix.get(currentLayer()) : kind === 'palette' ? (paletteMode === '' ? null : records.palette.get(Number(paletteMode))) : records.snapshot;
      card.button.disabled = !active || locked || hooks.isConnected?.() === false || (kind === 'matrix' && currentLayer() === null) || (kind === 'palette' && (paletteMode === '' || !availableModes().some(mode => String(mode.id) === paletteMode)));
      card.chip.textContent = data ? '硬件只读快照' : '尚无当前读回'; card.chip.className = 'setting-capability ' + (data ? 'enabled' : 'pending');
      card.source.textContent = data ? '硬件读回 · ' + time(data.readAt) : '来源：等待手动读取设备';
      card.message.textContent = data || errors[kind] ? messages[kind] : kind === 'matrix' ? '当前' + (currentLayer() === null ? '层未选择' : layerNames[currentLayer()]) + '尚未读取。' : kind === 'palette' ? '当前模式尚未读取；选择模式不会访问设备。' : messages[kind];
      card.message.dataset.error = String(errors[kind]);
    }
    modeSelect.disabled = !active || locked;
  }
  function makeCard(kind, title, buttonLabel, host) {
    const section = element('section', 'setting-card keyboard-read-card'); section.id = 'keyboard-read-' + kind;
    const heading = element('div', 'subheading'), chip = element('span', 'setting-capability pending', '尚未读取');
    heading.append(element('h3', '', title), chip);
    const button = readButton('keyboard-read-' + kind + '-button', buttonLabel, () => read(kind));
    const body = element('div', 'keyboard-read-body'), source = element('p', 'source-label'), message = element('p', 'small-note');
    message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    section.append(heading, button, body, source, message); host.append(section);
    cards.set(kind, {section, chip, button, body, source, message}); return section;
  }
  function mount() {
    if (mounted) return;
    const keysHost = document.getElementById('page-keys'), lightingHost = document.getElementById('page-lighting');
    if (!keysHost || !lightingHost || document.getElementById('keyboard-read-matrix')) return;
    makeCard('identity', '键盘型号与固件', '读取设备身份', keysHost);
    const matrix = makeCard('matrix', '实际按键动作', '读取当前层实际映射', keysHost);
    matrix.insertBefore(element('p', 'small-note', '沿用上方层选择。逐键显示实际读回动作和原始四字节；未知动作保留原值。读取不会更改设备。'), cards.get('matrix').button);
    const snapshot=makeCard('snapshot','四层与调色板同会话快照','读取全部原始配置块',keysHost);
    snapshot.insertBefore(element('p','small-note','单次只读事务依次核验PSD、四层矩阵和RGB调色板。返回实际字节数、末尾标记与首个失败位置；不会写设备或建立恢复记录。'),cards.get('snapshot').button);
    const palette = makeCard('palette', '模式 RGB 调色板', '读取所选模式调色板', lightingHost);
    const label = element('label', 'keyboard-read-mode', '读取模式'); modeSelect = element('select'); modeSelect.id = 'keyboard-read-mode';
    modeSelect.addEventListener('change', () => {if (blocked()) {modeSelect.value = paletteMode; return;} paletteMode = modeSelect.value; errors.palette = false; paintPalette(); sync();});
    label.append(modeSelect); palette.insertBefore(label, cards.get('palette').button);
    palette.insertBefore(element('p', 'small-note', '这里只读取模式颜色；选择模式不会切换设备灯效。七个 RGB 值按设备顺序显示。'), label);
    layerSelect = document.getElementById('key-layer');
    layerSelect?.addEventListener('change', () => {errors.matrix = false; paintMatrix(); sync();});
    mounted = true; sync();
  }
  window.keyboardReads = {
    init(options = {}) {hooks = options; mount(); sync();},
    isBusy: () => busy,
    sync,
    invalidate,
    setDevice(id) {
      window.keyboardDrafts?.setDevice(id);
      if (deviceId !== id) {
        deviceId = id;
        invalidate();
      } else sync();
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once: true});
  else mount();
})();
