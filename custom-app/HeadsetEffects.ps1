# Fixed effect fields recovered from the official UI. No arbitrary SDK property dispatch.
function Test-HeadsetDirectBackend($Backend) { return $null-ne$Backend-and$Backend.PSObject.Properties['BackendKind']-and$Backend.BackendKind-ceq'windows-effect-store' }
function Get-HeadsetEffectSource($Backend) { if(Test-HeadsetDirectBackend $Backend){return 'windows-effect-store'};return 'sdk' }
function Get-XearEffectMap {
 $bool=@{min=0;max=1;bool=$true}
 return @{
  eq=@{flow='render';license=5;fields=[ordered]@{enabled=@{property='Enable_EQ_GFX';min=0;max=1;bool=$true};bandsRaw=@{properties=@(1..10|ForEach-Object {'EQ_Slider'+$_});min=-20;max=20}}}
  surround71=@{flow='render';license=18;fields=[ordered]@{enabled=@{property='Enable_CONLAB_HPSPK_LFX';min=0;max=1;bool=$true};modeRaw=@{property='CONLAB_HPSPK_MODE';allowed=@(0,1)};roomSizeRaw=@{property='CONLAB_HPSPK_ROOMSIZE';allowed=@(0,1,2)}}}
  brilliant=@{flow='render';license=11;fields=[ordered]@{enabled=@{property='Enable_AUDIOBRILLIANT_LFX';min=0;max=1;bool=$true};levelRaw=@{property='AUDIOBRILLIANT_LEVEL';min=0;max=10}}}
  dynamicBass=@{flow='render';license=12;fields=[ordered]@{enabled=@{property='Enable_VIRTUALBASS_LFX';min=0;max=1;bool=$true};modeRaw=@{property='VIRTUALBASS_Mode';min=-2147483648;max=2147483647};levelRaw=@{property='VIRTUALBASS_Level';min=0;max=10};cutoffRaw=@{property='VIRTUALBASS_CutOffFrequency';allowed=@(100,150,200,300,400)}}}
  smartVolume=@{flow='render';license=17;fields=[ordered]@{enabled=@{property='Enable_ADAPTIVEVOLUME_GFX';min=0;max=1;bool=$true};levelRaw=@{property='ADAPTIVEVOLUME_LEVEL';min=0;max=100};modeRaw=@{property='ADAPTIVEVOLUME_MODE';allowed=@(0,1)}}}
  voiceClarity=@{flow='render';license=19;fields=[ordered]@{enabled=@{property='Enable_VOICECLARITY_LFX';min=0;max=1;bool=$true};levelRaw=@{property='VOICECLARITY_LEVEL';min=0;max=10};noiseSuppressionRaw=@{property='VOICECLARITY_NOISESUPP_LEVEL';allowed=@(0,5,10,15,20)}}}
  surroundMax=@{flow='render';license=7;fields=[ordered]@{enabled=@{property='Enable_Channel_COPY_LFX';min=0;max=1;bool=$true}}}
  'mic.magicVoice'=@{flow='capture';license=14;fields=[ordered]@{enabled=@{property='Enable_MAGICVOICE';min=0;max=1;bool=$true};selectionRaw=@{property='MagicVoice_Selection';allowed=@(0,1,2,3)}}}
  'mic.nr'=@{flow='capture';license=1;fields=[ordered]@{enabled=@{property='NR_Enable';min=0;max=1;bool=$true};levelRaw=@{property='NR_Level';min=6;max=40}}}
 }
}
function Assert-XearState {
 param([string]$Feature,[object]$State)
 $map=Get-XearEffectMap;if(-not$map.ContainsKey($Feature)){throw 'Unsupported effect family.'}
 if($State-isnot[Collections.IDictionary]){throw 'Effect state must be an object.'}
 $fields=$map[$Feature].fields
 if($State.Count-ne$fields.Count){throw 'Missing or extra effect fields.'}
 foreach($name in $fields.Keys){
  if(-not$State.Contains($name)){throw ('Missing field: '+$name)}
  $field=$fields[$name];$value=$State[$name]
  if($field.bool){if($value-isnot[bool]){throw ('Expected boolean: '+$name)};continue}
  if(-not$field.properties-and$value-isnot[int]-and$value-isnot[long]){throw ('Expected integer: '+$name)}
  $values=if($field.properties){if($value-isnot[Array]-or$value.Count-ne10){throw 'Exactly ten EQ bands are required.'};$value}else{@($value)}
  foreach($number in $values){
   if($number-isnot[int]-and$number-isnot[long]){throw ('Expected integer: '+$name)}
   if($field.allowed){if($number-notin$field.allowed){throw ('Value outside UI choices: '+$name)}}
   elseif($number-lt$field.min-or$number-gt$field.max){throw ('Value outside official UI range: '+$name)}
  }
 }
}
function Convert-XearScalar($value) {
 return [PeripheralHub.XearAudio]::Scalar($value,2)
}
function Assert-HeadsetAecRequest {
 param($Request)
 if($Request -isnot [pscustomobject]){throw 'AEC request must be an object.'}
 $keys=@($Request.PSObject.Properties.Name)
 if($keys.Count -ne 2 -or 'action' -cnotin $keys -or 'endpointId' -cnotin $keys){throw 'AEC request accepts only action and endpointId.'}
 if($Request.action -isnot [string] -or $Request.action -cne 'headset-aec-read'){throw 'Unknown AEC operation.'}
 if($Request.endpointId -isnot [string] -or $Request.endpointId -cnotmatch '^\{0\.0\.1\.00000000\}\.\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$'){throw 'AEC requires a valid capture endpoint.'}
}
function Read-XearAecState {
 param($Sdk,$Endpoint)
 if((Convert-XearScalar $Endpoint.Properties['DataFlow']) -ne 2){throw '麦克风AEC仅适用于录音端点。'}
 $enabled=Convert-XearScalar ($Sdk.ReadAllowed($Endpoint.Uid,'AEC_Enable'));$level=Convert-XearScalar ($Sdk.ReadAllowed($Endpoint.Uid,'AEC_Level'));$delay=Convert-XearScalar ($Sdk.ReadAllowed($Endpoint.Uid,'AEC_DelayTime'))
 if($enabled -notin @(0,1)){throw 'AEC_Enable不是有效的0/1值。'}
 return [ordered]@{enabled=[bool]$enabled;levelRaw=[int]$level;delayRaw=[int]$delay}
}
function Read-XearEffectState {
 param($Sdk,$Endpoint,[string]$Feature)
 if(Test-HeadsetDirectBackend $Sdk){return Read-HeadsetDirectState $Endpoint $Feature}
 $map=Get-XearEffectMap;$definition=$map[$Feature]
 if(-not$definition){throw 'Unsupported effect family.'}
 $license=$Endpoint.Properties['SupportedLicenseCategory']
 if($license.Error-ne0-or$license.DataType-ne2-or$license.ValidationError-or$definition.license-notin$license.Value){throw '此端点未提供该音效的有效许可。'}
 $state=[ordered]@{}
 foreach($name in $definition.fields.Keys){$field=$definition.fields[$name]
  if($field.properties){$state[$name]=@(foreach($property in $field.properties){Convert-XearScalar ($Sdk.ReadAllowed($Endpoint.Uid,$property))})}
  else{$value=Convert-XearScalar ($Sdk.ReadAllowed($Endpoint.Uid,$field.property));if($field.bool){if($value-notin@(0,1)){throw 'SDK boolean is outside 0/1.'};$state[$name]=[bool]$value}else{$state[$name]=[int]$value}}
 }
 return $state
}
function Set-XearEffectState {
 param($Sdk,$Endpoint,[string]$Feature,[Collections.IDictionary]$State)
 if(Test-HeadsetDirectBackend $Sdk){return Set-HeadsetDirectState $Sdk $Endpoint $Feature $State}
 Assert-XearState $Feature $State
 $before=Read-XearEffectState $Sdk $Endpoint $Feature
 if($Feature-eq'dynamicBass'-and$State.modeRaw-ne$before.modeRaw){throw '动态低频模式映射未确认，仅允许保留当前读值。'}
 $definition=(Get-XearEffectMap)[$Feature];$writes=@()
 # Turn a feature off before changing its parameters; enable only after parameters are ready.
 if(-not$State.enabled-and$before.enabled){$writes+=@{property=$definition.fields.enabled.property;value=0}}
 foreach($name in $definition.fields.Keys){if($name-eq'enabled'){continue};$field=$definition.fields[$name]
  if($field.properties){for($i=0;$i-lt10;$i++){if($State[$name][$i]-ne$before[$name][$i]){$writes+=@{property=$field.properties[$i];value=[int]$State[$name][$i]}}}}
  elseif($State[$name]-ne$before[$name]){$writes+=@{property=$field.property;value=[int]$State[$name]}}
 }
 if($State.enabled-and-not$before.enabled){$writes+=@{property=$definition.fields.enabled.property;value=1}}
 foreach($write in $writes){$Sdk.WriteInt32($Endpoint.Uid,$write.property,$write.value)}
 $actual=Read-XearEffectState $Sdk $Endpoint $Feature
 if(($actual|ConvertTo-Json -Compress)-cne($State|ConvertTo-Json -Compress)){
  # Compare fields rather than caller object key order.
  foreach($name in $definition.fields.Keys){if(($actual[$name]|ConvertTo-Json -Compress)-cne($State[$name]|ConvertTo-Json -Compress)){throw 'SDK音效读回与请求不一致。'}}
 }
 return $actual
}
function Save-XearRecovery {
 param([string]$Path,[object]$Value)
 $directory=Split-Path $Path;[IO.Directory]::CreateDirectory($directory)|Out-Null
 $temp=$Path+'.'+[guid]::NewGuid().ToString('N')+'.tmp';$stream=$null
 try{$bytes=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 12 -Compress));$stream=[IO.File]::Open($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true);$stream.Dispose();$stream=$null;[IO.File]::Move($temp,$Path,$true)}
 finally{if($stream){$stream.Dispose()};if([IO.File]::Exists($temp)){[IO.File]::Delete($temp)}}
}
function Read-XearRecovery {
 param([string]$Path)
 if(-not[IO.File]::Exists($Path)){return @{schemaVersion=1;entries=@()}}
 if((Get-Item -LiteralPath $Path).Length-gt1048576){throw '音效恢复记录过大，已保留原文件。'}
 try{$record=[IO.File]::ReadAllText($Path)|ConvertFrom-Json -AsHashtable -ErrorAction Stop
  if($record.schemaVersion-ne1-or$record.entries-isnot[Array]-or$record.entries.Count-gt128){throw 'Invalid snapshot.'}
  $ids=@{}
  foreach($entry in $record.entries){Assert-XearState $entry.feature $entry.state;if($entry.pending-isnot[bool]){throw 'Invalid pending state.'};if($entry.pending){Assert-XearState $entry.feature $entry.immediateBefore};if($entry.endpointId-notmatch'^\{0\.0\.[01]\.00000000\}\.\{[0-9a-fA-F-]{36}\}$'){throw 'Invalid endpoint snapshot.'};$key=$entry.endpointId+'|'+$entry.feature;if($ids.ContainsKey($key)-or$entry.usbInstanceId-notmatch'^USB\\VID_0E6A&PID_0110\\[^\\]+$'){throw 'Invalid identity in snapshot.'};$ids[$key]=$true}
  return $record
 }catch{throw ('音效恢复记录损坏，已保留原文件：'+$_.Exception.Message)}
}
function Invoke-XearEffectChange {
 param($Sdk,$Endpoint,[string]$EndpointId,[string]$Feature,[Collections.IDictionary]$State,[string]$RecoveryPath)
 Assert-XearState $Feature $State
 $before=Read-XearEffectState $Sdk $Endpoint $Feature;Assert-XearState $Feature $before
 $usb=if(Test-HeadsetDirectBackend $Sdk){[string]$Endpoint.UsbInstanceId}else{[string][PeripheralHub.XearAudio]::Scalar($Endpoint.Properties['USBDeviceInstanceID'],5)}
 $record=Read-XearRecovery $RecoveryPath
 if(@($record.entries|Where-Object {$_.pending}).Count){throw '上次音效操作尚未确认，请先恢复快照。'}
 $entry=@($record.entries|Where-Object {$_.endpointId-ieq$EndpointId-and$_.feature-eq$Feature})
 if($entry.Count-eq0){$entry=@(@{endpointId=$EndpointId;usbInstanceId=$usb;feature=$Feature;state=$before;pending=$false});$record.entries+=,$entry[0]}
 if($entry[0].usbInstanceId-ine$usb){throw '音效快照属于另一台USB设备，拒绝复用。'}
 $entry[0].pending=$true;$entry[0].immediateBefore=$before;Save-XearRecovery $RecoveryPath $record
 try {
  $actual=Set-XearEffectState $Sdk $Endpoint $Feature $State
  $entry[0].pending=$false;$entry[0].Remove('immediateBefore');Save-XearRecovery $RecoveryPath $record
  return $actual
 }catch {
  $original=$_.Exception.Message
  try{[void](Set-XearEffectState $Sdk $Endpoint $Feature $before);$entry[0].pending=$false;$entry[0].Remove('immediateBefore');Save-XearRecovery $RecoveryPath $record}
  catch{throw ($original+'；自动恢复未完成，已保留操作前快照。'+$_.Exception.Message)}
  throw ($original+'；已恢复并读回本次操作前的设置。')
 }
}
