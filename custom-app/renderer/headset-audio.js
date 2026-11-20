'use strict';
(() => {
  const DEVICE_ID = 'ikf-v11-pro-71';
  const CHANNEL_EPSILON = 0.001;
  const SESSION_EPSILON = 0.5;
  const kinds = ['channels', 'balance', 'peak', 'sessions', 'format', 'default'];

  const titles = {channels: '声道音量', balance: '左右平衡', peak: '瞬时峰值', sessions: '应用音频会话', format: '端点格式', default: '默认设备角色'};
  const roleNames = {multimedia: '默认设备', communications: '通信'};
  const expectedSources = Object.freeze({channels: 'windows-system', balance: 'windows-system', peak: 'windows-system', sessions: 'windows-system', format: 'windows-system', default: 'windows-system'});
  const sourceName = () => 'Windows 系统';
  const records = new Map();
  const cards = new Map();
  let hooks = {}, busy = false, mounted = false, listed = false;
  let endpoints = [], selected = '';
  let section, endpointSelect, readButton, restoreButton, status;

  const errorText = error => typeof error?.message === 'string' ? error.message : String(error || '音频服务异常');
  const clone = value => JSON.parse(JSON.stringify(value));
  const scalar = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
  const percent = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
  const nearChannel = (left, right) => Math.abs(left - right) <= CHANNEL_EPSILON;
  const nearSession = (left, right) => Math.abs(left - right) <= SESSION_EPSILON;
  const formatKey = format => [format.channels, format.bitDepth, format.sampleRate].join('/');
  const formatText = format => `${format.channels} 声道 · ${format.bitDepth} bit · ${format.sampleRate} Hz`;
  const pct = value => Number((value * 100).toFixed(4)) + '%';
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, className = 'secondary-button') {
    const node = element('button', className, text);
    node.type = 'button';
    return node;
  }
  function blocked() { return busy || Boolean(hooks.isBusy?.()); }
  function setBusy(value) {
    busy = value;
    sync();
    hooks.onBusyChange?.(value);
  }
  async function invoke(operation, args = {}) {
    if (typeof window.hub?.features?.invoke !== 'function') throw Error('音频服务尚未就绪，请重启应用。');
    const response = await window.hub.features.invoke({apiVersion: 1, deviceId: DEVICE_ID, operation, args});
    if (response?.ok !== true) throw Error(response?.error?.message || '音频服务没有返回成功结果。');
    return response.data;
  }
  function record(kind, endpointId = selected) {
    if (!endpointId) return null;
    if (!records.has(endpointId)) records.set(endpointId, new Map());
    const group = records.get(endpointId);
    if (!group.has(kind)) group.set(kind, {readback: null, draft: null, dirty: false, readAt: null, error: false, message: '尚未读取。'});
    return group.get(kind);
  }
  function invalidate(kind, endpointId, message) {
    const entry = record(kind, endpointId);
    if (!entry) return;
    entry.readback = null;
    entry.readAt = null;
    entry.error = true;
    entry.message = message;
  }
  function invalidateAll(message) {
    for (const group of records.values()) for (const entry of group.values()) {
      entry.readback = null;
      entry.readAt = null;
      entry.message = message;
      entry.error = false;
    }
  }
  function verified(kind, result, endpointId, applied = false) {
    if (!result || result.endpointId !== endpointId) throw Error('音频服务返回的端点与请求不一致。');
    if (result.support !== 'supported') throw Error('当前端点未确认支持此项（' + (result.support || 'unknown') + '）。');
    if (!Object.hasOwn(expectedSources, kind) || result.source !== expectedSources[kind] || result.verified !== true) throw Error('未取得经过验证的' + sourceName(kind) + '读回。');
    if (applied && result.applied !== true) throw Error('音频服务未确认设置已应用。');
  }
  function validChannels(result, endpointId, applied = false) {
    verified('channels', result, endpointId, applied);
    const values = result.state?.channels;
    if (!Array.isArray(values) || values.length < 1 || values.length > 128 || values.some(item => !item || !Number.isInteger(item.channelRaw) || item.channelRaw < 0 || item.channelRaw >= 128 || !scalar(item.volumeRaw))) throw Error('声道读回不完整或音量超出 0–1。');
    const ordered = values.map(item => ({channelRaw: item.channelRaw, volumeRaw: item.volumeRaw})).sort((a, b) => a.channelRaw - b.channelRaw);
    if (ordered.some((item, index) => item.channelRaw !== index)) throw Error('声道编号必须从 0 开始连续且唯一。');
    return ordered;
  }
  function validBalance(result, endpointId, applied = false) {
    verified('balance', result, endpointId, applied);
    if (!scalar(result.state?.leftRaw) || !scalar(result.state?.rightRaw)) throw Error('左右平衡须返回两个 0–1 的实际声道值。');
    return {leftRaw: result.state.leftRaw, rightRaw: result.state.rightRaw};
  }
  const balanceEqual = (left, right) => nearChannel(left.leftRaw, right.leftRaw) && nearChannel(left.rightRaw, right.rightRaw);
  function balancePosition(value, previous) {
    const left = value.leftRaw, right = value.rightRaw;
    if (left === right) return left === 0 ? Number.isInteger(previous) ? previous : null : 10;
    const relative = Math.round(Math.min(left, right) / Math.max(left, right) * 10);
    return left < right ? 20 - relative : relative;
  }
  function balanceDraft(entry, current = entry?.readback) {
    const position = entry?.draft?.position;
    if (!Number.isInteger(position) || position < 0 || position > 20) throw Error('请选择 0–20 的整数平衡位置。');
    if (!scalar(current?.leftRaw) || !scalar(current?.rightRaw)) throw Error('请先读取当前实际双声道状态。');
    // This ceiling is the latest observed channel maximum, not the endpoint master volume.
    const ceiling = Math.max(current.leftRaw, current.rightRaw);
    return {leftRaw: position <= 10 ? ceiling : ceiling * (20 - position) / 10, rightRaw: position >= 10 ? ceiling : ceiling * position / 10};
  }
  function synchronizeChannels(kind, value, endpointId) {
    if (kind === 'balance') {
      install('channels', [{channelRaw: 0, volumeRaw: value.leftRaw}, {channelRaw: 1, volumeRaw: value.rightRaw}], endpointId, '已同步左右平衡的双声道读回。');
    } else if (kind === 'channels') {
      if (value.length === 2) install('balance', {leftRaw: value[0].volumeRaw, rightRaw: value[1].volumeRaw}, endpointId, '已从实际双声道读回同步平衡。');
      else balanceUnavailable(endpointId, value.length);
    }
  }
  function balanceUnavailable(endpointId, channelCount) {
    invalidate('balance', endpointId, '当前端点有 ' + channelCount + ' 个实际音量声道；左右平衡仅适用于双声道。请重新读取声道核对，已有草稿已保留。');
    const entry = record('balance', endpointId);
    if (entry) entry.error = false;
  }
  function validFormat(value) {
    if (!value || ['channels', 'bitDepth', 'sampleRate'].some(key => !Number.isInteger(value[key]) || value[key] <= 0 || value[key] > 2147483647) || value.channels > 128) throw Error('格式读回必须包含有效的声道数、位深和采样率。');
    return {channels: value.channels, bitDepth: value.bitDepth, sampleRate: value.sampleRate};
  }
  function validSessions(result, endpointId) {
    verified('sessions', result, endpointId);
    if (!Array.isArray(result.sessions) || result.sessions.length > 1024) throw Error('会话列表格式无效。');
    const ids = new Set();
    return result.sessions.map(item => {
      if (!item || typeof item.sessionId !== 'string' || !item.sessionId || item.sessionId.length > 2048 || ids.has(item.sessionId) || !(item.processId === null || (Number.isInteger(item.processId) && item.processId >= 0)) || typeof item.description !== 'string' || !(item.active === null || typeof item.active === 'boolean') || !percent(item.volume) || typeof item.muted !== 'boolean') throw Error('会话列表缺少有效身份、音量或静音读回。');
      ids.add(item.sessionId);
      return {sessionId: item.sessionId, processId: item.processId, description: item.description, active: item.active, volume: item.volume, muted: item.muted};
    });
  }
  function validRoles(result, endpointId) {
    verified('default', result, endpointId);
    if (!Array.isArray(result.roles) || result.roles.length > 2 || result.roles.some(role => !Object.hasOwn(roleNames, role)) || new Set(result.roles).size !== result.roles.length) throw Error('默认设备角色读回无效。');
    return [...result.roles];
  }
  function acknowledge(result) {
    if (result?.applied !== true || result.verified !== true || !Array.isArray(result.warnings) || result.warnings.some(item => typeof item !== 'string')) throw Error('服务未返回已应用、已验证的完整确认结果。');
    return result.warnings;
  }
  function numberDraft(raw, title, maximum = 100) {
    if (raw === '' || raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) throw Error('请填写' + title + '。');
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > maximum) throw Error(title + '须为 0–' + maximum + ' 的数值。');
    return value;
  }
  function channelDraft(entry) {
    if (!Array.isArray(entry?.draft)) throw Error('请先读取声道音量。');
    if (entry.readback && (entry.draft.length !== entry.readback.length || entry.draft.some((item, index) => item.channelRaw !== entry.readback[index].channelRaw))) throw Error('保留草稿的声道布局与当前读回不同，不能应用。');
    return entry.draft.map(item => ({channelRaw: item.channelRaw, volumeRaw: item.percentDraft === undefined ? item.volumeRaw : numberDraft(item.percentDraft, '声道百分比') / 100}));
  }
  const channelsEqual = (a, b) => a.length === b.length && a.every((item, index) => item.channelRaw === b[index].channelRaw && nearChannel(item.volumeRaw, b[index].volumeRaw));
  function sessionDraft(item) {
    return {volume: item.percentDraft === undefined ? item.volume : numberDraft(item.percentDraft, '会话音量'), muted: item.muted};
  }
  function sessionDirty(draft, actual) {
    if (!actual) return true;
    const next = sessionDraft(draft);
    return !nearSession(next.volume, actual.volume) || next.muted !== actual.muted;
  }
  function difference(kind, entry) {
    if (!entry?.draft) return false;
    if (!entry.readback) return entry.dirty;
    if (kind === 'channels') return !channelsEqual(channelDraft(entry), entry.readback);
    if (kind === 'balance') return entry.draft.edited === true && !balanceEqual(balanceDraft(entry), entry.readback);
    if (kind === 'format') return entry.draft !== formatKey(entry.readback.format);
    if (kind === 'default') return Boolean(entry.draft.role) && !entry.readback.includes(entry.draft.role);
    if (kind === 'sessions') return Object.values(entry.draft).some(item => sessionDirty(item, entry.readback.find(actual => actual.sessionId === item.sessionId)));
    return false;
  }
  function draftError(kind, entry) {
    if (!entry?.draft) return '';
    try {
      if (kind === 'channels') channelDraft(entry);
      if (kind === 'balance' && entry.draft.edited && entry.readback) balanceDraft(entry);
      if (kind === 'sessions') Object.values(entry.draft).forEach(sessionDraft);
      if (kind === 'format' && entry.readback && !entry.readback.formats.some(item => formatKey(item) === entry.draft)) throw Error('请选择当前端点已验证的可用格式。');
      if (kind === 'default' && entry.draft.role && !Object.hasOwn(roleNames, entry.draft.role)) throw Error('请选择支持的角色。');
      return '';
    } catch (error) { return errorText(error); }
  }
  function install(kind, value, endpointId, message) {
    const entry = record(kind, endpointId);
    const preserve = Boolean(entry.draft && entry.dirty);
    entry.readback = value;
    entry.readAt = Date.now();
    if (!preserve) {
      if (kind === 'channels') entry.draft = clone(value);
      if (kind === 'balance') entry.draft = {position: balancePosition(value, entry.draft?.position), edited: false};
      if (kind === 'sessions') entry.draft = Object.fromEntries(value.map(item => [item.sessionId, clone(item)]));
      if (kind === 'format') entry.draft = formatKey(value.format);
      if (kind === 'default') entry.draft = {role: ''};
    } else if (kind === 'sessions') {
      // Newly observed sessions get their real readback; drafts for ended sessions stay recoverable.
      for (const item of value) if (!Object.hasOwn(entry.draft, item.sessionId)) entry.draft[item.sessionId] = clone(item);
    }
    entry.error = false;
    entry.message = (message || '已读取' + sourceName(kind) + '当前状态。') + (preserve ? ' 未应用的草稿已保留。' : '');
    try { entry.dirty = difference(kind, entry); } catch { entry.dirty = true; }
  }
  async function readKind(kind, endpointId = selected) {
    if (!endpointId) return false;
    invalidate(kind, endpointId, '正在读取当前系统状态，草稿已保留。');
    if (endpointId === selected) paint(kind);
    sync();
    try {
      const args = {endpointId};
      let value;
      if (kind === 'channels') value = validChannels(await invoke('headset.audio.channels.read', args), endpointId);
      if (kind === 'balance') {
        const channels = record('channels', endpointId)?.readback;
        if (channels && channels.length !== 2) { balanceUnavailable(endpointId, channels.length); return false; }
        value = validBalance(await invoke('headset.audio.balance.read', args), endpointId);
      }
      if (kind === 'peak') {
        const result = await invoke('headset.audio.peak.read', args);
        verified(kind, result, endpointId);
        if (!Array.isArray(result.valuesRaw) || result.valuesRaw.length < 1 || result.valuesRaw.length > 128 || result.valuesRaw.some(item => !scalar(item))) throw Error('峰值读回必须是 0–1 的有效数组。');
        value = [...result.valuesRaw];
      }
      if (kind === 'sessions') value = validSessions(await invoke('headset.audio.sessions.list', args), endpointId);
      if (kind === 'format') {
        const current = await invoke('headset.audio.format.read', args);
        verified('format', current, endpointId);
        const format = validFormat(current.format);
        const available = await invoke('headset.audio.format.list', args);
        verified('format', available, endpointId);
        if (!Array.isArray(available.formats) || available.formats.length > 256) throw Error('可用格式列表无效。');
        const formats = available.formats.map(validFormat);
        if (new Set(formats.map(formatKey)).size !== formats.length) throw Error('可用格式列表包含重复项。');
        value = {format, formats};
      }
      if (kind === 'default') value = validRoles(await invoke('headset.audio.default.read', args), endpointId);
      if (kind === 'peak') record(kind, endpointId).live = false;
      install(kind, value, endpointId, kind === 'peak' ? '已单次采样；音频总览可见时由实时监测继续更新。' : undefined);
      synchronizeChannels(kind, value, endpointId);
      return true;
    } catch (error) {
      invalidate(kind, endpointId, '读取失败：' + errorText(error) + ' 旧读回已清除；草稿已保留，请重新读取。');
      if (kind === 'channels') invalidate('balance', endpointId, '声道读取失败，平衡旧读回已清除；请重新读取双声道状态。');
      if (kind === 'balance' && record('channels', endpointId)?.readback?.length === 2) invalidate('channels', endpointId, '平衡读取失败，相关双声道读回已清除；草稿已保留。');
      return false;
    } finally {
      if (endpointId === selected) {
        paint(kind);
        if (kind === 'channels') paint('balance');
        if (kind === 'balance') paint('channels');
      }
      sync();
    }
  }
  function fillEndpoints() {
    endpointSelect.replaceChildren();
    if (!endpoints.some(item => item.endpointId === selected)) selected = endpoints[0]?.endpointId || '';
    if (!endpoints.length) {
      const option = element('option', '', listed ? '未检测到目标耳机端点' : '点击读取后列出端点');
      option.value = '';
      endpointSelect.append(option);
    }
    for (const endpoint of endpoints) {
      const option = element('option', '', (endpoint.flow === 'render' ? '播放 · ' : '录音 · ') + (endpoint.displayName || endpoint.endpointId));
      option.value = endpoint.endpointId;
      endpointSelect.append(option);
    }
    endpointSelect.value = selected;
    for (const kind of kinds) paint(kind);
  }
  async function readAll() {
    if (blocked()) return;
    setBusy(true);
    invalidateAll('正在重新检测和读取；未应用草稿已保留。');
    for (const kind of kinds) paint(kind);
    sync();
    status.textContent = '正在检测目标耳机端点…';
    try {
      const result = await invoke('headset.device.detect');
      if (!Array.isArray(result?.devices) || result.devices.length > 128 || result.devices.some(item => !item || typeof item.endpointId !== 'string' || !item.endpointId || item.endpointId.length > 2048 || !['render', 'capture'].includes(item.flow) || item.matchedTarget === false) || new Set(result.devices.map(item => item.endpointId)).size !== result.devices.length) throw Error('目标端点列表格式或身份无效。');
      endpoints = result.devices.map(item => ({endpointId: item.endpointId, flow: item.flow, displayName: typeof item.displayName === 'string' ? item.displayName : ''}));
      listed = true;
      fillEndpoints();
      if (!selected) { status.textContent = '未检测到目标耳机端点。当前读回已清除；已有草稿已保留。'; return; }
      let succeeded = 0;
      for (const kind of kinds) {
        status.textContent = '正在读取' + titles[kind] + '…';
        if (await readKind(kind)) succeeded++;
      }
      const warnings = Array.isArray(result.warnings) ? result.warnings.filter(item => typeof item === 'string') : [];
      status.textContent = '当前端点读取完成：' + succeeded + '/' + kinds.length + ' 项成功。平衡、声道与会话需单独应用；格式与默认角色选择直接生效。音频总览可见时持续更新峰值。' + (warnings.length ? ' ' + warnings.join('；') : '');
    } catch (error) {
      endpoints = [];
      selected = '';
      listed = true;
      fillEndpoints();
      status.textContent = '检测失败：' + errorText(error) + ' 当前读回已清除；草稿已保留。';
    } finally { setBusy(false); if (!document.getElementById('page-effects')?.hidden) window.headsetEffects?.open(); }
  }
  async function readOne(kind) {
    if (blocked() || !selected) return;
    const endpointId = selected;
    setBusy(true);
    try { await readKind(kind, endpointId); } finally { setBusy(false); }
  }
  function edited(kind) {
    const entry = record(kind);
    if (!entry) return;
    try { entry.dirty = difference(kind, entry); } catch { entry.dirty = true; }
    entry.message = entry.readback ? ['format','default'].includes(kind) ? '正在同步当前选择…' : '更改仅保存在草稿中；点击应用才会写入。' : '当前状态无效，请重新读取。';
    entry.error = false;
    sync();
  }
  async function apply(kind, sessionId) {
    if (blocked() || !selected) return;
    const endpointId = selected, entry = record(kind, endpointId);
    if (!entry?.readback) return;
    const invalid = draftError(kind, entry);
    if (invalid) { entry.message = invalid; entry.error = true; sync(); return; }
    let requested, actualSession;
    if (kind === 'channels') {
      requested = channelDraft(entry);
      if (!channelsEqual(requested, entry.readback) && (requested.length !== entry.readback.length || requested.some((item, index) => item.channelRaw !== entry.readback[index].channelRaw))) return;
      if (channelsEqual(requested, entry.readback)) return;
    } else if (kind === 'balance') {
      requested = balanceDraft(entry);
      if (!entry.draft.edited || balanceEqual(requested, entry.readback)) return;
    } else if (kind === 'sessions') {
      const draft = entry.draft?.[sessionId];
      actualSession = entry.readback.find(item => item.sessionId === sessionId);
      if (!draft || !actualSession || !sessionDirty(draft, actualSession)) return;
      requested = sessionDraft(draft);
    } else if (kind === 'format') {
      requested = entry.readback.formats.find(item => formatKey(item) === entry.draft);
      if (!requested || formatKey(requested) === formatKey(entry.readback.format)) return;
    } else if (kind === 'default') {
      requested = entry.draft.role;
      if (!Object.hasOwn(roleNames, requested) || entry.readback.includes(requested)) return;
    } else return;
    setBusy(true);
    entry.message = '正在应用并等待系统真实读回…';
    sync();
    try {
      let value, warnings = [];
      if (kind === 'channels') {
        value = validChannels(await invoke('headset.audio.channels.set', {endpointId, state: {channels: requested}}), endpointId, true);
        if (!channelsEqual(value, requested)) throw Error('声道系统读回与请求不一致。');
      }
      if (kind === 'balance') {
        const current = validBalance(await invoke('headset.audio.balance.read', {endpointId}), endpointId);
        if (endpointId !== selected || !endpoints.some(endpoint => endpoint.endpointId === endpointId)) throw Error('平衡应用前端点选择已变化，请重新读取。');
        install(kind, current, endpointId);
        synchronizeChannels(kind, current, endpointId);
        requested = balanceDraft(entry, current);
        if (balanceEqual(requested, current)) {
          entry.dirty = false;
          install(kind, current, endpointId, '当前双声道已符合草稿；未写入音量。');
          status.textContent = '当前双声道无需调整，未写入音量。';
          return;
        }
        value = validBalance(await invoke('headset.audio.balance.set', {endpointId, state: requested}), endpointId, true);
        if (!balanceEqual(value, requested)) throw Error('左右平衡的两个实际声道读回与请求不一致。');
      }
      if (kind === 'sessions') {
        const args = {endpointId, sessionId};
        if (!nearSession(requested.volume, actualSession.volume)) args.volume = requested.volume;
        if (requested.muted !== actualSession.muted) args.muted = requested.muted;
        const result = await invoke('headset.audio.sessions.set', args);
        if (!result || result.sessionId !== sessionId || result.verified !== true || !percent(result.volume) || typeof result.muted !== 'boolean' || !nearSession(result.volume, requested.volume) || result.muted !== requested.muted) throw Error('会话音量或静音未通过系统读回验证。');
        value = entry.readback.map(item => item.sessionId === sessionId ? {...item, volume: result.volume, muted: result.muted} : item);
        entry.draft[sessionId] = clone(value.find(item => item.sessionId === sessionId));
      }
      if (kind === 'format') {
        warnings = acknowledge(await invoke('headset.audio.format.set', {endpointId, format: requested}));
        const result = await invoke('headset.audio.format.read', {endpointId});
        verified(kind, result, endpointId);
        const current = validFormat(result.format);
        if (formatKey(current) !== formatKey(requested)) throw Error('系统格式读回与所选格式不一致。');
        value = {format: current, formats: entry.readback.formats};
      }
      if (kind === 'default') {
        warnings = acknowledge(await invoke('headset.audio.default.set', {endpointId, role: requested}));
        value = validRoles(await invoke('headset.audio.default.read', {endpointId}), endpointId);
        if (!value.includes(requested)) throw Error('系统未读回所请求的默认角色。');
        const flow = endpoints.find(item => item.endpointId === endpointId)?.flow;
        for (const endpoint of endpoints) if (endpoint.endpointId !== endpointId && endpoint.flow === flow) invalidate('default', endpoint.endpointId, '同方向的默认角色已更改，请重新读取此端点。');
      }
      if (kind !== 'sessions') entry.dirty = false;
      install(kind, value, endpointId, '已应用并完成' + sourceName(kind) + '读回。' + (warnings.length ? ' ' + warnings.join('；') : ''));
      synchronizeChannels(kind, value, endpointId);
      if (kind === 'format') {
        for (const related of ['channels', 'balance', 'peak', 'sessions']) invalidate(related, endpointId, '端点格式已更改，请重新读取此项；草稿已保留。');
      }
      if (endpointId === selected) status.textContent = titles[kind] + '已应用并通过' + sourceName(kind) + '读回验证。';
    } catch (error) {
      entry.dirty = true;
      invalidate(kind, endpointId, '应用失败：' + errorText(error) + ' 旧读回已清除；草稿已保留。请重新读取，或恢复修改前状态。');
      if (kind === 'channels' || kind === 'balance') invalidate(kind === 'channels' ? 'balance' : 'channels', endpointId, '相关声道操作未通过验证；旧读回已清除，草稿已保留。');
      if (endpointId === selected) status.textContent = titles[kind] + '应用未通过验证，请重新读取实际状态。';
    } finally { for (const name of kinds) paint(name); setBusy(false); }
  }
  async function restore() {
    if (blocked()) return;
    setBusy(true);
    invalidateAll('恢复操作已开始。请重新读取核对；未应用草稿已保留。');
    for (const kind of kinds) paint(kind);
    status.textContent = '正在恢复本应用保存的音频控制快照…';
    try {
      const result = await invoke('headset.audio.controls.restore');
      if (!result || !Number.isInteger(result.restored) || result.restored < 0 || !Array.isArray(result.errors) || result.errors.some(item => typeof item !== 'string')) throw Error('恢复结果格式不完整。');
      status.textContent = (result.restored ? '已恢复 ' + result.restored + ' 项音频控制。' : '暂无可恢复的音频控制快照。') + (result.errors.length ? ' 部分恢复失败：' + result.errors.join('；') : '') + ' 点击「检测并读取音频」核对当前状态；草稿已保留。';
    } catch (error) { status.textContent = '恢复未完成：' + errorText(error) + ' 请重新读取核对实际状态；草稿已保留。'; }
    finally { setBusy(false); }
  }
  function channelName(index) {
    // The scalar API does not return a channel mask, so speaker positions remain unknown.
    return '声道 ' + (index + 1);
  }
  function numericInput(value, label) {
    const input = element('input');
    input.type = 'number';
    input.min = '0';
    input.max = '100';
    input.step = 'any';
    input.value = value === undefined ? '' : String(value);
    input.setAttribute('aria-label', label);
    input.dataset.audioEdit = 'true';
    return input;
  }
  function paint(kind) {
    if (!mounted) return;
    const card = cards.get(kind), entry = record(kind);
    card.body.replaceChildren();
    if (kind === 'balance') {
      const endpointId = selected, position = entry?.draft?.position;
      const known = Number.isInteger(position) && position >= 0 && position <= 20;
      const labels = element('div', 'headset-balance-labels');
      const left = element('output'), right = element('output');
      left.id = 'headset-audio-balance-left'; right.id = 'headset-audio-balance-right';
      labels.append(left, element('span', '', '平衡位置'), right);
      const label = element('label', 'headset-balance-control', '左右平衡（21 档）'), slider = element('input');
      slider.id = 'headset-audio-balance-position'; slider.type = 'range'; slider.min = '0'; slider.max = '20'; slider.step = '1';
      slider.value = known ? String(position) : '10'; slider.dataset.audioEdit = 'true';
      slider.setAttribute('aria-label', '左右平衡位置'); slider.setAttribute('aria-describedby', 'headset-audio-balance-note');
      const update = value => {
        left.textContent = value === null ? '左 —' : '左 ' + (100 - value * 5) + '%';
        right.textContent = value === null ? '右 —' : '右 ' + value * 5 + '%';
        slider.setAttribute('aria-valuetext', value === null ? '平衡位置未知' : '左 ' + (100 - value * 5) + '%，右 ' + value * 5 + '%');
      };
      const choose = value => {
        if (blocked() || !entry?.readback || endpointId !== selected) return;
        if (!Number.isInteger(value) || value < 0 || value > 20) return;
        entry.draft = {position: value, edited: true}; slider.value = String(value); update(value); edited(kind);
      };
      slider.addEventListener('input', () => choose(Number(slider.value))); update(known ? position : null);
      label.append(slider);
      const center = button('置中', 'secondary-button'); center.id = 'headset-audio-balance-center'; center.dataset.audioEdit = 'true';
      center.title = '草稿设为左 50% / 右 50%，点击应用平衡后生效'; center.addEventListener('click', () => choose(10));
      const note = element('p', 'small-note', '百分比表示平衡位置，实际声道电平见下方。拖动与置中只改草稿；应用时重新读取，只衰减一侧并保留当时较大的声道电平。');
      note.id = 'headset-audio-balance-note';
      card.body.append(labels, label, center, note);
      if (!entry?.readback) card.body.append(element('p', 'small-note', '尚无当前双声道读回；单声道或未知端点不提供平衡应用，保留的草稿不代表当前状态。'));
      else if (entry.readback.leftRaw === 0 && entry.readback.rightRaw === 0) card.body.append(element('p', 'small-note', '当前左右声道均为 0，无法据此推断原平衡；选择位置也不会构造非零音量。'));
    }
    if (kind === 'channels' && entry?.draft) {
      const flow = endpoints.find(item => item.endpointId === selected)?.flow;
      const grid = element('div', 'headset-audio-channels');
      for (const item of entry.draft) {
        const name = channelName(item.channelRaw);
        const label = element('label', 'headset-audio-channel', name + '（%）');
        const input = numericInput(item.percentDraft === undefined ? item.volumeRaw * 100 : item.percentDraft, name + '音量百分比');
        input.dataset.channelRaw = String(item.channelRaw);
        input.addEventListener('input', () => { if (blocked()) return; item.percentDraft = input.value; edited(kind); });
        label.append(input);
        grid.append(label);
      }
      card.body.append(grid);
      if (flow === 'capture' && entry.draft.length === 1) card.body.append(element('p', 'small-note', '当前录音端点只有一个声道，不提供左右平衡。'));
      else card.body.append(element('p', 'small-note', '声道名称按系统索引显示；没有推断扬声器位置。'));
    }
    if (kind === 'peak' && entry?.readback) {
      const list = element('div', 'headset-audio-peaks');
      entry.readback.forEach((value, index) => {
        const row = element('div', 'headset-audio-peak');
        const meter = element('meter');
        meter.min = 0; meter.max = 1; meter.value = value;
        meter.setAttribute('aria-label', '声道 ' + (index + 1) + ' 瞬时峰值');
        row.append(element('span', '', '声道 ' + (index + 1)), meter, element('output', '', pct(value)));
        list.append(row);
      });
      card.body.append(list);
    }
    if (kind === 'sessions' && entry?.draft) {
      const items = Object.values(entry.draft);
      if (!items.length) card.body.append(element('p', 'small-note', entry.readback ? '当前端点没有可见的音频会话。' : '尚无当前会话读回。'));
      for (const item of items) {
        const actual = entry.readback?.find(value => value.sessionId === item.sessionId);
        const row = element('section', 'headset-audio-session');
        row.dataset.sessionId = item.sessionId;
        row.append(element('h4', '', item.description || (item.processId === 0 ? '系统声音' : '未命名会话')));
        row.append(element('p', 'small-note', 'PID ' + (item.processId ?? '未知') + ' · ' + (actual ? actual.active === null ? '活动状态未知' : actual.active ? '活动中' : '非活动' : '请重新读取会话身份')));
        const label = element('label', '', '会话音量（%）');
        const volume = numericInput(item.percentDraft === undefined ? item.volume : item.percentDraft, (item.description || '会话') + '音量百分比');
        volume.addEventListener('input', () => { if (blocked()) return; item.percentDraft = volume.value; edited(kind); });
        const muteLabel = element('label', 'headset-audio-mute', '静音');
        const muted = element('input');
        muted.type = 'checkbox'; muted.checked = item.muted; muted.dataset.audioEdit = 'true';
        muted.addEventListener('change', () => { if (blocked()) return; item.muted = muted.checked; edited(kind); });
        muteLabel.append(muted);
        label.append(volume);
        const readback = element('p', 'field-hint', actual ? '系统读回：' + Number(actual.volume.toFixed(4)) + '% · ' + (actual.muted ? '已静音' : '未静音') : '尚无当前系统读回；草稿已保留。');
        const applyButton = button('应用此会话', 'primary-button');
        applyButton.dataset.sessionApply = item.sessionId;
        applyButton.addEventListener('click', () => { void apply(kind, item.sessionId); });
        row.append(label, muteLabel, readback, applyButton);
        card.body.append(row);
      }
    }
    if (kind === 'format') {
      const label = element('label', '', '已验证的可用格式');
      const input = element('select');
      input.dataset.audioEdit = 'true';
      const formats = entry?.readback?.formats || [];
      const empty = element('option', '', entry?.readback ? formats.length ? '选择格式' : '未返回可用格式' : '尚未读取可用格式');
      empty.value = ''; input.append(empty);
      for (const format of formats) {
        const option = element('option', '', formatText(format));
        option.value = formatKey(format); input.append(option);
      }
      if (entry?.draft && !formats.some(item => formatKey(item) === entry.draft)) {
        const option = element('option', '', (entry.dirty ? '保留的草稿：' : '当前格式：') + entry.draft + '（未在可用列表中）');
        option.value = entry.draft; option.disabled = true; input.append(option);
      }
      input.value = entry?.draft || '';
      input.addEventListener('change', () => { if (blocked() || !entry) return; entry.draft = input.value; edited(kind); void apply(kind); });
      label.append(input); card.body.append(label);
    }
    if (kind === 'default') {
      const group = element('fieldset','headset-role-options'), legend = element('legend','','设为当前方向的默认设备'); group.append(legend);
      for (const [value,text] of Object.entries(roleNames)) {
        const label=element('label','',text),input=element('input'); input.type='radio';input.name='headset-default-role-'+value;input.value=value;input.dataset.audioEdit='true';input.checked=entry?.readback?.includes(value)===true;
        input.addEventListener('click',()=>{if(blocked()||!entry)return;entry.draft={role:value};edited(kind);void apply(kind);});label.prepend(input);group.append(label);
      }
      card.body.append(group);

    }
  }
  function summarize(kind, entry) {
    if (!entry?.readback) return '尚无当前系统读回。';
    if (kind === 'channels') return entry.readback.map(item => '声道 ' + (item.channelRaw + 1) + '：' + pct(item.volumeRaw)).join(' · ');
    if (kind === 'balance') return '实际声道读回：左 ' + pct(entry.readback.leftRaw) + ' · 右 ' + pct(entry.readback.rightRaw);
    if (kind === 'peak') return entry.live ? '峰值为 0–1 标量，以百分比显示；来自 Windows 持续监测的最新样本。' : '峰值为 0–1 标量，以百分比显示；只代表本次采样。';
    if (kind === 'sessions') return entry.readback.length + ' 个当前会话；各会话读回见上方。';
    if (kind === 'format') return formatText(entry.readback.format) + ' · ' + entry.readback.formats.length + ' 个已验证可用格式';
    if (kind === 'default') return entry.readback.length ? '当前默认角色：' + entry.readback.map(role => roleNames[role]).join('、') : '当前端点没有多媒体或通信默认角色。';
    return '';
  }
  function sync() {
    if (!mounted) return;
    const locked = blocked();
    section.setAttribute('aria-busy', String(busy));
    readButton.disabled = locked;
    readButton.textContent = busy ? '音频操作中…' : '检测并读取音频';
    endpointSelect.disabled = locked || !endpoints.length;
    restoreButton.disabled = locked;
    for (const kind of kinds) {
      const card = cards.get(kind), entry = record(kind);
      const channelState = kind === 'balance' ? record('channels')?.readback : null;
      const unavailable = channelState && channelState.length !== 2;
      const invalid = draftError(kind, entry);
      let dirty = false;
      try { dirty = difference(kind, entry); } catch { dirty = true; }
      card.read.disabled = locked || !selected;
      card.chip.textContent = unavailable ? '不适用' : !entry?.readback ? entry?.draft ? '请重新读取' : '尚未读取' : dirty ? '有待应用的草稿' : kind === 'peak' ? entry.live ? '持续反馈' : '单次采样' : '已读取系统';
      card.chip.className = 'setting-capability ' + (entry?.readback ? 'enabled' : 'pending');
      card.readback.textContent = summarize(kind, entry);
      card.source.textContent = unavailable ? '来源：Windows 实际声道布局' : entry?.readback ? sourceName(kind) + ' · 已验证 · ' + new Date(entry.readAt).toLocaleTimeString('zh-CN', {hour12: false}) : '来源：等待读取当前' + sourceName(kind) + '状态';
      card.message.textContent = (entry?.message || (selected ? '点击读取此项获取当前状态。' : '点击「检测并读取音频」选择目标端点。')) + (invalid ? ' ' + invalid : '');
      card.message.dataset.error = String(Boolean(entry?.error || invalid));
      card.message.setAttribute('role', entry?.error ? 'alert' : 'status');
      for (const input of card.body.querySelectorAll('[data-audio-edit]')) {
        const sessionRow = input.closest('[data-session-id]');
        input.disabled = locked || !entry?.readback || (sessionRow && !entry.readback.some(item => item.sessionId === sessionRow.dataset.sessionId));
      }
      if (card.apply) card.apply.disabled = locked || !entry?.readback || !dirty || Boolean(invalid);
      if (kind === 'sessions') for (const applyButton of card.body.querySelectorAll('[data-session-apply]')) {
        const item = entry?.draft?.[applyButton.dataset.sessionApply];
        const actual = entry?.readback?.find(value => value.sessionId === applyButton.dataset.sessionApply);
        let changed = false;
        try { changed = Boolean(item && actual && sessionDirty(item, actual)); } catch { /* Invalid drafts remain visible and unwritable. */ }
        applyButton.disabled = locked || !actual || !changed || Boolean(invalid);
      }
    }
  }
  function acceptMonitor(snapshot) {
    if (!mounted || busy || snapshot?.source !== 'windows-system') return;
    const sampledAt = Date.parse(snapshot.sampledAt);
    const updates = snapshot.running && Array.isArray(snapshot.endpoints) && Number.isFinite(sampledAt) ? snapshot.endpoints : endpoints.map(item => ({endpointId: item.endpointId, available: false}));
    for (const item of updates) {
      const endpointId = item?.endpointId;
      if (!endpoints.some(endpoint => endpoint.endpointId === endpointId)) continue;
      if (Number.isFinite(sampledAt) && ['channels', 'balance', 'peak'].some(kind => (record(kind, endpointId)?.readAt || 0) > sampledAt)) continue;
      if (!item.available || item.identityVerified !== true) {
        for (const kind of ['channels', 'balance', 'peak']) invalidate(kind, endpointId, '实时监测未取得当前端点读回；已有草稿已保留。');
      } else {
        if (Array.isArray(item.channels) && item.channels.length >= 1 && item.channels.length <= 32 && item.channels.every(scalar)) {
          const values = item.channels.map((volumeRaw, channelRaw) => ({channelRaw, volumeRaw}));
          install('channels', values, endpointId, 'Windows 持续监测的实际声道读回。');
          synchronizeChannels('channels', values, endpointId);
        } else for (const kind of ['channels', 'balance']) invalidate(kind, endpointId, '实时声道读回未知；已有草稿已保留。');
        if (Array.isArray(item.peaks) && item.peaks.length >= 1 && item.peaks.length <= 32 && item.peaks.every(scalar)) {
          install('peak', [...item.peaks], endpointId, 'Windows 持续监测的最新峰值。');
          record('peak', endpointId).live = true;
        } else invalidate('peak', endpointId, '实时峰值读回未知。');
      }
      if (endpointId === selected) for (const kind of ['channels', 'balance', 'peak']) {
        const entry = record(kind, endpointId), card = cards.get(kind);
        if (kind === 'peak' || !entry?.dirty && !card.node.contains(document.activeElement)) paint(kind);
      }
    }
    sync();
  }
  async function focusEndpoint(endpointId, kind = 'balance') {
    if (blocked() || typeof endpointId !== 'string' || !kinds.includes(kind)) return false;
    try {
      if (!endpoints.some(endpoint => endpoint.endpointId === endpointId)) await readAll();
      if (!endpoints.some(endpoint => endpoint.endpointId === endpointId)) throw Error('目标端点当前不可用，请重新检测。');
      selected = endpointId; fillEndpoints(); sync();
      if (kind === 'balance') { await readOne('channels'); await readOne('balance'); }
      else await readOne(kind);
      cards.get(kind).node.scrollIntoView({block: 'start', behavior: 'smooth'});
      return true;
    } catch (error) { status.textContent = '打开控制未完成：' + errorText(error); return false; }
  }
  function mount() {
    if (mounted) return;
    const host = document.getElementById('audio-settings');
    if (!host || document.getElementById('headset-audio-panel')) return;
    section = element('section', 'headset-audio');
    section.id = 'headset-audio-panel';
    section.setAttribute('aria-label', '耳机高级音频控制');
    const heading = element('div', 'subheading');
    heading.append(element('h3', '', '平衡、声道、会话与格式'), element('span', 'source-label', 'Windows 音频控制'));
    section.append(heading, element('p', 'small-note', '显示当前端点的真实系统状态，切换端点后自动读取。平衡、声道与会话需单独应用；格式与默认角色选择直接生效。音频总览可见时持续更新声道与峰值，已有草稿保留。'));
    const toolbar = element('div', 'headset-audio-toolbar');
    readButton = button('检测并读取音频', 'primary-button'); readButton.id = 'headset-audio-read';
    readButton.addEventListener('click', () => { void readAll(); });
    toolbar.append(readButton); section.append(toolbar);
    const label = element('label', 'headset-audio-endpoint', '高级音频端点');
    endpointSelect = element('select'); endpointSelect.id = 'headset-audio-endpoint';
    endpointSelect.addEventListener('change', () => {
      if (blocked()) { endpointSelect.value = selected; return; }
      if (!endpoints.some(item => item.endpointId === endpointSelect.value)) return;
      selected = endpointSelect.value;
      for (const kind of kinds) paint(kind);
      status.textContent = '正在读取当前端点…';
      sync(); void readAll();
    });
    label.append(endpointSelect); section.append(label);
    status = element('p', 'small-note', '尚未读取高级音频状态。'); status.id = 'headset-audio-status';
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); section.append(status);
    const grid = element('div', 'headset-audio-grid');
    for (const kind of kinds) {
      const node = element('section', 'setting-card headset-audio-card');
      node.id = 'headset-audio-' + kind; node.setAttribute('aria-label', titles[kind]);
      const header = element('div', 'subheading');
      const chip = element('span', 'setting-capability pending', '尚未读取');
      header.append(element('h3', '', titles[kind]), chip);
      const read = button(kind === 'peak' ? '单次读取峰值' : '读取' + titles[kind]);
      read.id = 'headset-audio-' + kind + '-read'; read.addEventListener('click', () => { void readOne(kind); });
      const body = element('div', 'headset-audio-body');
      const readback = element('p', 'field-hint');
      const source = element('p', 'source-label');
      const message = element('p', 'small-note'); message.setAttribute('aria-live', 'polite');
      node.append(header, read, body, readback, source, message);
      let applyButton = null;
      if (kind === 'channels' || kind === 'balance') {
        applyButton = button(kind === 'balance' ? '应用平衡' : '应用' + titles[kind], 'primary-button');
        applyButton.id = 'headset-audio-' + kind + '-apply';
        applyButton.addEventListener('click', () => { void apply(kind); });
        node.append(applyButton);
      }
      cards.set(kind, {node, chip, body, read, readback, source, message, apply: applyButton});
      grid.append(node);
    }
    section.append(grid);
    const restoreCard = element('div', 'setting-card headset-audio-recovery');
    restoreCard.append(element('h3', '', '恢复修改前的音频控制'), element('p', 'small-note', '恢复本应用保存的平衡、声道、会话、格式与默认角色快照。恢复结果由服务返回；随后手动读取核对当前状态。'));
    restoreButton = button('恢复音频控制快照'); restoreButton.id = 'headset-audio-restore';
    restoreButton.addEventListener('click', () => { void restore(); }); restoreCard.append(restoreButton);
    section.append(restoreCard); host.append(section);
    mounted = true;
    fillEndpoints(); sync();
  }
  window.headsetAudio = {
    init(options = {}) { hooks = options; mount(); sync(); },
    isBusy: () => busy,
    open() { if (!blocked()) void readAll(); },
    sync, acceptMonitor, focusEndpoint
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once: true});
  else mount();
})();
