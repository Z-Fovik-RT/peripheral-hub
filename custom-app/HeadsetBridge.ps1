#requires -Version 7.0
param([Parameter(Mandatory)][string]$RequestPath,[Parameter(Mandatory)][string]$ResponsePath)
$ErrorActionPreference='Stop';$exitCode=0;$operationGate=$null;$gateOwned=$false
try {
 $operationGate=[Threading.Mutex]::new($false,'Local\PeripheralHub.HeadsetAudio');try{$gateOwned=$operationGate.WaitOne(20000)}catch [Threading.AbandonedMutexException]{$gateOwned=$true};if(-not$gateOwned){throw '另一项耳机操作仍在进行，请稍后重试。'}
 $request=[IO.File]::ReadAllText($RequestPath)|ConvertFrom-Json
 $root=if((Split-Path $PSScriptRoot -Leaf)-eq'custom-app'){Split-Path $PSScriptRoot}else{[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))}
 Add-Type -Path (Join-Path $root 'native\CoreAudio.cs')
 . (Join-Path $PSScriptRoot 'HeadsetDiagnostics.ps1')
 $audioActions=@('headset-audio-channels-read','headset-audio-channels-set','headset-audio-balance-read','headset-audio-balance-set','headset-audio-peak-read','headset-audio-sessions-list','headset-audio-sessions-set','headset-audio-format-read','headset-audio-format-list','headset-audio-format-set','headset-audio-default-read','headset-audio-default-set','headset-audio-controls-restore')
 $masterActions=@('headset-master-read','headset-master-set','headset-master-restore')
 $profileActions=@('headset-profiles-list','headset-profiles-create','headset-profiles-select','headset-profiles-delete')
 if([string]$request.action -cnotin (@('headset-detect','headset-info','headset-apo','headset-effects-read','headset-effects-set','headset-effects-restore','headset-aec-read','headset-eq-preset-apply')+$audioActions+$masterActions+$profileActions)){throw 'Unknown headset operation.'}
 if([string]$request.action -like 'headset-effects-*'-or$request.action-ceq'headset-eq-preset-apply'-or$request.action-ceq'headset-aec-read'-or[string]$request.action-in$audioActions-or[string]$request.action-in$masterActions-or[string]$request.action-in$profileActions){
  if([string]$request.action-in$audioActions){Add-Type -Path (Join-Path $root 'native\AudioExtras.cs');. (Join-Path $PSScriptRoot 'HeadsetAudioControls.ps1')}
  if([string]$request.action-in$audioActions-or$request.action-ceq'headset-aec-read'){. (Join-Path $PSScriptRoot 'HeadsetWindowsAudio.ps1')}
  . (Join-Path $PSScriptRoot 'HeadsetEffects.ps1')
  if($request.action-ceq'headset-aec-read'){Assert-HeadsetAecRequest $request}
  . (Join-Path $PSScriptRoot 'HeadsetMaster.ps1')
  . (Join-Path $PSScriptRoot 'HeadsetRestore.ps1')
   . (Join-Path $PSScriptRoot 'HeadsetProfiles.ps1')
  Add-Type -Path (Join-Path $root 'native\IkfDirectAudio.cs')
  . (Join-Path $PSScriptRoot 'HeadsetDirectBackend.ps1')
  $sdk=New-HeadsetDirectBackend (Join-Path $root 'local-state\headset-direct-before-changes.json')
  try {
   $recoveryPath=Join-Path $root 'local-state\headset-effects-before-changes.json'
   $masterPath=Join-Path $root 'local-state\headset-master-before-changes.json'
   if([string]$request.action-in$masterActions){
    if($request.action-ne'headset-master-read'){$record=Read-XearRecovery $recoveryPath;if(@($record.entries|Where-Object {$_.endpointId-ieq$request.endpointId-and$_.pending}).Count){throw '此端点仍有未完成音效事务，请先恢复音效快照。'}}
    $data=Invoke-HeadsetMasterControl $request $sdk $masterPath
   }
   elseif([string]$request.action-in$profileActions){$data=Invoke-HeadsetProfileControl $request $sdk (Join-Path $root 'local-state\headset-global-profiles.json') $recoveryPath $masterPath}
   elseif([string]$request.action-in$audioActions){$data=Invoke-HeadsetAudioControl $request $sdk (Join-Path $root 'local-state\headset-audio-controls-before-changes.json')}
   elseif($request.action-ceq'headset-aec-read'){$data=Invoke-HeadsetWindowsAudioRead $request}
    elseif($request.action-eq'headset-effects-restore'){$data=Invoke-HeadsetRecovery $sdk $recoveryPath $masterPath}
    elseif($request.action-ceq'headset-eq-preset-apply'){
     Assert-HeadsetMasterKeys $request @('action','endpointId','bandsRaw')
      if($request.action-isnot[string]-or$request.action-cne'headset-eq-preset-apply'){throw 'Unknown fixed EQ preset operation.'}
     if((Get-HeadsetMasterFlow $request.endpointId)-cne'render'){throw 'EQ预设仅可应用到播放端点。'}
     # Preserve the observed enable flag within the same serialized effect transaction.
     Assert-XearState 'eq' ([ordered]@{enabled=$false;bandsRaw=$request.bandsRaw})
     $endpointId=$request.endpointId
     Assert-HeadsetMasterAllowsEffects $endpointId $masterPath
     $endpoint=$sdk.FindTarget($endpointId,'render')
     $before=Read-XearEffectState $sdk $endpoint 'eq';Assert-XearState 'eq' $before
     $state=[ordered]@{enabled=$before.enabled;bandsRaw=$request.bandsRaw}
     $actual=Invoke-XearEffectChange $sdk $endpoint $endpointId 'eq' $state $recoveryPath
     $data=@{endpointId=$endpointId;support='supported';source=(Get-HeadsetEffectSource $sdk);verified=$true;state=$actual;applied=$true;preservedEnabled=$before.enabled}
    }
   else {
    $feature=[string]$request.feature;$definition=(Get-XearEffectMap)[$feature];if(-not$definition){throw 'Unsupported effect family.'}
    $endpointId=[string]$request.endpointId;$endpoint=$sdk.FindTarget($endpointId,$definition.flow)
    if($request.action-eq'headset-effects-set'){
     Assert-HeadsetMasterAllowsEffects $endpointId $masterPath
     $state=[hashtable]::new();foreach($property in $request.state.PSObject.Properties){$state[$property.Name]=$property.Value}
     $actual=Invoke-XearEffectChange $sdk $endpoint $endpointId $feature $state $recoveryPath
     $data=@{endpointId=$endpointId;support='supported';source=(Get-HeadsetEffectSource $sdk);verified=$true;state=$actual;applied=$true}
    }else{$actual=Read-XearEffectState $sdk $endpoint $feature;$data=@{endpointId=$endpointId;support='supported';source=(Get-HeadsetEffectSource $sdk);verified=$true;state=$actual}}
   }
  }finally{$sdk.Dispose()}
 }else {
  $evidence=Get-HeadsetSystemEvidence
  if($request.action-eq'headset-detect'){$data=[ordered]@{devices=@($evidence.devices);warnings=@($evidence.warnings);observedAt=[datetime]::UtcNow.ToString('o')}}
  else {
   $endpointId=[string]$request.endpointId
   if(-not$endpointId-or$endpointId.Length-gt2048){throw 'Invalid audio endpoint identifier.'}
   $targets=@($evidence.devices|Where-Object {$_.endpointId-ceq$endpointId})
   if($targets.Count-ne1){throw '目标耳机端点未就绪或未通过USB身份核验。请重新检测设备。'}
   $device=$targets[0];$detail=$evidence.details[$endpointId]
   if($request.action-eq'headset-info'){$data=[ordered]@{endpointId=$endpointId;support='supported';source='windows-system';verified=$true;displayName=$detail.endpoint.Name;controllerName=$detail.target.name;driverVersion=$detail.target.driverVersion;usbRevisionRaw=$null;jackTypeRaw=$null;channelCountRaw=$null;driverProvider=$detail.target.driverProvider;driverInf=$detail.target.driverInf;identityVerified=$true;warnings=@('以上为Windows端点和USB驱动元数据；未知字段保留为空，不代表音效已支持。')}}
   else {$fx=Read-HeadsetFxStore -EndpointId $endpointId -Flow $device.flow;$data=Convert-HeadsetApoEvidence -EndpointId $endpointId -Flow $device.flow -Fx $fx}
  }
 }
 $response=@{ok=$true;data=$data}
}catch{$response=@{ok=$false;error=$_.Exception.Message};$exitCode=1}
finally{if($gateOwned){$operationGate.ReleaseMutex()};if($operationGate){$operationGate.Dispose()}}
[IO.File]::WriteAllText($ResponsePath,($response|ConvertTo-Json -Depth 10 -Compress))
exit $exitCode
