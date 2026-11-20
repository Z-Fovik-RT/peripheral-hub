# 外设中心统一功能接口 v1

本阶段完成接口声明和调用框架；接口数量不代表设备功能实现数量。所有尚未接入或验证的操作都明确返回错误，不会保存草稿后假报硬件成功。

共 329 个操作：implemented 112；planned 61；unverified 147；disabled 9。

## 调用入口

渲染进程使用 `window.hub.features`，由 preload 的固定 IPC 白名单进入主进程。保留既有 UI 方法兼容。能力查询不会打开 HID 或触发音频采集；调用具体读取方法才访问设备。

```javascript
const capabilities = await window.hub.features.list({deviceId:'ikf-v11-pro-71'});
const eqContract = await window.hub.features.describe('headset.eq.read');
const result = await window.hub.features.invoke({
  apiVersion:1, deviceId:'inphic-in9', operation:'system.mouse.read', args:{}
});
if (result.ok) console.log(result.data);
else console.log(result.error.code, result.error.message);
```

## 状态与验证

| 状态 | 行为 |
|---|---|
| implemented | 有适配器；实际设备仍可能未就绪、驱动缺失、模式不允许或处于恢复锁定 |
| planned | 返回 NOT_IMPLEMENTED，不调用任何适配器 |
| unverified | 返回 UNVERIFIED，协议/设备适用性/完整回读恢复未验证 |
| disabled | 返回 DISABLED_OPERATION；本目录不提供固件更新、恢复出厂或清空板载操作 |

`evidence` 与实现状态独立：generic-only 仅是通用原厂资源线索，不能据此认定 V11 支持。target-confirmed 也只表示目标文档/配置证据，实际就绪与可写能力仍需检测。`canInvoke` 表示存在当前接线，`deviceReadiness` 固定为 not-probed，不代表设备在线。

## 参数与响应

- 每个操作均有封闭参数和响应 schema。未知字段、错误设备、错误版本、越界、非有限数字、空必需字段会被拒绝。
- 普通请求最大1 MiB；mouse.profile请求上限1,600,000字节以容纳最大1 MiB原始PSF的Base64。字段/数组另有长度边界；接口没有任意文件路径、HID 命令、SDK 属性名或脚本执行入口。
- RAW 参数明确保留原始单位；未证实范围不冒充 dB、毫米或毫秒。结构长度/数值上限有些是 API 资源限制，不是设备支持范围。
- 成功返回 `{apiVersion, requestId, deviceId, operation, ok:true, data, meta}`；data 校验失败为 INVALID_RESPONSE。
- 失败返回相同身份字段和 `{ok:false,error:{code,message,retryable}}`。设备不就绪也可由 device.read 成功返回 hardware-status 表示接收器回应，不能把它当配置读取成功。
- restore 返回 errors 数组时可能部分恢复成功；调用者必须逐项展示，不能只看 ok。
- 本地草稿、保存的官方配置、真实硬件读数各自标明来源；不把 IN9 官方默认DPI表当硬件恢复基准。

错误码：`INVALID_ARGUMENT`、`UNKNOWN_OPERATION`、`DEVICE_MISMATCH`、`NOT_IMPLEMENTED`、`UNVERIFIED`、`DISABLED_OPERATION`、`DEVICE_NOT_READY`、`DEPENDENCY_MISSING`、`READBACK_MISMATCH`、`ADAPTER_ERROR`、`INVALID_RESPONSE`、`UNSUPPORTED_FORMAT`、`NOT_FOUND`、`CONFLICT`、`STORAGE_ERROR`。

## 后续接入一个功能

1. 根据官方证据补齐协议与参数含义，读取真实前态并确定恢复策略。
2. 在适配器中实现操作、回读与失败处理，加入离线/真机证据。
3. 将该条 availability 切为 implemented，并加入同名处理函数；构造器会拒绝缺少处理函数的 implemented 条目，也拒绝额外的未授权适配器。
4. 运行 `node tools/generate-api.cjs` 和 `node tests/feature-api-check.cjs`，生成声明/文档，检查覆盖矩阵与错误行为。

## 功能清单

详细参数与返回 schema 见 [JSON目录](api-catalog.json)；请求 schema 见 [JSON Schema](api-request.schema.json)；类型声明见 [TypeScript](../custom-app/api/index.d.ts)。耳机覆盖说明见 [耳机功能](headset-feature-coverage.md)。

