'use strict';
const {S}=require('../schema.cjs');

// Declaration only: requiring this module never loads a vendor library or performs I/O.
// target-confirmed means the matching 0E6A:0110 MI_00 package configures the feature,
// NOT that this machine has the APO/license, or that hardware/DSP behavior is verified.
const devices=['ikf-v11-pro-71'];
const endpointId=S.string(2048),id=S.string(128),text=S.text(2048);
const rawInt=S.int(-2147483648,2147483647); // ABI bounds, never advertised DSP limits/dB.
const rawNumber=S.num();
const flow=S.enum(['render','capture']);
const evidence=S.enum(['target-confirmed','static-protocol','generic-only','hardware-verified','system-verified']);
const support=S.enum(['unknown','supported','unsupported','license-error','device-error','property-error']);
const source=S.enum(['static-contract','windows-system','sdk','windows-effect-store','property-store','local-profile']);
const endpoint=S.obj({id:endpointId,name:S.text(1024),flow,volume:S.num(0,100),muted:S.bool});
const endpointArgs=S.obj({endpointId});
const status={support,source,verified:S.bool};
const ack=S.obj({applied:S.bool,verified:S.bool,warnings:S.array(text,0,128)});
const out=[];
function add(id,title,effect,args,result,availability='unverified',ev='generic-only',auditIds=['H-SDK'],reason='仅有通用 SDK/UI 静态证据；V11 支持、范围、许可及实际回读未验证。'){
 out.push({id,devices:[...devices],title,effect,availability,evidence:ev,auditIds,args,result,reason});
}
// Every family has a closed field enum. No endpoint accepts arbitrary SDK property names.
// .range/.contracts are our API contracts, not an invented CmGetProperty range API.
function family(key,title,fields,ev,audit,reason,options={}){
 const base='headset.'+key;
 const names=Object.keys(fields);
 const field=S.enum(names);
 const state=S.obj(fields);
 const note=reason+' 未知数值均为 raw SDK/配置值，不换算为 dB、Hz、毫秒或角度；写入前须有已验证映射、范围、身份及回读。';
 add(base+'.read','读取'+title,'read',endpointArgs,S.obj({endpointId,...status,state:S.nullable(state)}),'unverified',ev,[audit],note);
 add(base+'.set','设置'+title,'write',S.obj({endpointId,state}),S.obj({endpointId,...status,state:S.nullable(state),applied:S.bool}),options.disabled?'disabled':'unverified',ev,[audit],note);
 add(base+'.range','查询'+title+'参数范围','read',endpointArgs,S.obj({endpointId,fields:S.array(S.obj({field,minimum:S.nullable(rawNumber),maximum:S.nullable(rawNumber),step:S.nullable(rawNumber),allowedRaw:S.array(S.union(rawNumber,S.bool,S.string(128)),0,256),unit:S.enum(['raw-sdk','boolean','unknown']),verified:S.bool,source,reason:text}),0,names.length)}),'unverified',ev,[audit],'这是本应用的范围查询；没有已证实的通用 SDK 范围属性。未知 min/max/step 返回 null，allowedRaw 空列表不表示任意值可写。'+reason);
 add(base+'.contracts','查询'+title+'静态契约','local',S.empty,S.obj({feature:S.enum([key]),evidence,fields:S.array(S.obj({field,sdkProperty:S.nullable(S.string(128)),storageKey:S.nullable(S.string(128)),valueType:S.enum(['int32','float','boolean','array','object','enum','unknown']),rangeKnown:S.bool,unit:S.enum(['raw-sdk','boolean','unknown']),reason:text}),0,names.length),warnings:S.array(text,0,128)}),'planned',ev,[audit],'静态元数据查询，尚未实现；字段名受固定枚举限制。'+reason);
}

// These three schemas/ids are fixed integration points implemented by main.
add('headset.audio.list','列出播放和录音端点','read',S.empty,S.obj({endpoints:S.array(endpoint,0,128)}),'implemented','system-verified',['H-AUDIO'],'由主进程 Windows 音频适配器实现；不表示厂商 DSP 功能已实现。');
add('headset.audio.set','设置端点音量与静音','write',S.obj({endpointId,volume:S.num(0,100),muted:S.bool},['endpointId']),endpoint,'implemented','system-verified',['H-AUDIO'],'由主进程实现；运行时另要求 volume/muted 至少一个，且端点属于目标设备。');
add('headset.audio.restore','恢复音频快照','write',S.empty,S.obj({restored:S.int(0,128),errors:S.array(S.text(2048),0,128)}),'implemented','system-verified',['H-AUDIO'],'由主进程恢复本应用保存的音量/静音快照；不恢复未实现的 DSP 效果。');

