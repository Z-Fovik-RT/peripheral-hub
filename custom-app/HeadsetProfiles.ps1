# Fixed global profiles for the currently verified nine iKF effect families.
# Dot-source after HeadsetEffects/Master/Restore; caller owns the shared audio mutex.
function Copy-HeadsetProfileValue($Value) {
 return ,(ConvertFrom-Json -InputObject (ConvertTo-Json -InputObject $Value -Depth 24 -Compress) -AsHashtable -NoEnumerate)
}
function Get-HeadsetProfileDefaults {
 return [ordered]@{
  eq=[ordered]@{enabled=$false;bandsRaw=@(0,0,0,0,0,0,0,0,0,0)}
  surroundMax=[ordered]@{enabled=$false}
  brilliant=[ordered]@{enabled=$false;levelRaw=3}
  dynamicBass=[ordered]@{enabled=$false;modeRaw=0;levelRaw=5;cutoffRaw=200}
  smartVolume=[ordered]@{enabled=$false;levelRaw=70;modeRaw=0}
  surround71=[ordered]@{enabled=$false;modeRaw=0;roomSizeRaw=1}
  voiceClarity=[ordered]@{enabled=$false;levelRaw=3;noiseSuppressionRaw=0}
  'mic.nr'=[ordered]@{enabled=$false;levelRaw=15}
  'mic.magicVoice'=[ordered]@{enabled=$false;selectionRaw=0}
 }
}
function Assert-HeadsetProfileSnapshot($Snapshot) {
 if($Snapshot -isnot [array] -or $Snapshot.Count -lt 1 -or $Snapshot.Count -gt 2){throw 'Global profiles require one or two verified endpoints.'}
 $ids=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
 foreach($target in $Snapshot){
  Assert-HeadsetMasterKeys $target @('endpointId','usbInstanceId','flow','effects')
  if($target.flow -cne (Get-HeadsetMasterFlow $target.endpointId) -or -not $ids.Add($target.endpointId) -or $target.usbInstanceId -isnot [string] -or $target.usbInstanceId -notmatch '^USB\\VID_0E6A&PID_0110\\[^\\\x00-\x1f]+$'){throw 'Invalid global profile endpoint identity.'}
  if($target.effects -isnot [Collections.IDictionary]){throw 'Invalid global profile effect map.'}
  $known=@(Get-HeadsetMasterFeatures $target.flow);if($target.effects.Count -lt 1 -or $target.effects.Count -gt $known.Count){throw 'Invalid licensed profile families.'}
  foreach($feature in $target.effects.Keys){if($feature -cnotin $known){throw 'Unknown or wrong-direction profile effect.'};Assert-XearState $feature $target.effects[$feature]}
 }
}
function Assert-HeadsetProfileStore($Store) {
 Assert-HeadsetMasterKeys $Store @('schemaVersion','currentName','profiles')
 if($Store.schemaVersion -ne 1 -or $Store.currentName -isnot [string] -or $Store.profiles -isnot [array] -or $Store.profiles.Count -gt 128){throw 'Invalid global profile storage.'}
 $names=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
 foreach($profile in $Store.profiles){
  Assert-HeadsetMasterKeys $profile @('name','snapshot')
  if($profile.name -isnot [string] -or $profile.name.Length -lt 1 -or $profile.name.Length -gt 128 -or -not $names.Add($profile.name)){throw 'Global profile names must be unique and nonempty.'}
  Assert-HeadsetProfileSnapshot $profile.snapshot
 }
 if($Store.profiles.Count -lt 1 -or -not $names.Contains('Default') -or ($Store.currentName -cne 'Current' -and -not $names.Contains($Store.currentName))){throw 'Default or current profile is missing.'}
}
function Read-HeadsetProfileStore([string]$Path) {
 if(-not [IO.File]::Exists($Path)){return $null}
 try{if((Get-Item -LiteralPath $Path).Length -gt 2097152){throw 'Profile storage exceeds2MiB.'};$store=ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($Path)) -AsHashtable -ErrorAction Stop;Assert-HeadsetProfileStore $store;return $store}
 catch{throw ('全局配置文件损坏，已保留原文件：'+$_.Exception.Message)}
}
function Save-HeadsetProfileStore([string]$Path,$Store) {
 Assert-HeadsetProfileStore $Store
 if([Text.Encoding]::UTF8.GetByteCount((ConvertTo-Json -InputObject $Store -Depth 20 -Compress)) -gt 2097152){throw 'Global profiles exceed2MiB.'}
 Save-XearRecovery $Path $Store
}
function Read-HeadsetProfileSnapshot($Sdk,[string[]]$EndpointIds) {
 if($null -eq $EndpointIds -or $EndpointIds.Count -lt 1 -or $EndpointIds.Count -gt 2 -or @($EndpointIds | Select-Object -Unique).Count -ne $EndpointIds.Count){throw 'Select one or two distinct target endpoints.'}
 $result=@(foreach($endpointId in $EndpointIds){$target=Get-HeadsetMasterEndpoint $Sdk $endpointId;$read=Read-HeadsetMasterSnapshot $Sdk $target;$effects=[ordered]@{};foreach($feature in (Get-HeadsetProfileDefaults).Keys){if($read.Contains($feature)){$effects[$feature]=$read[$feature]}};@{endpointId=$endpointId;usbInstanceId=$target.usbInstanceId;flow=$target.flow;effects=$effects}})
 Assert-HeadsetProfileSnapshot $result;return ,$result
}
function Convert-HeadsetDefaultSnapshot($Current) {
 $result=Copy-HeadsetProfileValue $Current;$defaults=Get-HeadsetProfileDefaults
 foreach($target in $result){foreach($feature in @($target.effects.Keys)){$mode=if($feature -ceq 'dynamicBass'){$target.effects[$feature].modeRaw}else{$null};$target.effects[$feature]=Copy-HeadsetProfileValue $defaults[$feature];if($feature -ceq 'dynamicBass'){$target.effects[$feature].modeRaw=$mode}}}
 return ,$result
}
function Test-HeadsetProfileSnapshots($Left,$Right,[bool]$IgnoreDynamicMode=$true) {
 if($Left.Count -ne $Right.Count){return $false}
 foreach($a in $Left){$found=@($Right | Where-Object {$_.endpointId -ieq $a.endpointId -and $_.usbInstanceId -ieq $a.usbInstanceId -and $_.flow -ceq $a.flow});if($found.Count -ne 1){return $false};$b=$found[0]
  if($a.effects.Count -ne $b.effects.Count){return $false}
  foreach($feature in $a.effects.Keys){if(-not $b.effects.Contains($feature)){return $false};foreach($field in (Get-XearEffectMap)[$feature].fields.Keys){if($IgnoreDynamicMode -and $feature -ceq 'dynamicBass' -and $field -ceq 'modeRaw'){continue};if((ConvertTo-Json -InputObject $a.effects[$feature][$field] -Compress) -cne (ConvertTo-Json -InputObject $b.effects[$feature][$field] -Compress)){return $false}}}
 }
 return $true
}
function Get-HeadsetProfileDesired($Profile,$Current) {
 # Only the selected target's exact identities and licensed family sets are eligible.
 $result=Copy-HeadsetProfileValue $Current
 foreach($target in $result){
  $matches=@($Profile.snapshot | Where-Object {$_.endpointId -ieq $target.endpointId -and $_.usbInstanceId -ieq $target.usbInstanceId -and $_.flow -ceq $target.flow})
  if($matches.Count -ne 1){throw '所选配置不包含当前耳机端点，请重新连接原设备。'}
  $saved=$matches[0];if($target.effects.Count -ne $saved.effects.Count){throw '配置许可范围与当前设备不同。'}
  foreach($feature in @($target.effects.Keys)){if(-not $saved.effects.Contains($feature)){throw '配置缺少当前许可音效。'};$mode=if($feature -ceq 'dynamicBass'){$target.effects[$feature].modeRaw}else{$null};$target.effects[$feature]=Copy-HeadsetProfileValue $saved.effects[$feature];if($feature -ceq 'dynamicBass'){$target.effects[$feature].modeRaw=$mode}}
 }
 Assert-HeadsetProfileSnapshot $result;return ,$result
}
function New-HeadsetProfileReceipt($Store,$Current,[bool]$Applied=$false,$Backend=$null) {
 return @{profiles=@(foreach($profile in $Store.profiles){@{name=$profile.name;isDefault=($profile.name -ceq 'Default')}});currentName=$Store.currentName;snapshot=$Current;verified=$true;applied=$Applied;source=(Get-HeadsetEffectSource $Backend);scope=$(if(Test-HeadsetDirectBackend $Backend){'target-effects'}else{'licensed-effects'})}
}
function Invoke-HeadsetProfileTransaction($Sdk,$Current,$Desired,$RecoveryPath,[scriptblock]$Commit,[scriptblock]$RollbackCommit) {
 Assert-HeadsetProfileSnapshot $Current;Assert-HeadsetProfileSnapshot $Desired
 $record=Read-XearRecovery $RecoveryPath
 foreach($entry in $record.entries){Assert-HeadsetRecoveryEntry $entry}
 if(@($record.entries | Where-Object {$_.pending}).Count){throw '仍有未完成的音效事务，请先恢复快照。'}
 $staged=Copy-HeadsetProfileValue $record
 foreach($target in $Current){foreach($feature in $target.effects.Keys){
  $existing=@($staged.entries | Where-Object {$_.endpointId -ieq $target.endpointId -and $_.feature -ceq $feature})
  if($existing.Count -eq 0){$entry=@{endpointId=$target.endpointId;usbInstanceId=$target.usbInstanceId;feature=$feature;state=$target.effects[$feature];pending=$false};$staged.entries+=@($entry)}else{$entry=$existing[0];if($entry.usbInstanceId -ine $target.usbInstanceId){throw '配置恢复快照属于另一台USB设备。'}}
  $entry.pending=$true;$entry.immediateBefore=Copy-HeadsetProfileValue $target.effects[$feature]
 }}
 if($staged.entries.Count -gt 128){throw '音效恢复记录已满，请先恢复已有快照。'}
 foreach($entry in $staged.entries){Assert-HeadsetRecoveryEntry $entry}
 # The full cross-family before-image reaches disk before the first setter.
 Save-XearRecovery $RecoveryPath $staged
 try{
  foreach($target in $Desired){foreach($feature in $target.effects.Keys){$entry=@{endpointId=$target.endpointId;usbInstanceId=$target.usbInstanceId;feature=$feature};$endpoint=Get-HeadsetRecoveryEndpoint $Sdk $entry;[void](Set-XearEffectState $Sdk $endpoint $feature $target.effects[$feature])}}
  $actual=Read-HeadsetProfileSnapshot $Sdk ([string[]]@($Desired.endpointId));if(-not(Test-HeadsetProfileSnapshots $actual $Desired $false)){throw '全局配置最终读回不一致。'}
  & $Commit
  $done=Copy-HeadsetProfileValue $staged
  foreach($target in $Current){foreach($feature in $target.effects.Keys){$entry=@($done.entries | Where-Object {$_.endpointId -ieq $target.endpointId -and $_.feature -ceq $feature})[0];$entry.pending=$false;[void]$entry.Remove('immediateBefore')}}
  Save-XearRecovery $RecoveryPath $done
  return ,$actual
 }catch{
  $failure=$_.Exception.Message;$rollbackErrors=[Collections.Generic.List[string]]::new()
  foreach($target in $Current){foreach($feature in $target.effects.Keys){try{$entry=@{endpointId=$target.endpointId;usbInstanceId=$target.usbInstanceId;feature=$feature};$endpoint=Get-HeadsetRecoveryEndpoint $Sdk $entry;[void](Set-XearEffectState $Sdk $endpoint $feature $target.effects[$feature])}catch{$rollbackErrors.Add($feature+': '+$_.Exception.Message)}}}
  try{& $RollbackCommit}catch{$rollbackErrors.Add('配置记录恢复：'+$_.Exception.Message)}
  if($rollbackErrors.Count -eq 0){try{$actual=Read-HeadsetProfileSnapshot $Sdk ([string[]]@($Current.endpointId));if(-not(Test-HeadsetProfileSnapshots $actual $Current $false)){throw 'Rollback final state differs.'};$done=Copy-HeadsetProfileValue $staged;foreach($entry in $done.entries){if($entry.pending){$entry.pending=$false;[void]$entry.Remove('immediateBefore')}};Save-XearRecovery $RecoveryPath $done}catch{$rollbackErrors.Add($_.Exception.Message)}}
  if($rollbackErrors.Count){throw ('全局配置应用失败：'+$failure+'；恢复未完成，完整操作前快照已保留：'+($rollbackErrors -join '；'))}
  throw ('全局配置应用失败，已恢复并读回操作前全部音效：'+$failure)
 }
}
function Invoke-HeadsetProfileControl($Request,$Sdk,[string]$StorePath,[string]$RecoveryPath,[string]$MasterPath) {
 $action=$Request.action;$keys=@('action','endpointIds');if($action -in @('headset-profiles-create','headset-profiles-select','headset-profiles-delete')){$keys+='name'}
 Assert-HeadsetMasterKeys $Request $keys
 if($action -cnotin @('headset-profiles-list','headset-profiles-create','headset-profiles-select','headset-profiles-delete')){throw 'Unknown global profile operation.'}
 if($Request.endpointIds -isnot [array] -or $Request.endpointIds.Count -lt 1 -or $Request.endpointIds.Count -gt 2){throw 'One or two target endpoint IDs required.'}
 foreach($id in $Request.endpointIds){[void](Get-HeadsetMasterFlow $id)}
 if($action -cne 'headset-profiles-list' -and ($Request.name -isnot [string] -or $Request.name.Length -lt 1 -or $Request.name.Length -gt 128)){throw '全局配置名称不能为空，且不得超过128字符。'}
 $store=Read-HeadsetProfileStore $StorePath
 $current=Read-HeadsetProfileSnapshot $Sdk ([string[]]$Request.endpointIds)
 if($null -eq $store){$store=@{schemaVersion=1;currentName='Current';profiles=@(@{name='Default';snapshot=(Convert-HeadsetDefaultSnapshot $current)})};Save-HeadsetProfileStore $StorePath $store}
 # Refresh a stored selection against the real device. Current never overwrites a saved profile.
 $selected=@($store.profiles | Where-Object {$_.name -ceq $store.currentName})
 if($store.currentName -cne 'Current' -and $selected.Count -eq 1){try{$expected=Get-HeadsetProfileDesired $selected[0] $current;if(-not(Test-HeadsetProfileSnapshots $current $expected)){$store.currentName='Current';Save-HeadsetProfileStore $StorePath $store}}catch{$store.currentName='Current';Save-HeadsetProfileStore $StorePath $store}}
 if($action -ceq 'headset-profiles-list'){return New-HeadsetProfileReceipt $store $current $false $Sdk}
 if($action -ceq 'headset-profiles-create'){
  if(@($store.profiles | Where-Object {$_.name -ceq $Request.name}).Count){throw '配置名称已存在。'}
  if($store.profiles.Count -ge 128){throw '全局配置已达到128项上限。'}
  $store.profiles+=@(@{name=$Request.name;snapshot=(Copy-HeadsetProfileValue $current)});$store.currentName=$Request.name;Save-HeadsetProfileStore $StorePath $store
  return New-HeadsetProfileReceipt $store $current $true $Sdk
 }
 if($action -ceq 'headset-profiles-select' -and $Request.name -ceq 'Current'){$store.currentName='Current';Save-HeadsetProfileStore $StorePath $store;return New-HeadsetProfileReceipt $store $current $true $Sdk}
 $matches=@($store.profiles | Where-Object {$_.name -ceq $Request.name});if($matches.Count -ne 1){throw '所选全局配置不存在。'}
 if($action -ceq 'headset-profiles-delete' -and $Request.name -ceq 'Default'){throw '默认配置不能删除。'}
 $beforeStore=Copy-HeadsetProfileValue $store;$candidate=Copy-HeadsetProfileValue $store
 if($action -ceq 'headset-profiles-delete'){
  $candidate.profiles=@($candidate.profiles | Where-Object {$_.name -cne $Request.name})
  if($store.currentName -cne $Request.name){Save-HeadsetProfileStore $StorePath $candidate;return New-HeadsetProfileReceipt $candidate $current $false $Sdk}
  $name='Default'
 }else{$name=$Request.name;if($name -ceq 'Current'){return New-HeadsetProfileReceipt $store $current $true $Sdk}}
 $profile=@($candidate.profiles | Where-Object {$_.name -ceq $name})[0];$desired=Get-HeadsetProfileDesired $profile $current
 $candidate.currentName=$name
 if(Test-HeadsetProfileSnapshots $current $desired){Save-HeadsetProfileStore $StorePath $candidate;return New-HeadsetProfileReceipt $candidate $current $true $Sdk}
 $master=Read-HeadsetMasterLedger $MasterPath
 foreach($endpointId in $current.endpointId){$entry=Get-HeadsetMasterEntry $master $endpointId;if($entry -and $entry.pending){throw '总开关仍有未完成恢复事务，请先恢复。'}}
 $commit={Save-HeadsetProfileStore $StorePath $candidate};$rollback={Save-HeadsetProfileStore $StorePath $beforeStore}
 $actual=Invoke-HeadsetProfileTransaction $Sdk $current $desired $RecoveryPath $commit $rollback
 return New-HeadsetProfileReceipt $candidate $actual $true $Sdk
}
