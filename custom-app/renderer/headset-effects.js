'use strict';
(() => {
  const DEVICE_ID = 'ikf-v11-pro-71';
  const flows = ['render', 'capture'];
  const flowNames = {render: '播放', capture: '录音'};
  const frequencies = ['31', '63', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
  const numberField = (key, title, min, max, unit = '') => ({key, title, min, max, unit});
  const selectField = (key, title, choices) => ({key, title, choices});
  const definitions = [
    {key: 'eq', title: '十段均衡器', flow: 'render', fields: [
      {key: 'bandsRaw', title: '频段增益', bands: true, min: -20, max: 20, unit: 'dB'}
    ]},
    {key: 'surround71', title: '7.1 耳机环绕', flow: 'render', fields: [
      selectField('modeRaw', '场景', [[0, '音乐 / 游戏'], [1, '电影']]),
      selectField('roomSizeRaw', '空间大小', [[2, '小'], [1, '中'], [0, '大']])
    ]},
    {key: 'brilliant', title: '声音明亮化', flow: 'render', fields: [numberField('levelRaw', '强度', 0, 10)]},
    {key: 'dynamicBass', title: '动态低频', flow: 'render', note: '模式保留当前读值。', fields: [
      {key: 'modeRaw', title: '模式（原始值，只读）', readOnly: true},
      numberField('levelRaw', '强度', 0, 10),
      selectField('cutoffRaw', '截止频率', [100, 150, 200, 300, 400].map(value => [value, value + ' Hz']))
    ]},
    {key: 'smartVolume', title: '智能音量', flow: 'render', fields: [
      numberField('levelRaw', '强度', 0, 100),
      selectField('modeRaw', '模式', [[0, '音乐'], [1, '语音']])
    ]},
    {key: 'voiceClarity', title: '人声清晰', flow: 'render', fields: [
      numberField('levelRaw', '强度', 0, 10),
      selectField('noiseSuppressionRaw', '噪声抑制', [0, 5, 10, 15, 20].map(value => [value, value + ' dB']))
    ]},
    {key: 'surroundMax', title: '环绕扩增 · Surround Max', flow: 'render', fields: []},
    {key: 'mic.magicVoice', title: '魔幻音效', flow: 'capture', fields: [
      selectField('selectionRaw', '音色', [[0, '怪兽'], [1, '卡通'], [2, '男声'], [3, '女声']])
    ]},
    {key: 'mic.nr', title: '麦克风降噪', flow: 'capture', fields: [numberField('levelRaw', '降噪强度', 6, 40)]}
  ];

  let busy = false, writing = false;
  const pending = new Map();
  let presetSelect, presetRadioGroup, presetMenu, presetName, presetSave, presetMessage, presets = [], presetsReady = false, needsRead = true;
  let presetFile, presetImport, presetExport, presetTransferStatus;
  let hooks = {};
  let mounted = false;
  let listed = false;
  let endpoints = [];
  const selected = {render: '', capture: ''};
  const records = new Map();
  const cards = new Map();
  const selectors = new Map();
  let section, readButton, restoreButton, status;

  const copy = value => JSON.parse(JSON.stringify(value));
  const errorText = error => error && typeof error.message === 'string' ? error.message : String(error);
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, className) {
    const node = element('button', className, text);
    node.type = 'button';
    return node;
  }
  function externalBusy() {
    return Boolean(hooks.isBusy ? hooks.isBusy() : window.deviceControls?.isBusy?.());
  }
  function blocked() { return busy || externalBusy(); }
  function setBusy(value) {
    busy = value;
    sync();
    if (typeof hooks.onBusyChange === 'function') hooks.onBusyChange(value);
  }
  async function invoke(operation, args = {}) {
    if (typeof window.hub?.features?.invoke !== 'function') throw Error('耳机音效服务尚未就绪，请重启应用。');
    const response = await window.hub.features.invoke({apiVersion: 1, deviceId: DEVICE_ID, operation, args});
    if (!response || response.ok !== true) throw Error(response?.error?.message || '音效服务未返回成功结果。');
    return response.data;
  }
  function getRecord(definition, endpointId = selected[definition.flow]) {
    if (!endpointId) return null;
    if (!records.has(endpointId)) records.set(endpointId, new Map());
    const group = records.get(endpointId);
    if (!group.has(definition.key)) group.set(definition.key, {
      draft: null, readback: null, dirty: false, error: false, message: '尚未读取。', readAt: null
    });
    return group.get(definition.key);
  }
  function validateShape(definition, state) {
    if (!state || typeof state !== 'object' || Array.isArray(state) || typeof state.enabled !== 'boolean') throw Error('音效状态缺少有效的启用开关。');
    const clean = {enabled: state.enabled};
    for (const field of definition.fields) {
      const value = state[field.key];
      if (field.bands) {
        if (!Array.isArray(value) || value.length !== 10 || value.some(n => !Number.isInteger(n))) throw Error('未返回完整的十段均衡器数据。');
        clean[field.key] = [...value];
      } else {
        if (!Number.isInteger(value)) throw Error('未返回有效的「' + field.title + '」。');
        clean[field.key] = value;
      }
    }
    return clean;
  }
  function verifiedState(definition, result, endpointId, applied = false) {
    if (!result || result.endpointId !== endpointId) throw Error('返回的音频端点与请求不一致。');
    const reasons = {
      unknown: '尚未确认此项支持状态', unsupported: '此端点未支持此项',
      'license-error': '音效许可读取失败', 'device-error': '设备访问失败', 'property-error': '音效属性读取失败'
    };
    if (result.support !== 'supported') throw Error(reasons[result.support] || '未确认此项可用');
    if (!['sdk','windows-effect-store'].includes(result.source) || result.verified !== true) throw Error('尚未取得经过验证的音效属性读回。');
    if (applied && result.applied !== true) throw Error('未确认设置已应用。');
    return validateShape(definition, result.state);
  }
  function draftState(definition, record) {
    if (!record?.draft) throw Error('请先读取此项的当前状态。');
    const next = {enabled: record.draft.enabled};
    for (const field of definition.fields) {
      if (field.readOnly) {
        const current = record.readback?.[field.key] ?? record.draft[field.key];
        if (!Number.isInteger(current)) throw Error('请重新读取「' + field.title + '」。');
        next[field.key] = current;
        continue;
      }
      const parse = raw => {
        if (raw === '' || raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) throw Error('请填写「' + field.title + '」。');
        const value = Number(raw);
        if (!Number.isInteger(value)) throw Error('「' + field.title + '」须为整数。');
        if (field.choices && !field.choices.some(([allowed]) => allowed === value)) throw Error('「' + field.title + '」请选择已开放的参数值。');
        if (!field.choices && (value < field.min || value > field.max)) throw Error('「' + field.title + '」范围为 ' + field.min + '–' + field.max + (field.unit ? ' ' + field.unit : '') + '。');
        return value;
      };
      next[field.key] = field.bands ? record.draft[field.key].map(parse) : parse(record.draft[field.key]);
    }
    return next;
  }
  const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  function difference(definition, record) {
    if (!record?.draft || !record.readback) return Boolean(record?.dirty);
    try { return !equal(draftState(definition, record), record.readback); } catch { return true; }
  }
  function summarize(definition, state) {
    const values = [state.enabled ? '已启用' : '已关闭'];
    for (const field of definition.fields) {
      const value = state[field.key];
      if (field.bands) values.push(value.map((gain, index) => frequencies[index] + ' Hz ' + (gain > 0 ? '+' : '') + gain + ' dB').join(' / '));
      else {
        const label = field.choices?.find(([raw]) => raw === value)?.[1];
        values.push(field.title + '：' + (label ?? (String(value) + (field.unit ? ' ' + field.unit : ''))));
      }
    }
    return values.join(' · ');
  }
  function invalidateAll(message) {
    for (const group of records.values()) for (const record of group.values()) {
      record.readback = null;
      record.readAt = null;
      record.version = (record.version || 0) + 1;
      record.generation = (record.generation || 0) + 1;
      if (message) { record.message = message; record.error = false; }
    }
  }
  function fillSelect(input, choices, value) {
    input.replaceChildren();
    const empty = element('option', '', '尚未读取');
    empty.value = '';
    empty.disabled = true;
    input.append(empty);
    for (const [raw, text] of choices) {
      const option = element('option', '', text);
      option.value = String(raw);
      input.append(option);
    }
    if (value !== undefined && value !== null && value !== '' && !choices.some(([raw]) => String(raw) === String(value))) {
      const unknown = element('option', '', '当前值 ' + value + '（暂不可应用）');
      unknown.value = String(value);
      unknown.disabled = true;
      input.append(unknown);
    }
    input.value = value === undefined || value === null ? '' : String(value);
  }
  function paintDraft(definition) {
    const card = cards.get(definition.key), record = getRecord(definition);
    if (!card) return;
    card.enabled.checked = record?.draft?.enabled === true;
    if (definition.key === 'eq' && presetSelect && presetRadioGroup) {
      const bands = record?.draft?.bandsRaw?.map(Number);
      const official = presets.find(preset => preset.origin === 'official' && equal(preset.bandsRaw, bands));
      const custom = presets.find(preset => preset.origin === 'user' && preset.id === record?.profileId);
      presetSelect.value = custom?.id || ''; presetSelect.textContent = custom ? custom.name : '自定义设定档';
      for (const option of presetMenu.querySelectorAll('[data-eq-profile]')) option.setAttribute('aria-selected', String(option.dataset.eqProfile === custom?.id));
      for (const radio of presetRadioGroup.querySelectorAll('input')) radio.checked = radio.value === official?.id;
    }
    for (const control of card.controls) {
      const value = control.index === undefined ? record?.draft?.[control.field.key] : record?.draft?.[control.field.key]?.[control.index];
      if (control.choice !== undefined) control.input.checked = String(value) === String(control.choice);
      else if (control.ticks) control.input.value = String(Math.max(0, control.ticks.indexOf(Number(value))));
      else control.input.value = value === undefined || value === null ? '' : String(value);
      if (control.output) control.output.textContent = value === undefined || value === null ? '—' : control.ticks ? (control.field.choices.find(([raw]) => raw === Number(value))?.[1] || String(value)) : value + (control.field.unit ? ' ' + control.field.unit : '');
    }
  }
  function sync() {
    if (!mounted) return;
    const locked = blocked();
    section.setAttribute('aria-busy', String(busy));
    readButton.disabled = locked;
    readButton.textContent = busy ? '耳机音效操作中…' : '读取耳机音效';
    restoreButton.disabled = locked;
    if (presetFile) {
      presetFile.disabled = locked; presetImport.disabled = locked || !presetFile.files.length;
      presetExport.disabled = locked;
    }
    for (const flow of flows) selectors.get(flow).disabled = locked || !endpoints.some(endpoint => endpoint.flow === flow);
    for (const definition of definitions) {
      const card = cards.get(definition.key), record = getRecord(definition);
      const masterLocked=window.headsetMaster?.isEffectLocked(selected[definition.flow])??true;
      const canEdit = !externalBusy() && (!busy || writing) && !masterLocked && Boolean(record?.draft && record?.readback);
      card.enabled.disabled = !canEdit;
      if (definition.key === 'surround71') window.headsetVoiceTest?.update({endpointId:selected.render,surroundEnabled:record?.draft?.enabled === true,enabled:!locked && canEdit && record?.readback?.enabled === true && record?.draft?.enabled === true});
      for (const control of card.controls) control.input.disabled = control.field.readOnly || !canEdit || record?.draft?.enabled !== true;
      for (const reset of card.resets || []) reset.disabled = !canEdit || record?.draft?.enabled !== true;
      let invalid = '';
      if (record?.draft) { try { draftState(definition, record); } catch (error) { invalid = errorText(error); } }
      const dirty = difference(definition, record);
      if (definition.key === 'eq' && presetSelect) {
        const enabled = canEdit && record?.draft?.enabled === true && presetsReady;
        presetSelect.disabled = !enabled; presetName.disabled = !enabled || busy;
        presetSave.disabled = !enabled || busy || record?.enableSave !== true || Boolean(invalid);
        for (const input of presetRadioGroup.querySelectorAll('input')) input.disabled = !enabled;
        for (const button of presetMenu.querySelectorAll('button')) button.disabled = !enabled || busy;
        if (!enabled || busy) setPresetMenu(false);
      }
      card.chip.textContent = record?.readback ? (dirty ? '正在同步' : '与音效属性读回一致') : record?.draft ? '请重新读取' : '尚未读取';
      card.chip.className = 'setting-capability ' + (record?.readback ? 'enabled' : 'pending');
      card.readback.textContent = record?.readback ? summarize(definition, record.readback) : '尚未取得当前音效属性读回';
      card.source.textContent = record?.readback ? '音效属性 · 已读回 · ' + new Date(record.readAt).toLocaleTimeString('zh-CN', {hour12: false}) : '来源：等待读取音效属性';
      const noEndpoint = listed ? '未检测到' + flowNames[definition.flow] + '端点，请连接耳机后重新读取。' : '点击「读取耳机音效」列出端点并读取当前播放与录音音效。';
      card.status.textContent = (record?.message || noEndpoint) + (invalid && record?.draft ? ' ' + invalid : '');
      card.status.setAttribute('data-error', String(Boolean(record?.error || invalid)));
      card.status.setAttribute('role', record?.error ? 'alert' : 'status');
    }
  }
  function edit(definition, field, input, index) {
    const record = getRecord(definition);
    if (externalBusy() || (busy && !writing) || window.headsetMaster?.isEffectLocked(selected[definition.flow]) || !record?.readback || !record?.draft || field?.readOnly || (field && !record.draft.enabled)) { paintDraft(definition); return; }
    if (field?.bands && Number(record.draft[field.key][index]) === Number(input.value)) return;
    if (!field) record.draft.enabled = input.checked;
    else if (index === undefined) record.draft[field.key] = input.value;
    else record.draft[field.key][index] = input.value;
    record.dirty = record.readback ? difference(definition, record) : true;
    record.version = (record.version || 0) + 1;
    if (definition.key === 'eq' && field?.bands && presetSelect) { clearPresetChoice(); matchCustomPreset(record); paintDraft(definition); }
    record.message = '正在同步当前选择…';
    sync();
    void apply(definition);
  }
  function renderEndpoints() {
    for (const flow of flows) {
      const input = selectors.get(flow), list = endpoints.filter(endpoint => endpoint.flow === flow);
      if (!list.some(endpoint => endpoint.id === selected[flow])) selected[flow] = list[0]?.id || '';
      input.replaceChildren();
      if (!list.length) {
        const option = element('option', '', listed ? '未检测到' + flowNames[flow] + '端点' : '点击读取后列出端点');
        option.value = '';
        input.append(option);
      }
      for (const endpoint of list) {
        const option = element('option', '', endpoint.name || endpoint.id);
        option.value = endpoint.id;
        input.append(option);
      }
      input.value = selected[flow];
    }
    for (const definition of definitions) paintDraft(definition);
    sync();
  }
  async function readAll() {
    if (blocked()) return;
    needsRead = false;
    setBusy(true);
    invalidateAll('正在读取当前音效…');
    status.textContent = '正在列出耳机的播放与录音端点…';
    try {
      const result = await invoke('headset.audio.list');
      if (!result || !Array.isArray(result.endpoints) || result.endpoints.some(endpoint => !endpoint || typeof endpoint.id !== 'string' || !endpoint.id || typeof endpoint.name !== 'string' || !flows.includes(endpoint.flow))) throw Error('端点列表格式不完整。');
      if (new Set(result.endpoints.map(endpoint => endpoint.id)).size !== result.endpoints.length) throw Error('端点列表包含重复标识，无法安全选择。');
      const previousTargets=flows.map(flow=>selected[flow]).filter(Boolean).sort().join('|');
      endpoints = result.endpoints.map(({id, name, flow}) => ({id, name, flow}));
      listed = true;
      renderEndpoints();
      const currentTargets=flows.map(flow=>selected[flow]).filter(Boolean);
      if(previousTargets!==[...currentTargets].sort().join('|'))await window.headsetAutoSwitch?.targetsChanged?.(currentTargets);
      try { await reloadPresets(); presetMessage.textContent = ''; } catch (error) { presets = []; presetsReady = false; fillPresets(); presetMessage.textContent = '设定档读取失败：' + errorText(error) + '。请重新读取。'; }
      let succeeded = 0, failed = 0, skipped = 0;
      const masterFailures=new Set();
      for(const flow of flows){const endpointId=selected[flow];if(!endpointId)continue;try{const master=await invoke('headset.master.read',{endpointId});window.headsetMaster?.acceptRead(master,flow);}catch(error){window.headsetMaster?.invalidate('总开关读取失败：'+errorText(error)+'；单项音效保持锁定。',endpointId);masterFailures.add(flow);}}
      // The SDK shares native endpoint state: never run family calls concurrently.
      for (const definition of definitions) {
        const endpointId = selected[definition.flow];
        if (!endpointId) { skipped++; continue; }
        const record = getRecord(definition, endpointId);
        status.textContent = '正在读取' + flowNames[definition.flow] + ' · ' + definition.title + '…';
        record.message = '正在读取此项音效属性…';
        sync();
        try {
          const response = await invoke('headset.' + definition.key + '.read', {endpointId});
          const state = verifiedState(definition, response, endpointId);
          record.readback = state;
          window.headsetMaster?.acceptEffectRead?.(endpointId, definition.key, state.enabled);
          record.readAt = Date.now();
          record.draft = copy(state);
          if (definition.key === 'eq') matchCustomPreset(record);
          for (const field of definition.fields) if (field.readOnly) record.draft[field.key] = state[field.key];
          record.dirty = difference(definition, record);
          record.error = false;
          record.message = '已读取当前音效属性。';
          succeeded++;
        } catch (error) {
          record.readback = null;
          record.readAt = null;
          record.error = true;
          record.message = '读取失败：' + errorText(error) + '。请重新读取；此项应用已锁定。';
          failed++;
        }
        paintDraft(definition);
        sync();
      }
      status.textContent = '音效读取完成：' + succeeded + ' 项成功' + (failed ? '，' + failed + ' 项失败' : '') + (skipped ? '，' + skipped + ' 项因缺少对应端点未读取' : '') + (masterFailures.size ? '。总开关读取失败，相关端点保持锁定，请重新读取。' : '。');
    } catch (error) {
      status.textContent = '读取未完成：' + errorText(error) + '。请重新读取，应用已锁定；已有草稿已保留。';
    } finally { setBusy(false);window.headsetProfiles?.acceptEndpoints(flows.map(flow=>selected[flow]).filter(Boolean)); }
  }
  async function apply(definition) {
    const endpointId = selected[definition.flow], record = getRecord(definition, endpointId);
    if (!record?.readback || externalBusy() || (busy && !writing) || window.headsetMaster?.isEffectLocked(endpointId)) return;
    try { draftState(definition, record); } catch (error) { record.message = errorText(error); record.error = true; sync(); return; }
    pending.set(definition.key, {definition, endpointId});
    if (writing) return;
    writing = true; setBusy(true);
    try {
      while (pending.size) {
        const [key, item] = pending.entries().next().value; pending.delete(key);
        const current = getRecord(item.definition, item.endpointId), version = current.version || 0, generation = current.generation || 0;
        if (!current.readback || window.headsetMaster?.isEffectLocked(item.endpointId)) throw Error('当前音效读回已失效，请重新读取。');
        const next = draftState(item.definition, current);
        if (equal(next, current.readback)) { current.dirty = false; continue; }
        current.message = '正在同步，并等待读回…'; sync();
        try {
          const response = await invoke('headset.' + item.definition.key + '.set', {endpointId:item.endpointId, state:next});
          const actual = verifiedState(item.definition, response, item.endpointId, true);
          if ((current.generation || 0) !== generation || !current.readback || window.headsetMaster?.isEffectLocked(item.endpointId)) throw Error('写入期间当前读回已失效；请重新读取核对。');
          if (!equal(actual, next)) throw Error('音效属性读回与当前选择不一致。');
          current.readback = actual; current.readAt = Date.now(); current.error = false;
          window.headsetMaster?.acceptEffectRead?.(item.endpointId, item.definition.key, actual.enabled);
          if ((current.version || 0) === version) {current.draft = copy(actual); paintDraft(item.definition);}
          current.dirty = difference(item.definition, current);
          current.message = current.dirty ? '正在同步后续选择…' : '已应用并完成音效属性读回。';
          status.textContent = item.definition.title + '已应用并完成读回。';
        } catch (error) {
          current.readback = null; current.readAt = null; current.dirty = true; current.error = true;
          current.message = '同步失败：' + errorText(error) + '。请重新读取实际状态。';
          pending.clear(); status.textContent = item.definition.title + '同步失败；后续更改已停止，请重新读取。';
          break;
        }
        sync();
      }
    } catch (error) { pending.clear(); status.textContent = '同步已停止：' + errorText(error); }
    finally { writing = false; setBusy(false);window.headsetProfiles?.effectsChanged(); }
  }
  function clearPresetChoice() {
    if (presetSelect) presetSelect.value = '';
    const record = getRecord(definitions[0]); if (record) record.profileId = '';
    if (presetRadioGroup) for (const radio of presetRadioGroup.querySelectorAll('input')) radio.checked = false;
  }
  function matchCustomPreset(record) {
    if (!record?.draft) return;
    const bands = record.draft.bandsRaw.map(Number), match = presets.find(preset => preset.origin === 'user' && equal(preset.bandsRaw, bands));
    record.profileId = match?.id || ''; record.enableSave = !match;
  }
  function setPresetMenu(open) {
    if (!presetMenu || !presetSelect) return;
    presetMenu.hidden = !open; presetSelect.setAttribute('aria-expanded', String(open));
  }
  async function reloadPresets() {
    const result = await invoke('headset.eq.presets.list', {flow:'render'});
    if (!result || !Array.isArray(result.presets)) throw Error('设定档列表格式不完整。');
    presets = result.presets; presetsReady = true; fillPresets();
  }
  function fillPresets() {
    if (!presetSelect || !presetRadioGroup || !presetMenu) return;
    presetMenu.replaceChildren(); presetRadioGroup.replaceChildren();
    for (const preset of presets) {
      if (preset.origin === 'official') {
        const label = element('label', 'effect-radio-choice', preset.name), radio = element('input');
        radio.type = 'radio'; radio.name = 'headset-eq-preset'; radio.value = preset.id; radio.disabled = true;
        radio.addEventListener('change', () => {if (radio.checked) choosePreset(preset.id);}); label.prepend(radio); presetRadioGroup.append(label);
      } else {
        const row = element('div', 'eq-profile-option'); row.setAttribute('role', 'option'); row.dataset.eqProfile = preset.id;
        const choose = button(preset.name, 'eq-profile-choose'); choose.dataset.eqProfileChoose = preset.id; choose.title = preset.name;
        choose.addEventListener('click', () => {choosePreset(preset.id); setPresetMenu(false); presetSelect.focus();});
        const remove = button('×', 'eq-profile-delete'); remove.dataset.eqProfileDelete = preset.id;
        remove.setAttribute('aria-label', '删除设定档 ' + preset.name); remove.title = '删除设定档';
        remove.addEventListener('click', event => {event.stopPropagation(); void deletePreset(preset.id);}); row.append(choose, remove); presetMenu.append(row);
      }
    }
    if (!presets.some(preset => preset.origin === 'user')) presetMenu.append(element('p', 'small-note', '尚无自定义设定档'));
    paintDraft(definitions[0]);
  }
  async function importOfficialPresets() {
    if (blocked() || !presetFile?.files.length) return;
    const file = presetFile.files[0]; setBusy(true); presetTransferStatus.textContent = '正在导入设定档…';
    try {
      if (file.size > 1048576) throw Error('文件不能超过1 MiB。');
      const content = new TextDecoder('utf-8', {fatal:true}).decode(await file.arrayBuffer());
      const result = await invoke('headset.eq.presets.official.import', {content});
      if (!Number.isInteger(result?.imported) || result.imported < 0 || !Array.isArray(result.presetIds) || result.presetIds.length !== result.imported) throw Error('导入结果格式不完整。');
      await reloadPresets(); const record = getRecord(definitions[0]); matchCustomPreset(record); paintDraft(definitions[0]);
      presetFile.value = ''; window.localLibrary?.invalidate?.();
      presetTransferStatus.textContent = '已导入 ' + result.imported + ' 个设定档，保留顺序和同名条目。选择设定档后才改变声音。';
    } catch (error) {presetTransferStatus.textContent = '导入未完成：' + errorText(error);}
    finally {setBusy(false);}
  }
  async function exportOfficialPresets() {
    if (blocked()) return;
    setBusy(true); presetTransferStatus.textContent = '正在备份设定档…';
    try {
      const result = await invoke('headset.eq.presets.official.export');
      if (typeof result?.content !== 'string' || !Number.isInteger(result.count) || result.suggestedName !== 'EQCustom.json') throw Error('导出结果格式不完整。');
      if (typeof window.hub?.saveExport !== 'function') throw Error('文件保存服务尚未就绪，请重启应用。');
      const bytes = new TextEncoder().encode(result.content), chunks = [];
      for (let offset = 0; offset < bytes.length; offset += 8192) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
      const saved = await window.hub.saveExport({format:'json', suggestedName:result.suggestedName, contentBase64:btoa(chunks.join(''))});
      if (saved?.canceled === true) {presetTransferStatus.textContent = '已取消备份。'; return;}
      if (saved?.saved !== true || saved.byteLength !== bytes.length) throw Error('未取得完整文件保存结果。');
      presetTransferStatus.textContent = '已保存：' + saved.fileName + '，共 ' + result.count + ' 个播放设定档。';
    } catch (error) {presetTransferStatus.textContent = '备份未完成：' + errorText(error);}
    finally {setBusy(false);}
  }
  async function savePreset() {
    const definition = definitions[0], record = getRecord(definition);
    if (blocked() || presetSave.disabled || !record?.readback || !record.draft.enabled || difference(definition, record) || window.headsetMaster?.isEffectLocked(selected.render)) return;
    const bandsRaw = draftState(definition, record).bandsRaw, name = presetName.value;
    setBusy(true); presetMessage.textContent = '正在储存设定档…';
    try {
      const result = await invoke('headset.eq.presets.create', {name, bandsRaw});
      if (!result?.preset || result.preset.origin !== 'user' || !equal(result.preset.bandsRaw, bandsRaw)) throw Error('保存结果与当前均衡器不一致。');
      record.profileId = result.preset.id; presetName.value = '';
      await reloadPresets(); presetMessage.textContent = '已储存「' + result.preset.name + '」。';
    } catch (error) { presetMessage.textContent = '储存未完成：' + errorText(error); }
    finally {setBusy(false);}
  }
  async function deletePreset(id) {
    if (blocked() || presetSelect.disabled || !presetsReady) return;
    const preset = presets.find(item => item.id === id && item.origin === 'user'); if (!preset) return;
    setBusy(true); presetMessage.textContent = '正在删除设定档…';
    try {
      const result = await invoke('headset.eq.presets.delete', {flow:'render', presetId:id});
      if (result?.deleted !== true) throw Error('服务未确认删除。');
      const record = getRecord(definitions[0]); if (record?.profileId === id) record.profileId = '';
      await reloadPresets(); matchCustomPreset(record); paintDraft(definitions[0]); presetMessage.textContent = '已删除「' + preset.name + '」。当前增益保持不变。';
    } catch (error) {presetMessage.textContent = '删除未完成：' + errorText(error);}
    finally {setBusy(false); if (!presetSelect.disabled) {setPresetMenu(true); presetMenu.querySelector('button')?.focus();}}
  }
  function choosePreset(id) {
    const definition = definitions.find(item => item.key === 'eq'), record = getRecord(definition);
    if (externalBusy() || (busy && !writing) || !record?.readback || !record.draft.enabled || window.headsetMaster?.isEffectLocked(selected.render)) return;
    const preset = presets.find(item => item.id === id); if (!preset) return;
    if (preset.origin !== 'official') for (const radio of presetRadioGroup.querySelectorAll('input')) radio.checked = false;
    if (preset.origin === 'user') record.profileId = preset.id;
    record.draft.bandsRaw = [...preset.bandsRaw]; record.version = (record.version || 0) + 1;
    record.dirty = difference(definition, record); paintDraft(definition); void apply(definition);
  }
  function resetField(definition, field, value) {
    const record = getRecord(definition);
    if (externalBusy() || (busy && !writing) || !record?.readback || !record.draft.enabled || window.headsetMaster?.isEffectLocked(selected[definition.flow])) return;
    record.draft[field.key] = copy(value); record.version = (record.version || 0) + 1;
    if (definition.key === 'eq' && presetSelect) clearPresetChoice();
    paintDraft(definition); void apply(definition);
  }
  async function restore() {
    if (blocked()) return;
    setBusy(true);
    invalidateAll('恢复操作已开始，草稿已保留；请重新读取当前状态。');
    status.textContent = '正在恢复本应用保存的首次音效快照…';
    try {
      const result = await invoke('headset.effects.restore');
      needsRead = true;
      window.headsetMaster?.invalidate('效果快照恢复已执行，请重新读取总开关。');
      if (!result || !Number.isInteger(result.restored) || result.restored < 0 || !Array.isArray(result.errors) || result.errors.some(error => typeof error !== 'string')) throw Error('恢复结果格式不完整。');
      status.textContent = (result.restored ? '已恢复 ' + result.restored + ' 项音效快照。' : '暂无需要恢复的音效快照。') + (result.errors.length ? ' 部分恢复失败：' + result.errors.join('；') : '') + ' 请点击「读取耳机音效」核对；未应用草稿仍保留。';
    } catch (error) {
      status.textContent = '恢复未完成：' + errorText(error) + '。请重新读取核对；未应用草稿已保留。';
    } finally { setBusy(false); }
  }
  function mount() {
    if (mounted) return;
    const host = document.getElementById('page-effects') || document.getElementById('audio-settings');
    if (!host) return;
    section = element('section', 'headset-effects');
    section.id = 'headset-effects';
    section.setAttribute('aria-label', '耳机音效');
    const heading = element('div', 'subheading');
    heading.append(element('h3', '', '耳机音效'), element('span', 'source-label', 'iKF V11 Pro 7.1'));
    section.append(heading, element('p', 'small-note', '开关、滑块和模式选择直接生效；播放与录音可分别选择端点。'));
    const toolbar = element('div', 'library-toolbar');
    readButton = button('读取耳机音效', 'primary-button');
    readButton.id = 'read-headset-effects';
    readButton.addEventListener('click', () => { void readAll(); });
    toolbar.append(readButton);
    section.append(toolbar);
    const endpointCard = element('div', 'setting-card glass');
    for (const flow of flows) {
      const label = element('label', '', flowNames[flow] + '音效端点');
      const input = element('select');
      input.id = 'headset-effects-' + flow + '-endpoint';
      input.setAttribute('aria-label', flowNames[flow] + '音效端点');
      input.disabled = true;
      input.addEventListener('change', async () => {
        if (blocked()) { input.value = selected[flow]; return; }
        if (!endpoints.some(endpoint => endpoint.flow === flow && endpoint.id === input.value)) return;
        const next=input.value;
        setBusy(true);
        try {await window.headsetAutoSwitch?.targetsChanged?.(flows.map(item=>item===flow?next:selected[item]).filter(Boolean));}
        catch(error){input.value=selected[flow];status.textContent='端点未切换：无法确认自动切换已经停止。'+errorText(error);return;}
        finally{setBusy(false);}
        selected[flow] = next;
        window.headsetMaster?.invalidate('已切换效果端点，请重新读取总开关状态。',input.value);
        for (const definition of definitions.filter(item => item.flow === flow)) paintDraft(definition);
        status.textContent = '正在读取' + flowNames[flow] + '端点…';
        sync(); void readAll();
      });
      label.append(input);
      endpointCard.append(label);
      selectors.set(flow, input);
    }
    section.append(endpointCard);
    status = element('p', 'small-note', '尚未读取音效。');
    status.id = 'headset-effects-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    section.append(status);
    for (const flow of flows) {
      const group = element('section');
      group.setAttribute('aria-label', flowNames[flow] + '音效');
      group.append(element('h3', '', flow === 'render' ? '播放音效' : '录音音效'));
      for (const definition of definitions.filter(item => item.flow === flow)) {
        const card = element('section', 'setting-card glass');
        card.id = 'headset-effect-' + definition.key.replaceAll('.', '-');
        card.setAttribute('aria-label', definition.title);
        const header = element('div', 'subheading');
        const chip = element('span', 'setting-capability pending', '尚未读取');
        header.append(element('h3', '', definition.title), chip);
        card.append(header);
        const enabledLabel = element('label', '', '启用' + definition.title);
        const enabled = element('input');
        enabled.type = 'checkbox';
        enabled.id = card.id + '-enabled';
        enabled.disabled = true;
        enabled.addEventListener('change', () => edit(definition, null, enabled));
        enabledLabel.append(enabled);
        card.append(enabledLabel);
        if (definition.key === 'eq') {
          presetRadioGroup = element('div', 'effect-preset-options'); presetRadioGroup.setAttribute('role','radiogroup'); presetRadioGroup.setAttribute('aria-label','官方均衡器预设');
          const toolbar = element('div', 'eq-profile-toolbar'), picker = element('div', 'eq-profile-picker');
          const label = element('span', '', '自定义设定档'); label.id = 'headset-eq-profile-label';
          presetSelect = button('自定义设定档', 'secondary-button'); presetSelect.id = 'headset-effect-eq-preset'; presetSelect.disabled = true;
          presetSelect.setAttribute('aria-haspopup', 'listbox'); presetSelect.setAttribute('aria-expanded', 'false'); presetSelect.setAttribute('aria-labelledby', label.id + ' ' + presetSelect.id);
          presetMenu = element('div', 'eq-profile-menu glass'); presetMenu.id = 'headset-eq-profile-options'; presetMenu.hidden = true;
          presetMenu.setAttribute('role','listbox'); presetMenu.setAttribute('aria-label','自定义均衡器设定档'); presetSelect.setAttribute('aria-controls', presetMenu.id);
          presetSelect.addEventListener('click', () => {setPresetMenu(presetMenu.hidden); if (!presetMenu.hidden) presetMenu.querySelector('button')?.focus();});
          picker.addEventListener('keydown', event => {
            if (event.key === 'Escape') {setPresetMenu(false); presetSelect.focus(); event.preventDefault();}
            if (['ArrowDown','ArrowUp'].includes(event.key)) {
              event.preventDefault(); if (presetSelect.disabled) return; setPresetMenu(true);
              const options = [...presetMenu.querySelectorAll('button:not(:disabled)')], index = options.indexOf(document.activeElement);
              options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus();
            }
          });
          picker.addEventListener('focusout', () => queueMicrotask(() => {if (!picker.contains(document.activeElement)) setPresetMenu(false);}));
          document.addEventListener('click', event => {if (!picker.contains(event.target)) setPresetMenu(false);});
          picker.append(presetSelect, presetMenu);
          const nameLabel = element('label', 'eq-profile-name', '设定档名称'); presetName = element('input'); presetName.id = 'headset-eq-profile-name'; presetName.type = 'text'; presetName.maxLength = 128; presetName.placeholder = '留空自动编号'; presetName.disabled = true; nameLabel.append(presetName);
          presetSave = button('储存设定档', 'secondary-button'); presetSave.id = 'headset-eq-profile-save'; presetSave.disabled = true; presetSave.addEventListener('click', () => void savePreset());
          toolbar.append(label, picker, nameLabel, presetSave);
          presetMessage = element('p', 'small-note'); presetMessage.id = 'headset-eq-profile-status'; presetMessage.setAttribute('role', 'status');
          const transfer = element('details', 'library-transfer'); transfer.id = 'headset-eq-official-transfer';
          transfer.append(element('summary', '', '迁移与备份设定档'), element('p', 'small-note', '导入原厂 EQCustom.json 会追加到当前列表，保留顺序与同名条目。备份包含全部自定义播放设定档。文件操作不改变当前声音。'));
          const fileLabel = element('label', '', '选择原厂设定档文件'); presetFile = element('input'); presetFile.type = 'file'; presetFile.accept = '.json,application/json'; presetFile.id = 'headset-eq-official-file'; presetFile.addEventListener('change', sync); fileLabel.append(presetFile);
          presetImport = button('导入设定档', 'secondary-button'); presetImport.id = 'headset-eq-official-import'; presetImport.disabled = true; presetImport.addEventListener('click', () => void importOfficialPresets());
          presetExport = button('备份全部设定档', 'secondary-button'); presetExport.id = 'headset-eq-official-export'; presetExport.addEventListener('click', () => void exportOfficialPresets());
          const transferToolbar = element('div', 'eq-profile-toolbar'); transferToolbar.append(fileLabel, presetImport, presetExport);
          presetTransferStatus = element('p', 'small-note'); presetTransferStatus.id = 'headset-eq-official-status'; presetTransferStatus.setAttribute('role', 'status');
          transfer.append(transferToolbar, presetTransferStatus);
          card.append(presetRadioGroup, toolbar, presetMessage, transfer); fillPresets();
        }
        const controls = [];
        for (const field of definition.fields) {
          if (field.readOnly) continue;
          const id = card.id + '-' + field.key;
          const discrete = field.choices && ['cutoffRaw','noiseSuppressionRaw'].includes(field.key);
          if (field.choices && !discrete) {
            const group = element('fieldset','effect-options'); const legend = element('legend','',field.title); group.append(legend);
            for (const [value,title] of field.choices) {
              const label = element('label','effect-radio-choice',title), input = element('input');
              input.type = 'radio'; input.name = id; input.id = id + '-' + value; input.value = String(value); input.disabled = true;
              input.addEventListener('change', () => {if(input.checked) edit(definition,field,input);});
              label.prepend(input); group.append(label); controls.push({field,input,choice:value});
            }
            card.append(group); continue;
          }
          const wrapper = field.bands ? element('div','library-eq-bands') : card; if(field.bands) card.append(wrapper);
          for (let index=0;index<(field.bands?10:1);index++) {
            const label = element('label','effect-slider-label',field.bands?frequencies[index]+' Hz':field.title), input=element('input');
            input.id = id + (field.bands?'-'+index:''); input.type = field.readOnly?'number':'range'; input.disabled=true;
            input.setAttribute('aria-label',definition.title+' · '+(field.bands?frequencies[index]+' Hz 增益（dB）':field.title));
            const ticks = discrete ? field.choices.map(([value])=>value) : null;
            if(!field.readOnly){input.min=String(ticks?0:field.min);input.max=String(ticks?ticks.length-1:field.max);input.step='1';}
            input.readOnly=Boolean(field.readOnly); const bandIndex=field.bands?index:undefined;
            const output = field.readOnly?null:element('output'); if(output){output.htmlFor=input.id;output.textContent='—';}
            const display = ()=>ticks?field.choices.find(([value])=>value===ticks[Number(input.value)])?.[1]:input.value+(field.unit?' '+field.unit:'');
            input.addEventListener('input',()=>{if(output)output.textContent=display();if(ticks)edit(definition,field,{value:ticks[Number(input.value)]});else edit(definition,field,input,bandIndex);});
            label.append(input);if(output)label.append(output);wrapper.append(label);controls.push({field,input,index:bandIndex,output,ticks});
          }
        }
        if (definition.key === 'surround71') window.headsetVoiceTest?.mount(card);
        if (definition.note) card.append(element('p', 'small-note', definition.note));
        const readback = element('p', 'field-hint', '尚未取得当前音效属性读回');
        const source = element('p', 'source-label', '来源：等待读取音效属性');
        const message = element('p', 'small-note');
        message.setAttribute('role', 'status');
        message.setAttribute('aria-live', 'polite');
        const defaults = {brilliant:{levelRaw:3}, dynamicBass:{levelRaw:5,cutoffRaw:200}, smartVolume:{levelRaw:70}, voiceClarity:{levelRaw:3,noiseSuppressionRaw:0}, 'mic.nr':{levelRaw:15}};
        const resetRow = element('div', 'library-toolbar');
        for (const [key,value] of Object.entries(defaults[definition.key] || {})) {
          const field = definition.fields.find(item => item.key === key);
          const reset = button(field.bands ? '平直' : '重设' + field.title, 'secondary-button');
          reset.id = card.id + '-reset-' + key; reset.dataset.resetField = key; reset.disabled = true;
          reset.addEventListener('click', () => resetField(definition, field, value)); resetRow.append(reset);
        }
        card.append(resetRow, element('strong', 'small-note', '音效属性读回'), readback, source, message);
        cards.set(definition.key, {enabled, controls, chip, readback, source, status:message, resets:[...resetRow.children]});
        group.append(card);
      }
      section.append(group);
    }
    const restoreCard = element('div', 'setting-card glass');
    restoreCard.append(element('h3', '', '恢复首次音效快照'), element('p', 'small-note', '恢复本应用首次成功调整每项音效前保存的快照。'));
    restoreButton = button('恢复音效首次快照', 'secondary-button');
    restoreButton.id = 'restore-headset-effects';
    restoreButton.addEventListener('click', () => { void restore(); });
    restoreCard.append(restoreButton);
    section.append(restoreCard);
    host.append(section);
    mounted = true;
    renderEndpoints();
  }

  window.headsetEffects = {
    init(options = {}) { hooks = options; mount(); sync(); },
    isBusy: () => busy,
    invalidate(message) { needsRead = true; invalidateAll(message);window.headsetProfiles?.invalidate(); sync(); },
    open() { if (!blocked()) { needsRead = false; void readAll();} },
    sync
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once: true});
  else mount();
})();