const audioFormat=S.obj({channels:rawInt,bitDepth:rawInt,sampleRate:rawInt});
add('headset.audio.format.read','读取端点默认格式','read',endpointArgs,S.obj({endpointId,...status,format:S.nullable(audioFormat)}),'unverified','generic-only',['H-FORMAT'],'DefaultFormat / CmDataAudioFormat；channels、bitDepth、sampleRate 均为 Int32。未证明目标可选格式。');
add('headset.audio.format.list','查询端点可用格式','read',endpointArgs,S.obj({endpointId,...status,formats:S.array(audioFormat,0,256)}),'unverified','generic-only',['H-FORMAT'],'官方 JackSetting 与 DefaultBitDepth/DefaultChannels/DefaultSampleRates 静态资源；组合必须逐项验证，不能做笛卡尔积推断支持。');
add('headset.audio.format.set','设置端点默认格式','write',S.obj({endpointId,format:audioFormat}),ack,'unverified','generic-only',['H-FORMAT'],'仅接受已针对该端点验证的格式，尚未实现。');
family('audio.balance','左右平衡',{leftRaw:rawNumber,rightRaw:rawNumber},'generic-only','H-BALANCE','PanelBalance 使用 VolumeLevelScalar 和 ChannelVolume；不是单独的 Balance SDK 属性。');
family('audio.channels','声道音量',{channels:S.array(S.obj({channelRaw:rawInt,volumeRaw:rawNumber}),1,128)},'generic-only','H-CHANNELS','ChannelCount、VolumeLevel/VolumeLevelScalar、CmDataChannelVolume；声道编号和音量单位需对应端点契约。');
add('headset.audio.volume.range','查询端点原始音量范围','read',endpointArgs,S.obj({endpointId,...status,minimumRaw:S.nullable(rawNumber),maximumRaw:S.nullable(rawNumber),stepRaw:S.nullable(rawNumber)}),'unverified','generic-only',['H-AUDIO'],'SDK VolumeRange 和 CmDataRangeFloat 有静态证据；与主进程 0–100 百分比音量区分。');
add('headset.audio.peak.read','读取端点峰值','read',endpointArgs,S.obj({endpointId,...status,valuesRaw:S.nullable(S.array(rawNumber,0,128))}),'unverified','generic-only',['H-PEAK'],'PanelPeakMeter / PeakValue；未知刻度不当作 dB。');
const session=S.obj({sessionId:endpointId,processId:S.nullable(S.int(0,4294967295)),description:S.text(2048),active:S.nullable(S.bool),volume:S.num(0,100),muted:S.bool});
add('headset.audio.sessions.list','列出端点音频会话','read',endpointArgs,S.obj({endpointId,...status,sessions:S.array(session,0,1024)}),'unverified','generic-only',['H-SESSION'],'SessionInstanceID、SessionProcessID、SessionProcessDescription、IsSessionActive；不假定 SDK 支持按会话写音量。');
add('headset.audio.sessions.set','设置会话音量与静音','write',S.obj({endpointId,sessionId:endpointId,volume:S.num(0,100),muted:S.bool},['endpointId','sessionId']),S.obj({sessionId:endpointId,volume:S.num(0,100),muted:S.bool,verified:S.bool}),'planned','generic-only',['H-SESSION'],'拟由 Windows 会话适配器实现；须核实会话属于端点且至少一个修改字段，SDK setter 未确认。');
add('headset.audio.default.read','读取默认端点角色','read',endpointArgs,S.obj({endpointId,...status,roles:S.array(S.enum(['multimedia','communications']),0,2)}),'unverified','generic-only',['H-DEFAULT'],'DefaultDevice 与 CmDefaultRole：Multimedia=1、Communication=2；不混同 Windows 其他 role 编码。');
add('headset.audio.default.set','设置默认端点角色','write',S.obj({endpointId,role:S.enum(['multimedia','communications'])}),ack,'unverified','generic-only',['H-DEFAULT'],'官方 JackSetting 有默认/通信设备选择；目标行为尚未验证。');
add('headset.audio.channelTest.start','开始指定声道试听','write',S.obj({endpointId,channel:S.enum(['LF','RF','C','LFE','LS','RS','LB','RB'])}),S.obj({sessionId:id,started:S.bool}),'planned','generic-only',['H-CHANNELS'],'官方 7.1 UI 有八声道测试；播放声音属于输出操作，尚未实现，也不据此证明物理八声道。');
add('headset.audio.channelTest.stop','停止声道试听','write',S.obj({endpointId,sessionId:id}),S.obj({stopped:S.bool}),'planned','generic-only',['H-CHANNELS'],'停止本应用创建的试听会话。');