| 操作 | 功能 | 设备 | 状态 | 证据 | 官方域 |
|---|---|---|---|---|---|
| `device.read` | 读取当前已接入的设备状态 | aula-f87-pro, inphic-in9 | implemented | hardware-verified | A01, I01 |
| `device.restore` | 恢复键盘已保存快照 | aula-f87-pro | implemented | static-protocol | A03 |
| `system.mouse.read` | 读取 Windows 鼠标参数 | inphic-in9 | implemented | local-verified | I20 |
| `system.mouse.set` | 应用 Windows 鼠标参数 | inphic-in9 | implemented | local-verified | I20 |
| `system.mouse.restore` | 恢复 Windows 鼠标参数 | inphic-in9 | implemented | local-verified | I20 |
| `system.mouse.precision.set` | 提高指针精确度 | inphic-in9 | implemented | local-verified | I20 |
| `system.mouse.buttons.set` | 左右手按钮偏好 | inphic-in9 | implemented | local-verified | I20 |
| `system.mouse.scroll.set` | 水平和垂直滚动偏好 | inphic-in9 | implemented | local-verified | I20 |
| `profiles.list` | 配置：list | aula-f87-pro, inphic-in9, ikf-v11-pro-71 | implemented | local-verified | A17, I15 |
| `profiles.get` | 配置：get | aula-f87-pro, inphic-in9, ikf-v11-pro-71 | implemented | local-verified | A17, I15 |
| `profiles.save` | 配置：save | aula-f87-pro, inphic-in9, ikf-v11-pro-71 | implemented | local-verified | A17, I15 |
| `profiles.rename` | 配置：rename | aula-f87-pro, inphic-in9, ikf-v11-pro-71 | implemented | local-verified | A17, I15 |
| `profiles.duplicate` | 配置：duplicate | aula-f87-pro, inphic-in9, ikf-v11-pro-71 | implemented | local-verified | A17, I15 |
| `profiles.delete` | 配置：delete | aula-f87-pro, inphic-in9, ikf-v11-pro-71 | implemented | local-verified | A17, I15 |
| `profiles.import` | 配置：import | aula-f87-pro, inphic-in9, ikf-v11-pro-71 | implemented | local-verified | A17, I15 |
| `profiles.export` | 配置：export | aula-f87-pro, inphic-in9, ikf-v11-pro-71 | implemented | local-verified | A17, I15 |
| `profiles.validate` | 配置：validate | aula-f87-pro, inphic-in9, ikf-v11-pro-71 | implemented | local-verified | A17, I15 |
| `profiles.linkApplication` | 配置：linkApplication | aula-f87-pro, inphic-in9, ikf-v11-pro-71 | planned | target-confirmed | A17, I15 |
| `keyboard.profiles.official.inspect` | 检查官方AULA DCT配置目录 | aula-f87-pro | implemented | local-verified | A17 |
| `profiles.apply` | 将配置应用到设备 | aula-f87-pro, inphic-in9, ikf-v11-pro-71 | unverified | target-confirmed | A17, I15 |
| `recovery.list` | 列出恢复快照 | aula-f87-pro, inphic-in9, ikf-v11-pro-71 | planned | target-confirmed |  |
| `recovery.restore` | 恢复指定快照 | aula-f87-pro, inphic-in9, ikf-v11-pro-71 | unverified | target-confirmed |  |
| `app.preferences.read` | 读取应用偏好 | application | implemented | local-verified | A21, I22 |
| `app.preferences.set` | 修改应用偏好 | application | implemented | local-verified | A21, I22 |
| `app.version.read` | 软件版本信息 | application | implemented | target-confirmed | A20, I22 |
| `app.updates.check` | 查询自建程序更新 | application | planned | target-confirmed | A20 |
| `app.updates.install` | 安装自建程序更新 | application | disabled | target-confirmed | A20 |
| `keyboard.identity.read` | 读取键盘型号与固件 | aula-f87-pro | implemented | hardware-verified | A01 |
| `keyboard.connection.read` | 读取键盘与接收器状态 | aula-f87-pro | unverified | static-protocol | A01 |
| `keyboard.battery.read` | 查询键盘电量适用性 | aula-f87-pro | disabled | target-confirmed | A01 |
| `keyboard.lighting.modes.list` | 列出键盘灯效与各模式参数能力 | aula-f87-pro | planned | static-protocol | A02, A09 |
| `keyboard.lighting.read` | 读取键盘灯光配置 | aula-f87-pro | implemented | hardware-verified | A02, A03, A04, A05, A06, A09 |
| `keyboard.lighting.mode.set` | 切换键盘灯效 | aula-f87-pro | implemented | hardware-verified | A02 |
| `keyboard.lighting.brightness.set` | 应用键盘常亮亮度 | aula-f87-pro | implemented | hardware-verified | A03, A04 |
| `keyboard.lighting.speed.set` | 设置键盘当前灯效速度 | aula-f87-pro | implemented | hardware-verified | A05 |
| `keyboard.lighting.color.set` | 设置键盘调色板索引或多彩 | aula-f87-pro | implemented | hardware-verified | A06 |
| `keyboard.lighting.enabled.set` | 开关键盘灯效 | aula-f87-pro | implemented | hardware-verified | A09 |
| `keyboard.palette.read` | 读取每模式RGB调色板 | aula-f87-pro | implemented | static-protocol | A07 |
| `keyboard.palette.set` | 设置每模式RGB调色板 | aula-f87-pro | unverified | static-protocol | A07 |
| `keyboard.lighting.custom.read` | 读取自定义逐键RGB | aula-f87-pro | unverified | static-protocol | A08 |
| `keyboard.lighting.custom.set` | 设置自定义逐键RGB | aula-f87-pro | unverified | static-protocol | A08 |
| `keyboard.colors.favorites.list` | 读取本地收藏颜色 | aula-f87-pro | implemented | local-verified | A07 |
| `keyboard.colors.favorites.save` | 保存本地收藏颜色 | aula-f87-pro | implemented | local-verified | A07 |
| `keyboard.colors.favorites.delete` | 删除本地收藏颜色 | aula-f87-pro | implemented | local-verified | A07 |
| `keyboard.sleep.read` | 读取键盘休眠 | aula-f87-pro | implemented | hardware-verified | A10 |
| `keyboard.sleep.set` | 设置键盘休眠 | aula-f87-pro | implemented | hardware-verified | A10 |
| `keyboard.debounce.read` | 读取键盘防抖档位 | aula-f87-pro | implemented | hardware-verified | A11 |
| `keyboard.debounce.set` | 设置键盘防抖档位 | aula-f87-pro | implemented | hardware-verified | A11 |
| `keyboard.tap.read` | 读取Tap开关与灵敏度 | aula-f87-pro | unverified | generic-only | A12 |
| `keyboard.tap.set` | 设置Tap开关与灵敏度 | aula-f87-pro | unverified | generic-only | A12 |
| `keyboard.systemMode.read` | 读取键盘系统模式 | aula-f87-pro | unverified | static-protocol | A12 |
| `keyboard.systemMode.set` | 设置键盘系统模式 | aula-f87-pro | unverified | static-protocol | A12 |
| `keyboard.bindings.read` | 读取四层按键映射 | aula-f87-pro | unverified | static-protocol | A13, A14 |
| `keyboard.bindings.set` | 设置四层按键映射 | aula-f87-pro | unverified | static-protocol | A13, A14 |
| `keyboard.binding.set` | 设置单个键位动作 | aula-f87-pro | unverified | static-protocol | A13, A14 |
| `keyboard.bindings.validate` | 校验键盘映射与动作适用性 | aula-f87-pro | planned | static-protocol | A13, A14 |
| `keyboard.music.modes.list` | 音乐灯效模式 | aula-f87-pro | planned | static-protocol | A18 |
| `keyboard.music.start` | 启动音频驱动的灯光流 | aula-f87-pro | planned | target-confirmed | A18 |
| `keyboard.music.stop` | 停止音乐灯光流 | aula-f87-pro | planned | static-protocol | A18 |
| `mouse.identity.read` | 鼠标身份、电量与传感器 | inphic-in9 | planned | hardware-verified | I01 |
| `mouse.dpi.read` | 读取鼠标六档DPI | inphic-in9 | unverified | static-protocol | I02, I03, I04 |
| `mouse.dpi.set` | 设置鼠标六档DPI | inphic-in9 | unverified | static-protocol | I02, I03, I04 |
| `mouse.dpi.options.list` | 支持的DPI逻辑选项 | inphic-in9 | planned | static-protocol | I02 |
| `mouse.dpi.stage.set` | 选择当前DPI档 | inphic-in9 | unverified | static-protocol | I03 |
| `mouse.dpi.mask.set` | 启用DPI档位 | inphic-in9 | unverified | static-protocol | I03 |
| `mouse.dpi.color.set` | 设置单档DPI指示颜色 | inphic-in9 | unverified | static-protocol | I04 |
| `mouse.status.read` | 读取当前档序号和回报率状态 | inphic-in9 | unverified | static-protocol | I03, I05 |
| `mouse.polling.read` | 读取鼠标回报率 | inphic-in9 | unverified | static-protocol | I05 |
| `mouse.polling.set` | 设置鼠标回报率 | inphic-in9 | unverified | static-protocol | I05 |
| `mouse.lighting.read` | 读取鼠标灯光区域和参数 | inphic-in9 | unverified | static-protocol | I06, I07 |
| `mouse.lighting.set` | 设置鼠标灯光区域和参数 | inphic-in9 | unverified | static-protocol | I06, I07 |
| `mouse.lighting.modes.list` | 鼠标灯效能力目录 | inphic-in9 | planned | static-protocol | I06, I07 |
| `mouse.bindings.read` | 读取鼠标六键映射 | inphic-in9 | unverified | static-protocol | I08, I09, I10, I11, I12 |
| `mouse.bindings.set` | 设置鼠标六键映射 | inphic-in9 | unverified | static-protocol | I08, I09, I10, I11, I12 |
| `mouse.binding.set` | 设置单个鼠标按键动作 | inphic-in9 | unverified | static-protocol | I08, I09, I10, I11, I12 |
| `mouse.bindings.validate` | 校验唯一按键与至少一个左键 | inphic-in9 | planned | static-protocol | I12 |
| `mouse.sleep.read` | 读取鼠标休眠代码 | inphic-in9 | unverified | static-protocol | I16 |
| `mouse.sleep.set` | 设置鼠标休眠代码 | inphic-in9 | unverified | static-protocol | I16 |
| `mouse.motion.read` | 读取移动关灯与移动唤醒 | inphic-in9 | unverified | static-protocol | I17 |
| `mouse.motion.set` | 设置移动关灯与移动唤醒 | inphic-in9 | unverified | static-protocol | I17 |
| `mouse.liftOff.read` | 读取鼠标LOD高度代码 | inphic-in9 | unverified | static-protocol | I18 |
| `mouse.liftOff.set` | 设置鼠标LOD高度代码 | inphic-in9 | unverified | static-protocol | I18 |
| `mouse.debounce.read` | 读取鼠标去抖代码 | inphic-in9 | unverified | static-protocol | I19 |
| `mouse.debounce.set` | 设置鼠标去抖代码 | inphic-in9 | unverified | static-protocol | I19 |
| `mouse.angleSnap.read` | 读取角度捕捉 | inphic-in9 | unverified | static-protocol | I18 |
| `mouse.angleSnap.set` | 设置角度捕捉 | inphic-in9 | unverified | static-protocol | I18 |
| `keyboard.factoryReset` | 恢复出厂默认 | aula-f87-pro | disabled | static-protocol | A19 |
| `keyboard.onboard.clear` | 清空板载配置 | aula-f87-pro | disabled | static-protocol | A19 |
| `keyboard.firmware.read` | 读取固件版本 | aula-f87-pro | unverified | static-protocol | A01, A20 |
| `mouse.factoryReset` | 恢复出厂默认 | inphic-in9 | disabled | static-protocol | I21 |
| `mouse.onboard.clear` | 清空板载配置 | inphic-in9 | disabled | static-protocol | I21 |
| `mouse.firmware.read` | 读取固件版本 | inphic-in9 | unverified | static-protocol | I22 |
| `keyboard.bindings.snapshot.read` | 读取所选层实际矩阵记录 | aula-f87-pro | implemented | static-protocol | A13, A14 |
| `keyboard.configuration.snapshot.read` | 同会话读取四层矩阵与调色板 | aula-f87-pro | implemented | static-protocol | A13, A14 |
| `keyboard.draft.patch` | 编辑键盘原始配置本地草稿 | aula-f87-pro | implemented | local-verified | A07, A13, A14, A15 |
| `mouse.profile.statusRead` | 读取IN9设备身份与电量状态 | inphic-in9 | implemented | live-observed | I02, I03, I04, I05, I06, I07, I08, I09, I16, I19 |
| `mouse.profile.installedList` | 列出本地鼠标PSF与内置默认模板 | inphic-in9 | implemented | local-verified | I02, I03, I04, I05, I06, I07, I08, I09, I16, I19 |
| `mouse.profile.archiveInstalled` | 归档IN9官方本地配置与宏库原始文件 | inphic-in9 | implemented | local-verified | I02, I03, I04, I05, I06, I07, I08, I09, I16, I19 |
| `mouse.profile.preview` | 预览并编辑官方鼠标PSF | inphic-in9 | implemented | local-verified | I02, I03, I04, I05, I06, I07, I08, I09, I16, I19 |
| `mouse.profile.read` | 读取鼠标本地传输记录 | inphic-in9 | implemented | local-verified | I02, I03, I04, I05, I06, I07, I08, I09, I16, I19 |
| `mouse.profile.export` | 导出官方鼠标PSF | inphic-in9 | implemented | local-verified | I02, I03, I04, I05, I06, I07, I08, I09, I16, I19 |
| `mouse.profile.apply` | 发送明确选择的鼠标完整配置 | inphic-in9 | implemented | static-protocol | I02, I03, I04, I05, I06, I07, I08, I09, I16, I19 |
| `mouse.profile.restore` | 重新发送上一份鼠标配置 | inphic-in9 | implemented | static-protocol | I02, I03, I04, I05, I06, I07, I08, I09, I16, I19 |
| `headset.audio.list` | 列出播放和录音端点 | ikf-v11-pro-71 | implemented | system-verified | H-AUDIO |
| `headset.audio.set` | 设置端点音量与静音 | ikf-v11-pro-71 | implemented | system-verified | H-AUDIO |
| `headset.audio.restore` | 恢复音频快照 | ikf-v11-pro-71 | implemented | system-verified | H-AUDIO |
| `headset.audio.format.read` | 读取端点默认格式 | ikf-v11-pro-71 | implemented | system-verified | H-FORMAT |
| `headset.audio.format.list` | 查询端点可用格式 | ikf-v11-pro-71 | implemented | system-verified | H-FORMAT |
| `headset.audio.format.set` | 设置端点默认格式 | ikf-v11-pro-71 | implemented | system-verified | H-FORMAT |
| `headset.audio.balance.read` | 读取左右平衡 | ikf-v11-pro-71 | implemented | system-verified | H-BALANCE |
| `headset.audio.balance.set` | 设置左右平衡 | ikf-v11-pro-71 | implemented | system-verified | H-BALANCE |
| `headset.audio.balance.range` | 查询左右平衡参数范围 | ikf-v11-pro-71 | unverified | generic-only | H-BALANCE |
| `headset.audio.balance.contracts` | 查询左右平衡静态契约 | ikf-v11-pro-71 | planned | generic-only | H-BALANCE |
| `headset.audio.channels.read` | 读取声道音量 | ikf-v11-pro-71 | implemented | system-verified | H-CHANNELS |
| `headset.audio.channels.set` | 设置声道音量 | ikf-v11-pro-71 | implemented | system-verified | H-CHANNELS |
| `headset.audio.channels.range` | 查询声道音量参数范围 | ikf-v11-pro-71 | unverified | generic-only | H-CHANNELS |
| `headset.audio.channels.contracts` | 查询声道音量静态契约 | ikf-v11-pro-71 | planned | generic-only | H-CHANNELS |
| `headset.audio.volume.range` | 查询端点原始音量范围 | ikf-v11-pro-71 | unverified | generic-only | H-AUDIO |
| `headset.audio.peak.read` | 读取端点峰值 | ikf-v11-pro-71 | implemented | system-verified | H-PEAK |
| `headset.audio.sessions.list` | 列出端点音频会话 | ikf-v11-pro-71 | implemented | system-verified | H-SESSION |
| `headset.audio.sessions.set` | 设置会话音量与静音 | ikf-v11-pro-71 | implemented | system-verified | H-SESSION |
| `headset.audio.default.read` | 读取默认端点角色 | ikf-v11-pro-71 | implemented | system-verified | H-DEFAULT |
| `headset.audio.default.set` | 设置默认端点角色 | ikf-v11-pro-71 | implemented | system-verified | H-DEFAULT |
| `headset.audio.channelTest.start` | 开始指定声道试听 | ikf-v11-pro-71 | planned | generic-only | H-CHANNELS |
| `headset.audio.channelTest.stop` | 停止声道试听 | ikf-v11-pro-71 | planned | generic-only | H-CHANNELS |
| `headset.eq.read` | 读取播放十段 EQ | ikf-v11-pro-71 | implemented | hardware-verified | H-EQ |
| `headset.eq.set` | 设置播放十段 EQ | ikf-v11-pro-71 | implemented | hardware-verified | H-EQ |
| `headset.eq.range` | 查询播放十段 EQ参数范围 | ikf-v11-pro-71 | unverified | target-confirmed | H-EQ |
| `headset.eq.contracts` | 查询播放十段 EQ静态契约 | ikf-v11-pro-71 | planned | target-confirmed | H-EQ |
| `headset.mic.eq.read` | 读取录音十段 EQ | ikf-v11-pro-71 | unverified | generic-only | H-MIC-EQ |
| `headset.mic.eq.set` | 设置录音十段 EQ | ikf-v11-pro-71 | unverified | generic-only | H-MIC-EQ |
| `headset.mic.eq.range` | 查询录音十段 EQ参数范围 | ikf-v11-pro-71 | unverified | generic-only | H-MIC-EQ |
| `headset.mic.eq.contracts` | 查询录音十段 EQ静态契约 | ikf-v11-pro-71 | planned | generic-only | H-MIC-EQ |
| `headset.mic.eq.filters.read` | 读取录音 EQ 滤波与前级 | ikf-v11-pro-71 | unverified | target-confirmed | H-MIC-FILTERS |
| `headset.mic.eq.filters.set` | 设置录音 EQ 滤波与前级 | ikf-v11-pro-71 | unverified | target-confirmed | H-MIC-FILTERS |
| `headset.mic.eq.filters.range` | 查询录音 EQ 滤波与前级参数范围 | ikf-v11-pro-71 | unverified | target-confirmed | H-MIC-FILTERS |
| `headset.mic.eq.filters.contracts` | 查询录音 EQ 滤波与前级静态契约 | ikf-v11-pro-71 | planned | target-confirmed | H-MIC-FILTERS |
| `headset.eq.presets.list` | 列出播放或录音 EQ 预设 | ikf-v11-pro-71 | implemented | local-verified | H-EQ-PRESETS |
| `headset.eq.presets.create` | 按官方流程另存当前 EQ 设定档 | ikf-v11-pro-71 | implemented | local-verified | H-EQ-PRESETS |
| `headset.eq.presets.save` | 保存本地 EQ 预设 | ikf-v11-pro-71 | implemented | local-verified | H-EQ-PRESETS |
| `headset.eq.presets.delete` | 删除本地用户 EQ 预设 | ikf-v11-pro-71 | implemented | local-verified | H-EQ-PRESETS |
| `headset.eq.presets.apply` | 应用 EQ 预设 | ikf-v11-pro-71 | implemented | hardware-verified | H-EQ-PRESETS |
| `headset.eq.presets.export` | 导出本地 EQ 预设 | ikf-v11-pro-71 | implemented | local-verified | H-EQ-PRESETS |
| `headset.eq.presets.official.import` | 导入原厂自定义 EQ 列表 | ikf-v11-pro-71 | implemented | local-verified | H-EQ-PRESETS |
| `headset.eq.presets.official.export` | 导出原厂自定义 EQ 列表 | ikf-v11-pro-71 | implemented | local-verified | H-EQ-PRESETS |
| `headset.eq.presets.import` | 导入结构化 EQ 预设 | ikf-v11-pro-71 | implemented | local-verified | H-EQ-PRESETS |
| `headset.surround71.read` | 读取7.1 耳机环绕 | ikf-v11-pro-71 | implemented | hardware-verified | H-71 |
| `headset.surround71.set` | 设置7.1 耳机环绕 | ikf-v11-pro-71 | implemented | hardware-verified | H-71 |
| `headset.surround71.range` | 查询7.1 耳机环绕参数范围 | ikf-v11-pro-71 | unverified | target-confirmed | H-71 |
| `headset.surround71.contracts` | 查询7.1 耳机环绕静态契约 | ikf-v11-pro-71 | planned | target-confirmed | H-71 |
| `headset.virtualSpeaker.read` | 读取八声道虚拟扬声器位置 | ikf-v11-pro-71 | unverified | target-confirmed | H-VSS |
| `headset.virtualSpeaker.set` | 设置八声道虚拟扬声器位置 | ikf-v11-pro-71 | unverified | target-confirmed | H-VSS |
| `headset.virtualSpeaker.range` | 查询八声道虚拟扬声器位置参数范围 | ikf-v11-pro-71 | unverified | target-confirmed | H-VSS |
| `headset.virtualSpeaker.contracts` | 查询八声道虚拟扬声器位置静态契约 | ikf-v11-pro-71 | planned | target-confirmed | H-VSS |
| `headset.virtualSpeaker.rotate` | 旋转虚拟扬声器 | ikf-v11-pro-71 | unverified | target-confirmed | H-VSS |
| `headset.virtualSpeaker.stop` | 停止虚拟扬声器旋转 | ikf-v11-pro-71 | unverified | target-confirmed | H-VSS |
| `headset.surroundMax.read` | 读取Surround Max | ikf-v11-pro-71 | implemented | hardware-verified | H-SURROUND-MAX |
| `headset.surroundMax.set` | 设置Surround Max | ikf-v11-pro-71 | implemented | hardware-verified | H-SURROUND-MAX |
| `headset.surroundMax.range` | 查询Surround Max参数范围 | ikf-v11-pro-71 | unverified | target-confirmed | H-SURROUND-MAX |
| `headset.surroundMax.contracts` | 查询Surround Max静态契约 | ikf-v11-pro-71 | planned | target-confirmed | H-SURROUND-MAX |
| `headset.bass.read` | 读取低音管理 | ikf-v11-pro-71 | unverified | generic-only | H-BASS |
| `headset.bass.set` | 设置低音管理 | ikf-v11-pro-71 | unverified | generic-only | H-BASS |
| `headset.bass.range` | 查询低音管理参数范围 | ikf-v11-pro-71 | unverified | generic-only | H-BASS |
| `headset.bass.contracts` | 查询低音管理静态契约 | ikf-v11-pro-71 | planned | generic-only | H-BASS |
| `headset.brilliant.read` | 读取Xear Audio Brilliant | ikf-v11-pro-71 | implemented | hardware-verified | H-BRILLIANT |
| `headset.brilliant.set` | 设置Xear Audio Brilliant | ikf-v11-pro-71 | implemented | hardware-verified | H-BRILLIANT |
| `headset.brilliant.range` | 查询Xear Audio Brilliant参数范围 | ikf-v11-pro-71 | unverified | target-confirmed | H-BRILLIANT |
| `headset.brilliant.contracts` | 查询Xear Audio Brilliant静态契约 | ikf-v11-pro-71 | planned | target-confirmed | H-BRILLIANT |
| `headset.dynamicBass.read` | 读取Xear Dynamic Bass | ikf-v11-pro-71 | implemented | hardware-verified | H-DYNAMIC-BASS |
| `headset.dynamicBass.set` | 设置Xear Dynamic Bass | ikf-v11-pro-71 | implemented | hardware-verified | H-DYNAMIC-BASS |
| `headset.dynamicBass.range` | 查询Xear Dynamic Bass参数范围 | ikf-v11-pro-71 | unverified | target-confirmed | H-DYNAMIC-BASS |
| `headset.dynamicBass.contracts` | 查询Xear Dynamic Bass静态契约 | ikf-v11-pro-71 | planned | target-confirmed | H-DYNAMIC-BASS |
| `headset.dynamicBass.highPass.read` | 读取动态低音高通 | ikf-v11-pro-71 | unverified | target-confirmed | H-DYNAMIC-BASS |
| `headset.dynamicBass.highPass.set` | 设置动态低音高通 | ikf-v11-pro-71 | unverified | target-confirmed | H-DYNAMIC-BASS |
| `headset.dynamicBass.highPass.range` | 查询动态低音高通参数范围 | ikf-v11-pro-71 | unverified | target-confirmed | H-DYNAMIC-BASS |
| `headset.dynamicBass.highPass.contracts` | 查询动态低音高通静态契约 | ikf-v11-pro-71 | planned | target-confirmed | H-DYNAMIC-BASS |
| `headset.voiceClarity.read` | 读取Xear Voice Clarity | ikf-v11-pro-71 | implemented | hardware-verified | H-VOICE-CLARITY |
| `headset.voiceClarity.set` | 设置Xear Voice Clarity | ikf-v11-pro-71 | implemented | hardware-verified | H-VOICE-CLARITY |
| `headset.voiceClarity.range` | 查询Xear Voice Clarity参数范围 | ikf-v11-pro-71 | unverified | target-confirmed | H-VOICE-CLARITY |
| `headset.voiceClarity.contracts` | 查询Xear Voice Clarity静态契约 | ikf-v11-pro-71 | planned | target-confirmed | H-VOICE-CLARITY |
| `headset.smartVolume.read` | 读取Xear Smart Volume | ikf-v11-pro-71 | implemented | hardware-verified | H-SMART-VOLUME |
| `headset.smartVolume.set` | 设置Xear Smart Volume | ikf-v11-pro-71 | implemented | hardware-verified | H-SMART-VOLUME |
| `headset.smartVolume.range` | 查询Xear Smart Volume参数范围 | ikf-v11-pro-71 | unverified | target-confirmed | H-SMART-VOLUME |
| `headset.smartVolume.contracts` | 查询Xear Smart Volume静态契约 | ikf-v11-pro-71 | planned | target-confirmed | H-SMART-VOLUME |
| `headset.vocalFading.read` | 读取人声消除 | ikf-v11-pro-71 | unverified | target-confirmed | H-VOCAL-FADING |
| `headset.vocalFading.set` | 设置人声消除 | ikf-v11-pro-71 | unverified | target-confirmed | H-VOCAL-FADING |
| `headset.vocalFading.range` | 查询人声消除参数范围 | ikf-v11-pro-71 | unverified | target-confirmed | H-VOCAL-FADING |
| `headset.vocalFading.contracts` | 查询人声消除静态契约 | ikf-v11-pro-71 | planned | target-confirmed | H-VOCAL-FADING |
| `headset.keyShift.read` | 读取升降调 | ikf-v11-pro-71 | unverified | target-confirmed | H-KEY-SHIFT |
| `headset.keyShift.set` | 设置升降调 | ikf-v11-pro-71 | unverified | target-confirmed | H-KEY-SHIFT |
| `headset.keyShift.range` | 查询升降调参数范围 | ikf-v11-pro-71 | unverified | target-confirmed | H-KEY-SHIFT |
| `headset.keyShift.contracts` | 查询升降调静态契约 | ikf-v11-pro-71 | planned | target-confirmed | H-KEY-SHIFT |
| `headset.mic.echo.read` | 读取麦克风回声 | ikf-v11-pro-71 | unverified | target-confirmed | H-ECHO |
| `headset.mic.echo.set` | 设置麦克风回声 | ikf-v11-pro-71 | unverified | target-confirmed | H-ECHO |
| `headset.mic.echo.range` | 查询麦克风回声参数范围 | ikf-v11-pro-71 | unverified | target-confirmed | H-ECHO |
| `headset.mic.echo.contracts` | 查询麦克风回声静态契约 | ikf-v11-pro-71 | planned | target-confirmed | H-ECHO |
| `headset.mic.magicVoice.read` | 读取传统变声 | ikf-v11-pro-71 | implemented | hardware-verified | H-MAGIC-VOICE |
| `headset.mic.magicVoice.set` | 设置传统变声 | ikf-v11-pro-71 | implemented | hardware-verified | H-MAGIC-VOICE |
| `headset.mic.magicVoice.range` | 查询传统变声参数范围 | ikf-v11-pro-71 | unverified | target-confirmed | H-MAGIC-VOICE |
| `headset.mic.magicVoice.contracts` | 查询传统变声静态契约 | ikf-v11-pro-71 | planned | target-confirmed | H-MAGIC-VOICE |
| `headset.environment.read` | 读取环境音效 | ikf-v11-pro-71 | unverified | generic-only | H-ENVIRONMENT |
| `headset.environment.set` | 设置环境音效 | ikf-v11-pro-71 | unverified | generic-only | H-ENVIRONMENT |
| `headset.environment.range` | 查询环境音效参数范围 | ikf-v11-pro-71 | unverified | generic-only | H-ENVIRONMENT |
| `headset.environment.contracts` | 查询环境音效静态契约 | ikf-v11-pro-71 | planned | generic-only | H-ENVIRONMENT |
| `headset.playback.nr.read` | 读取播放非 AI 降噪 | ikf-v11-pro-71 | unverified | generic-only | H-PLAYBACK-NR |
| `headset.playback.nr.set` | 设置播放非 AI 降噪 | ikf-v11-pro-71 | disabled | generic-only | H-PLAYBACK-NR |
| `headset.playback.nr.range` | 查询播放非 AI 降噪参数范围 | ikf-v11-pro-71 | unverified | generic-only | H-PLAYBACK-NR |
| `headset.playback.nr.contracts` | 查询播放非 AI 降噪静态契约 | ikf-v11-pro-71 | planned | generic-only | H-PLAYBACK-NR |
| `headset.mic.nr.read` | 读取麦克风降噪 | ikf-v11-pro-71 | implemented | hardware-verified | H-MIC-NR |
| `headset.mic.nr.set` | 设置麦克风降噪 | ikf-v11-pro-71 | implemented | hardware-verified | H-MIC-NR |
| `headset.mic.nr.range` | 查询麦克风降噪参数范围 | ikf-v11-pro-71 | unverified | target-confirmed | H-MIC-NR |
| `headset.mic.nr.contracts` | 查询麦克风降噪静态契约 | ikf-v11-pro-71 | planned | target-confirmed | H-MIC-NR |
| `headset.mic.hdNr.read` | 读取麦克风 HD 降噪 | ikf-v11-pro-71 | unverified | generic-only | H-HD-NR |
| `headset.mic.hdNr.set` | 设置麦克风 HD 降噪 | ikf-v11-pro-71 | unverified | generic-only | H-HD-NR |
| `headset.mic.hdNr.range` | 查询麦克风 HD 降噪参数范围 | ikf-v11-pro-71 | unverified | generic-only | H-HD-NR |
| `headset.mic.hdNr.contracts` | 查询麦克风 HD 降噪静态契约 | ikf-v11-pro-71 | planned | generic-only | H-HD-NR |
| `headset.mic.aec.read` | 读取麦克风回声消除诊断状态 | ikf-v11-pro-71 | implemented | target-confirmed | H-AEC |
| `headset.mic.aec.set` | 设置麦克风回声消除 | ikf-v11-pro-71 | unverified | target-confirmed | H-AEC |
| `headset.mic.aec.range` | 查询麦克风回声消除参数范围 | ikf-v11-pro-71 | unverified | target-confirmed | H-AEC |
| `headset.mic.aec.contracts` | 查询麦克风回声消除静态契约 | ikf-v11-pro-71 | planned | target-confirmed | H-AEC |
| `headset.mic.array.read` | 读取麦克风阵列 | ikf-v11-pro-71 | unverified | target-confirmed | H-ARRAY |
| `headset.mic.array.set` | 设置麦克风阵列 | ikf-v11-pro-71 | unverified | target-confirmed | H-ARRAY |
| `headset.mic.array.range` | 查询麦克风阵列参数范围 | ikf-v11-pro-71 | unverified | target-confirmed | H-ARRAY |
| `headset.mic.array.contracts` | 查询麦克风阵列静态契约 | ikf-v11-pro-71 | planned | target-confirmed | H-ARRAY |
| `headset.mic.agc.read` | 读取麦克风自动增益上限 | ikf-v11-pro-71 | unverified | generic-only | H-AGC |
| `headset.mic.agc.set` | 设置麦克风自动增益上限 | ikf-v11-pro-71 | unverified | generic-only | H-AGC |
| `headset.mic.agc.range` | 查询麦克风自动增益上限参数范围 | ikf-v11-pro-71 | unverified | generic-only | H-AGC |
| `headset.mic.agc.contracts` | 查询麦克风自动增益上限静态契约 | ikf-v11-pro-71 | planned | generic-only | H-AGC |
| `headset.playback.agc.read` | 读取播放自动增益上限 | ikf-v11-pro-71 | unverified | generic-only | H-AGC |
| `headset.playback.agc.set` | 设置播放自动增益上限 | ikf-v11-pro-71 | unverified | generic-only | H-AGC |
| `headset.playback.agc.range` | 查询播放自动增益上限参数范围 | ikf-v11-pro-71 | unverified | generic-only | H-AGC |
| `headset.playback.agc.contracts` | 查询播放自动增益上限静态契约 | ikf-v11-pro-71 | planned | generic-only | H-AGC |
| `headset.mic.antiClipping.read` | 读取麦克风防削波 | ikf-v11-pro-71 | unverified | target-confirmed | H-ANTI-CLIPPING |
| `headset.mic.antiClipping.set` | 设置麦克风防削波 | ikf-v11-pro-71 | unverified | target-confirmed | H-ANTI-CLIPPING |
| `headset.mic.antiClipping.range` | 查询麦克风防削波参数范围 | ikf-v11-pro-71 | unverified | target-confirmed | H-ANTI-CLIPPING |
| `headset.mic.antiClipping.contracts` | 查询麦克风防削波静态契约 | ikf-v11-pro-71 | planned | target-confirmed | H-ANTI-CLIPPING |
| `headset.mic.compressor.read` | 读取录音压缩器 | ikf-v11-pro-71 | unverified | generic-only | H-COMPRESSOR |
| `headset.mic.compressor.set` | 设置录音压缩器 | ikf-v11-pro-71 | unverified | generic-only | H-COMPRESSOR |
| `headset.mic.compressor.range` | 查询录音压缩器参数范围 | ikf-v11-pro-71 | unverified | generic-only | H-COMPRESSOR |
| `headset.mic.compressor.contracts` | 查询录音压缩器静态契约 | ikf-v11-pro-71 | planned | generic-only | H-COMPRESSOR |
| `headset.mic.noiseGate.read` | 读取录音噪声门 | ikf-v11-pro-71 | unverified | generic-only | H-NOISE-GATE |
| `headset.mic.noiseGate.set` | 设置录音噪声门 | ikf-v11-pro-71 | unverified | generic-only | H-NOISE-GATE |
| `headset.mic.noiseGate.range` | 查询录音噪声门参数范围 | ikf-v11-pro-71 | unverified | generic-only | H-NOISE-GATE |
| `headset.mic.noiseGate.contracts` | 查询录音噪声门静态契约 | ikf-v11-pro-71 | planned | generic-only | H-NOISE-GATE |
| `headset.mic.ldr.read` | 读取远距离录音组合模式 | ikf-v11-pro-71 | unverified | generic-only | H-LDR |
| `headset.mic.ldr.set` | 设置远距离录音组合模式 | ikf-v11-pro-71 | unverified | generic-only | H-LDR |
| `headset.mic.ldr.range` | 查询远距离录音组合模式参数范围 | ikf-v11-pro-71 | unverified | generic-only | H-LDR |
| `headset.mic.ldr.contracts` | 查询远距离录音组合模式静态契约 | ikf-v11-pro-71 | planned | generic-only | H-LDR |
| `headset.playback.limiter.read` | 读取播放 VRMS 限幅 | ikf-v11-pro-71 | unverified | target-confirmed | H-LIMITER |
| `headset.playback.limiter.set` | 设置播放 VRMS 限幅 | ikf-v11-pro-71 | unverified | target-confirmed | H-LIMITER |
| `headset.playback.limiter.range` | 查询播放 VRMS 限幅参数范围 | ikf-v11-pro-71 | unverified | target-confirmed | H-LIMITER |
| `headset.playback.limiter.contracts` | 查询播放 VRMS 限幅静态契约 | ikf-v11-pro-71 | planned | target-confirmed | H-LIMITER |
| `headset.ai.nr.playback.read` | 读取AI 播放降噪 | ikf-v11-pro-71 | unverified | generic-only | H-AI-NR |
| `headset.ai.nr.playback.set` | 设置AI 播放降噪 | ikf-v11-pro-71 | unverified | generic-only | H-AI-NR |
| `headset.ai.nr.playback.range` | 查询AI 播放降噪参数范围 | ikf-v11-pro-71 | unverified | generic-only | H-AI-NR |
| `headset.ai.nr.playback.contracts` | 查询AI 播放降噪静态契约 | ikf-v11-pro-71 | planned | generic-only | H-AI-NR |
| `headset.ai.nr.mic.read` | 读取AI 麦克风降噪 | ikf-v11-pro-71 | unverified | generic-only | H-AI-NR |
| `headset.ai.nr.mic.set` | 设置AI 麦克风降噪 | ikf-v11-pro-71 | unverified | generic-only | H-AI-NR |
| `headset.ai.nr.mic.range` | 查询AI 麦克风降噪参数范围 | ikf-v11-pro-71 | unverified | generic-only | H-AI-NR |
| `headset.ai.nr.mic.contracts` | 查询AI 麦克风降噪静态契约 | ikf-v11-pro-71 | planned | generic-only | H-AI-NR |
| `headset.ai.aec.read` | 读取AI 回声消除 | ikf-v11-pro-71 | unverified | generic-only | H-AI-AEC |
| `headset.ai.aec.set` | 设置AI 回声消除 | ikf-v11-pro-71 | unverified | generic-only | H-AI-AEC |
| `headset.ai.aec.range` | 查询AI 回声消除参数范围 | ikf-v11-pro-71 | unverified | generic-only | H-AI-AEC |
| `headset.ai.aec.contracts` | 查询AI 回声消除静态契约 | ikf-v11-pro-71 | planned | generic-only | H-AI-AEC |
| `headset.ai.array.read` | 读取AI 麦克风阵列 | ikf-v11-pro-71 | unverified | generic-only | H-AI-ARRAY |
| `headset.ai.array.set` | 设置AI 麦克风阵列 | ikf-v11-pro-71 | unverified | generic-only | H-AI-ARRAY |
| `headset.ai.array.range` | 查询AI 麦克风阵列参数范围 | ikf-v11-pro-71 | unverified | generic-only | H-AI-ARRAY |
| `headset.ai.array.contracts` | 查询AI 麦克风阵列静态契约 | ikf-v11-pro-71 | planned | generic-only | H-AI-ARRAY |
| `headset.ai.voice.read` | 读取AI 变声 | ikf-v11-pro-71 | unverified | generic-only | H-AI-VOICE |
| `headset.ai.voice.set` | 设置AI 变声 | ikf-v11-pro-71 | unverified | generic-only | H-AI-VOICE |
| `headset.ai.voice.range` | 查询AI 变声参数范围 | ikf-v11-pro-71 | unverified | generic-only | H-AI-VOICE |
| `headset.ai.voice.contracts` | 查询AI 变声静态契约 | ikf-v11-pro-71 | planned | generic-only | H-AI-VOICE |
| `headset.magicVoice2.read` | 读取Magic Voice II | ikf-v11-pro-71 | unverified | generic-only | H-MAGIC-VOICE2 |
| `headset.magicVoice2.set` | 设置Magic Voice II | ikf-v11-pro-71 | unverified | generic-only | H-MAGIC-VOICE2 |
| `headset.magicVoice2.range` | 查询Magic Voice II参数范围 | ikf-v11-pro-71 | unverified | generic-only | H-MAGIC-VOICE2 |
| `headset.magicVoice2.contracts` | 查询Magic Voice II静态契约 | ikf-v11-pro-71 | planned | generic-only | H-MAGIC-VOICE2 |
| `headset.magicVoice2.targets.list` | 列出可用变声音色模型 | ikf-v11-pro-71 | unverified | generic-only | H-MAGIC-VOICE2 |
| `headset.magicVoice2.profiles.list` | 列出本地变声配置 | ikf-v11-pro-71 | planned | generic-only | H-MAGIC-VOICE2 |
| `headset.magicVoice2.profiles.save` | 保存本地变声配置 | ikf-v11-pro-71 | planned | generic-only | H-MAGIC-VOICE2 |
| `headset.magicVoice2.profiles.reset` | 重置本地变声配置 | ikf-v11-pro-71 | planned | generic-only | H-MAGIC-VOICE2 |
| `headset.magicVoice2.pitchEstimation.start` | 开始个性化音高估计 | ikf-v11-pro-71 | disabled | generic-only | H-MAGIC-VOICE2 |
| `headset.magicVoice2.pitchEstimation.stop` | 停止个性化音高估计 | ikf-v11-pro-71 | disabled | generic-only | H-MAGIC-VOICE2 |
| `headset.listening.read` | 读取麦克风监听 | ikf-v11-pro-71 | unverified | generic-only | H-LISTENING |
| `headset.listening.set` | 设置麦克风监听 | ikf-v11-pro-71 | unverified | generic-only | H-LISTENING |
| `headset.listening.range` | 查询麦克风监听参数范围 | ikf-v11-pro-71 | unverified | generic-only | H-LISTENING |
| `headset.listening.contracts` | 查询麦克风监听静态契约 | ikf-v11-pro-71 | planned | generic-only | H-LISTENING |
| `headset.vigilance.read` | 读取监听警觉模式 | ikf-v11-pro-71 | unverified | generic-only | H-VIGILANCE |
| `headset.vigilance.set` | 设置监听警觉模式 | ikf-v11-pro-71 | unverified | generic-only | H-VIGILANCE |
| `headset.vigilance.range` | 查询监听警觉模式参数范围 | ikf-v11-pro-71 | unverified | generic-only | H-VIGILANCE |
| `headset.vigilance.contracts` | 查询监听警觉模式静态契约 | ikf-v11-pro-71 | planned | generic-only | H-VIGILANCE |
| `headset.headtracking.read` | 读取头部追踪与空间音效 | ikf-v11-pro-71 | unverified | generic-only | H-HEADTRACKING |
| `headset.headtracking.set` | 设置头部追踪与空间音效 | ikf-v11-pro-71 | unverified | generic-only | H-HEADTRACKING |
| `headset.headtracking.range` | 查询头部追踪与空间音效参数范围 | ikf-v11-pro-71 | unverified | generic-only | H-HEADTRACKING |
| `headset.headtracking.contracts` | 查询头部追踪与空间音效静态契约 | ikf-v11-pro-71 | planned | generic-only | H-HEADTRACKING |
| `headset.headtracking.orientation.read` | 读取头部姿态与位置 | ikf-v11-pro-71 | unverified | generic-only | H-HEADTRACKING |
| `headset.headtracking.recenter` | 重置头部追踪中心 | ikf-v11-pro-71 | unverified | generic-only | H-HEADTRACKING |
| `headset.headtracking.config.read` | 读取本地追踪参数 | ikf-v11-pro-71 | planned | generic-only | H-HEADTRACKING |
| `headset.headtracking.config.set` | 保存本地追踪参数 | ikf-v11-pro-71 | planned | generic-only | H-HEADTRACKING |
| `headset.device.detect` | 检测目标端点和设备身份 | ikf-v11-pro-71 | implemented | system-verified | H-DETECTION |
| `headset.device.info.read` | 读取耳机端点设备信息 | ikf-v11-pro-71 | implemented | system-verified | H-DETECTION |
| `headset.capabilities.read` | 读取已验证能力与许可类别 | ikf-v11-pro-71 | unverified | generic-only | H-CAPABILITIES |
| `headset.apo.binding.read` | 读取目标 APO 绑定证据 | ikf-v11-pro-71 | implemented | system-verified | H-APO |
| `headset.battery.read` | 读取电池与充电状态 | ikf-v11-pro-71 | unverified | generic-only | H-BATTERY |
| `headset.led.read` | 读取耳机灯光 | ikf-v11-pro-71 | unverified | generic-only | H-LED |
| `headset.led.set` | 设置耳机灯光 | ikf-v11-pro-71 | unverified | generic-only | H-LED |
| `headset.led.range` | 查询耳机灯光参数范围 | ikf-v11-pro-71 | unverified | generic-only | H-LED |
| `headset.led.contracts` | 查询耳机灯光静态契约 | ikf-v11-pro-71 | planned | generic-only | H-LED |
| `headset.led.systemLighting.read` | 读取系统动态灯光关联 | ikf-v11-pro-71 | unverified | generic-only | H-LED |
| `headset.firmware.info.read` | 读取固件身份与版本 | ikf-v11-pro-71 | unverified | generic-only | H-FIRMWARE |
| `headset.autoSwitch.list` | 列出应用自动切换规则 | ikf-v11-pro-71 | implemented | local-verified | H-AUTO-SWITCH |
| `headset.autoSwitch.save` | 保存应用自动切换规则 | ikf-v11-pro-71 | implemented | local-verified | H-AUTO-SWITCH |
| `headset.autoSwitch.delete` | 删除应用自动切换规则 | ikf-v11-pro-71 | implemented | local-verified | H-AUTO-SWITCH |
| `headset.autoSwitch.preview` | 预览应用匹配的耳机配置 | ikf-v11-pro-71 | implemented | local-verified | H-AUTO-SWITCH |
| `headset.autoSwitch.setEnabled` | 启停应用自动切换 | ikf-v11-pro-71 | implemented | local-verified | H-AUTO-SWITCH |
| `headset.autoSwitch.status` | 读取应用自动切换运行状态 | ikf-v11-pro-71 | implemented | local-verified | H-AUTO-SWITCH |
| `headset.autoSwitch.rebind` | 将失效自动切换规则回绑到现有配置 | ikf-v11-pro-71 | implemented | local-verified | H-AUTO-SWITCH |
| `headset.events.read` | 读取设备与效果变更事件 | ikf-v11-pro-71 | planned | generic-only | H-EVENTS |
| `headset.audio.controls.restore` | 恢复声道、会话、格式和默认角色快照 | ikf-v11-pro-71 | implemented | system-verified | H-AUDIO |
| `headset.effects.restore` | 恢复本应用修改前的耳机音效 | ikf-v11-pro-71 | implemented | hardware-verified | H-EQ, H-71, H-MIC-NR |
| `headset.master.read` | 读取端点总音效开关 | ikf-v11-pro-71 | implemented | target-confirmed | H-SDK |
| `headset.master.set` | 关闭或恢复端点音效组合 | ikf-v11-pro-71 | implemented | target-confirmed | H-SDK |
| `headset.master.restore` | 恢复总音效开关首次快照 | ikf-v11-pro-71 | implemented | target-confirmed | H-SDK |
| `headset.profiles.list` | 读取耳机全局配置与当前状态 | ikf-v11-pro-71 | implemented | target-confirmed | H-SDK |
| `headset.profiles.create` | 保存当前音效为新全局配置 | ikf-v11-pro-71 | implemented | target-confirmed | H-SDK |
| `headset.profiles.select` | 立即切换耳机全局配置 | ikf-v11-pro-71 | implemented | target-confirmed | H-SDK |
| `headset.profiles.delete` | 删除耳机全局配置 | ikf-v11-pro-71 | implemented | target-confirmed | H-SDK |
| `headset.audio.monitor.start` | 开始读取双端点实时状态 | ikf-v11-pro-71 | implemented | system-verified | H-AUDIO |
| `headset.audio.monitor.read` | 读取实时状态缓存 | ikf-v11-pro-71 | implemented | system-verified | H-AUDIO |
| `headset.audio.monitor.stop` | 停止实时状态读取 | ikf-v11-pro-71 | implemented | system-verified | H-AUDIO |
