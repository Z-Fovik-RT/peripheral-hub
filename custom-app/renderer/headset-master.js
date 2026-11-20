'use strict';
(() => {
  const DEVICE_ID = 'ikf-v11-pro-71';
  const flows = ['render', 'capture'];
  const flowNames = {render: '播放', capture: '录音'};
  const features = Object.freeze({
    render: ['eq', 'surround71', 'brilliant', 'dynamicBass', 'smartVolume', 'voiceClarity', 'surroundMax'],
    capture: ['mic.magicVoice', 'mic.nr']
  });
  const featureNames = {eq: '十段均衡器', surround71: '7.1 环绕', brilliant: '声音明亮化', dynamicBass: '动态低频', smartVolume: '智能音量', voiceClarity: '人声清晰', surroundMax: 'Surround Max', 'mic.magicVoice': '魔幻音效', 'mic.nr': '麦克风降噪'};
  const cache = new Map(), cards = new Map();
  const selected = {render: '', capture: ''};
  let hooks = {}, busy = false, mounted = false, listed = false, endpoints = [], section;
  const errorText = error => typeof error?.message === 'string' ? error.message : String(error || '耳机总开关服务异常');
  const blocked = () => busy || Boolean(hooks.isBusy?.());
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(id, text, action, primary = false) {
    const node = element('button', primary ? 'primary-button' : 'secondary-button', text);
    node.id = id; node.type = 'button'; node.addEventListener('click', () => { void action(); }); return node;
  }
  function getRecord(endpointId) {
    if (!endpointId) return null;
    if (!cache.has(endpointId)) cache.set(endpointId, {readback: null, readAt: null, error: false, message: '尚未读取总开关状态。'});
    return cache.get(endpointId);
  }
  function isEffectLocked(endpointId) {
    const data = endpointId ? cache.get(endpointId)?.readback : null;
    return !data || data.recoveryPending || !data.state.enabled;
  }
  function setBusy(value) {busy = value; sync(); hooks.onBusyChange?.(value);}
  async function invoke(operation, args = {}) {
    if (typeof window.hub?.features?.invoke !== 'function') throw Error('耳机总开关服务尚未就绪，请重启应用。');
    const response = await window.hub.features.invoke({apiVersion: 1, deviceId: DEVICE_ID, operation, args});
    if (response?.ok !== true) throw Error(response?.error?.message || '总开关服务没有返回成功结果。');
    return response.data;
  }
  function validate(result, expectedEndpoint, expectedFlow, action) {
    if (!result || typeof result.endpointId !== 'string' || !result.endpointId || result.endpointId.length > 2048 || (expectedEndpoint && result.endpointId !== expectedEndpoint)) throw Error('总开关返回的端点无效或与请求不一致。');
    if (result.support !== 'supported' || !['sdk','windows-effect-store'].includes(result.source) || result.verified !== true) throw Error('未取得经过验证的音效属性读回。');
    if (typeof result.recoveryPending !== 'boolean' || typeof result.canRestore !== 'boolean' || !result.state || typeof result.state.enabled !== 'boolean' || !Array.isArray(result.state.effects)) throw Error('总开关状态、恢复状态或音效组合字段不完整。');
    const flags = result.state.effects;
    if (flags.some(item => !item || typeof item.feature !== 'string' || typeof item.enabled !== 'boolean') || new Set(flags.map(item => item.feature)).size !== flags.length) throw Error('音效组合必须包含唯一功能名和严格的布尔开关。');
    const flow = flows.find(value => flags.length === features[value].length && features[value].every(feature => flags.some(item => item.feature === feature)));
    const knownFlow = endpoints.find(endpoint => endpoint.id === result.endpointId)?.flow;
    if (!flow || (expectedFlow && flow !== expectedFlow) || (knownFlow && flow !== knownFlow)) throw Error('总开关未返回当前方向完整的七项播放或两项录音音效。');
    if (action === 'set' && result.applied !== true) throw Error('未确认总开关设置已应用。');
    if (action === 'restore' && typeof result.restored !== 'boolean') throw Error('未返回有效的恢复结果。');
    const effects = features[flow].map(feature => ({feature, enabled: flags.find(item => item.feature === feature).enabled}));
    return {endpointId: result.endpointId, flow, support: 'supported', source: result.source, verified: true, state: {enabled: result.state.enabled, effects}, recoveryPending: result.recoveryPending, canRestore: result.canRestore, ...(action === 'set' ? {applied: true} : {}), ...(action === 'restore' ? {restored: result.restored} : {})};
  }
  function install(value, message) {
    const record = getRecord(value.endpointId);
    record.readback = value; record.readAt = Date.now(); record.error = false;
    record.message = message || (value.recoveryPending ? '上次操作需要恢复。单项音效保持锁定，请先恢复待处理操作。' : value.state.enabled ? '总开关已启用。单项音效保持当前各自的开关状态。' : '总开关已关闭。单项音效编辑保持锁定。');
    return value;
  }
  function acceptRead(response, flow) {
    try {const value = install(validate(response, undefined, flow)); if(!endpoints.some(endpoint=>endpoint.id===value.endpointId)){endpoints.push({id:value.endpointId,name:flowNames[value.flow]+'耳机端点',flow:value.flow});listed=true;} selected[value.flow]=value.endpointId; updateEndpoints(); sync(); return value;}
    catch (error) {
      const endpointId = response?.endpointId;
      if (typeof endpointId === 'string' && endpointId) invalidate(errorText(error), endpointId);
      throw error;
    }
  }
  function acceptEffectRead(endpointId, feature, enabled) {
    const record = cache.get(endpointId), value = record?.readback;
    if (!value || value.recoveryPending || typeof enabled !== 'boolean') return;
    const effect = value.state.effects.find(item => item.feature === feature); if (!effect) return;
    effect.enabled = enabled; record.readAt = Date.now(); sync();
  }
  function invalidate(reason = '总开关读回已失效，请重新读取。', endpointId) {
    const records = endpointId ? [getRecord(endpointId)] : [...cache.values()];
    for (const record of records) if (record) {record.readback = null; record.readAt = null; record.error = true; record.message = reason;}
    sync();
  }
  function invalidateEffects(message) {window.headsetEffects?.invalidate?.(message);}
  function updateEndpoints() {
    for (const flow of flows) {
      const card = cards.get(flow), matches = endpoints.filter(endpoint => endpoint.flow === flow);
      if (!matches.some(endpoint => endpoint.id === selected[flow])) selected[flow] = matches[0]?.id || '';
      card.select.replaceChildren();
      if (!matches.length) {const empty = element('option', '', listed ? '未检测到' + flowNames[flow] + '端点' : '点击读取后列出端点'); empty.value = ''; card.select.append(empty);}
      for (const endpoint of matches) {const option = element('option', '', endpoint.name || endpoint.id); option.value = endpoint.id; card.select.append(option);}
      card.select.value = selected[flow];
    }
  }
  async function readFlow(flow) {
    if (blocked()) return;
    setBusy(true);
    const previousEndpoint = selected[flow];
    if (previousEndpoint) invalidate('正在读取总开关状态；单项音效暂时锁定。', previousEndpoint);
    cards.get(flow).localMessage = '正在列出耳机端点并读取' + flowNames[flow] + '总开关…';
    sync();
    try {
      const result = await invoke('headset.audio.list');
      if (!Array.isArray(result?.endpoints) || result.endpoints.length > 128 || result.endpoints.some(endpoint => !endpoint || typeof endpoint.id !== 'string' || !endpoint.id || endpoint.id.length > 2048 || typeof endpoint.name !== 'string' || !flows.includes(endpoint.flow)) || new Set(result.endpoints.map(endpoint => endpoint.id)).size !== result.endpoints.length) throw Error('耳机端点列表缺少有效身份、名称或方向。');
      const nextEndpoints = result.endpoints.map(({id, name, flow}) => ({id, name, flow}));
      for (const [id, record] of cache) if (!nextEndpoints.some(endpoint => endpoint.id === id)) {record.readback = null; record.readAt = null; record.error = true; record.message = '端点已不在当前列表中，请重新读取。';}
      endpoints = nextEndpoints; listed = true; updateEndpoints();
      const endpointId = selected[flow];
      if (!endpointId) {cards.get(flow).localMessage = '未检测到' + flowNames[flow] + '端点，请连接耳机后重试。'; return;}
      invalidate('正在读取总开关状态；单项音效暂时锁定。', endpointId);
      const value = validate(await invoke('headset.master.read', {endpointId}), endpointId, flow);
      install(value); cards.get(flow).localMessage = '';
    } catch (error) {
      const endpointId = selected[flow];
      const message = '读取失败：' + errorText(error) + ' 旧读回已清除，单项音效保持锁定。';
      if (endpointId) invalidate(message, endpointId);
      cards.get(flow).localMessage = message;
    } finally {setBusy(false);}
  }
  async function change(flow, action) {
    if (blocked()) return;
    const endpointId = selected[flow], record = getRecord(endpointId), before = record?.readback;
    if (!before) return;
    const restoring = action === 'restore', enabled = action === 'enable';
    if (restoring ? !before.canRestore : before.recoveryPending || before.state.enabled === enabled) return;
    let succeeded = false;
    setBusy(true); record.message = restoring ? '正在恢复保存的组合并等待读回…' : enabled ? '正在恢复关闭前组合并等待读回…' : '正在关闭全部音效并等待读回…';
    sync();
    // An interrupted write must not leave another card presenting a trusted editable state.
    invalidateEffects('总开关操作已开始，单项音效旧读回已失效；操作后请重新读取音效。');
    invalidate('总开关操作中，单项音效暂时锁定。', endpointId);
    try {
      const result = await invoke(restoring ? 'headset.master.restore' : 'headset.master.set', restoring ? {endpointId} : {endpointId, enabled});
      const value = validate(result, endpointId, flow, restoring ? 'restore' : 'set');
      if (value.recoveryPending) throw Error('操作仍有待恢复记录，请重新读取并恢复。');
      if (!restoring && value.state.enabled !== enabled) throw Error('读回的总开关状态与请求不一致。');
      if (!restoring && !enabled && value.state.effects.some(effect => effect.enabled)) throw Error('未确认当前方向的全部音效都已关闭。');
      install(value, restoring ? value.restored ? '已恢复保存的组合，并完成读回。' : '暂无可恢复的首次快照，已读取当前状态。' : enabled ? '已恢复关闭前的音效组合，并完成读回。' : '全部音效已关闭并完成读回。');
      cards.get(flow).localMessage = ''; succeeded = true;
      invalidateEffects('总开关已变更，正在更新单项音效。');
    } catch (error) {
      invalidate('操作失败：' + errorText(error) + ' 旧读回已清除，单项音效保持锁定。请重新读取总开关，或按读回提示恢复。', endpointId);
      cards.get(flow).localMessage = '';
    } finally {setBusy(false); if (succeeded) window.headsetEffects?.open();}
  }
  function sync() {
    if (!mounted) return;
    section.setAttribute('aria-busy', String(busy));
    const locked = blocked();
    for (const flow of flows) {
      const card = cards.get(flow), endpointId = selected[flow], record = endpointId ? cache.get(endpointId) : null, value = record?.readback;
      card.select.disabled = locked || !endpoints.some(endpoint => endpoint.flow === flow);
      card.read.disabled = locked;
      card.toggle.disabled = locked || !value || value.recoveryPending;
      card.toggle.checked = value?.state.enabled === true;
      card.restore.disabled = locked || !value?.canRestore;
      card.restore.textContent = value?.recoveryPending ? '恢复待处理操作' : '恢复首次快照';
      card.chip.textContent = !value ? '请先读取' : value.recoveryPending ? '需要恢复' : value.state.enabled ? '总开关已启用' : '总开关已关闭';
      card.chip.className = 'setting-capability ' + (value && !value.recoveryPending ? 'enabled' : 'pending');
      card.flags.replaceChildren();
      if (value) for (const effect of value.state.effects) {const flag = element('li', '', featureNames[effect.feature] + '：' + (effect.enabled ? '开启' : '关闭')); flag.dataset.feature = effect.feature; card.flags.append(flag);}
      card.source.textContent = value ? '音效属性 · 已读回 · ' + new Date(record.readAt).toLocaleTimeString('zh-CN', {hour12: false}) : '来源：等待读取音效属性';
      card.message.textContent = card.localMessage || record?.message || (listed ? '请选择端点并手动读取总开关。' : '点击读取后列出耳机端点并读取当前方向。');
      card.message.dataset.error = String(Boolean(record?.error));
      card.message.setAttribute('role', record?.error ? 'alert' : 'status');
      card.lock.textContent = !value ? '当前端点未取得总开关读回，单项音效保持锁定。' : value.recoveryPending ? '恢复完成前，单项音效保持锁定。' : value.state.enabled ? '单项音效按各自开关状态工作；总开关不会自动开启每项音效。' : '单项音效编辑已锁定。点击恢复关闭前组合可重新启用。';
    }
  }
  function mount() {
    if (mounted) return;
    const page = document.getElementById('page-effects');
    if (!page || document.getElementById('headset-master-panel')) return;
    section = element('section', 'headset-master'); section.id = 'headset-master-panel'; section.setAttribute('aria-label', '耳机音效总开关');
    const heading = element('div', 'subheading'); heading.append(element('h3', '', '音效总开关'), element('span', 'source-label', '播放与录音分别控制'));
    section.append(heading, element('p', 'small-note', '关闭时记住各项音效的启用组合，再次开启恢复该组合。总开关开启时，各项音效仍保留自己的开关。'));
    const group = element('div', 'headset-master-grid');
    for (const flow of flows) {
      const card = element('section', 'setting-card headset-master-card'); card.id = 'headset-master-' + flow;
      const header = element('div', 'subheading'), chip = element('span', 'setting-capability pending', '请先读取'); header.append(element('h3', '', flowNames[flow] + '音效'), chip);
      const label = element('label', '', flowNames[flow] + '端点'), select = element('select'); select.id = 'headset-master-' + flow + '-endpoint'; select.setAttribute('aria-label', flowNames[flow] + '总开关端点'); label.append(select);
      select.addEventListener('change', () => {
        if (blocked()) {select.value = selected[flow]; return;}
        if (!endpoints.some(endpoint => endpoint.flow === flow && endpoint.id === select.value)) return;
        selected[flow] = select.value; cards.get(flow).localMessage = '';
        invalidateEffects('总开关端点选择已更改，正在读取。'); sync(); void readFlow(flow);
      });
      const read = button('headset-master-' + flow + '-read', '读取' + flowNames[flow] + '总开关', () => readFlow(flow));
      const actions = element('div', 'headset-master-actions');
      const toggleLabel = element('label', 'headset-master-toggle', '总音效开关'), toggle = element('input');
      toggle.type = 'checkbox'; toggle.role = 'switch'; toggle.id = 'headset-master-' + flow + '-toggle'; toggle.disabled = true;
      toggle.addEventListener('change', () => {if(blocked()){sync();return;} void change(flow,toggle.checked?'enable':'disable');}); toggleLabel.append(toggle);
      const restore = button('headset-master-' + flow + '-restore', '恢复首次快照', () => change(flow, 'restore'));
      actions.append(toggleLabel, restore);
      const flags = element('ul', 'headset-master-flags'), source = element('p', 'source-label'), message = element('p', 'small-note'), lock = element('p', 'field-hint'); message.setAttribute('aria-live', 'polite');
      card.append(header, label, read, flags, source, lock, message, actions); group.append(card);
      cards.set(flow, {select, read, toggle, restore, chip, flags, source, message, lock, localMessage: ''});
    }
    section.append(group);
    const effects = document.getElementById('headset-effects'), effectsHeading = effects?.querySelector(':scope > .subheading');
    if (effectsHeading) effectsHeading.insertAdjacentElement('afterend', section);
    else page.prepend(section);
    mounted = true; updateEndpoints(); sync();
  }
  window.headsetMaster = {init(options = {}) {hooks = options; mount(); sync();}, sync, isBusy: () => busy, isEffectLocked, invalidate, acceptRead, acceptEffectRead};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once: true});
  else mount();
})();