const tenBands=S.array(rawInt,10,10);
family('eq','播放十段 EQ',{enabled:S.bool,bandsRaw:tenBands},'target-confirmed','H-EQ','目标 INF 播放 MFX：Enable_EQ_GFX / EQ_Slider1…10；EQViewModel 0x0600031a / 0x060002e0；没有频点/dB比例或有效上下限证据。');
family('mic.eq','录音十段 EQ',{enabled:S.bool,bandsRaw:tenBands},'generic-only','H-MIC-EQ','MicEQ_Enable 与 MicEQ_Slider1…10 在 SDK/通用 UI 中存在；目标 INF 只明确配置 MicEQ 开关、滤波及前级，不足以确认 V11 的十个滑块。');
family('mic.eq.filters','录音 EQ 滤波与前级',{enabled:S.bool,lowPassEnabled:S.bool,lowPassCutoffRaw:rawInt,highPassEnabled:S.bool,highPassCutoffRaw:rawInt,preGainRaw:rawInt},'target-confirmed','H-MIC-FILTERS','目标 INF CAPTURE_MICEQ_ENABLE/LPF_ENABLE/LPF_FC/HPF_ENABLE/HPF_FC/PREGAIN；SDK MicEQ_* 名称存在。');
const preset=S.obj({id,name:S.text(128),flow,origin:S.enum(['official','user']),bandsRaw:tenBands,enabled:S.bool});
add('headset.eq.presets.list','列出播放或录音 EQ 预设','local',S.obj({flow}),S.obj({presets:S.array(preset,0,256)}),'planned','generic-only',['H-EQ-PRESETS'],'官方 EQPreset.json 有播放预设 Index 0…11，每项恰好10值；不推断其为 dB，也不自动作为录音官方预设。录音用户预设是本地 API 设计。');
add('headset.eq.presets.create','按官方流程另存当前 EQ 设定档','local',S.obj({name:S.text(128),bandsRaw:S.array(S.int(-20,20),10,10)}),S.obj({preset}),'implemented','local-verified',['H-EQ-PRESETS'],'总是追加当前十段增益；空名称在同一存储事务内取首个可用Profile n，同名不覆盖。只保存本地配置，不改变音效启用状态。');
add('headset.eq.presets.save','保存本地 EQ 预设','local',S.obj({preset}),S.obj({saved:S.bool}),'planned','generic-only',['H-EQ-PRESETS'],'保存结构化本地预设不表示已应用到设备；不允许传文件路径。');
add('headset.eq.presets.delete','删除本地用户 EQ 预设','local',S.obj({presetId:id,flow}),S.obj({deleted:S.bool}),'planned','generic-only',['H-EQ-PRESETS'],'仅可删除用户预设，官方静态资源只读。');
add('headset.eq.presets.apply','应用 EQ 预设','write',S.obj({endpointId,flow,presetId:id}),ack,'unverified','generic-only',['H-EQ-PRESETS'],'按端点方向解析预设并验证全部十段范围；目标录音十段能力尚未确认。');
add('headset.eq.presets.export','导出本地 EQ 预设','local',S.obj({presetId:id,flow}),S.obj({preset}),'planned','generic-only',['H-EQ-PRESETS']);
add('headset.eq.presets.official.import','导入原厂自定义 EQ 列表','local',S.obj({content:S.text(524288)}),S.obj({imported:S.int(0,244),presetIds:S.array(id,0,244),warnings:S.array(text,0,128)}),'implemented','local-verified',['H-EQ-PRESETS'],'读取EQCustom.json的Name/EQValues列表，完整校验后原子追加；保留顺序与同名，失败不改已有配置，不访问设备或官方存储。');
add('headset.eq.presets.official.export','导出原厂自定义 EQ 列表','local',S.empty,S.obj({content:S.text(524288),suggestedName:S.string(128),count:S.int(0,244)}),'implemented','local-verified',['H-EQ-PRESETS'],'按EQCustom.json的Name/EQValues格式导出全部播放用户档；不包含官方预设和录音档，保留顺序与同名，不改变设备。');
add('headset.eq.presets.import','导入结构化 EQ 预设','local',S.obj({preset}),S.obj({saved:S.bool,warnings:S.array(text,0,128)}),'planned','generic-only',['H-EQ-PRESETS']);

