'use strict';
(() => {
  const DEVICE_ID = 'inphic-in9';
  const MAX_BYTES = 1024 * 1024;
  const MAX_BASE64 = 4 * Math.ceil(MAX_BYTES / 3);
  const MAX_PACKETS = 256;
  const DOMAIN_DEFS = [
    ['dpi', 'DPI 档位'], ['dpiColors', 'DPI 指示色'], ['polling', '回报率'],
    ['lighting', '灯光'], ['buttons', '按键分配'],
    ['debounce', '按键防抖'], ['power', '休眠 / 移动熄灯'], ['motion', '移动唤醒'], ['lift', '抬升高度']
  ];
  const DOMAIN_IDS = DOMAIN_DEFS.map(item => item[0]);
  const DOMAIN_NAMES = {...Object.fromEntries(DOMAIN_DEFS), macros: '旧版宏（仅历史记录）'};
  const DEFAULT_DOMAINS = new Set(['dpi', 'polling', 'lighting']);
  const DPI_OPTIONS = [...Array.from({length: 49}, (_, index) => 200 + index * 100), 5500, 6000, 6400, 7000, 7500, 8000, 8500, 9000, 9500, 10000];
  const RATE_OPTIONS = [125, 250, 500, 1000];
  const parameterControls = [];
  let parameterState = null;
  const hexByte = value => value.toString(16).padStart(2, '0').toUpperCase();
  function actionCatalog() {
    const catalog = window.in9Actions;
    if (!catalog || !Array.isArray(catalog.groups) || typeof catalog.resolveSelection !== 'function') fail('固定动作目录尚未加载，请重新打开应用。');
    return catalog;
  }
  const state = {
    deviceId: DEVICE_ID, view: 'mouse-profile', busy: false, revision: 0, session: 0, contentBase64: '',
    fileName: 'IN9-profile.psf', encoding: '', installedProfiles: [], liveStatus: null, preview: null, receipts: null,
    status: '导入官方 PSF 或粘贴配置文本，然后手动预览。', statusKind: 'idle'
  };
  let hooks = {}, ui = null;
  const domainInputs = new Map();
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
  const boundedText = (value, max, nullable = false) => (nullable && value === null) || (typeof value === 'string' && value.length <= max);
  const nullableByte = value => value === null || integer(value, 0, 255);
  const nullableBoolean = value => value === null || typeof value === 'boolean';
  const errorText = error => (typeof error?.message === 'string' ? error.message : '本地配置服务异常。').slice(0, 2048);
  function fail(message = '服务返回的配置结果不完整，请重新预览。') { throw Error(message); }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(id, text, primary = false) {
    const node = element('button', primary ? 'primary-button' : 'secondary-button', text);
    node.type = 'button'; node.id = id;
    return node;
  }
  function note(text) { return element('p', 'in9-profile-note', text); }
  function blocked() { return state.busy || Boolean(hooks.isBusy?.()); }
  function selectedDomains() { return DOMAIN_IDS.filter(id => domainInputs.get(id)?.checked); }
  function sameDomains(left, right) { return left.length === right.length && left.every((value, index) => value === right[index]); }
  function validateDomains(value, historical = false) {
    const allowed = historical ? Object.keys(DOMAIN_NAMES) : DOMAIN_IDS;
    if (!Array.isArray(value) || value.length < 1 || value.length > allowed.length || value.some(id => !allowed.includes(id)) || new Set(value).size !== value.length) fail('服务返回了无效的应用范围。');
    return [...value];
  }
  function validateWarnings(value) {
    if (!Array.isArray(value) || value.length > 64 || value.some(item => !boundedText(item, 4096))) fail('服务提示超出允许范围。');
    return [...value];
  }
  function decodeBase64(value) {
    if (typeof value !== 'string' || value.length < 4 || value.length > MAX_BASE64 || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail('PSF 内容须为 1 字节至 1 MiB 的有效 Base64。');
    let raw;
    try { raw = atob(value); } catch { fail('PSF Base64 解码失败。'); }
    if (!raw.length || raw.length > MAX_BYTES || btoa(raw) !== value) fail('PSF 内容大小或 Base64 编码无效。');
    return Uint8Array.from(raw, character => character.charCodeAt(0));
  }
  function encodeBase64(bytes) {
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_BYTES) fail('PSF 文件大小须为 1 字节至 1 MiB。');
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 8192) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
    return btoa(chunks.join(''));
  }
  function decodeText(bytes) {
    let encoding = 'UTF-8', offset = 0;
    if (bytes[0] === 255 && bytes[1] === 254) {
      if (bytes.length % 2) fail('UTF-16LE 文件末尾不完整。');
      encoding = 'UTF-16LE'; offset = 2;
    } else if (bytes[0] === 254 && bytes[1] === 255) fail('请使用 UTF-16LE 或 UTF-8 编码的官方 PSF。');
    else if (bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) offset = 3;
    let text;
    try { text = new TextDecoder(encoding, {fatal: true}).decode(bytes.subarray(offset)); }
    catch { fail('无法按 UTF-16LE / UTF-8 解码此 PSF。'); }
    if (text.includes('\0')) fail('PSF 文本包含无效的空字符。');
    return {text, encoding};
  }
  function validateSha(value) {
    if (typeof value !== 'string' || !/^[A-Fa-f0-9]{64}$/.test(value)) fail('服务没有返回有效的内容摘要。');
    return value.toUpperCase();
  }
  function validateLiveStatus(value) {
    const allowed=['source','scope','hardwareReadback','writePerformed','sensorCode','sensorName','family','batteryPercent','charging','activityFlagRaw','readAt','warnings'];
    if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || value.source !== 'live-hardware-feature20' || value.scope !== 'identity-power-activity' || value.hardwareReadback !== true || value.writePerformed !== false || value.sensorCode !== 37 || value.family !== 'M909' || !boundedText(value.sensorName, 128) || !integer(value.batteryPercent, 0, 100) || typeof value.charging !== 'boolean' || !integer(value.activityFlagRaw, 0, 255) || !boundedText(value.readAt, 64) || !Number.isFinite(Date.parse(value.readAt)) || !Array.isArray(value.warnings)) fail('实时IN9状态超出已验证Feature20范围。');
    return value;
  }
  function validateInstalledProfiles(value) {
    if (object(value) && value.found === false && value.source === null && value.directory === null && value.profileCount === 0 && value.hardwareIO === false && value.applied === false && value.stagedOnly === true && Array.isArray(value.profiles) && value.profiles.length === 0) return [];
    if (!object(value) || value.found !== true || !['official-user-data','official-install', 'bundled-defaults'].includes(value.source) || value.hardwareIO !== false || value.applied !== false || value.stagedOnly !== true || !Array.isArray(value.profiles) || value.profiles.length > 5) fail('本地 PSF 列表无效。');
    return value.profiles.map(entry => {
      if (!object(entry) || !boundedText(entry.file, 128) || !boundedText(entry.path, 512) || entry.hardwareReadback !== false || entry.applied !== false || entry.stagedOnly !== true) fail('本地 PSF 条目来源无效。');
      const contentBase64 = entry.contentBase64, contentSha256 = validateSha(entry.contentSha256), bytes = decodeBase64(contentBase64);
      if (!object(entry.profile) || entry.profile.hardwareReadback !== false) fail('PSF 条目不是本地配置。');
      validateProfile(entry.profile);
      return {file: entry.file, path: entry.path, profile: entry.profile, contentBase64, contentSha256, bytes, source: value.source};
    });
  }
  function validateArchiveResult(value) {
    const allowed = ['archiveCreated','archiveId','archiveRelativeDirectory','createdAt','files','hardwareReadback','sourceFilesModified','warnings'];
    if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || value.hardwareReadback !== false || value.sourceFilesModified !== false || !Array.isArray(value.files) || value.files.length > 64 || !Array.isArray(value.warnings) || value.warnings.some(item => !boundedText(item, 2048)) || !boundedText(value.createdAt,64) || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.archiveCreated !== 'boolean') fail('IN9 本地文件归档回执无效。');
    if (!value.archiveCreated) {
      if (value.archiveId !== null || value.archiveRelativeDirectory !== null || value.files.length) fail('空归档回执包含了归档内容。');
      return value;
    }
    if (typeof value.archiveId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.archiveId) || value.archiveRelativeDirectory !== 'local-state/vendor-config-archives/in9/' + value.archiveId || !value.files.length) fail('IN9 归档目录标识无效。');
    const paths = new Set();
    for (const file of value.files) {
      const relative = typeof file?.relativePath === 'string' ? /^source-(\d+)\/([A-Za-z0-9_. -]{1,128})$/.exec(file.relativePath) : null;
      if (!object(file) || !['official-user-data','official-install'].includes(file.source) || !boundedText(file.fileName,128) || !/^(?:[A-Za-z0-9_. -]{1,124}\.psf|config\.ini|MacroLibraryFile\.mlf)$/i.test(file.fileName) || !relative || relative[2] !== file.fileName || paths.has(file.relativePath) || !integer(file.byteLength,1,8*1024*1024) || !/^[0-9a-f]{64}$/i.test(file.sha256)) fail('IN9 归档文件清单无效。');
      paths.add(file.relativePath);
    }
    return value;
  }
  async function checkSha(bytes, expected) {
    if (typeof window.crypto?.subtle?.digest !== 'function') fail('当前环境无法核对文件摘要，请从桌面程序打开。');
    const digest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', bytes));
    const actual = Array.from(digest, item => item.toString(16).padStart(2, '0')).join('').toUpperCase();
    if (actual !== expected) fail('返回的 PSF 字节与内容摘要不一致。');
  }
  function validateProfile(value) {
    if (!object(value) || value.source !== 'user-selected-official-local-profile' || value.hardwareReadback !== false || value.sensorCode !== 37) fail('预览来源必须是用户选择的本地 IN9 配置。');
    if (!(value.profileName === null || boundedText(value.profileName, 256, true)) || !Array.isArray(value.linkedGameFiles) || value.linkedGameFiles.length !== 3 || value.linkedGameFiles.some(item => !(item === null || boundedText(item, 512, true)))) fail('PSF 配置元数据无效。');
    if (!integer(value.enabledMask, 1, 63) || !integer(value.currentEnabledOrdinal, 0, 5)) fail('DPI 启用档位无效。');
    const enabled = Array.from({length: 6}, (_, index) => index).filter(index => value.enabledMask & (1 << index));
    if (value.currentEnabledOrdinal >= enabled.length) fail('当前 DPI 档位不在启用范围内。');
    if (!Array.isArray(value.dpiSlots) || value.dpiSlots.length !== 8 || value.dpiSlots.some(item => !integer(item, 200, 10000)) || !Array.isArray(value.dpiColorsRgb) || value.dpiColorsRgb.length !== 8 || value.dpiColorsRgb.some(item => !integer(item, 0, 0xFFFFFF))) fail('预览须含 8 个保留 DPI 值及 8 个 RGB 指示色。');
    if (![125, 250, 500, 1000].includes(value.pollingRateHz)) fail('回报率不在已支持范围内。');
    const light = value.lighting;
    if (light !== null && (!object(light) || !integer(light.mode, 0, 9) || typeof light.enabled !== 'boolean' || !integer(light.speedIndex, 0, 255) || !integer(light.brightnessIndex, 0, 255) || !integer(light.direction, 0, 255) || !integer(light.colorCount, 0, 10))) fail('灯光预览数据无效。');
    if (value.keyCount !== 6 || !Array.isArray(value.keys) || value.keys.length !== 6) fail('预览须含 6 个按键。');
    const keys = value.keys.map((key, index) => {
      if (!object(key) || key.index !== index || !boundedText(key.name, 8192, true) || !boundedText(key.macroName, 8192, true) || typeof key.valueHex !== 'string' || !/^[A-Fa-f0-9]{6}$/.test(key.valueHex) || !(key.macroActionCount === null || integer(key.macroActionCount, 0, 336)) || typeof key.hasStoredMacro !== 'boolean') fail('按键或宏预览数据无效。');
      return {index, name: key.name, valueHex: key.valueHex.toUpperCase(), macroName: key.macroName, macroActionCount: key.macroActionCount, hasStoredMacro: key.hasStoredMacro};
    });
    if (!nullableByte(value.powerDownTimeRaw) || !nullableByte(value.keyDebounceRaw) || !nullableBoolean(value.moveClosesLight) || !nullableBoolean(value.motionWakeup)) fail('电源或性能预览数据无效。');
    return {
      profileName: value.profileName, linkedGameFiles: [...value.linkedGameFiles],
      enabledMask: value.enabledMask, currentEnabledOrdinal: value.currentEnabledOrdinal,
      dpiSlots: [...value.dpiSlots], dpiColorsRgb: [...value.dpiColorsRgb], pollingRateHz: value.pollingRateHz,
      lighting: light === null ? null : {mode: light.mode, enabled: light.enabled, speedIndex: light.speedIndex, brightnessIndex: light.brightnessIndex, direction: light.direction, colorCount: light.colorCount},
      keys, powerDownTimeRaw: value.powerDownTimeRaw, keyDebounceRaw: value.keyDebounceRaw,
      moveClosesLight: value.moveClosesLight, motionWakeup: value.motionWakeup
    };
  }
  async function validatePreview(result, contentBase64, domains, transmission = false) {
    if (!object(result) || result.hardwareReadback !== false || result.verified !== false || result.applied !== false || result.transmitted !== transmission) fail('服务未明确区分本地配置与未读回的设备传输。');
    const profile = validateProfile(result.profile);
    if (!integer(result.packetCount, 1, MAX_PACKETS)) fail('生成报文数量超出允许范围。');
    const actualDomains = validateDomains(result.domains);
    if (domains && !sameDomains(actualDomains, domains)) fail('服务返回的应用范围与本次请求不一致。');
    if (contentBase64 !== null && result.contentBase64 !== contentBase64) fail('服务返回的 PSF 与本次预览字节不一致。');
    const bytes = decodeBase64(result.contentBase64), contentSha256 = validateSha(result.contentSha256);
    await checkSha(bytes, contentSha256);
    const clean = {profile, packetCount: result.packetCount, domains: actualDomains, warnings: validateWarnings(result.warnings), contentBase64: result.contentBase64, contentSha256};
    if (transmission) {
      if (result.transmittedCount !== result.packetCount || !integer(result.transmittedCount, 1, MAX_PACKETS) || result.baselineKind !== 'explicitly-selected-desired-profile' || typeof result.containerId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(result.containerId)) fail('服务没有返回完整的传输回执。');
      const info = result.info;
      if (!object(info) || info.sensorCode !== 37 || info.family !== 'M909' || !boundedText(info.sensorName, 128) || !integer(info.batteryPercent, 0, 100) || typeof info.charging !== 'boolean' || !integer(info.activityFlagRaw, 0, 255) || !boundedText(info.readAt, 64) || !Number.isFinite(Date.parse(info.readAt))) fail('传输目标身份确认数据无效。');
      clean.transmittedCount = result.transmittedCount;
      clean.containerId = result.containerId;
    }
    return clean;
  }
  function validateReceipt(value) {
    if (value === null) return null;
    if (!object(value) || value.transmitted !== true || value.hardwareReadback !== false || value.verified !== false || !integer(value.packetCount, 1, MAX_PACKETS) || !boundedText(value.selectedAt, 64) || !Number.isFinite(Date.parse(value.selectedAt))) fail('本地传输回执无效。');
    return {contentSha256: validateSha(value.contentSha256), domains: validateDomains(value.domains, true), packetCount: value.packetCount, selectedAt: value.selectedAt};
  }
  function validateRead(result) {
    if (!object(result) || result.source !== 'local-transmission-ledger' || result.hardwareReadback !== false || result.verified !== false || result.hasOriginalHardwareBaseline !== false || typeof result.recoveryPending !== 'boolean' || typeof result.canRestorePrevious !== 'boolean') fail('服务未返回有效的本地传输记录。');
    if (!(result.containerId === null || (typeof result.containerId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(result.containerId)))) fail('本地记录的接收器身份无效。');
    const active = validateReceipt(result.active), previousApplied = validateReceipt(result.previousApplied);
    if (result.canRestorePrevious && (!active || active.domains.includes('macros') || (!result.recoveryPending && (!previousApplied || previousApplied.domains.includes('macros'))))) fail('可恢复标记与本地记录不一致。');
    return {active, previousApplied, recoveryPending: result.recoveryPending, canRestorePrevious: result.canRestorePrevious, warnings: validateWarnings(result.warnings)};
  }
  async function invoke(operation, args) {
    if (typeof window.hub?.features?.invoke !== 'function') fail('本地配置服务尚未就绪，请从桌面程序打开。');
    const response = await window.hub.features.invoke({apiVersion: 1, deviceId: DEVICE_ID, operation, args});
    if (!object(response) || response.ok !== true) {
      const message = boundedText(response?.error?.message, 4096) ? response.error.message : '本地配置服务没有返回成功结果。';
      fail(message);
    }
    return response.data;
  }
  const liveStatusPlaceholder = '尚未读取。该查询仅读身份、电量、充电和活动状态。';
  function liveStatusText(value) {
    if (!value) return liveStatusPlaceholder;
    return `M909 / ${value.sensorName} · 电量 ${value.batteryPercent}% · ${value.charging ? '充电中' : '未充电'} · activity ${value.activityFlagRaw} · ${value.readAt}`;
  }
  function paintLiveStatus() { if (ui?.liveStatus) ui.liveStatus.textContent = liveStatusText(state.liveStatus); }
  function invalidateForDeviceChange() {
    state.session++;
    const wasBusy = Boolean(state.busy);
    state.busy = false;
    state.liveStatus = null;
    if (wasBusy) hooks.onBusyChange?.(false);
    paintLiveStatus();
  }
  function beginLiveStatusRead() {
    state.liveStatus = null;
    paintLiveStatus();
  }
  function setBusy(value) {
    state.busy = value;
    sync();
    hooks.onBusyChange?.(value);
  }
  function setStatus(message, kind = 'idle') {
    state.status = message; state.statusKind = kind;
    if (ui) { ui.status.textContent = message; ui.status.dataset.kind = kind; }
  }
  function clearPreview(message) {
    state.revision++;
    state.preview = null;
    if (ui) { ui.accept.checked = false; ui.summary.replaceChildren(); ui.previewWarnings.replaceChildren(); ui.previewPanel.hidden = true; }
    if (message) setStatus(message);
    sync();
  }
  function freshPreview() {
    const preview = state.preview;
    return Boolean(preview && preview.revision === state.revision && preview.contentBase64 === state.contentBase64 && sameDomains(preview.domains, selectedDomains()));
  }
  function paintWarnings(list, warnings) {
    list.replaceChildren();
    const translations = {
      'PSF is a user-selected local profile; it is not a hardware readback or original-device backup.': '这是用户选择的本地配置，不是硬件读回，也不是原设备配置备份。',
      'PowerDownTime/MoveLightingOnOffMode is absent; power domain remains unavailable until explicitly supplied.': '配置缺少休眠或移动熄灯字段；请明确填写后再选择电源范围。',
      'KeyDebounce is absent; debounce domain remains unavailable until explicitly supplied.': '配置缺少按键防抖字段；请明确填写后再选择防抖范围。',
      'MotionWakeup is absent; motion domain remains unavailable until explicitly supplied.': '配置缺少移动唤醒字段；请明确填写后再选择移动唤醒范围。',
      'LiftDetectionHeight is absent; LiftDetectionValue is not substituted.': '配置缺少抬升高度字段；不会使用旧版相似字段代替，请明确选择高度代码。',
      'Lighting OffOn=false with nonzero mode has no proven wire transform and is rejected by apply planning.': '非零灯光模式与关闭标记没有已确认的报文转换；请明确选择模式 0。',
      'No complete IN9 settings readback exists; transmitted frames are not verified hardware state.': 'IN9 暂无完整配置读回；已传输报文不能视为硬件状态已验证。',
      'Local receipts prove only previous generated-frame transmission; no original hardware snapshot exists.': '本地记录仅证明之前的配置报文传输；没有原设备配置快照。',
      'Exported values are a selected local profile, not hardware state.': '导出文件保存的是所选本地配置，不代表当前硬件状态。',
      'All generated packets were accepted by the OS sender; physical effects and hardware storage have not been read back.': '系统发送接口已接受全部生成报文；设备效果与硬件存储尚未读回。'
    };
    for (const warning of warnings) {
      const item = element('li'); item.append(element('span', '', translations[warning] || '服务返回了额外提示，请展开原文核对。'));
      const details = element('details', 'in9-profile-warning-original');
      details.append(element('summary', '', '原始服务提示'), element('p', '', warning)); item.append(details); list.append(item);
    }
    list.hidden = !warnings.length;
  }
  function row(list, title, value) {
    const wrapper = element('div', 'in9-profile-detail');
    wrapper.append(element('dt', '', title), element('dd', '', value)); list.append(wrapper);
  }
  function paintPreview(preview) {
    const profile = preview.profile;
    ui.summary.replaceChildren();
    row(ui.summary, '配置来源', '用户选择的官方本地 PSF · 不是设备读回');
    row(ui.summary, '传感器分支', '3325 / 代码 37');
    row(ui.summary, '本次传输范围', preview.domains.map(id => DOMAIN_NAMES[id]).join('、'));
    row(ui.summary, '生成报文', `${preview.packetCount} 条 · 尚未传输`);
    row(ui.summary, '回报率', `${profile.pollingRateHz} Hz`);
    const enabled = Array.from({length: 6}, (_, index) => index).filter(index => profile.enabledMask & (1 << index));
    const current = enabled[profile.currentEnabledOrdinal];
    const dpi = element('div', 'in9-profile-dpi');
    profile.dpiSlots.forEach((value, index) => {
      const slot = element('div', 'in9-profile-dpi-slot');
      slot.dataset.enabled = String(enabled.includes(index));
      slot.dataset.current = String(index === current);
      const color = '#' + profile.dpiColorsRgb[index].toString(16).padStart(6, '0');
      const swatch = element('span', 'in9-profile-swatch'); swatch.style.backgroundColor = color; swatch.title = color;
      slot.append(element('span', '', index < 6 ? `档位 ${index + 1}` : `保留位 ${index + 1}`), element('strong', '', String(value)), element('small', '', index >= 6 ? '仅保留原字段' : index === current ? '启用 · 当前选中' : enabled.includes(index) ? '启用' : '未启用'), swatch);
      dpi.append(slot);
    });
    ui.summary.append(dpi);
    const light = profile.lighting;
    row(ui.summary, '灯光', light ? `模式代码 ${light.mode} · ${light.enabled ? '开启' : '关闭'} · 速度索引 ${light.speedIndex} · 亮度索引 ${light.brightnessIndex} · 方向 ${light.direction} · ${light.colorCount} 色` : '未提供');
    row(ui.summary, '防抖 / 休眠原值', `${profile.keyDebounceRaw ?? '未提供'} / ${profile.powerDownTimeRaw ?? '未提供'}`);
    const boolText = value => value === null ? '未提供' : value ? '开启' : '关闭';
    row(ui.summary, '移动熄灯 / 移动唤醒', `${boolText(profile.moveClosesLight)} / ${boolText(profile.motionWakeup)}`);
    const keys = element('div', 'in9-profile-keys');
    for (const key of profile.keys) {
      const card = element('div', 'in9-profile-key');
      card.append(element('strong', '', `按键 ${key.index + 1} · ${key.name || '未命名'}`), element('code', '', key.valueHex));
      keys.append(card);
    }
    ui.summary.append(keys);
    row(ui.summary, 'SHA-256', preview.contentSha256);
    paintWarnings(ui.previewWarnings, preview.warnings);
    ui.previewPanel.hidden = false;
  }
  function receiptText(receipt) {
    return `${receipt.packetCount} 条报文 · ${receipt.domains.map(id => DOMAIN_NAMES[id]).join('、')} · ${new Date(receipt.selectedAt).toLocaleString('zh-CN', {hour12: false})}\nSHA-256 ${receipt.contentSha256}`;
  }
  function paintReceipts() {
    if (!ui) return;
    const receipts = state.receipts;
    ui.activeReceipt.textContent = receipts?.active ? receiptText(receipts.active) : '尚无已读取的当前传输记录。';
    ui.previousReceipt.textContent = receipts?.previousApplied ? receiptText(receipts.previousApplied) : '尚无已读取的上一次配置。';
    ui.receiptStatus.textContent = !receipts ? '点击“读取本地记录”后确认是否可恢复；此操作不读取鼠标配置。' : receipts.recoveryPending ? (receipts.canRestorePrevious ? '存在未完成传输。可明确确认后重新传输此前已知配置；也可重新预览并重试同一配置与范围。原设备未知配置没有备份。' : '存在未完成传输，且无可恢复的已知配置。仅可重新预览并明确重试同一配置与范围；后端会核对记录。') : receipts.canRestorePrevious ? '可重新传输上一次由本应用发送的配置。原设备未知配置没有备份。' : '没有可恢复的上一次传输配置。原设备未知配置没有备份。';
    ui.receiptStatus.dataset.kind = receipts?.recoveryPending ? 'error' : 'idle';
    paintWarnings(ui.receiptWarnings, receipts?.warnings || []);
  }
  function updateSourceMeta() {
    if (!ui) return;
    const bytes = state.contentBase64 ? decodeBase64(state.contentBase64).length : 0;
    ui.sourceMeta.textContent = bytes ? `所选配置：${state.fileName} · ${bytes.toLocaleString('zh-CN')} 字节 · ${state.encoding}` : '所选配置：尚未载入 · 支持 UTF-16LE / UTF-8 · 最大 1 MiB';
  }
  function paintView() {
    if (!ui?.viewTitle) return;
    const titles = {'mouse-profile':'配置与传输', lighting:'灯光', keys:'按键分配', performance:'DPI 与性能', restore:'已知配置恢复'};
    ui.viewTitle.textContent = titles[state.view];
    for (const group of ui.parameters.querySelectorAll('[data-in9-views]')) group.hidden = state.view !== 'mouse-profile' && !group.dataset.in9Views.split(' ').includes(state.view);
    ui.controls.hidden = state.view !== 'mouse-profile';
    ui.previewPanel.hidden = state.view !== 'mouse-profile' || !freshPreview();
    ui.transfer.hidden = !['mouse-profile','restore'].includes(state.view);
    ui.applyButton.hidden = state.view === 'restore';
    ui.exportCard.hidden = state.view !== 'mouse-profile';
    ui.liveCard.hidden = state.view !== 'mouse-profile';
    ui.receiptCard.hidden = !['mouse-profile','restore'].includes(state.view);
    if (ui.systemMouse) ui.systemMouse.hidden = state.view !== 'performance';
    ui.emptyParameters.hidden = Boolean(parameterState) || state.view === 'restore';
  }
  function showView(view) {
    state.view = ['mouse-profile','lighting','keys','performance','restore'].includes(view) ? view : 'mouse-profile';
    mount(); sync();
  }
  function sync() {
    if (!ui) return;
    const inactive = state.deviceId !== DEVICE_ID, locked = inactive || blocked();
    ui.section.hidden = inactive;
    ui.section.setAttribute('aria-busy', String(Boolean(state.busy)));
    ui.importButton.disabled = locked;
    ui.installedButton.disabled = locked;
    ui.archiveButton.disabled = locked;
    ui.archiveButton.textContent = state.busy === 'archive' ? '正在归档…' : '归档官方本地配置';
    ui.installedSelect.disabled = locked || !state.installedProfiles.length;
    ui.installedLoad.disabled = locked || !state.installedProfiles.length;
    ui.liveReadButton.disabled = locked;

    ui.file.disabled = locked;
    ui.raw.disabled = locked;
    for (const input of domainInputs.values()) input.disabled = locked;
    ui.previewButton.disabled = locked || !state.contentBase64 || !selectedDomains().length;
    ui.exportButton.disabled = locked || !state.contentBase64 || parameterState?.dirty === true;
    for (const control of parameterControls) control.disabled = locked || !parameterState;
    for (const slot of ui.params?.lightColors || []) { slot.color.disabled = locked || parameterState?.colorEditable !== true; slot.selected.disabled = locked || parameterState?.colorEditable !== true; }
    if (ui.regenerate) ui.regenerate.disabled = locked || !parameterState || !selectedDomains().length;
    if (ui.params?.lightDirection) ui.params.lightDirection.disabled = locked || !parameterState || ui.params.lightMode.value !== '1';
    if (ui.params?.keyboardEditor) ui.params.keyboardEditor.stage.disabled = locked || !parameterState || !ui.params.keyboardEditor.target.value || !ui.params.keyboardEditor.usage.value;
    if (ui.params?.fireEditor) ui.params.fireEditor.stage.disabled=locked||!parameterState||!ui.params.fireEditor.target.value||ui.params.fireEditor.interval.value===''||ui.params.fireEditor.count.value==='';
    if (ui.params?.dpiLockEditor) ui.params.dpiLockEditor.stage.disabled=locked||!parameterState||!ui.params.dpiLockEditor.target.value||!ui.params.dpiLockEditor.value.value;
    if (ui.parameterNote && parameterState?.dirty) ui.parameterNote.textContent = '有尚未生成的参数草稿。请重新生成预览；旧的配置导出与传输已停用。';
    ui.exportFormat.disabled = locked;
    ui.readButton.disabled = locked;
    ui.accept.disabled = locked;
    ui.applyButton.disabled = locked || !ui.accept.checked || !freshPreview();
    ui.restoreButton.disabled = locked || !ui.accept.checked || state.receipts?.canRestorePrevious !== true;
    ui.previewButton.textContent = state.busy === 'preview' ? '正在校验…' : '预览所选配置';
    ui.applyButton.textContent = state.busy === 'apply' ? '正在传输…' : '将此配置传输到鼠标';
    ui.restoreButton.textContent = state.busy === 'restore' ? '正在传输…' : '重新传输上一次配置';
    paintView();
  }
  function editorChanged() {
    if (blocked() || state.deviceId !== DEVICE_ID) return;
    resetParameters();
    clearPreview();
    try {
      const bytes = new TextEncoder().encode(ui.raw.value);
      state.contentBase64 = bytes.length ? encodeBase64(bytes) : '';
      state.encoding = 'UTF-8（文本编辑后）';
      setStatus('文本已修改；旧预览已失效。请重新预览后再传输。');
    } catch (error) { state.contentBase64 = ''; setStatus(errorText(error), 'error'); }
    updateSourceMeta(); sync();
  }
  async function loadInstalledProfiles() {
    if (blocked() || state.deviceId !== DEVICE_ID) return;
    const session = state.session; setBusy('installed-list');
    try {
      const data = await invoke('mouse.profile.installedList', {});
      const entries = validateInstalledProfiles(data);
      if (session !== state.session || state.deviceId !== DEVICE_ID) return;
      state.installedProfiles = entries;
      ui.installedSelect.replaceChildren();
      for (const [index, entry] of entries.entries()) { const option = element('option', '', `${entry.file} · ${entry.profile.source}`); option.value = String(index); ui.installedSelect.append(option); }
      ui.installedSelect.hidden = entries.length === 0;
      ui.installedLoad.disabled = entries.length === 0;
      const sourceLabel = data.source === 'bundled-defaults' ? '内置默认模板' : data.source === 'official-user-data' ? '官方用户目录 PSF' : '安装目录 PSF';
      setStatus(entries.length ? `发现 ${entries.length} 份${sourceLabel}；选择并载入仅生成本地草稿，不代表鼠标当前状态。` : '未找到可用的本地 PSF。');
    } catch (error) { if (session === state.session) setStatus('读取本地 PSF 失败：' + errorText(error), 'error'); }
    finally { if (session === state.session) setBusy(false); }
  }
  async function loadSelectedInstalledProfile() {
    const index = Number(ui.installedSelect.value), entry = state.installedProfiles[index];
    if (!entry || blocked()) return;
    const session = state.session; setBusy('import');
    try {
      await checkSha(entry.bytes, entry.contentSha256);
      const decoded = decodeText(entry.bytes);
      if (session !== state.session || state.deviceId !== DEVICE_ID) return;
      const sourceLabel = entry.source === 'bundled-defaults' ? '内置默认模板' : entry.source === 'official-user-data' ? '官方用户目录 PSF' : '安装目录 PSF';
      resetParameters(); clearPreview(); state.contentBase64 = entry.contentBase64; state.fileName = entry.file; state.encoding = decoded.encoding + `（${sourceLabel}，本地草稿）`;
      ui.raw.value = decoded.text; updateSourceMeta(); setStatus(`${entry.file}（${sourceLabel}）已载入本地草稿 · SHA-256 ${entry.contentSha256} · 不代表鼠标当前状态，尚未预览或发送。`); sync();
    } catch (error) { if (session === state.session) setStatus('载入本地 PSF 失败：' + errorText(error), 'error'); }
    finally { if (session === state.session) setBusy(false); }
  }
  async function importFile() {
    const file = ui.file.files?.[0];
    if (!file || blocked() || state.deviceId !== DEVICE_ID) return;
    if (!integer(file.size, 1, MAX_BYTES)) { ui.file.value = ''; setStatus('请选择 1 字节至 1 MiB 的 PSF 文件。', 'error'); return; }
    const session = state.session;
    setBusy('import');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const decoded = decodeText(bytes), content = encodeBase64(bytes);
      if (session !== state.session || state.deviceId !== DEVICE_ID) return;
      resetParameters(); clearPreview();
      state.contentBase64 = content;
      state.fileName = file.name.slice(0, 200) || 'IN9-profile.psf';
      state.encoding = decoded.encoding + '（保留导入字节）';
      ui.raw.value = decoded.text;
      updateSourceMeta();
      setStatus('已载入本地 PSF，尚未预览；导入不会写入鼠标。');
    } catch (error) { if (session === state.session) setStatus('导入失败：' + errorText(error) + ' 已有草稿保留。', 'error'); }
    finally { if (session === state.session) { ui.file.value = ''; setBusy(false); } }
  }
  function psfFields(text) {
    const fields = new Map();
    for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
      const line = raw.trim();
      if (!line || /^[;#\[]/.test(line)) continue;
      const at = line.indexOf('=');
      if (at > 0) { const key = line.slice(0, at).trim().toLowerCase(); if (!fields.has(key)) fields.set(key, line.slice(at + 1)); }
    }
    return {get: name => fields.get(name.toLowerCase()), has: name => fields.has(name.toLowerCase())};
  }
  function tenHexValues(value) {
    if (typeof value !== 'string') return null;
    const values = value.split('|');
    return values.length === 10 && values.every(item => /^[A-Fa-f0-9]{2}$/.test(item)) ? values.map(item => parseInt(item, 16)) : null;
  }
  function resetParameters() {
    parameterState = null;
    if (!ui) return;
    ui.parameters.hidden = true;
    for (const control of parameterControls) { if (control.type === 'checkbox') control.checked = false; else if (control.type !== 'color') control.value = ''; }
  }
  function parameterChanged() {
    if (!parameterState || blocked() || state.deviceId !== DEVICE_ID) return;
    parameterState.dirty = true;
    clearPreview('参数草稿已修改；请点击“重新生成参数预览”。生成前不能导出或传输旧配置。');
  }
  function numberValue(control, min, max, title) {
    if (!/^\d+$/.test(control.value) || !integer(Number(control.value), min, max)) fail(`${title}须为 ${min}–${max} 的整数。`);
    return Number(control.value);
  }
  function putUpdate(updates, name, value) {
    if (parameterState.fields.get(name) !== value) updates[name] = value;
  }
  function buildParameterUpdates() {
    if (!parameterState) return {};
    const updates = {}, controls = ui.params;
    let mask = 0;
    controls.dpi.forEach((slot, index) => {
      if (slot.enabled.checked) mask |= 1 << index;
      const dpi = Number(slot.value.value), dpiIndex = DPI_OPTIONS.indexOf(dpi);
      if (dpiIndex < 0) fail(`档位 ${index + 1} 请选择已支持的 DPI。`);
      putUpdate(updates, `XYSetting${index + 1}Value`, hexByte(dpiIndex));
    });
    const enabled = controls.dpi.map((slot, index) => slot.enabled.checked ? index : -1).filter(index => index >= 0);
    if (!enabled.length) fail('至少需要启用一个 DPI 档位。');
    const currentSlot = numberValue(controls.current, 0, 5, '当前 DPI 档位');
    if (!enabled.includes(currentSlot)) fail('当前 DPI 档位必须是已勾选启用的档位。');
    putUpdate(updates, 'DPIOffOnFlagValue', hexByte(mask));
    putUpdate(updates, 'CurrentDPILevelValue', hexByte(enabled.indexOf(currentSlot)));
    controls.colors.forEach((control, index) => {
      if (!/^#[A-Fa-f0-9]{6}$/.test(control.value)) fail('请选择有效的 DPI 指示色。');
      putUpdate(updates, `DPILevelIndication${index}Valuer`, control.value.slice(1).toUpperCase());
    });
    const rateIndex = RATE_OPTIONS.indexOf(Number(controls.rate.value));
    if (rateIndex < 0) fail('请选择支持的回报率。');
    putUpdate(updates, 'PollingRateValue', hexByte(rateIndex) + '0000');
    // These indices address PSF tables, never the wire register or the packed wire nibbles.
    const mode = numberValue(controls.lightMode, 0, 9, '灯光模式代码');
    putUpdate(updates, 'Lighting1ModeValue', hexByte(mode) + '0000');
    if (!['0', '1'].includes(controls.lightEnabled.value)) fail('请选择灯光开关。');
    if (controls.lightEnabled.value === '0' && mode !== 0) fail('关闭灯光请明确选择模式 0；非零模式与关闭标记没有已证实的发送转换。');
    putUpdate(updates, 'Lighting1OffOn', hexByte(Number(controls.lightEnabled.value)));
    for (const [control, field, title] of [[controls.lightSpeed, 'Lighting1Speed', '灯光速度索引'], [controls.lightBrightness, 'Lighting1Brightness', '灯光亮度索引']]) {
      const values = [...parameterState.lightTables[field]];
      const value = numberValue(control, 0, 14, title); values[mode] = value;
      putUpdate(updates, field, values.map(hexByte).join('|'));
    }
    if (mode === 1) {
      const direction = numberValue(controls.lightDirection, 0, 1, '灯光方向代码');
      const values = parameterState.lightTables.Lighting1Direction;
      if (!values) fail('原配置缺少完整的十模式方向字段；请先在原始文本中明确提供后重新预览。');
      const copy = [...values]; copy[mode] = direction;
      putUpdate(updates, 'Lighting1Direction', copy.map(hexByte).join('|'));
    } else if (parameterState.lightTables.Lighting1Direction) {
      putUpdate(updates, 'Lighting1Direction', parameterState.lightTables.Lighting1Direction.map(hexByte).join('|'));
    }
    if (typeof parameterState.fixedColorRaw === 'string' && parameterState.fixedColorRaw !== parameterState.fields.get('Lighting1FixedColor')) putUpdate(updates, 'Lighting1FixedColor', parameterState.fixedColorRaw);
    if (typeof parameterState.selectedColorRaw === 'string' && parameterState.selectedColorRaw !== parameterState.fields.get('Lighting1ColorSelected')) putUpdate(updates, 'Lighting1ColorSelected', parameterState.selectedColorRaw);
    controls.keys.forEach((control, index) => {
      const field = `Key${index}Value`, original = parameterState.fields.get(field);
      // Keep the original PSF key index and all three bytes, including unmapped/macro90 values.
      // Wire slot 3/4 translation and primary-button protection belong to the existing native plan.
      const pendingBinding = parameterState.bindingDrafts?.get(index);
      let value = pendingBinding ? pendingBinding.valueHex : actionCatalog().resolveSelection(control.value, original);
      putUpdate(updates, field, value);
      if (pendingBinding) putUpdate(updates, `Key${index}Name`, pendingBinding.name);
    });
    for (const [control, field, title] of [[controls.debounce, 'KeyDebounce', '按键防抖原值'], [controls.power, 'PowerDownTime', '休眠原值']]) {
      if (control.value !== '') putUpdate(updates, field, String(numberValue(control, 0, 255, title)));
      else if (parameterState.fields.has(field)) fail(`${title}不能清空已有值；如需移除字段，请使用原始文本编辑。`);
    }
    for (const [control, field] of [[controls.moveClosesLight, 'MoveLightingOnOffMode'], [controls.motionWakeup, 'MotionWakeup'], [controls.lift, 'LiftDetectionHeight']]) {
      if (control.value !== '') {
        if (!(field === 'LiftDetectionHeight' ? ['1', '2'] : ['0', '1']).includes(control.value)) fail('开关或抬升代码超出已支持范围。');
        putUpdate(updates, field, control.value);
      } else if (parameterState.fields.has(field)) fail('已有的开关或抬升字段不能清空；如需移除字段，请使用原始文本编辑。');
    }
    const profileName=controls.profileName.value;
    if(profileName.length>256||/[\r\n\0]/.test(profileName))fail('配置名称最多256字符且不能包含换行或空字符。');
    if(profileName!==(parameterState.fields.get('ProfileName')??''))putUpdate(updates,'ProfileName',profileName);
    controls.gameFiles.forEach((control,index)=>{
      const value=control.value,field=`GameFile${index}`;
      if(value.length>512||/[\r\n\0]/.test(value))fail(`游戏文件字段 ${index+1} 最多512字符且不能包含换行或空字符。`);
      if(value!==(parameterState.fields.get(field)??''))putUpdate(updates,field,value);
    });
    return updates;
  }
  function paintLightMode() {
    if (!parameterState) return;
    const mode = Number(ui.params.lightMode.value), tables = parameterState.lightTables;
    ui.params.lightSpeed.value = tables.Lighting1Speed?.[mode] ?? '';
    ui.params.lightBrightness.value = tables.Lighting1Brightness?.[mode] ?? '';
    ui.params.lightDirection.value = tables.Lighting1Direction?.[mode] === undefined ? '' : String(tables.Lighting1Direction[mode]);
    paintLightingColors();
    sync();
  }
  function paintLightingColors() {
    if (!ui?.params?.lightColors || !parameterState) return;
    let model;
    try { model = window.In9LightingColors?.getMode(parameterState.fixedColorRaw, parameterState.selectedColorRaw, Number(ui.params.lightMode.value)); }
    catch (error) { model = {editable:false, reason:errorText(error)}; }
    parameterState.colorEditable = model?.editable === true;
    ui.lightColors.hidden = !parameterState.colorEditable;
    ui.lightColorsNote.textContent = parameterState.colorEditable ? (model.reason ? model.reason + ' ' : '') + '编辑所选配置的七个颜色槽位；其余三个保留槽位和其他模式保持原值。' + (model.extraSelectedCount ? ` 另有 ${model.extraSelectedCount} 个保留槽位已选中。` : '') : (model?.reason || '颜色模块尚未就绪；原配置保持不变。');
    if (parameterState.colorEditable) for (let i=0;i<7;i++) { ui.params.lightColors[i].color.value = model.colors[i]; ui.params.lightColors[i].selected.checked = model.selected[i]; }
  }
  function lightingColorsChanged() {
    if (!parameterState || blocked() || state.deviceId !== DEVICE_ID || parameterState.colorEditable !== true) return;
    try {
      const patched = window.In9LightingColors.patchMode(parameterState.fixedColorRaw, parameterState.selectedColorRaw, Number(ui.params.lightMode.value), ui.params.lightColors.map(slot=>slot.color.value), ui.params.lightColors.map(slot=>slot.selected.checked));
      parameterState.fixedColorRaw = patched.fixedRaw; parameterState.selectedColorRaw = patched.selectedRaw;
      parameterChanged();
    } catch (error) { setStatus('颜色草稿未更新：' + errorText(error), 'error'); paintLightingColors(); sync(); }
  }
  function paintKeyAction(control, valueHex) {
    const catalog = actionCatalog(), current = catalog.describeCurrent(valueHex);
    for (const option of control.querySelectorAll('option[data-preserve-current]')) option.remove();
    if (current.readOnly) {
      const option = element('option', '', current.label); option.value = catalog.CURRENT_VALUE;
      option.disabled = true; option.selected = true; option.dataset.preserveCurrent = 'true'; control.prepend(option);
    }
    control.value = current.value;
  }
  function paintKeyboardEditor() {
    const editor=ui?.params?.keyboardEditor;if(!editor||!parameterState)return;
    const index=Number(editor.target.value),original=editor.target.value!==''?parameterState.fields.get(`Key${index}Value`):null,raw=original?(parameterState.bindingDrafts?.get(index)?.valueHex||actionCatalog().resolveSelection(ui.params.keys[index].value,original)):null,binding=raw?actionCatalog().decodeKeyboardBinding(raw):null;
    editor.usage.value=binding?String(binding.usage):'';
    editor.modifiers.forEach((input,bit)=>input.checked=Boolean(binding&&(binding.modifiers&(1<<bit))));
    editor.capture.value=binding?actionCatalog().keyboardLabel(binding.usage,binding.modifiers):'';
    editor.current.textContent=raw?'当前目标：'+actionCatalog().describeCurrent(raw).label:'请选择要替换的鼠标按键。';
    sync();
  }
  function bindingDraftValue(index) {
    const original=parameterState.fields.get(`Key${index}Value`);
    return parameterState.bindingDrafts?.get(index)?.valueHex||actionCatalog().resolveSelection(ui.params.keys[index].value,original);
  }
  function setBindingDraft(index,valueHex,name) {
    const values=ui.params.keys.map((_,key)=>key===index?valueHex:bindingDraftValue(key));
    if(!values.some(value=>value.toUpperCase()==='100100'))fail('至少保留一个左键；请先把左键分配到其他按键。');
    if(!parameterState.bindingDrafts)parameterState.bindingDrafts=new Map();parameterState.bindingDrafts.set(index,{valueHex,name});
    paintKeyAction(ui.params.keys[index],valueHex);domainInputs.get('buttons').checked=true;
    parameterChanged();
  }
  function stageKeyboardBinding() {
    if(blocked()||state.deviceId!==DEVICE_ID||!parameterState)return;
    const editor=ui.params.keyboardEditor;
    try {
      const index=numberValue(editor.target,0,5,'目标按键'),usage=numberValue(editor.usage,1,255,'键盘键'),modifiers=editor.modifiers.reduce((mask,input,bit)=>input.checked?mask|(1<<bit):mask,0);
      const valueHex=actionCatalog().keyboardBinding(usage,modifiers),name=actionCatalog().keyboardLabel(usage,modifiers);
      setBindingDraft(index,valueHex,name);editor.current.textContent=`已编入按键 ${index+1} 的草稿：${name}。重新生成预览后可导出或确认传输。`;
    }catch(error){editor.current.textContent='按键草稿未更新：'+errorText(error);setStatus(editor.current.textContent,'error');}
  }
  function paintSpecialBindingEditors() {
    if(!parameterState)return;
    const fire=ui?.params?.fireEditor,lock=ui?.params?.dpiLockEditor;
    if(fire){const current=fire.target.value!==''?actionCatalog().decodeRapidFireBinding(bindingDraftValue(Number(fire.target.value))):null;fire.interval.value=current?String(current.interval):'';fire.count.value=current?String(current.count):'';}
    if(lock){const current=lock.target.value!==''?actionCatalog().decodeDpiLockBinding(bindingDraftValue(Number(lock.target.value))):null;lock.value.value=current?String(current.dpi):'';}
    sync();
  }
  function stageSpecialBinding(kind) {
    if(blocked()||state.deviceId!==DEVICE_ID||!parameterState)return;
    const editor=kind==='fire'?ui.params.fireEditor:ui.params.dpiLockEditor;
    try{
      const index=numberValue(editor.target,0,5,'目标按键');
      if(kind==='fire'){const interval=numberValue(editor.interval,5,255,'火力间隔原值'),count=numberValue(editor.count,0,255,'火力次数');setBindingDraft(index,actionCatalog().rapidFireBinding(interval,count),`火力键 · ${interval} / ${count===0?'按住持续':count+' 次'}`);}
      else{const dpi=numberValue(editor.value,200,1200,'DPI 锁定');setBindingDraft(index,actionCatalog().dpiLockBinding(dpi),'DPI 锁定 '+dpi);}
      editor.message.textContent=`已编入按键 ${index+1} 的草稿；重新生成预览后可导出或确认传输。`;setStatus(editor.message.textContent);
    }catch(error){editor.message.textContent='按键草稿未更新：'+errorText(error);setStatus(editor.message.textContent,'error');}
  }
  function installParameters(preview, text) {
    const profile = preview.profile, fields = psfFields(text), lightTables = {};
    for (const key of ['Lighting1Speed', 'Lighting1Brightness', 'Lighting1Direction']) lightTables[key] = tenHexValues(fields.get(key));
    if (!lightTables.Lighting1Speed || !lightTables.Lighting1Brightness || !profile.lighting) { resetParameters(); return; }
    parameterState = {fields, lightTables, fixedColorRaw:fields.get('Lighting1FixedColor'), selectedColorRaw:fields.get('Lighting1ColorSelected'), bindingDrafts:new Map(), dirty: false};
    const controls = ui.params;
    controls.dpi.forEach((slot, index) => { slot.value.value = String(profile.dpiSlots[index]); slot.enabled.checked = Boolean(profile.enabledMask & (1 << index)); });
    const enabled = controls.dpi.map((slot, index) => slot.enabled.checked ? index : -1).filter(index => index >= 0);
    controls.current.value = String(enabled[profile.currentEnabledOrdinal]);
    controls.colors.forEach((control, index) => { control.value = '#' + profile.dpiColorsRgb[index].toString(16).padStart(6, '0'); });
    controls.rate.value = String(profile.pollingRateHz);
    controls.lightMode.value = String(profile.lighting.mode); controls.lightEnabled.value = profile.lighting.enabled ? '1' : '0';
    controls.keys.forEach((control, index) => {
      const raw = fields.get(`Key${index}Value`); paintKeyAction(control, raw);
    });
    controls.profileName.value=profile.profileName??'';
    controls.gameFiles.forEach((control,index)=>control.value=profile.linkedGameFiles[index]??'');
    controls.debounce.value = profile.keyDebounceRaw === null ? '' : String(profile.keyDebounceRaw);
    controls.power.value = profile.powerDownTimeRaw === null ? '' : String(profile.powerDownTimeRaw);
    controls.moveClosesLight.value = profile.moveClosesLight === null ? '' : profile.moveClosesLight ? '1' : '0';
    controls.motionWakeup.value = profile.motionWakeup === null ? '' : profile.motionWakeup ? '1' : '0';
    const lift = fields.get('LiftDetectionHeight'); controls.lift.value = ['1', '2'].includes(lift) ? lift : '';
    ui.parameters.hidden = false; paintLightMode();paintKeyboardEditor();paintSpecialBindingEditors();
    ui.parameterNote.textContent = '参数来自本次已校验的本地 PSF。修改仅保留草稿；点击重新生成预览后才会更新配置文本。';
  }
  function createParameters() {
    const card = element('section', 'in9-profile-card in9-profile-parameters glass'); card.id = 'in9-profile-parameters'; card.hidden = true;
    card.append(element('h4', '', '直观参数编辑 · 生成配置草稿'));
    const parameterNote = note(''), params = {};
    card.append(parameterNote);
    function field(parent, name, id, type = 'number', options) {
      const label = element('label', 'in9-profile-field'); label.append(element('span', '', name));
      const input = element(options ? 'select' : 'input'); input.id = 'in9-param-' + id;
      if (options) for (const [value, title] of options) { const option = element('option', '', title); option.value = value; input.append(option); }
      else { input.type = type; if (type === 'number') { input.min = '0'; input.max = '255'; input.step = '1'; input.placeholder = '未提供'; } }
      label.append(input); parent.append(label); parameterControls.push(input);
      input.addEventListener(type === 'color' || type === 'text' || !options ? 'input' : 'change', parameterChanged);
      return input;
    }
    function actionField(parent, index) {
      const catalog = actionCatalog();
      const label = element('label', 'in9-profile-field'); label.append(element('span', '', ['左键', '右键', '中键', '前进键', '后退键', 'DPI 键'][index]));
      const select = element('select'); select.id = 'in9-param-key-' + index;
      for (const group of catalog.groups) {
        const optgroup = element('optgroup'); optgroup.label = group.label;
        for (const action of group.actions) { const option = element('option', '', action.label); option.value = action.id; optgroup.append(option); }
        select.append(optgroup);
      }
      label.append(select); parent.append(label); parameterControls.push(select);
      select.addEventListener('change', ()=>{parameterState?.bindingDrafts?.delete(index);parameterChanged();if(Number(ui.params.keyboardEditor?.target.value)===index)paintKeyboardEditor();paintSpecialBindingEditors();});
      return select;
    }
    function grid(title, views) { const group = element('fieldset', 'in9-param-group'), body = element('div', 'in9-param-grid'); group.dataset.in9Views = views; group.append(element('legend', '', title), body); card.append(group); return body; }
    function groupNote(text, views) { const paragraph = note(text); paragraph.dataset.in9Views = views; card.append(paragraph); }
    const metadataGroup=element('fieldset','in9-param-group in9-param-metadata'),metadataGrid=element('div','in9-param-grid');metadataGroup.dataset.in9Views='performance lighting keys';metadataGroup.append(element('legend','','PSF 配置元数据（本地）'),metadataGrid);card.append(metadataGroup);
    params.profileName=field(metadataGrid,'配置名称','profile-name','text');params.profileName.maxLength=256;
    params.gameFiles=Array.from({length:3},(_,index)=>{const input=field(metadataGrid,`GameFile${index}`,'game-file-'+index,'text');input.maxLength=512;return input;});
    const metadataNote=note('只编辑并保留所选 PSF 中的配置名称与 GameFile 字段。GameFile 的自动切换语义尚未验证；本编辑器不会监视应用或自动切换鼠标配置。');metadataNote.dataset.in9Views='performance lighting keys';card.append(metadataNote);
    const dpiGrid = grid('六档 DPI 与启用状态', 'performance'); params.dpi = [];
    for (let index = 0; index < 6; index++) {
      const slot = element('div', 'in9-param-dpi-slot'); dpiGrid.append(slot);
      const value = field(slot, `档位 ${index + 1} DPI`, 'dpi-' + index, 'select', DPI_OPTIONS.map(value => [String(value), String(value)]));
      const label = element('label', 'in9-profile-domain'), enabled = element('input'); enabled.type = 'checkbox'; enabled.id = 'in9-param-dpi-enabled-' + index;
      label.append(enabled, element('span', '', '启用此档')); slot.append(label); parameterControls.push(enabled); enabled.addEventListener('change', parameterChanged);
      params.dpi.push({value, enabled});
    }
    params.current = field(dpiGrid, '当前选中档位', 'dpi-current', 'select', Array.from({length: 6}, (_, index) => [String(index), `档位 ${index + 1}`]));
    params.rate = field(dpiGrid, '回报率', 'polling', 'select', RATE_OPTIONS.map(value => [String(value), value + ' Hz']));
    groupNote('保留位 7、8 的 DPI 字段保持原值。当前档位按已启用档位的顺序编码；至少保留一个启用档。', 'performance');
    const colorGrid = grid('八个 DPI 指示色', 'performance');
    params.colors = Array.from({length: 8}, (_, index) => field(colorGrid, index < 6 ? `档位 ${index + 1}` : `保留色 ${index + 1}`, 'color-' + index, 'color'));
    const lightGrid = grid('灯光', 'lighting');
    params.lightMode = field(lightGrid, '模式代码', 'light-mode', 'select', Array.from({length: 10}, (_, index) => [String(index), index === 0 ? '0 · 模式代码 0' : `模式 ${index}`]));
    params.lightEnabled = field(lightGrid, '配置中的灯光开关', 'light-enabled', 'select', [['1', '开启'], ['0', '关闭（需模式 0）']]);
    params.lightSpeed = field(lightGrid, '速度索引（0–14）', 'light-speed'); params.lightSpeed.max = '14';
    params.lightBrightness = field(lightGrid, '亮度索引（0–14）', 'light-brightness'); params.lightBrightness.max = '14';
    params.lightDirection = field(lightGrid, '方向代码（模式 1）', 'light-direction', 'select', [['', '未提供'], ['0', '0'], ['1', '1']]);
    groupNote('速度与亮度分别保留各模式的草稿。关闭时请明确选择模式 0；模式代码不推断为未经确认的灯效名称。', 'lighting');
    const lightColors = element('div', 'in9-light-colors'); lightColors.id = 'in9-light-colors'; lightColors.hidden = true;
    params.lightColors = Array.from({length:7}, (_,index)=>{
      const slot = element('div', 'in9-light-color-slot'), label = element('label', 'in9-profile-field'), color = element('input'), selectLabel = element('label', 'in9-profile-domain'), selected = element('input');
      color.type = 'color'; color.id = 'in9-light-color-' + index; color.disabled = true; label.htmlFor = color.id; label.append(element('span', '', '颜色 ' + (index+1)), color);
      selected.type = 'checkbox'; selected.id = 'in9-light-selected-' + index; selected.disabled = true; selectLabel.append(selected, element('span', '', '使用此色')); slot.append(label, selectLabel); lightColors.append(slot);
      color.addEventListener('input', lightingColorsChanged); color.addEventListener('change', lightingColorsChanged); selected.addEventListener('change', lightingColorsChanged); parameterControls.push(color, selected);
      return {color, selected};
    });
    const lightColorsNote = note('载入所选配置后显示可编辑的颜色。'); lightColorsNote.id = 'in9-light-colors-note'; lightColorsNote.dataset.in9Views = 'lighting';
    const lightColorsGroup = element('div', 'in9-light-colors-group'); lightColorsGroup.dataset.in9Views = 'lighting'; lightColorsGroup.append(lightColors, lightColorsNote); card.append(lightColorsGroup);
    const keyGrid = grid('六个按键 · 官方动作', 'keys'); keyGrid.classList.add('in9-param-key-grid');
    params.keys = Array.from({length: 6}, (_, index) => actionField(keyGrid, index));
    const keyboardGrid=grid('键盘键 / 组合键', 'keys');keyboardGrid.classList.add('in9-keyboard-grid');
    const keyboardTargetLabel=element('label','in9-profile-field'),keyboardTarget=element('select');keyboardTarget.id='in9-keyboard-target';
    const noTarget=element('option','','请选择目标按键');noTarget.value='';keyboardTarget.append(noTarget);for(const [index,name] of ['左键','右键','中键','前进键','后退键','DPI 键'].entries()){const option=element('option','',name);option.value=String(index);keyboardTarget.append(option);}keyboardTarget.value='';keyboardTargetLabel.append(element('span','','替换目标按键'),keyboardTarget);keyboardGrid.append(keyboardTargetLabel);
    const usageLabel=element('label','in9-profile-field'),usage=element('select');usage.id='in9-keyboard-usage';const none=element('option','','请选择键盘键');none.value='';usage.append(none);
    for(const key of actionCatalog().keyboardKeys){const option=element('option','',key.label);option.value=String(key.usage);usage.append(option);}usageLabel.append(element('span','','键盘键'),usage);keyboardGrid.append(usageLabel);
    const captureLabel=element('label','in9-profile-field'),capture=element('input');capture.type='text';capture.id='in9-keyboard-capture';capture.readOnly=true;capture.placeholder='点击后按下键或组合键';captureLabel.append(element('span','','按键输入'),capture);keyboardGrid.append(captureLabel);
    const modifierGroup=element('div','in9-keyboard-modifiers'),modifiers=['Ctrl','Shift','Alt','Win'].map((name,index)=>{const label=element('label','in9-profile-domain'),input=element('input');input.type='checkbox';input.id='in9-keyboard-modifier-'+index;label.append(input,element('span','',name));modifierGroup.append(label);return input;});keyboardGrid.append(modifierGroup);
    const current=note('请选择要替换的鼠标按键。');current.id='in9-keyboard-current';current.setAttribute('role','status');current.setAttribute('aria-live','polite');current.classList.add('in9-keyboard-current');const keyboardStage=button('in9-keyboard-stage','编入按键草稿');keyboardGrid.append(current,keyboardStage);
    params.keyboardEditor={target:keyboardTarget,usage,capture,modifiers,current,stage:keyboardStage};parameterControls.push(keyboardTarget,usage,capture,...modifiers);
    const captureText=()=>{if(usage.value)capture.value=actionCatalog().keyboardLabel(Number(usage.value),modifiers.reduce((mask,input,index)=>input.checked?mask|(1<<index):mask,0));else capture.value='';sync();};
    keyboardTarget.addEventListener('change',paintKeyboardEditor);usage.addEventListener('change',captureText);for(const input of modifiers)input.addEventListener('change',captureText);keyboardStage.addEventListener('click',stageKeyboardBinding);
    capture.addEventListener('keydown',event=>{if(blocked()||!parameterState)return;event.preventDefault();event.stopImmediatePropagation();if(event.isComposing||event.repeat)return;const key=actionCatalog().keyboardUsageForCode(event.code);if(key>=224&&key<=231)return;if(!actionCatalog().keyboardKeys.some(item=>item.usage===key)){setStatus('此键没有已确认的直接绑定编码；请选择列表中的键。','error');return;}usage.value=String(key);modifiers.forEach((input,index)=>input.checked=[event.ctrlKey,event.shiftKey,event.altKey,event.metaKey][index]===true);captureText();});
    groupNote('修饰键不区分左右；未知原值保持只读。绑定先进入按键草稿，可重新预览和导出。', 'keys');
    function specialTarget(parent,prefix){const label=element('label','in9-profile-field'),select=element('select');select.id='in9-'+prefix+'-target';const none=element('option','','请选择目标按键');none.value='';select.append(none);for(const [index,name]of ['左键','右键','中键','前进键','后退键','DPI 键'].entries()){const option=element('option','',name);option.value=String(index);select.append(option);}select.value='';label.append(element('span','','替换目标按键'),select);parent.append(label);parameterControls.push(select);select.addEventListener('change',paintSpecialBindingEditors);return select;}
    function specialNumber(parent,prefix,title,min,max){const label=element('label','in9-profile-field'),input=element('input');input.type='number';input.id='in9-fire-'+prefix;input.min=String(min);input.max=String(max);input.step='1';input.placeholder='明确填写';label.append(element('span','',title),input);parent.append(label);parameterControls.push(input);input.addEventListener('input',sync);return input;}
    const fireGrid=grid('火力键', 'keys'),fireTarget=specialTarget(fireGrid,'fire'),fireInterval=specialNumber(fireGrid,'interval','间隔原值（5–255）',5,255),fireCount=specialNumber(fireGrid,'count','次数（0–255）',0,255),fireStage=button('in9-fire-stage','编入火力键草稿'),fireMessage=note('');fireMessage.id='in9-fire-message';fireMessage.classList.add('in9-keyboard-current');fireMessage.setAttribute('role','status');fireGrid.append(fireStage,fireMessage);params.fireEditor={target:fireTarget,interval:fireInterval,count:fireCount,stage:fireStage,message:fireMessage};fireStage.addEventListener('click',()=>stageSpecialBinding('fire'));
    groupNote('采用官方火力键的间隔原值及次数。次数 0 表示按住不放时持续开火；间隔单位尚未确认，不换算成毫秒。', 'keys');
    const lockGrid=grid('DPI 锁定', 'keys'),lockTarget=specialTarget(lockGrid,'dpi-lock'),lockLabel=element('label','in9-profile-field'),lockValue=element('select');lockValue.id='in9-dpi-lock-value';const noLock=element('option','','请选择官方锁定档位');noLock.value='';lockValue.append(noLock);for(const dpi of actionCatalog().dpiLockOptions){const option=element('option','',String(dpi));option.value=String(dpi);lockValue.append(option);}lockLabel.append(element('span','','官方 DPI 锁定档位'),lockValue);lockGrid.append(lockLabel);parameterControls.push(lockValue);const lockStage=button('in9-dpi-lock-stage','编入 DPI 锁定草稿'),lockMessage=note('');lockMessage.id='in9-dpi-lock-message';lockMessage.classList.add('in9-keyboard-current');lockMessage.setAttribute('role','status');lockGrid.append(lockStage,lockMessage);params.dpiLockEditor={target:lockTarget,value:lockValue,stage:lockStage,message:lockMessage};lockValue.addEventListener('change',sync);lockStage.addEventListener('click',()=>stageSpecialBinding('dpiLock'));
    groupNote('这里使用官方锁定子菜单中的 200–1200 档位，只修改目标按键动作，不改六档 DPI 表。所选档位来自官方菜单，实际设备效果需传输后核对。', 'keys');
    groupNote('未映射原值保持只读。至少保留一个左键；修改先进入所选配置草稿，未传输或验证设备效果。', 'keys');
    const powerGrid = grid('防抖、电源与抬升', 'performance');
    params.debounce = field(powerGrid, '按键防抖原值（0–255）', 'debounce');
    params.power = field(powerGrid, '休眠原值（0–255）', 'power');
    const boolOptions = [['', '未提供'], ['0', '关闭'], ['1', '开启']];
    params.moveClosesLight = field(powerGrid, '移动熄灯', 'move-closes-light', 'select', boolOptions);
    params.motionWakeup = field(powerGrid, '移动唤醒', 'motion-wakeup', 'select', boolOptions);
    params.lift = field(powerGrid, '抬升高度代码', 'lift', 'select', [['', '未提供'], ['1', '代码 1'], ['2', '代码 2']]);
    groupNote('未提供字段保持空值，不补默认值。防抖、休眠的单位尚未证实，按原始字节值编辑；抬升代码不换算成毫米。', 'performance');
    const regenerate = button('in9-profile-regenerate', '重新生成参数预览'); card.append(regenerate);
    regenerate.addEventListener('click', () => void preview());
    params.lightMode.addEventListener('change', paintLightMode);
    for (const [control, key] of [[params.lightSpeed, 'Lighting1Speed'], [params.lightBrightness, 'Lighting1Brightness'], [params.lightDirection, 'Lighting1Direction']]) {
      const store = () => {
        if (!parameterState || control.value === '') return;
        const values = parameterState.lightTables[key];
        if (values && integer(Number(control.value), 0, key === 'Lighting1Direction' ? 1 : 14)) values[Number(params.lightMode.value)] = Number(control.value);
      };
      control.addEventListener('input', store); control.addEventListener('change', store);
    }
    return {parameters: card, parameterNote, params, regenerate, lightColors, lightColorsNote};
  }
  async function preview() {
    if (blocked() || state.deviceId !== DEVICE_ID || !state.contentBase64 || !selectedDomains().length) return;
    const contentBase64 = state.contentBase64, domains = selectedDomains(), session = state.session;
    clearPreview();
    const revision = state.revision;
    setBusy('preview'); setStatus('正在解析本地 PSF 并生成指定范围的报文预览…');
    try {
      decodeBase64(contentBase64);
      const updates = parameterState?.dirty ? buildParameterUpdates() : {};
      const hasUpdates = Object.keys(updates).length > 0;
      const args = {contentBase64, sensor: 37, domains};
      if (hasUpdates) args.updates = updates;
      const result = await validatePreview(await invoke('mouse.profile.preview', args), hasUpdates ? null : contentBase64, domains);
      const decoded = decodeText(decodeBase64(result.contentBase64)), fields = psfFields(decoded.text);
      if (hasUpdates && Object.entries(updates).some(([name, value]) => fields.get(name) !== value)) fail('返回的 PSF 未包含本次指定的参数更新。');
      if (session !== state.session || revision !== state.revision || state.contentBase64 !== contentBase64 || !sameDomains(domains, selectedDomains())) return;
      state.contentBase64 = result.contentBase64;
      state.encoding = decoded.encoding + (hasUpdates ? '（参数预览已更新）' : '（已校验）');
      ui.raw.value = decoded.text; updateSourceMeta();
      state.preview = {...result, revision};
      installParameters(result, decoded.text);
      paintPreview(result);
      setStatus(`预览完成：${result.packetCount} 条报文待传输。请核对配置与范围，并勾选替换确认。`, 'ready');
    } catch (error) { if (session === state.session) { state.preview = null; setStatus('预览失败：' + errorText(error), 'error'); } }
    finally { if (session === state.session) setBusy(false); }
  }
  async function readLiveStatus() {
    if (blocked() || state.deviceId !== DEVICE_ID) return;
    const session = state.session; beginLiveStatusRead(); setBusy('status-read');
    try {
      const result = validateLiveStatus(await invoke('mouse.profile.statusRead', {}));
      if (session !== state.session) return;
      state.liveStatus = result;
      paintLiveStatus();
      setStatus('已读取实时身份与电源状态；DPI、回报率、按键、灯光和休眠仍未读回。', 'ready');
    } catch (error) { if (session === state.session) { state.liveStatus = null; paintLiveStatus(); setStatus('读取实时状态失败：' + errorText(error) + ' 旧实时读数已清除。', 'error'); } }
    finally { if (session === state.session) setBusy(false); }
  }
  async function archiveInstalledFiles() {
    if (blocked() || state.deviceId !== DEVICE_ID) return;
    const session = state.session;
    setBusy('archive');
    setStatus('正在只读复制固定官方目录中的 IN9 PSF、配置 INI 与相关本地文件…');
    try {
      const result = validateArchiveResult(await invoke('mouse.profile.archiveInstalled', {}));
      if (session !== state.session || state.deviceId !== DEVICE_ID) return;
      if (!result.archiveCreated) {
        setStatus('固定官方目录中没有找到可归档的 IN9 配置文件。');
      } else {
        setStatus(`已归档 ${result.files.length} 个本地原始文件到 ${result.archiveRelativeDirectory}；这不是鼠标硬件状态或恢复基线。`);
      }
    } catch (error) {
      if (session === state.session) setStatus('IN9 本地配置归档失败：' + errorText(error) + '；原目录未修改。', 'error');
    } finally { if (session === state.session) setBusy(false); }
  }
  async function readReceipts() {
    if (blocked() || state.deviceId !== DEVICE_ID) return;
    const session = state.session;
    state.receipts = null; paintReceipts(); setBusy('read');
    try {
      const result = validateRead(await invoke('mouse.profile.read', {}));
      if (session !== state.session) return;
      state.receipts = result;
      setStatus('已读取本地传输记录；这些记录不是硬件配置读回，也不是原设备配置备份。');
    } catch (error) { if (session === state.session) setStatus('读取本地记录失败：' + errorText(error) + ' 旧记录已清除。', 'error'); }
    finally { if (session === state.session) { paintReceipts(); setBusy(false); } }
  }
  async function transmit(restore) {
    if (blocked() || state.deviceId !== DEVICE_ID || !ui.accept.checked) return;
    if (restore ? state.receipts?.canRestorePrevious !== true : !freshPreview()) return;
    const selected = state.preview, session = state.session;
    const recoveringPending = state.receipts?.recoveryPending === true;
    const previous = recoveringPending ? state.receipts?.active : state.receipts?.previousApplied;
    const args = restore ? {acceptReplaceUnknown: true} : {contentBase64: selected.contentBase64, domains: [...selected.domains], acceptReplaceUnknown: true};
    // An attempted write consumes consent and preview, even when the sender reports a failure.
    clearPreview(); state.receipts = null; paintReceipts();
    setBusy(restore ? 'restore' : 'apply'); setStatus('正在传输所选配置；完整设备配置无法读回，请等待传输回执。');
    try {
      const response = await invoke(restore ? 'mouse.profile.restore' : 'mouse.profile.apply', args);
      const result = await validatePreview(response, restore ? null : selected.contentBase64, restore ? previous.domains : selected.domains, true);
      if (restore && (response.restoreKind !== (recoveringPending ? 'known-receipt-before-pending-transmission' : 'previous-transmitted-profile') || result.contentSha256 !== previous.contentSha256)) fail('恢复回执与所选已知传输配置不一致。');
      if (Object.hasOwn(response, 'pendingReplay') && typeof response.pendingReplay !== 'boolean') fail('服务返回的重试标记无效。');
      if (session !== state.session) return;
      setStatus(`已传输 ${result.transmittedCount} 报文，设备效果待核对。${restore ? '已重新发送上一次传输配置。' : ''} 未获得完整硬件配置读回；请手动读取本地记录后再检查可恢复状态。`, 'transmitted');
      paintWarnings(ui.receiptWarnings, result.warnings);
    } catch (error) {
      if (session === state.session) setStatus('传输未确认完成：' + errorText(error) + ' 可能存在部分传输；请读取本地记录并核对鼠标效果。重新操作前需要再次预览和确认。', 'error');
    } finally { if (session === state.session) setBusy(false); }
  }
  function safeFileName() {
    const base = state.fileName.replace(/\.psf$/i, '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/g, '').slice(0, 120) || 'IN9-profile';
    return base + '.psf';
  }
  async function exportProfile() {
    if (blocked() || state.deviceId !== DEVICE_ID || !state.contentBase64) return;
    if (parameterState?.dirty) { setStatus('请先重新生成参数预览，再导出更新后的 PSF。', 'error'); return; }
    const contentBase64 = state.contentBase64, format = ui.exportFormat.value, session = state.session;
    if (format !== 'preserve') return;
    const args = {contentBase64, format};
    try {
    } catch (error) { setStatus(errorText(error), 'error'); return; }
    setBusy('export');
    try {
      const result = await invoke('mouse.profile.export', args);
      if (!object(result) || result.format !== format || result.hardwareReadback !== false || !integer(result.byteLength, 1, MAX_BYTES)) fail('服务返回的导出结果无效。');
      const warnings = validateWarnings(result.warnings), bytes = decodeBase64(result.contentBase64);
      if (bytes.length !== result.byteLength) fail('导出文件长度与实际字节不一致。');
      await checkSha(bytes, validateSha(result.contentSha256));
      if (session !== state.session) return;
      if(typeof window.hub?.saveExport!=='function')throw Error('文件保存服务尚未就绪，请重启更新后的程序。');
      const saved=await window.hub.saveExport({format:'psf',suggestedName:safeFileName(),contentBase64:result.contentBase64});
      if (session !== state.session) return;
      if(saved?.canceled===true){setStatus('已取消保存；当前配置仍保留。','ready');return;}
      if(saved?.saved!==true||saved.byteLength!==bytes.length||typeof saved.fileName!=='string')throw Error('未取得完整文件保存结果。');
      setStatus(`已保存：${saved.fileName} · ${bytes.length.toLocaleString('zh-CN')} 字节。`, 'ready');
      paintWarnings(ui.receiptWarnings, warnings);
    } catch (error) { if (session === state.session) setStatus('导出失败：' + errorText(error), 'error'); }
    finally { if (session === state.session) setBusy(false); }
  }
  function mount() {
    if (ui) return true;
    const host = document.getElementById('page-mouse-profile');
    if (!host) return false;
    const section = element('section', 'in9-profile'); section.id = 'in9-profile-editor'; section.setAttribute('aria-label', 'IN9 官方本地配置');
    const heading = element('div', 'in9-profile-heading');
    const viewTitle = element('h3', '', '配置与传输');
    heading.append(element('div', '', 'IN9 / SELECTED PROFILE'), viewTitle, note('参数来自所选官方 PSF。切换分类共用同一份草稿；实时身份与电量单独查询，所选配置不代表硬件读回。'));
    const importCard = element('section', 'in9-profile-card glass');
    const importHeading = element('div', 'in9-profile-card-heading'); importHeading.append(element('h4', '', '所选配置'), element('span', 'source-label', '本地 PSF 草稿'));
    const importButton = button('in9-profile-import', '选择官方 PSF');
    const installedButton = button('in9-profile-installed-list', '列出可用 PSF');
    const archiveButton = button('in9-profile-archive-local-files', '归档官方本地配置');
    const archiveNote = note('归档前先关闭官方 IN9 程序。只复制固定官方目录中的 PSF、config.ini 与 MacroLibraryFile.mlf 到应用保留数据；不读取设备，不代表硬件状态。');
    const installedSelect = element('select'); installedSelect.id = 'in9-profile-installed-select'; installedSelect.hidden = true; installedSelect.setAttribute('aria-label', '本地 IN9 配置模板');
    const installedLoad = button('in9-profile-installed-load', '载入为本地草稿'); installedLoad.disabled = true;
    const file = element('input'); file.type = 'file'; file.id = 'in9-profile-file'; file.accept = '.psf'; file.hidden = true;
    const sourceMeta = note('所选配置：尚未载入 · 支持 UTF-16LE / UTF-8 · 最大 1 MiB'); sourceMeta.id = 'in9-profile-source';
    const rawLabel = element('label', 'in9-profile-field'); rawLabel.htmlFor = 'in9-profile-raw'; rawLabel.append(element('span', '', 'PSF 原始文本'));
    const raw = element('textarea', 'in9-profile-raw'); raw.id = 'in9-profile-raw'; raw.rows = 10; raw.maxLength = MAX_BYTES; raw.spellcheck = false; raw.placeholder = '[Setting]\n粘贴完整的官方 PSF 文本'; raw.setAttribute('aria-describedby', 'in9-profile-raw-hint'); rawLabel.append(raw);
    const rawHint = note('编辑仅修改当前草稿，不会自动预览或发送。未编辑的导入保留原字节；文本修改后使用 UTF-8。未知字段保留，字段含义由后端校验。'); rawHint.id = 'in9-profile-raw-hint';
    const advanced = element('details', 'in9-profile-advanced'); advanced.id = 'in9-profile-advanced'; advanced.append(element('summary', '', '高级 · PSF 原始文本'), rawLabel, rawHint);
    importCard.append(importHeading, importButton, installedButton, installedSelect, installedLoad, archiveButton, archiveNote, file, sourceMeta, advanced);
    const controls = element('section', 'in9-profile-card glass');
    controls.append(element('h4', '', '02 · 选择本次应用范围'));
    const domains = element('fieldset', 'in9-profile-domains'); domains.append(element('legend', 'sr-only', '本次应用范围'));
    for (const [id, title] of DOMAIN_DEFS) {
      const label = element('label', 'in9-profile-domain'), input = element('input');
      input.type = 'checkbox'; input.id = 'in9-profile-domain-' + id; input.checked = DEFAULT_DOMAINS.has(id); input.dataset.domain = id;
      label.append(input, element('span', '', title)); domains.append(label); domainInputs.set(id, input);
      input.addEventListener('change', () => clearPreview('应用范围已修改；请重新预览。'));
    }
    const previewButton = button('in9-profile-preview', '预览所选配置');
    controls.append(domains, note('默认只选择 DPI、回报率和灯光。按键及其他范围需主动选择；原配置中的未支持动作保持原样，不提供编辑或传输入口。'));
    importCard.append(previewButton);
    const previewPanel = element('section', 'in9-profile-card glass'); previewPanel.id = 'in9-profile-preview-panel'; previewPanel.hidden = true;
    const summary = element('dl', 'in9-profile-summary'), previewWarnings = element('ul', 'in9-profile-warnings');
    previewPanel.append(element('h4', '', '配置预览 · 非硬件读回'), summary, previewWarnings);
    const transfer = element('section', 'in9-profile-card in9-profile-transfer glass');
    transfer.append(element('h4', '', '03 · 确认并传输'));
    const acceptLabel = element('label', 'in9-profile-consent'), accept = element('input'); accept.type = 'checkbox'; accept.id = 'in9-profile-accept'; accept.checked = false;
    acceptLabel.append(accept, element('span', '', '用此配置重新设置鼠标；未读取的原设备配置无法备份'));
    const applyButton = button('in9-profile-apply', '将此配置传输到鼠标', true);
    const status = note(state.status); status.id = 'in9-profile-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.dataset.kind = state.statusKind;
    transfer.append(acceptLabel, applyButton, note('发送完成仅说明报文已交给系统发送接口；请手动核对鼠标效果。每次编辑、切换范围或尝试传输后，都需重新预览与确认。'));
    importCard.append(status);
    const exportCard = element('section', 'in9-profile-card glass'); exportCard.append(element('h4', '', '导出本地 PSF'));
    const exportLabel = element('label', 'in9-profile-field'); exportLabel.htmlFor = 'in9-profile-export-format'; exportLabel.append(element('span', '', '导出格式'));
    const exportFormat = element('select'); exportFormat.id = 'in9-profile-export-format';
    for (const [value, text] of [['preserve', '保留字段与顺序']]) { const option = element('option', '', text); option.value = value; exportFormat.append(option); }
    exportLabel.append(exportFormat);
    const exportButton = button('in9-profile-export', '下载 .psf 文件');
    exportCard.append(exportLabel, note('导出为 UTF-16LE，保留未编辑的字段和原顺序。'), exportButton);
    const liveReadButton = button('in9-profile-live-status-read', '读取身份与电量');
    const liveStatus = note(liveStatusText(state.liveStatus)); liveStatus.id = 'in9-profile-live-status'; liveStatus.setAttribute('role', 'status'); liveStatus.setAttribute('aria-live', 'polite');
    const liveCard = element('section', 'in9-profile-card glass'); liveCard.append(element('h4', '', '实时设备状态 · Feature20'));
    liveCard.append(liveReadButton, liveStatus, note('此状态不包含 DPI、回报率、按键、灯光或休眠配置读回。'));
    const receiptCard = element('section', 'in9-profile-card glass'); receiptCard.append(element('h4', '', '本地传输记录与恢复'));
    const readButton = button('in9-profile-read', '读取本地记录');
    const receiptStatus = note(''), activeReceipt = element('p', 'in9-profile-receipt'), previousReceipt = element('p', 'in9-profile-receipt');
    activeReceipt.id = 'in9-profile-active-receipt'; previousReceipt.id = 'in9-profile-previous-receipt';
    receiptStatus.id = 'in9-profile-receipt-status'; receiptStatus.setAttribute('role', 'status');
    const restoreButton = button('in9-profile-restore', '重新传输上一次配置'), receiptWarnings = element('ul', 'in9-profile-warnings');
    receiptCard.append(readButton, receiptStatus, element('h5', '', '最近已传输配置'), activeReceipt, element('h5', '', '上一次已传输配置'), previousReceipt, restoreButton, note('恢复只会重新发送本应用记录的上一份配置，也需要上方替换确认。它无法还原首次使用前未知的鼠标配置。'), receiptWarnings);
    const parameters = createParameters();
    const emptyParameters = note('选择或载入官方 PSF 后，点击“预览所选配置”载入参数。此步骤只解析本地配置，不读取或写入鼠标。');
    const systemMouse = document.getElementById('system-mouse-controls');
    section.append(heading, importCard, emptyParameters, controls, parameters.parameters, previewPanel, transfer, exportCard, liveCard, receiptCard); if (systemMouse) section.append(systemMouse); host.append(section);
    ui = {section, viewTitle, controls, transfer, exportCard, liveCard, receiptCard, emptyParameters, systemMouse, importButton, installedButton, archiveButton, installedSelect, installedLoad, file, sourceMeta, raw, previewButton, previewPanel, summary, previewWarnings, accept, applyButton, status, exportFormat, exportButton, liveReadButton, liveStatus, readButton, receiptStatus, activeReceipt, previousReceipt, restoreButton, receiptWarnings, ...parameters};
    importButton.addEventListener('click', () => { if (!blocked()) file.click(); });
    installedButton.addEventListener('click', () => void loadInstalledProfiles());
    archiveButton.addEventListener('click', () => void archiveInstalledFiles());
    installedLoad.addEventListener('click', loadSelectedInstalledProfile);
    file.addEventListener('change', () => void importFile()); raw.addEventListener('input', editorChanged);
    previewButton.addEventListener('click', () => void preview()); accept.addEventListener('change', sync);
    applyButton.addEventListener('click', () => void transmit(false)); restoreButton.addEventListener('click', () => void transmit(true));
    liveReadButton.addEventListener('click', () => void readLiveStatus());
    readButton.addEventListener('click', () => void readReceipts()); exportButton.addEventListener('click', () => void exportProfile()); exportFormat.addEventListener('change', sync);
    paintReceipts(); sync();
    return true;
  }
  function init(options = {}) {
    hooks = {
      isBusy: typeof options.isBusy === 'function' ? options.isBusy : undefined,
      onBusyChange: typeof options.onBusyChange === 'function' ? options.onBusyChange : undefined
    };
    mount(); sync();
  }
  function setDevice(id) {
    if (state.deviceId === id) { mount(); sync(); return; }
    invalidateForDeviceChange();
    state.deviceId = id;
    clearPreview('设备已切换；草稿已保留，请重新预览后操作。');
    state.receipts = null; paintReceipts(); mount(); sync();
  }
  window.in9Profiles = Object.freeze({init, setDevice, sync, showView, isBusy: () => Boolean(state.busy)});
})();
