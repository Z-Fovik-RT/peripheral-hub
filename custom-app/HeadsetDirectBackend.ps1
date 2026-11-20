# Fixed CAPX backend. The effect/master/profile ledgers still own their grouped transactions.
function Test-HeadsetDirectBackend($Backend) { return $null-ne$Backend-and$Backend.PSObject.Properties['BackendKind']-and$Backend.BackendKind-ceq'windows-effect-store' }
function Get-HeadsetEffectSource($Backend) { if(Test-HeadsetDirectBackend $Backend){return 'windows-effect-store'};return 'sdk' }
function New-HeadsetDirectBackend([string]$JournalPath) {
 $backend=[pscustomobject]@{BackendKind='windows-effect-store';JournalPath=$JournalPath;Recovering=$false}
 $backend|Add-Member ScriptMethod FindTarget {param([string]$Id,[string]$Flow) return Get-HeadsetDirectEndpoint $Id $Flow}
 $backend|Add-Member ScriptMethod Dispose {}
 return $backend
}
function Invoke-HeadsetDirectNativeRead([string]$EndpointId) { return [PeripheralHub.IkfDirectAudio]::ReadEndpoint($EndpointId) }
function Invoke-HeadsetDirectNativeSet([string]$EndpointId,[string]$Feature,[Collections.IDictionary]$State,[Action[PeripheralHub.IkfDirectWriteResult]]$Checkpoint) { return [PeripheralHub.IkfDirectAudio]::SetEndpointState($EndpointId,$Feature,$State,$Checkpoint) }
function Get-HeadsetDirectEndpoint([string]$EndpointId,[string]$Flow) {
 $snapshot=Invoke-HeadsetDirectNativeRead $EndpointId
 if(-not$snapshot.IdentityVerified-or$snapshot.EndpointId-ine$EndpointId-or$snapshot.Flow-cne$Flow-or$snapshot.UsbParentId-notmatch'^USB\\VID_0E6A&PID_0110\\[^\\\x00-\x1f]+$'){throw ('Direct effect endpoint identity is unavailable: '+$snapshot.Error)}
 return [pscustomobject]@{BackendKind='windows-effect-store';EndpointId=$snapshot.EndpointId;Flow=$snapshot.Flow;UsbInstanceId=$snapshot.UsbParentId;Snapshot=$snapshot}
}
function Read-HeadsetDirectState($Endpoint,[string]$Feature) {
 $actual=Get-HeadsetDirectEndpoint $Endpoint.EndpointId $Endpoint.Flow
 if($actual.UsbInstanceId-ine$Endpoint.UsbInstanceId-or-not$actual.Snapshot.States.ContainsKey($Feature)){throw 'Direct effect state is incomplete or its current USB identity changed.'}
 $state=[ordered]@{};foreach($key in (Get-XearEffectMap)[$Feature].fields.Keys){$state[$key]=$actual.Snapshot.States[$Feature][$key]}
 Assert-XearState $Feature $state;return $state
}
function Copy-HeadsetDirectValue($Value) {return ConvertFrom-Json -InputObject (ConvertTo-Json -InputObject $Value -Depth 24 -Compress) -AsHashtable}
function Convert-HeadsetDirectRaw($Values,[string]$Feature) {
 return ,@(foreach($value in $Values){
  if($value.Property.Feature-cne$Feature-or$value.Status-cne'read'-or$null-eq$value.VariantType-or$null-eq$value.RawDword){throw 'Direct checkpoint requires every exact raw DWORD and variant type.'}
  [ordered]@{context=$value.Property.Context;propertyGuid=$value.Property.PropertyGuid;propertyId=[long]$value.Property.PropertyId;field=$value.Property.Field;index=[int]$value.Property.Index;variantType=[int]$value.VariantType;rawDword=[long]$value.RawDword}
 })
}
function Assert-HeadsetDirectSnapshot($Snapshot,[string]$Feature,[string]$EndpointId,[string]$Usb) {
 Assert-HeadsetMasterKeys $Snapshot @('identity','state','values')
 Assert-HeadsetMasterKeys $Snapshot.identity @('endpointId','flow','usbInstanceId','usbInterfaceId','endpointInstanceId')
 if($Snapshot.identity.endpointId-ine$EndpointId-or$Snapshot.identity.usbInstanceId-ine$Usb-or$Snapshot.identity.flow-cne(Get-HeadsetMasterFlow $EndpointId)-or$Snapshot.identity.usbInterfaceId-notmatch'^USB\\VID_0E6A&PID_0110&MI_00\\[^\\\x00-\x1f]+$'-or$Snapshot.identity.endpointInstanceId-ine('SWD\MMDEVAPI\'+$EndpointId)){throw 'Direct recovery identity is invalid.'}
 Assert-XearState $Feature $Snapshot.state
 $fields=@([PeripheralHub.IkfDirectAudio]::Describe($Snapshot.identity.flow)|Where-Object {$_.Feature-ceq$Feature})
 if($Snapshot.values-isnot[array]-or$Snapshot.values.Count-ne$fields.Count){throw 'Direct recovery raw field set is incomplete.'}
 $seen=@{}
 foreach($value in $Snapshot.values){
  Assert-HeadsetMasterKeys $value @('context','propertyGuid','propertyId','field','index','variantType','rawDword')
  $key=$value.context+'|'+$value.propertyGuid+'|'+$value.propertyId
  $matches=@($fields|Where-Object {$_.Context-ceq$value.context-and$_.PropertyGuid-ceq$value.propertyGuid-and$_.PropertyId-eq$value.propertyId-and$_.Field-ceq$value.field-and$_.Index-eq$value.index})
  if($seen.ContainsKey($key)-or$matches.Count-ne1-or$value.variantType-notin@(3,19)-or($value.rawDword-isnot[int]-and$value.rawDword-isnot[long])-or$value.rawDword-lt0-or$value.rawDword-gt4294967295){throw 'Direct recovery contains duplicate, unknown or invalid raw fields.'};$seen[$key]=$true
  $field=$matches[0];$expected=if($field.Boolean){[int][bool]$Snapshot.state[$field.Field]}elseif($field.Index-ge0){[int]$Snapshot.state[$field.Field][$field.Index]}else{[int]$Snapshot.state[$field.Field]}
  $signed=[BitConverter]::ToInt32([BitConverter]::GetBytes([uint32]$value.rawDword),0)
  if($signed-ne$expected){throw 'Direct recovery logical state and exact raw DWORD disagree.'}
 }
}
function Read-HeadsetDirectLedger([string]$Path) {
 if(-not[IO.File]::Exists($Path)){return @{schemaVersion=1;entries=@()}}
 try{
  if((Get-Item -LiteralPath $Path).Length-gt2097152){throw 'Direct recovery file exceeds2MiB.'}
  $record=ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($Path)) -AsHashtable -ErrorAction Stop
  Assert-HeadsetMasterKeys $record @('schemaVersion','entries');if($record.schemaVersion-ne1-or$record.entries-isnot[array]-or$record.entries.Count-gt128){throw 'Direct recovery schema is invalid.'}
  $seen=@{}
  foreach($entry in $record.entries){
   $names=@('endpointId','usbInstanceId','feature','baseline','pending','lastStatus');if($entry.pending){$names+='immediateBefore'};if($entry.ContainsKey('restoreTarget')){$names+='restoreTarget'}
   Assert-HeadsetMasterKeys $entry $names
   if($entry.pending-isnot[bool]-or$entry.usbInstanceId-notmatch'^USB\\VID_0E6A&PID_0110\\[^\\\x00-\x1f]+$'-or$entry.lastStatus-isnot[string]){throw 'Direct recovery flags or USB identity are invalid.'}
   $key=$entry.endpointId+'|'+$entry.feature;if($seen.ContainsKey($key)){throw 'Duplicate direct recovery target.'};$seen[$key]=$true
   Assert-HeadsetDirectSnapshot $entry.baseline $entry.feature $entry.endpointId $entry.usbInstanceId
   if($entry.pending){Assert-HeadsetDirectSnapshot $entry.immediateBefore $entry.feature $entry.endpointId $entry.usbInstanceId}
   if($entry.ContainsKey('restoreTarget')){Assert-HeadsetDirectSnapshot $entry.restoreTarget $entry.feature $entry.endpointId $entry.usbInstanceId}
  }
  return $record
 }catch{throw ('Direct effect recovery record is corrupt; preserved: '+$_.Exception.Message)}
}
function Find-HeadsetDirectEntry($Record,[string]$EndpointId,[string]$Feature){foreach($entry in $Record.entries){if($entry.endpointId-ieq$EndpointId-and$entry.feature-ceq$Feature){return $entry}};return $null}
function New-HeadsetDirectRawSnapshot($Result) {
 $identity=$Result.Identity
 if(-not$identity.IdentityVerified-or$identity.EndpointId-ine$Result.EndpointId){throw 'Native direct checkpoint has no verified identity.'}
 $snapshot=@{identity=@{endpointId=$identity.EndpointId;flow=$identity.Flow;usbInstanceId=$identity.UsbParentId;usbInterfaceId=$identity.UsbInterfaceId;endpointInstanceId=$identity.EndpointInstanceId};state=(Copy-HeadsetDirectValue $Result.BeforeState);values=(Convert-HeadsetDirectRaw $Result.Before $Result.Feature)}
 Assert-HeadsetDirectSnapshot $snapshot $Result.Feature $Result.EndpointId $identity.UsbParentId;return $snapshot
}
function Set-HeadsetDirectState($Backend,$Endpoint,[string]$Feature,[Collections.IDictionary]$State) {
 Assert-XearState $Feature $State
 $record=Read-HeadsetDirectLedger $Backend.JournalPath
 if(-not$Backend.Recovering-and@($record.entries|Where-Object {$_.pending-or$_.ContainsKey('restoreTarget')}).Count){throw 'A direct effect transaction requires recovery before another write.'}
 $prior=Find-HeadsetDirectEntry $record $Endpoint.EndpointId $Feature
 if($prior){
  $fresh=Get-HeadsetDirectEndpoint $Endpoint.EndpointId $Endpoint.Flow
  if($fresh.UsbInstanceId-ine$prior.usbInstanceId){throw 'Direct effect baseline belongs to another USB headset.'}
  $raw=Convert-HeadsetDirectRaw @($fresh.Snapshot.Values|Where-Object {$_.Property.Feature-ceq$Feature}) $Feature
  foreach($saved in $prior.baseline.values){$matches=@($raw|Where-Object {$_.context-ceq$saved.context-and$_.propertyGuid-ceq$saved.propertyGuid-and$_.propertyId-eq$saved.propertyId});if($matches.Count-ne1-or$matches[0].variantType-ne$saved.variantType){throw 'Direct effect property type differs from its saved exact baseline.'}}
 }
 $before=Read-HeadsetDirectState $Endpoint $Feature
 $checkpoint={param($result)
  $snapshot=New-HeadsetDirectRawSnapshot $result
  if($result.Status-ceq'prepared'){foreach($field in (Get-XearEffectMap)[$Feature].fields.Keys){if((ConvertTo-Json -InputObject $snapshot.state[$field] -Compress)-cne(ConvertTo-Json -InputObject $before[$field] -Compress)){throw 'Direct effect changed between the application read and the native write checkpoint.'}}}
  $entry=Find-HeadsetDirectEntry $record $result.EndpointId $result.Feature
  if($null-eq$entry){if($record.entries.Count-ge128){throw 'Direct recovery entry limit reached.'};$entry=@{endpointId=$result.EndpointId;usbInstanceId=$snapshot.identity.usbInstanceId;feature=$result.Feature;baseline=$snapshot;pending=$false;lastStatus='prepared'};$record.entries+=@($entry)}
  if($entry.usbInstanceId-ine$snapshot.identity.usbInstanceId){throw 'Direct checkpoint belongs to another USB headset.'}
  if($result.Status-ceq'prepared'){$entry.immediateBefore=$snapshot}
  $entry.pending=[bool]($result.RecoveryRequired-or$entry.ContainsKey('restoreTarget'))
  if(-not$entry.pending){[void]$entry.Remove('immediateBefore')}
  $entry.lastStatus=[string]$result.Status
  Save-XearRecovery $Backend.JournalPath $record
 }.GetNewClosure()
 $callback=[Action[PeripheralHub.IkfDirectWriteResult]]$checkpoint
 $result=Invoke-HeadsetDirectNativeSet $Endpoint.EndpointId $Feature $State $callback
 if($result.Status-cnotin@('applied','unchanged')-or-not$result.ReadbackVerified-or$result.RecoveryRequired-or$result.VendorSdkLoaded){throw ('Direct effect transaction '+$result.Status+': '+$result.Error+' '+$result.RecoveryError+' '+$result.CheckpointError)}
 return Copy-HeadsetDirectValue $result.ActualState
}
function Invoke-HeadsetDirectPendingRecovery($Backend) {
 $record=Read-HeadsetDirectLedger $Backend.JournalPath;$restored=0
 foreach($entry in @($record.entries|Where-Object {$_.pending-or$_.ContainsKey('restoreTarget')})){
  $target=if($entry.ContainsKey('restoreTarget')){$entry.restoreTarget}else{$entry.immediateBefore}
  $endpoint=Get-HeadsetDirectEndpoint $entry.endpointId $target.identity.flow
  if($endpoint.UsbInstanceId-ine$entry.usbInstanceId){throw 'Pending direct recovery target USB identity changed.'}
  $values=@($endpoint.Snapshot.Values|Where-Object {$_.Property.Feature-ceq$entry.feature})
  $actualRaw=Convert-HeadsetDirectRaw $values $entry.feature
  foreach($saved in $target.values){$match=@($actualRaw|Where-Object {$_.context-ceq$saved.context-and$_.propertyGuid-ceq$saved.propertyGuid-and$_.propertyId-eq$saved.propertyId});if($match.Count-ne1-or$match[0].variantType-ne$saved.variantType){throw 'Direct recovery refuses an altered property type.'}}
  $entry.restoreTarget=Copy-HeadsetDirectValue $target;Save-XearRecovery $Backend.JournalPath $record
  $Backend.Recovering=$true
  try{[void](Set-HeadsetDirectState $Backend $endpoint $entry.feature $target.state)}finally{$Backend.Recovering=$false}
  $after=Get-HeadsetDirectEndpoint $entry.endpointId $target.identity.flow;$afterRaw=Convert-HeadsetDirectRaw @($after.Snapshot.Values|Where-Object {$_.Property.Feature-ceq$entry.feature}) $entry.feature
  foreach($saved in $target.values){$match=@($afterRaw|Where-Object {$_.context-ceq$saved.context-and$_.propertyGuid-ceq$saved.propertyGuid-and$_.propertyId-eq$saved.propertyId});if($match.Count-ne1-or$match[0].variantType-ne$saved.variantType-or$match[0].rawDword-ne$saved.rawDword){throw 'Direct recovery exact raw DWORD/type verification failed.'}}
  $record=Read-HeadsetDirectLedger $Backend.JournalPath;$current=Find-HeadsetDirectEntry $record $entry.endpointId $entry.feature;$current.pending=$false;[void]$current.Remove('restoreTarget');[void]$current.Remove('immediateBefore');$current.lastStatus='recovered';Save-XearRecovery $Backend.JournalPath $record;$restored++
 }
 return $restored
}
function Clear-HeadsetDirectRecoveredBaselines($Backend,[string]$EffectsPath,[string]$MasterPath) {
 $record=Read-HeadsetDirectLedger $Backend.JournalPath
 if(-not[IO.File]::Exists($Backend.JournalPath)){return}
 $effects=Read-XearRecovery $EffectsPath;$master=Read-HeadsetMasterLedger $MasterPath
 $keep=@(foreach($entry in $record.entries){
  $effectEntries=@($effects.entries|Where-Object {$_.endpointId-ieq$entry.endpointId-and$_.feature-ceq$entry.feature})
  $masterEntries=@($master.entries|Where-Object {$_.endpointId-ieq$entry.endpointId})
  if($entry.pending-or$entry.ContainsKey('restoreTarget')-or$effectEntries.Count-or$masterEntries.Count){$entry}
 })
 if($keep.Count-ne$record.entries.Count){$record.entries=$keep;Save-XearRecovery $Backend.JournalPath $record}
}