family('surround71','7.1 耳机环绕',{enabled:S.bool,modeRaw:S.enum([0,1]),roomSizeRaw:S.enum([0,1,2])},'target-confirmed','H-71','Enable_CONLAB_HPSPK_LFX / CONLAB_HPSPK_MODE / ROOMSIZE；0x060003dc：mode 0音乐游戏/1电影，room 0大/1中/2小；UI 点击还写 HID，不能复用为只读。');
family('virtualSpeaker','八声道虚拟扬声器位置',{enabled:S.bool,speakers:S.array(S.obj({channel:S.enum(['LF','C','RF','RS','RB','LB','LS','LFE']),angleRaw:rawInt,distanceRaw:rawInt}),8,8)},'target-confirmed','H-VSS','Enable_SS_LFX 与 SS_{LF,C,RF,RS,RB,LB,LS,LFE}_{ANGLE,DIST}；八项需声道唯一且完整，不能用静态默认值推断范围。');
add('headset.virtualSpeaker.rotate','旋转虚拟扬声器','write',S.obj({endpointId,direction:S.enum(['clockwise','counterclockwise']),mode:S.enum(['continuous','step']),stepRaw:rawInt}),ack,'unverified','target-confirmed',['H-VSS'],'官方 VSS UI 旋转/手动位置资源；需将旋转换算为已验证的八个位置，并保存可恢复快照。');
add('headset.virtualSpeaker.stop','停止虚拟扬声器旋转','write',endpointArgs,ack,'unverified','target-confirmed',['H-VSS'],'停止本应用的旋转任务；没有臆造 SDK stop 属性。');
family('surroundMax','Surround Max',{enabled:S.bool},'target-confirmed','H-SURROUND-MAX','Enable_Channel_COPY_LFX；与7.1及虚拟扬声器是三个独立效果。');
family('bass','低音管理',{enabled:S.bool,frequencyRaw:rawInt,bassLevelRaw:rawInt,largeSpeakerRaw:rawInt},'generic-only','H-BASS','原生 SDK 静态字符串 Enable_BM_GFX / BM_Slider_Frequency / BM_Slider_BassLevel / BM_LargeSpeaker；目标 INF 未配置低音管理。');
family('brilliant','Xear Audio Brilliant',{enabled:S.bool,levelRaw:rawInt},'target-confirmed','H-BRILLIANT','目标播放 SFX：Enable_AUDIOBRILLIANT_LFX / AUDIOBRILLIANT_LEVEL。');
family('dynamicBass','Xear Dynamic Bass',{enabled:S.bool,modeRaw:rawInt,levelRaw:rawInt,cutoffRaw:rawInt},'target-confirmed','H-DYNAMIC-BASS','目标播放 SFX：Enable_VIRTUALBASS_LFX / VIRTUALBASS_Mode / Level / CutOffFrequency；与 BM 低音管理区分。');
family('dynamicBass.highPass','动态低音高通',{cutoffRaw:rawInt},'target-confirmed','H-DYNAMIC-BASS','目标 INF 有 VIRTUALBASS_HPFCutOffFrequency；现有 SDK 静态字符串/托管调用没有确认该属性名，不能直接按 INF 名发 SDK setter。');
family('voiceClarity','Xear Voice Clarity',{enabled:S.bool,levelRaw:rawInt,noiseSuppressionRaw:rawInt},'target-confirmed','H-VOICE-CLARITY','Enable_VOICECLARITY_LFX / VOICECLARITY_LEVEL / VOICECLARITY_NOISESUPP_LEVEL；目标播放 SFX。');
family('smartVolume','Xear Smart Volume',{enabled:S.bool,levelRaw:rawInt,modeRaw:rawInt},'target-confirmed','H-SMART-VOLUME','Enable_ADAPTIVEVOLUME_GFX / ADAPTIVEVOLUME_LEVEL / MODE；目标播放 MFX。');
family('vocalFading','人声消除',{enabled:S.bool,levelRaw:rawInt},'target-confirmed','H-VOCAL-FADING','Enable_VOCALCANCEL_GFX / VOCALCANCEL_LEVEL；目标播放 MFX。');
family('keyShift','升降调',{enabled:S.bool,levelRaw:rawInt},'target-confirmed','H-KEY-SHIFT','Enable_KEYSHIFT_GFX / KEYSHIFT_LEVEL；不假设原始整数等于半音。');
family('mic.echo','麦克风回声',{enabled:S.bool,levelRaw:rawInt},'target-confirmed','H-ECHO','Enable_MICECHO / MICECHO_Level；目标录音 MFX。');
family('mic.magicVoice','传统变声',{enabled:S.bool,selectionRaw:rawInt},'target-confirmed','H-MAGIC-VOICE','Enable_MAGICVOICE / MagicVoice_Selection；官方 UI Monster/Cartoon/Man/Woman 标签不构成完整数值映射。');
family('environment','环境音效',{enabled:S.bool,environmentRaw:rawInt,roomSizeRaw:rawInt},'generic-only','H-ENVIRONMENT','Enable_RFX_GFX / RFX_ENVIRONMENT / RFX_ROOMSIZE 与环境名称语言资源；目标 INF 未配置。');
family('playback.nr','播放非 AI 降噪',{enabled:S.bool,levelRaw:rawInt},'generic-only','H-PLAYBACK-NR','通用包只明确发现 AI_Playback_NR_* 播放路径；非 AI 播放 NR 尚无独立映射，禁止映射到录音 NR_Enable。',{disabled:true});
family('mic.nr','麦克风降噪',{enabled:S.bool,levelRaw:rawInt},'target-confirmed','H-MIC-NR','目标 CAPTURE_NR_ENABLE/LEVEL；SDK NR_Enable / NR_Level。');
family('mic.hdNr','麦克风 HD 降噪',{enabled:S.bool},'generic-only','H-HD-NR','HD_NR_Enable 与 CLC_HDNoiseReduction=2；目标 INF 未配置此通用效果。');
family('mic.aec','麦克风回声消除',{enabled:S.bool,levelRaw:rawInt,delayRaw:rawInt},'target-confirmed','H-AEC','CAPTURE_AEC_ENABLE/LEVEL/DELAYTIME；SDK AEC_Enable/Level/DelayTime；不暴露 AEC_DUMP_Enable 录音转储写入。');
family('mic.array','麦克风阵列',{enabled:S.bool,levelRaw:rawInt,micDistanceRaw:rawInt,beamWidthRaw:rawInt},'target-confirmed','H-ARRAY','目标 CAPTURE_MICARRAY_*；SDK MicArray_Enable/Level/MicDist/BeamWidth。INF 配置不证明 V11 有多麦物理阵列。');
family('mic.agc','麦克风自动增益上限',{maxGainRaw:rawInt},'generic-only','H-AGC','原生 SDK AI_AGC_MaxGain；未找到独立 AGC_Enable，不编造开关；目标 INF 未配置。');
family('playback.agc','播放自动增益上限',{maxGainRaw:rawInt},'generic-only','H-AGC','原生 SDK AI_Playback_AGC_MaxGain；未找到独立开关或目标配置。');
family('mic.antiClipping','麦克风防削波',{enabled:S.bool,decayRateRaw:rawInt,maxGainRaw:rawInt},'target-confirmed','H-ANTI-CLIPPING','目标 CAPTURE_DRC_*；SDK MicDRC_Enable/DecayRate/MaxGain；不混同 Compressor。');
family('mic.compressor','录音压缩器',{enabled:S.bool,thresholdRaw:rawNumber,kneeWidthRaw:rawNumber,ratioRaw:rawNumber,attackRaw:rawNumber,releaseRaw:rawNumber,makeUpGainRaw:rawNumber},'generic-only','H-COMPRESSOR','Compressor_Enable/Threshold/KneeWidth/Ratio/AttackTime/ReleaseTime/MakeUpGain；数值 ABI/单位需逐项验证，目标 INF 未配置。');
family('mic.noiseGate','录音噪声门',{enabled:S.bool,thresholdRaw:rawNumber,maxReductionRaw:rawNumber,attackRaw:rawNumber,releaseRaw:rawNumber},'generic-only','H-NOISE-GATE','NoiseGate_Enable/Threshold/MaxNR/AttackTime/ReleaseTime；CLC_NoiseGate=9，目标 INF 未配置。');
family('mic.ldr','远距离录音组合模式',{mode:S.enum(['off','aiNoiseReduction','compressor','longDistanceRecording'])},'generic-only','H-LDR','RecordingEffectHandler 0x06000418 组合 NR/HD_NR/AI_NR/Compressor；CLC_LDR=10，不存在已证实的 LDR_Enable 字符串，须恢复完整组合。');
family('playback.limiter','播放 VRMS 限幅',{enabled:S.bool,levelRaw:rawInt,attackRaw:rawInt,releaseRaw:rawInt,preGainRaw:rawInt},'target-confirmed','H-LIMITER','目标 INF RENDER_VRMSLIMITER_ENABLE/LEVEL/ATTACK/RELEASE/PREGAIN；SDK 属性字符串映射未确认，不能据 INF 名直接写。');
family('ai.nr.playback','AI 播放降噪',{enabled:S.bool,levelRaw:rawInt},'generic-only','H-AI-NR','AI_Playback_NR_Enable/Level；通用 UI AINRPlayback，V11 目标 INF 未配置 AI NR。');
family('ai.nr.mic','AI 麦克风降噪',{enabled:S.bool,levelRaw:rawInt},'generic-only','H-AI-NR','AI_NR_Enable/Level；通用 UI AINRCapture，许可 CLC_AINoiseReduction=3 不等于目标已许可。');
family('ai.aec','AI 回声消除',{enabled:S.bool,delayRaw:rawInt},'generic-only','H-AI-AEC','AI_AEC_Enable/DelayTime；MagicVoice2 通用调用包含该效果，目标支持未确认。');
family('ai.array','AI 麦克风阵列',{enabled:S.bool,micDistanceRaw:rawInt,beamWidthRaw:rawInt},'generic-only','H-AI-ARRAY','原生 SDK AI_MicArray_Enable/MicDist/BeamWidth；目标配置未确认。');
family('ai.voice','AI 变声',{enabled:S.bool,targetIndexRaw:rawInt,pitchRaw:rawInt},'generic-only','H-AI-VOICE','AI_MagicVoice_Enable/TargetIndex/Pitch；目标音色模型及许可未确认；不暴露 DebugMode/InfMode 等诊断写入。');
family('magicVoice2','Magic Voice II',{enabled:S.bool,target:S.enum(['man-ai','woman-ai','boy-ai','girl-ai','cartoon','monster','man','woman']),pitchRaw:rawInt,profileId:id},'generic-only','H-MAGIC-VOICE2','官方 MagicVoice2Handler/UI、语言资源与个性化音高估计流程；这是复合功能，不能臆造 MagicVoice2_Enable SDK 属性。');
const voiceProfile=S.obj({id,name:S.text(128),target:S.string(128),pitchRaw:rawInt});
add('headset.magicVoice2.targets.list','列出可用变声音色模型','read',endpointArgs,S.obj({endpointId,...status,targets:S.array(S.obj({id,name:S.text(128),available:S.bool}),0,256)}),'unverified','generic-only',['H-MAGIC-VOICE2'],'AiMagicVoice 读取 TargetVoices JSON 模型目录；包内未发现该 JSON/模型，不能把资源标签当成已可用模型。');
add('headset.magicVoice2.profiles.list','列出本地变声配置','local',S.empty,S.obj({profiles:S.array(voiceProfile,0,128)}),'planned','generic-only',['H-MAGIC-VOICE2']);
add('headset.magicVoice2.profiles.save','保存本地变声配置','local',S.obj({profile:voiceProfile}),S.obj({saved:S.bool}),'planned','generic-only',['H-MAGIC-VOICE2']);
add('headset.magicVoice2.profiles.reset','重置本地变声配置','local',S.obj({profileId:id}),S.obj({reset:S.bool}),'planned','generic-only',['H-MAGIC-VOICE2']);
add('headset.magicVoice2.pitchEstimation.start','开始个性化音高估计','write',endpointArgs,S.obj({sessionId:id,started:S.bool}),'disabled','generic-only',['H-MAGIC-VOICE2'],'官方 UI 有朗读采样流程；会启动录音与模型处理，尚无受限适配器/生命周期契约。');
add('headset.magicVoice2.pitchEstimation.stop','停止个性化音高估计','write',S.obj({endpointId,sessionId:id}),S.obj({stopped:S.bool,pitchRaw:S.nullable(rawInt)}),'disabled','generic-only',['H-MAGIC-VOICE2'],'只可停止本应用创建的采样会话；不返回录音内容。');
family('listening','麦克风监听',{enabled:S.bool,outputEndpointId:S.nullable(endpointId)},'generic-only','H-LISTENING','MagicVoiceII ListenToYourVoice/VoiceMonitor UI 与本地设置；监听可能走 Windows/NAudio，未发现独立 Listening SDK 属性。');
family('vigilance','监听警觉模式',{enabled:S.bool,modeRaw:rawInt},'generic-only','H-VIGILANCE','VigilanceModeControl 与 SDK CmDataVigilanceMode；与麦克风监听分开，目标支持未确认。');
family('headtracking','头部追踪与空间音效',{enabled:S.bool,orientationEnabled:S.bool,reverbEnabled:S.bool,algorithmRaw:rawInt,roomSizeRaw:rawInt,reverbConfigRaw:rawInt,autoResetDetectTimeRaw:rawNumber},'generic-only','H-HEADTRACKING','HeadTracking_* SDK/UI/JSON；JSON FWVid=0D8C、FWPid=0337 与目标 0E6A:0110 不同，不证明 V11 有追踪传感器。');
add('headset.headtracking.orientation.read','读取头部姿态与位置','read',endpointArgs,S.obj({endpointId,...status,orientation:S.nullable(S.obj({yawRaw:rawNumber,pitchRaw:rawNumber,rollRaw:rawNumber})),position:S.nullable(S.obj({frontRaw:rawNumber,topRaw:rawNumber,rightRaw:rawNumber}))}),'unverified','generic-only',['H-HEADTRACKING'],'HeadTracking_OrientationYaw/Pitch/Roll、PositionFront/Top/Right 静态字符串；不假定原始单位。');
add('headset.headtracking.recenter','重置头部追踪中心','write',endpointArgs,ack,'unverified','generic-only',['H-HEADTRACKING'],'HeadTracking_Reset / Re-Center；目标传感器、HID 路径和回读未验证。');
add('headset.headtracking.config.read','读取本地追踪参数','local',S.empty,S.obj({detectionTimeRaw:rawNumber,fadingTimeRaw:rawNumber,yawShiftThresholdRaw:rawNumber,yawPathThresholdRaw:rawNumber,autoReset:S.bool,hotKeyRaw:rawInt,batteryThresholdRaw:rawInt}),'planned','generic-only',['H-HEADTRACKING'],'对应官方 HeadTracking.json 配置字段；不把固件 VID/PID 作为客户端可修改目标。');
add('headset.headtracking.config.set','保存本地追踪参数','local',S.obj({detectionTimeRaw:rawNumber,fadingTimeRaw:rawNumber,yawShiftThresholdRaw:rawNumber,yawPathThresholdRaw:rawNumber,autoReset:S.bool,hotKeyRaw:rawInt,batteryThresholdRaw:rawInt}),S.obj({saved:S.bool}),'planned','generic-only',['H-HEADTRACKING'],'本地配置值有效范围尚待确认；保存后不能自动触发设备写入。');

