'use strict';
const {S}=require('../schema.cjs');
const byte=S.int(0,255),layer=S.int(0,3),keyId=S.string(3),base64=S.string(684);
const patch=S.union(
 S.obj({kind:S.enum(['keyboard']),layer,keyId,modifiers:byte,primaryUsage:byte,secondaryUsage:byte}),
 S.obj({kind:S.enum(['consumer']),layer,keyId,consumerUsage:S.int(0,65535)}),
 S.obj({kind:S.enum(['palette']),modeId:S.enum([1,2,4,5,7,8,10,11,12,13]),colorIndex:S.int(0,6),r:byte,g:byte,b:byte})
);
module.exports=[{
 id:'keyboard.draft.patch',title:'编辑键盘原始配置本地草稿',devices:['aula-f87-pro'],effect:'local',availability:'implemented',
 evidence:'local-verified',auditIds:['A07','A13','A14','A15'],
 reason:'仅修改导入或已明确捕获字节中的键位、Consumer 或颜色字段；其余数据逐字节保留，不补齐无线缺失尾部，不发送设备，也不授予硬件恢复资格。',
 args:S.obj({contentBase64:base64,patch}),
 result:S.obj({source:S.enum(['local-draft']),contentBase64:base64,originalSha256:S.string(64),sha256:S.string(64),changedOffsets:S.array(S.int(0,511),0,4),blockKind:S.enum(['matrix','palette']),layer:S.nullable(layer),actualLength:S.enum([490,504,512]),completeBlockProvided:S.bool,writeBaselineEligible:S.enum([false]),hardwareIO:S.enum([false])})
}];
