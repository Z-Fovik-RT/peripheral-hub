# Pure identity/registry-evidence interpretation plus explicit read-only providers.
# Dot-sourcing this file does not enumerate devices, load a vendor DLL or access the registry.
function Get-HeadsetParentChain {
 param([string]$InstanceId,[scriptblock]$GetNode)
 $chain=@();$seen=@{};$current=$InstanceId
 for($i=0;$i-lt12-and$current;$i++){
  if($seen.ContainsKey($current)){return @{nodes=$chain;warning='设备父级链出现循环，身份未确认。'}}
  $seen[$current]=$true
  try{$node=& $GetNode $current}catch{return @{nodes=$chain;warning=('无法读取设备父级：'+$_.Exception.Message)}}
  if(-not$node){return @{nodes=$chain;warning='设备父级元数据不可用。'}}
  if([string]$node.instanceId -ine $current){return @{nodes=$chain;warning='设备父级查询返回了其他实例。'}}
  $chain+=,$node
  if($current -match '^USB\\VID_0E6A&PID_0110&MI_00\\[^\\]+$'){return @{nodes=$chain;warning=$null;target=$node}}
  # Stop on any USB interface belonging to a different device or MI.
  if($current -match '^USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}&MI_[0-9A-F]{2}\\'){return @{nodes=$chain;warning=$null}}
  $current=[string]$node.parentId
 }
 return @{nodes=$chain;warning=$(if($current){'设备父级链超过检查上限。'}else{$null})}
}
function Get-HeadsetIdentityEvidence {
 param([object[]]$Identities,[object[]]$PresentNodes,[scriptblock]$GetNode,[object[]]$EndpointNodes=@())
 $present=@{};foreach($node in $PresentNodes){$present[[string]$node.InstanceId]=$true}
 $endpointNodesById=@{};foreach($node in $EndpointNodes){$endpointNodesById[[string]$node.InstanceId]=$node}
 $devices=@();$details=@{};$warnings=@()
 foreach($endpoint in $Identities){
  if($endpoint.Flow -notin @('render','capture')){continue}
  $looksTarget=[string]$endpoint.Name -match '(?i)iKF[ -]?V11\s*Pro'
  $instanceId=[string]$endpoint.InstanceId
  if(-not$instanceId){
   $candidate='SWD\MMDEVAPI\'+[string]$endpoint.Id
   if($endpointNodesById.ContainsKey($candidate)){$instanceId=[string]$endpointNodesById[$candidate].InstanceId}
   else{if($looksTarget){$warnings+='存在名称相似的端点，但身份属性与对应的PnP端点节点不可用；未将其作为控制目标。'};continue}
  }
  $chain=Get-HeadsetParentChain -InstanceId $instanceId -GetNode $GetNode
  if(-not$chain.target){if($looksTarget){$warnings+=('名称相似端点没有匹配到目标USB音频接口。'+$chain.warning)};continue}
  $target=$chain.target
  if(-not$present.ContainsKey([string]$target.instanceId)){$warnings+='目标USB音频接口不在当前已连接列表；忽略旧端点。';continue}
  if($endpoint.Id -notmatch '^\{0\.0\.([01])\.00000000\}\.\{([0-9a-fA-F-]{36})\}$'){$warnings+='音频端点ID格式不受支持；未生成注册表路径。';continue}
  if(($endpoint.Flow-eq'render'-and$Matches[1]-ne'0')-or($endpoint.Flow-eq'capture'-and$Matches[1]-ne'1')){$warnings+='端点ID方向与系统方向不一致。';continue}
  $devices+=,[ordered]@{endpointId=[string]$endpoint.Id;sdkUid=$null;instanceId=$instanceId;usbInstanceId=[string]$target.instanceId;vendorId=3690;productId=272;flow=[string]$endpoint.Flow;matchedTarget=$true}
  $details[[string]$endpoint.Id]=@{endpoint=$endpoint;target=$target}
 }
 return @{devices=$devices;details=$details;warnings=@($warnings|Select-Object -Unique)}
}
function Convert-HeadsetApoEvidence {
 param([string]$EndpointId,[ValidateSet('render','capture')][string]$Flow,[object]$Fx)
 $warnings=@('仅检查Windows保存的效果绑定；未实例化原厂APO，也未验证实时DSP或许可。')
 $expected=if($Flow-eq'render'){@{EFX='{22677C03-5EC6-443C-8082-8D4A1662F4A3}';MFX='{22677C04-5EC6-443C-8082-8D4A1662F4A3}';SFX='{22677C05-5EC6-443C-8082-8D4A1662F4A3}'}}else{@{EFX='{22677C06-5EC6-443C-8082-8D4A1662F4A3}';MFX='{22677C07-5EC6-443C-8082-8D4A1662F4A3}'}}
 $contexts=@{EFX='{9C97FB8F-7C45-4EF3-A5A8-67D0AC630E8F}';MFX='{4C6C316B-C24F-421C-A266-690540CABD11}';SFX='{C31A35A5-22EC-425E-9B74-B64700F067DA}'}
 $stagePids=@{SFX=@(1,5,11,13,19);MFX=@(6,12,14,20);EFX=@(2,7,15)}
 $matched=@();$foundContexts=@();$evidence='unknown';$propertySet='{D04E05A6-594B-4FB6-A80D-01AF5EED7D1D}'
 if($Fx.error){$warnings+=('无法读取效果存储：'+[string]$Fx.error)}
 elseif(-not$Fx.available){$evidence='not-observed';$warnings+='未观察到该端点的效果属性存储。'}
 else {
  foreach($stage in @('SFX','MFX','EFX')){
   if(-not$expected.ContainsKey($stage)){continue}
   foreach($propertyId in $stagePids[$stage]){foreach($value in @($Fx.values[($propertySet+','+$propertyId)])){if($value-is[string]-and$value-ieq$expected[$stage]){$matched+=,$expected[$stage]}}}
   if($contexts[$stage] -in @($Fx.contextNames)){$foundContexts+=,[ordered]@{stage=$stage;contextId=$contexts[$stage]}}
  }
  $matched=@($matched|Select-Object -Unique)
  $evidence=if($matched.Count-eq$expected.Count){'configured'}elseif($matched.Count-gt0){'partial'}else{'not-observed'}
  if($evidence-eq'not-observed'){$warnings+='当前属性中没有目标C-Media APO绑定证据；不以其他厂商GUID代替。'}
  if($evidence-eq'partial'){$warnings+='仅发现部分目标效果阶段，不能认为完整音效链就绪。'}
 }
 return [ordered]@{endpointId=$EndpointId;extensionMatched=$null;apoAttached=$null;licenseState='unknown';contexts=$foundContexts;warnings=$warnings;attachmentEvidence=$evidence;configuredClsids=$matched;source='property-store'}
}
function Read-HeadsetFxStore {
 param([string]$EndpointId,[ValidateSet('render','capture')][string]$Flow)
 if($EndpointId -notmatch '^\{0\.0\.([01])\.00000000\}\.\{([0-9a-fA-F-]{36})\}$'){throw 'Invalid endpoint ID for effect metadata.'}
 if(($Flow-eq'render'-and$Matches[1]-ne'0')-or($Flow-eq'capture'-and$Matches[1]-ne'1')){throw 'Endpoint flow mismatch.'}
 $guid=[guid]$Matches[2];$branch=if($Flow-eq'render'){'Render'}else{'Capture'}
 $base=$null;$key=$null
 try {
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry64)
  $key=$base.OpenSubKey(('SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\'+$branch+'\{'+$guid.ToString()+'}\FxProperties'),$false)
  if(-not$key){return @{available=$false;values=@{};contextNames=@();error=$null}}
  $values=@{};$fmtid='{D04E05A6-594B-4FB6-A80D-01AF5EED7D1D}'
  foreach($propertyId in @(1,2,5,6,7,11,12,13,14,15,19,20)){$name=$fmtid+','+$propertyId;$value=$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);if($null-ne$value){$values[$name]=$value}}
  return @{available=$true;values=$values;contextNames=@($key.GetSubKeyNames());error=$null}
 }catch{return @{available=$false;values=@{};contextNames=@();error=$_.Exception.Message}}
 finally{if($key){$key.Dispose()};if($base){$base.Dispose()}}
}
function Get-HeadsetSystemEvidence {
 $present=@(Get-PnpDevice -PresentOnly -InstanceId 'USB\VID_0E6A&PID_0110&MI_00\*' -ErrorAction Stop)
 $identities=@([PeripheralHub.CoreAudio]::ListEndpointIdentities())
 $endpointNodes=@(Get-PnpDevice -PresentOnly -Class AudioEndpoint -ErrorAction Stop)
 $cache=@{}
 $nodeReader={param($id)
  if($cache.ContainsKey($id)){return $cache[$id]}
  $map=@{}
  $properties=@(Get-PnpDeviceProperty -InstanceId $id -KeyName @('DEVPKEY_Device_Parent','DEVPKEY_Device_FriendlyName','DEVPKEY_Device_DriverVersion','DEVPKEY_Device_DriverProvider','DEVPKEY_Device_DriverInfPath') -ErrorAction Stop)
  foreach($property in $properties){$map[[string]$property.KeyName]=$property.Data}
  $node=@{instanceId=$id;parentId=$map['DEVPKEY_Device_Parent'];name=$map['DEVPKEY_Device_FriendlyName'];driverVersion=$map['DEVPKEY_Device_DriverVersion'];driverProvider=$map['DEVPKEY_Device_DriverProvider'];driverInf=$map['DEVPKEY_Device_DriverInfPath']}
  $cache[$id]=$node;return $node
 }.GetNewClosure()
 return Get-HeadsetIdentityEvidence -Identities $identities -PresentNodes $present -GetNode $nodeReader -EndpointNodes $endpointNodes
}