add('headset.device.detect','检测目标端点和设备身份','read',S.empty,S.obj({devices:S.array(S.obj({endpointId,sdkUid:S.nullable(S.string(64)),instanceId:S.string(2048),usbInstanceId:S.nullable(S.string(2048)),vendorId:S.int(0,65535),productId:S.int(0,65535),flow,matchedTarget:S.bool}),0,128)}),'planned','target-confirmed',['H-DETECTION'],'目标 INF 匹配 USB VID_0E6A PID_0110 MI_00；SDK UID 必须通过 EndpointID/InstanceID/USBDeviceInstanceID 关联，不能假定等于 IMMDevice ID GUID。');
add('headset.device.info.read','读取耳机端点设备信息','read',endpointArgs,S.obj({endpointId,...status,displayName:S.nullable(S.text(1024)),controllerName:S.nullable(S.text(1024)),driverVersion:S.nullable(S.text(128)),usbRevisionRaw:S.nullable(rawInt),jackTypeRaw:S.nullable(rawInt),channelCountRaw:S.nullable(rawInt)}),'unverified','generic-only',['H-DETECTION'],'DriverInstance.RebuildDevice 0x06000528；DisplayName/ControllerDisplayName/DriverVersion/USBRevisionNumber/JackType/ChannelCount。');
add('headset.capabilities.read','读取已验证能力与许可类别','read',endpointArgs,S.obj({endpointId,...status,licenseCategoriesRaw:S.nullable(S.array(rawInt,0,128)),features:S.array(S.obj({featureId:S.string(128),evidence,support,writable:S.bool,reason:text}),0,256)}),'unverified','generic-only',['H-CAPABILITIES'],'SupportedLicenseCategory 是 Int32 数组；每个功能仍需目标与回读证据，不提供许可证激活/绕过接口。没有 SupportedProperties 通用属性。');
add('headset.apo.binding.read','读取目标 APO 绑定证据','read',endpointArgs,S.obj({endpointId,extensionMatched:S.nullable(S.bool),apoAttached:S.nullable(S.bool),licenseState:S.enum(['unknown','available','unavailable']),contexts:S.array(S.obj({stage:S.enum(['SFX','MFX','EFX']),contextId:S.string(64)}),0,16),warnings:S.array(text,0,128)}),'planned','target-confirmed',['H-APO'],'目标 INF 配置 CM002X1&CMEDIA&CMAPO_ICE；Windows 11 CAPX 与旧 FX 路径不同。Microsoft USB function driver 不排除厂商 APO。');
add('headset.battery.read','读取电池与充电状态','read',endpointArgs,S.obj({endpointId,...status,percent:S.nullable(S.num(0,100)),charging:S.nullable(S.bool),connected:S.nullable(S.bool),batteryRaw:S.nullable(rawInt)}),'unverified','generic-only',['H-BATTERY'],'PanelBattery、BatteryLevel/BatteryStatus、HID 回调资源存在；未确认目标读取协议，未知不能显示为0%或未充电。');
family('led','耳机灯光',{enabled:S.bool,modeRaw:rawInt,brightnessRaw:rawInt,color:S.obj({r:S.int(0,255),g:S.int(0,255),b:S.int(0,255)})},'generic-only','H-LED','LEDControl、CMediaLEDObj、Constant/Blink/Breathe/Heart Beat 语言资源；V11 LED 协议、模式映射及亮度范围未验证。');
add('headset.led.systemLighting.read','读取系统动态灯光关联','read',endpointArgs,S.obj({endpointId,...status,systemManaged:S.nullable(S.bool)}),'unverified','generic-only',['H-LED'],'CCT_SystemDynamicLighting 回调枚举存在；不证明 V11 有 Windows Dynamic Lighting 支持。');
add('headset.firmware.info.read','读取固件身份与版本','read',endpointArgs,S.obj({endpointId,...status,model:S.nullable(S.text(128)),version:S.nullable(S.text(128)),typeRaw:S.nullable(rawInt)}),'unverified','generic-only',['H-FIRMWARE'],'仅保留只读版本信息查询；本应用不提供固件文件检查或更新入口。USB revision 不是已验证固件语义版本。');
const switchRule=S.obj({widgetName:S.string(256),appPath:S.text(2048),bindingProfileName:S.string(128),icon:S.text(256)});
add('headset.autoSwitch.list','列出应用自动切换规则','local',S.empty,S.obj({enabled:S.bool,rules:S.array(switchRule,0,256)}),'implemented','local-verified',['H-AUTO-SWITCH'],'本地规则管理与显式启停的自建前台观察器；不与原厂规则文件互通。');
add('headset.autoSwitch.save','保存应用自动切换规则','local',S.obj({rule:switchRule,previousApplicationId:S.text(2048)},['rule']),S.obj({saved:S.bool}),'implemented','local-verified',['H-AUTO-SWITCH'],'只持久化原厂四字段规则；完整Windows路径按原厂全字符串比较，不加载图标、不触发设备配置。');
add('headset.autoSwitch.delete','删除应用自动切换规则','local',S.obj({applicationId:S.text(2048)}),S.obj({deleted:S.bool}),'implemented','local-verified',['H-AUTO-SWITCH'],'按完整appPath删除本地规则；不删除未知图标文件，不触发设备操作。');
add('headset.autoSwitch.preview','预览应用匹配的耳机配置','local',S.obj({applicationId:S.text(2048)}),S.obj({enabled:S.bool,matched:S.bool,rule:S.nullable(switchRule)}),'implemented','local-verified',['H-AUTO-SWITCH'],'按完整路径String相等预览首条规则，不应用配置；不启动前台监听。');
add('headset.autoSwitch.setEnabled','启停应用自动切换','write',S.obj({enabled:S.bool,endpointIds:S.array(endpointId,1,2)},['enabled']),S.obj({enabled:S.bool}),'implemented','local-verified',['H-AUTO-SWITCH'],'每次启动需显式启用并核对目标端点；自建Windows前台事件钩子复制完整EXE路径与PID，观察器不加载原厂SDK；500ms稳定后按路径精确匹配，再排队到既有串行配置事务。暂停/恢复/退出注销钩子并等待线程结束，恢复时核对当前前台；失败停用，不自动持久启用。真实音效自动切换仍需独立验收。');
add('headset.autoSwitch.status','读取应用自动切换运行状态','local',S.empty,S.obj({enabled:S.bool,state:S.enum(['disabled','starting','watching','applying','error']),source:S.enum(['windows-foreground']),endpointIds:S.array(endpointId,0,2),foregroundPath:S.nullable(S.text(2048)),lastMatchedPath:S.nullable(S.text(2048)),lastProfileName:S.nullable(S.string(128)),lastAppliedAt:S.nullable(S.string(64)),lastError:S.nullable(S.text(2048))}),'implemented','local-verified',['H-AUTO-SWITCH'],'报告自建Windows前台事件观察器的规则状态和最近配置事务读回；启用/恢复时的Win32对账与钩子事件分别标识，不代表声学效果已实测。');
add('headset.autoSwitch.rebind','将失效自动切换规则回绑到现有配置','local',S.obj({profileName:S.string(128),fallbackProfileName:S.string(128)}),S.obj({updated:S.int(0,256)}),'implemented','local-verified',['H-AUTO-SWITCH'],'删除全局配置后显式持久化规则回绑；不启动前台监听、不应用音效。');

add('headset.events.read','读取设备与效果变更事件','read',S.obj({cursor:S.nullable(id)}),S.obj({nextCursor:S.nullable(id),events:S.array(S.obj({kind:S.enum(['deviceState','defaultDevice','defaultFormat','deviceVolume','effectValue','audioSession','systemDynamicLighting','foreground']),endpointId:S.nullable(endpointId),occurredAt:S.string(64)}),0,256)}),'planned','generic-only',['H-EVENTS'],'CmCallbackType 静态枚举；只定义应用事件队列，不注册 vendor 回调或暴露指针。');

for(const entry of out){
 if(['headset.eq.presets.list','headset.eq.presets.save','headset.eq.presets.delete','headset.eq.presets.import','headset.eq.presets.export'].includes(entry.id)){
  entry.availability='implemented';entry.evidence='local-verified';entry.reason='本地预设管理已实现：保留12项官方播放原始数组，用户预设按方向保存；不会应用到音频设备。';
 }
}
for(const entry of out){
 if(['headset.device.detect','headset.device.info.read','headset.apo.binding.read'].includes(entry.id)){
  entry.availability='implemented';entry.evidence='system-verified';entry.reason='只读Windows端点/PnP身份和效果属性存储，精确匹配0E6A:0110 MI00；不加载原厂SDK，不推断实时DSP或许可就绪。';
  if(entry.id==='headset.device.detect')entry.result=S.obj({...entry.result.properties,warnings:S.array(text,0,128),observedAt:S.string(64)});
  if(entry.id==='headset.device.info.read')entry.result=S.obj({...entry.result.properties,driverProvider:S.nullable(S.text(256)),driverInf:S.nullable(S.text(256)),identityVerified:S.bool,warnings:S.array(text,0,128)});
  if(entry.id==='headset.apo.binding.read')entry.result=S.obj({...entry.result.properties,attachmentEvidence:S.enum(['configured','partial','not-observed','unknown']),configuredClsids:S.array(S.string(64),0,16),source:S.enum(['property-store'])});
 }
}
add('headset.audio.controls.restore','恢复声道、会话、格式和默认角色快照','write',S.empty,S.obj({restored:S.int(0,256),errors:S.array(text,0,256)}),'implemented','system-verified',['H-AUDIO'],'先恢复未完成操作前状态，再恢复首次快照；验证当前USB身份，已结束的会话会明确报错并保留记录。');
for(const entry of out)if(['headset.audio.balance.read','headset.audio.balance.set','headset.audio.channels.read','headset.audio.channels.set','headset.audio.peak.read','headset.audio.sessions.list','headset.audio.sessions.set','headset.audio.format.read','headset.audio.format.list','headset.audio.format.set','headset.audio.default.read','headset.audio.default.set'].includes(entry.id)){entry.availability='implemented';entry.evidence='system-verified';entry.reason='自建Windows CoreAudio与已核对的Windows音频策略接口；端点USB身份核验、持久化事务、写后读回和失败回滚。不加载厂商SDK。声道值为0..1，平衡仅适用两个音量声道；格式查询固定180个独占PCM候选，完整原始波形恢复；默认设备同时验证console/multimedia联动且保留communications，恢复保存全部三个角色。';}
const presetApply=out.find(c=>c.id==='headset.eq.presets.apply');presetApply.availability='implemented';presetApply.evidence='hardware-verified';presetApply.reason='播放预设解析本地/官方数组后，检查十段−20至20dB并调用Windows音效属性EQ事务和原始值恢复；不加载厂商SDK。录音十段未确认，明确拒绝。';
// Promote only the existing read contract; never add AEC to writable effect families.
const aecRead=out.find(entry=>entry.id==='headset.mic.aec.read');
aecRead.title='读取麦克风回声消除诊断状态';
aecRead.availability='implemented';aecRead.evidence='target-confirmed';
aecRead.result=S.obj({endpointId,support:S.enum(['supported']),source:S.enum(['windows-effect-store']),verified:S.enum([true]),state:S.obj({enabled:S.bool,levelRaw:rawInt,delayRaw:rawInt})});
aecRead.reason='通过Windows音效属性存储只读目标录音端点三个AEC原始值；不加载厂商SDK，不开放setter，不推断范围、单位或声学效果。';
const liveEffects=['eq','surround71','brilliant','dynamicBass','smartVolume','voiceClarity','surroundMax','mic.magicVoice','mic.nr'];
for(const entry of out){
 if(liveEffects.some(key=>entry.id==='headset.'+key+'.read'||entry.id==='headset.'+key+'.set')){
  entry.availability='implemented';entry.evidence='hardware-verified';entry.reason='通过Windows音效属性存储直接控制目标iKF端点；无厂商SDK的正式Bridge已逐族实测修改、31个原始DWORD/类型读回和精确恢复。系统仍需匹配的已签名音频驱动/APO，属性读回不等于声学效果或卸载后验收。写入限制在官方UI已确认范围；动态低频modeRaw仅保留读值。';
 }
}
add('headset.effects.restore','恢复本应用修改前的耳机音效','write',S.empty,S.obj({restored:S.int(0,256),errors:S.array(text,0,256)}),'implemented','hardware-verified',['H-EQ','H-71','H-MIC-NR'],'按端点与USB设备身份恢复首次保存的九项音效快照；中断记录优先恢复本次操作前值。每项恢复后重新读取。');
const masterState=S.obj({enabled:S.bool,effects:S.array(S.obj({feature:S.enum(liveEffects),enabled:S.bool}),1,9)});
const masterResult={endpointId,support:S.enum(['supported']),source:S.enum(['sdk','windows-effect-store']),verified:S.enum([true]),state:masterState,recoveryPending:S.bool,canRestore:S.bool};
for(const [suffix,title,args,extra]of [['read','读取端点总音效开关',endpointArgs,{}],['set','关闭或恢复端点音效组合',S.obj({endpointId,enabled:S.bool}),{applied:S.enum([true])}],['restore','恢复总音效开关首次快照',endpointArgs,{restored:S.bool}]])add('headset.master.'+suffix,title,suffix==='read'?'read':'write',args,S.obj({...masterResult,...extra}),'implemented','target-confirmed',['H-SDK'],'按原厂运行时许可列表保存和恢复九族效果的启用组合，仅写固定enable字段；USB身份、持久化事务、完整参数读回和失败恢复。总开关关闭或恢复未完成时禁止单项音效写入。');
const profileEffects=S.obj(Object.fromEntries(liveEffects.map(key=>[key,out.find(c=>c.id==='headset.'+key+'.set').args.properties.state])),[]);
const profileSnapshot=S.array(S.obj({endpointId,usbInstanceId:S.string(2048),flow,effects:profileEffects}),1,2);
const globalProfileReceipt=S.obj({profiles:S.array(S.obj({name:S.string(128),isDefault:S.bool}),1,128),currentName:S.string(128),snapshot:profileSnapshot,verified:S.enum([true]),applied:S.bool,source:S.enum(['sdk','windows-effect-store']),scope:S.enum(['licensed-effects','target-effects'])});
for(const [suffix,title]of [['list','读取耳机全局配置与当前状态'],['create','保存当前音效为新全局配置'],['select','立即切换耳机全局配置'],['delete','删除耳机全局配置']])add('headset.profiles.'+suffix,title,suffix==='list'?'read':'write',S.obj({endpointIds:S.array(endpointId,1,2),...(suffix==='list'?{}:{name:S.string(128)})}),globalProfileReceipt,'implemented','target-confirmed',['H-SDK'],'当前已验证许可音效的全局快照；同名精确拒绝、新增选中、选择直接生效、变化标为Current；Default采用原厂ProfileTemplate常量。总开关off时仍允许选择并写入档案enabled组合，保留master缓存；重新开启恢复旧组合，profile参数保留。只有未完成master恢复事务会阻止写入。完整跨族写前日志、逐项读回与失败整组恢复。动态低频内部mode保留实时值。范围仅当前目标端点九族，不包括未知许可/其他设备。');
module.exports=out;
