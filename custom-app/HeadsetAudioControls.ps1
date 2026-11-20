# Fixed Windows/SDK audio controls and durable recovery. Loaded only by HeadsetBridge.
function Test-ControlDirectBackend($Backend){return $null-ne$Backend-and$Backend.PSObject.Properties['BackendKind']-and$Backend.BackendKind-ceq'windows-effect-store'}
function Get-ControlProperty($object,[string]$key){if($object -is [Collections.IDictionary]){return ,($object[$key])};return ,($object.$key)}
function Test-ControlNumber($value,[double]$min,[double]$max){return ($value -is [byte]-or$value -is [int]-or$value -is [long]-or$value -is [single]-or$value -is [double]-or$value -is [decimal])-and[double]::IsFinite([double]$value)-and[double]$value-ge$min-and[double]$value-le$max}
function Assert-ControlState([string]$kind,$state){
 if($null-eq$state){throw 'Audio recovery state is missing.'}
 $keys=if($state -is [Collections.IDictionary]){@($state.Keys)}else{@($state.PSObject.Properties.Name)}
 switch($kind){
  'channels' {if($keys.Count-ne1-or'levels'-notin$keys){throw 'Invalid channel state.'};$values=Get-ControlProperty $state 'levels';if($values -isnot [array]-or$values.Count-lt1-or$values.Count-gt128){throw 'Invalid channel array.'};foreach($value in $values){if(-not(Test-ControlNumber $value 0 1)){throw 'Channel values must be finite scalars 0..1.'}}}
  'session' {if($keys.Count-ne2-or'volume'-notin$keys-or'muted'-notin$keys-or-not(Test-ControlNumber (Get-ControlProperty $state 'volume') 0 100)-or(Get-ControlProperty $state 'muted') -isnot [bool]){throw 'Invalid session recovery state.'}}
  'format' {if($keys.Count-notin@(3,4)-or'channels'-notin$keys-or'bitDepth'-notin$keys-or'sampleRate'-notin$keys-or($keys.Count-eq4-and'rawBase64'-notin$keys)){throw 'Invalid audio format state.'};foreach($key in @('channels','bitDepth','sampleRate')){$value=Get-ControlProperty $state $key;if($value -isnot [int]-and$value -isnot [long]){throw 'Format fields must be integers.'}};if($state.channels-notin@(1,2,4,6,8)-or$state.bitDepth-notin@(16,24,32)-or$state.sampleRate-lt8000-or$state.sampleRate-gt384000){throw 'Audio format is outside the official candidate bounds.'};if('rawBase64'-in$keys){$base64=Get-ControlProperty $state 'rawBase64';if($base64-isnot[string]-or$base64.Length-gt5464){throw 'Invalid exact format recovery blob.'};[byte[]]$bytes=[Convert]::FromBase64String($base64);if($bytes.Length-lt18-or$bytes.Length-gt4096-or[Convert]::ToBase64String($bytes)-cne$base64-or$bytes.Length-ne(18+[BitConverter]::ToUInt16($bytes,16))-or[BitConverter]::ToUInt16($bytes,2)-ne$state.channels-or[BitConverter]::ToUInt16($bytes,14)-ne$state.bitDepth-or[BitConverter]::ToUInt32($bytes,4)-ne$state.sampleRate){throw 'Exact format blob and logical format disagree.'}}}
  'default' {$owner=Get-ControlProperty $state 'ownerEndpointId';if($keys.Count-notin@(1,2)-or'ownerEndpointId'-notin$keys-or($keys.Count-eq2-and'owners'-notin$keys)-or$owner -isnot [string]-or-not$owner-or$owner.Length-gt2048-or$owner.Contains([char]0)-or$owner-notmatch'^\{0\.0\.[01]\.00000000\}\.\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$'){throw 'Invalid default role owner.'};if('owners'-in$keys){$owners=Get-ControlProperty $state 'owners';if($owners-isnot[array]-or$owners.Count-ne3){throw 'All three original Windows role owners are required.'};$seen=@{};foreach($item in $owners){$names=if($item-is[Collections.IDictionary]){@($item.Keys)}else{@($item.PSObject.Properties.Name)};if($names.Count-ne4-or@($names|Where-Object {$_-cnotin@('flow','role','status','ownerEndpointId')}).Count-or$item.flow-cnotin@('render','capture')-or$item.role-cnotin@('console','multimedia','communications')-or$item.status-cne'read'-or$seen.ContainsKey($item.role)){throw 'Invalid exact Windows role owners.'};Assert-ControlState 'default' @{ownerEndpointId=$item.ownerEndpointId};$expectedPrefix=if($item.flow-ceq'render'){'{0.0.0.'}else{'{0.0.1.'};if(-not$item.ownerEndpointId.StartsWith($expectedPrefix,[StringComparison]::Ordinal)) {throw 'Saved Windows role owner direction mismatch.'};$seen[$item.role]=$true}}}
  default {throw 'Unknown audio control family.'}
 }
}
function Read-AudioControlRecovery([string]$path){
 if(-not(Test-Path -LiteralPath $path)){return @{schemaVersion=1;entries=@()}}
 if((Get-Item -LiteralPath $path).Length-gt1048576){throw 'Audio recovery file is too large; original preserved.'}
 $record=[IO.File]::ReadAllText($path)|ConvertFrom-Json -AsHashtable
 if($record.schemaVersion-ne1-or$record.entries -isnot [array]-or$record.entries.Count-gt256){throw 'Invalid audio recovery record; original preserved.'}
 $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
 foreach($entry in $record.entries){
  if($entry.kind-notin@('channels','session','format','default')-or$entry.endpointId -isnot [string]-or-not$entry.endpointId-or$entry.endpointId.Length-gt2048-or$entry.endpointId.Contains([char]0)-or$entry.endpointId-notmatch'^\{0\.0\.[01]\.00000000\}\.\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$'-or$entry.usbInstanceId -isnot [string]-or$entry.usbInstanceId-notlike'USB\VID_0E6A&PID_0110*'-or$entry.pending -isnot [bool]){throw 'Invalid audio recovery entry.'}
  if($entry.kind-eq'session'-and($entry.sessionId -isnot [string]-or-not$entry.sessionId-or$entry.sessionId.Length-gt2048-or$entry.sessionId.Contains([char]0))){throw 'Invalid recovery session identity.'}
  if($entry.kind-eq'default'-and$entry.role-notin@(1,2)){throw 'Invalid recovery role.'}
  $key=$entry.endpointId+'|'+$entry.kind+'|'+$entry.sessionId+'|'+$entry.role;if(-not$seen.Add($key)){throw 'Duplicate audio recovery entry.'}
  Assert-ControlState $entry.kind $entry.state
  if($entry.pending){Assert-ControlState $entry.kind $entry.immediateBefore}
  foreach($name in @('recoveryTarget','policyBefore')){if($entry.ContainsKey($name)){Assert-ControlState $entry.kind $entry[$name]}}
  if($entry.ContainsKey('recoveryRemovesEntry')-and$entry.recoveryRemovesEntry-isnot[bool]){throw 'Invalid direct policy recovery intent.'}
  if($entry.kind-eq'default'){
   $flow=if($entry.endpointId.StartsWith('{0.0.0.',[StringComparison]::Ordinal)){'render'}else{'capture'};$roleName=if($entry.role-eq1){'multimedia'}else{'communications'}
   foreach($stateName in @('state','immediateBefore','recoveryTarget','policyBefore')){if(-not$entry.ContainsKey($stateName)){continue};$saved=$entry[$stateName];if($saved.ContainsKey('owners')){if(@($saved.owners|Where-Object {$_.flow-cne$flow}).Count){throw 'Saved role owners belong to another endpoint direction.'};$selected=@($saved.owners|Where-Object {$_.role-ceq$roleName});if($selected.Count-ne1-or$selected[0].ownerEndpointId-cne$saved.ownerEndpointId){throw 'Saved default owner conflicts with its exact role-owner snapshot.'}}}
  }
 }
 return $record
}
function Save-AudioControlRecovery([string]$path,$record){
 $parent=Split-Path $path;[IO.Directory]::CreateDirectory($parent)|Out-Null
 $temp=$path+'.'+[guid]::NewGuid().ToString('N')+'.tmp';$stream=$null
 try{$bytes=[Text.Encoding]::UTF8.GetBytes(($record|ConvertTo-Json -Depth 12 -Compress));$stream=[IO.FileStream]::new($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true);$stream.Dispose();$stream=$null;[IO.File]::Move($temp,$path,$true)}finally{if($stream){$stream.Dispose()}}
}
function New-ControlFormat($state){$format=[PeripheralHub.XearFormat]::new();$format.Channels=$state.channels;$format.BitDepth=$state.bitDepth;$format.SampleRate=$state.sampleRate;return $format}
function Convert-ControlFormat($format){return @{channels=[int]$format.Channels;bitDepth=[int]$format.BitDepth;sampleRate=[int]$format.SampleRate}}
function Get-ControlEndpoint([string]$endpointId,$sdk=$null){
 if($sdk){
  if($endpointId-notmatch'^\{0\.0\.([01])\.00000000\}\.\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$'){throw 'Invalid audio endpoint identity.'}
  $flow=if($Matches[1]-eq'0'){'render'}else{'capture'};$endpoint=$sdk.FindTarget($endpointId,$flow)
  if(Test-ControlDirectBackend $sdk){if($endpoint.EndpointId-ine$endpointId-or$endpoint.Flow-cne$flow-or$endpoint.UsbInstanceId-notmatch'^USB\\VID_0E6A&PID_0110\\[^\\\x00-\x1f]+$'){throw 'Direct audio control identity changed.'};return @{endpointId=$endpointId;flow=$flow;usbInstanceId=[string]$endpoint.UsbInstanceId}}
  return @{endpointId=$endpointId;flow=$flow;usbInstanceId=[string][PeripheralHub.XearAudio]::Scalar($endpoint.Properties['USBDeviceInstanceID'],5)}
 }
 $evidence=Get-HeadsetSystemEvidence;$matches=@($evidence.devices|Where-Object {$_.endpointId-ceq$endpointId})
 if($matches.Count-ne1){throw 'The selected audio endpoint failed current USB identity verification.'}
 $detail=$evidence.details[$endpointId]
 return @{endpointId=$endpointId;flow=$matches[0].flow;usbInstanceId=[string]$detail.target.instanceId}
}
function Get-ControlSdkEndpoint($sdk,$target){return $sdk.FindTarget($target.endpointId,$target.flow)}
function Get-ControlRoleOwner($sdk,[string]$flow,[int]$role){
 if(Test-ControlDirectBackend $sdk){Initialize-HeadsetWindowsAudio;$name=switch($role){1{'multimedia'}2{'communications'}default{throw 'Invalid Windows role.'}};$owner=[PeripheralHub.WindowsAudioPolicy]::ReadRoleOwner($flow,$name);if($owner.Status-cne'read'-or-not$owner.OwnerEndpointId){throw 'The previous Windows role owner is unknown.'};return $owner.OwnerEndpointId}
 $uids=@($sdk.ReadRoleOwners($flow,$role));if($uids.Count-ne1){throw 'The previous default role owner cannot be uniquely determined.'}
 return [string][PeripheralHub.XearAudio]::Scalar($sdk.ReadAllowed($uids[0],'EndpointID'),5)
}
function Read-ControlWindowsRoleOwners([string]$Flow){Initialize-HeadsetWindowsAudio;return ,@([PeripheralHub.WindowsAudioPolicy]::ReadAllRoleOwners($Flow))}
function Read-ControlState($sdk,$target,[string]$kind,[string]$sessionId='',[int]$role=0){
 switch($kind){
  'channels' {return @{levels=@([PeripheralHub.AudioExtras]::GetChannels($target.endpointId).Levels|ForEach-Object {[double]$_})}}
  'session' {$matches=@([PeripheralHub.AudioExtras]::ListSessions($target.endpointId)|Where-Object {$_.InstanceId-ceq$sessionId});if($matches.Count-ne1){throw 'Audio session has ended or does not belong to this endpoint.'};return @{volume=[double]$matches[0].Volume;muted=[bool]$matches[0].Muted}}
  'format' {if(Test-ControlDirectBackend $sdk){$format=Read-HeadsetWindowsDeviceFormat $target.endpointId;$result=Convert-ControlFormat $format;$result.rawBase64=[string]$format.RawBase64;Assert-ControlState 'format' $result;return $result};$endpoint=Get-ControlSdkEndpoint $sdk $target;return Convert-ControlFormat ($sdk.ReadFormat($endpoint.Uid))}
  'default' {if(Test-ControlDirectBackend $sdk){$owners=Convert-ControlWindowsOwners (Read-ControlWindowsRoleOwners $target.flow);$name=switch($role){1{'multimedia'}2{'communications'}default{throw 'Invalid Windows role.'}};$selected=@($owners|Where-Object {$_.role-ceq$name});if($selected.Count-ne1){throw 'Requested Windows role has no exact current owner.'};return @{ownerEndpointId=$selected[0].ownerEndpointId;owners=$owners}};return @{ownerEndpointId=(Get-ControlRoleOwner $sdk $target.flow $role)}}
 }
 throw 'Unknown audio control state.'
}
function Convert-ControlWindowsOwners($Owners){
 $result=@(foreach($owner in $Owners){@{flow=[string](Get-ControlProperty $owner 'flow');role=[string](Get-ControlProperty $owner 'role');status=[string](Get-ControlProperty $owner 'status');ownerEndpointId=[string](Get-ControlProperty $owner 'ownerEndpointId')}})
 if($result.Count-ne3){throw 'All three Windows role owners must be read before a policy write.'}
 Assert-ControlState 'default' @{ownerEndpointId=$result[0].ownerEndpointId;owners=$result};return ,$result
}
function Assert-ControlExactPolicy([string]$Kind,$State){
 Assert-ControlState $Kind $State
 if($Kind-eq'format'-and-not(Get-ControlProperty $State 'rawBase64')){throw 'Legacy format recovery contains only a tuple; exact raw restoration is unavailable.'}
 if($Kind-eq'default'-and-not(Get-ControlProperty $State 'owners')){throw 'Legacy role recovery contains only one owner; exact three-role restoration is unavailable.'}
}
function New-ControlPolicyCheckpoint([string]$Path,$Record,$Entry,[string]$Kind,[int]$Role,$ExpectedBefore=$null){
 $formatCommand=Get-Command Convert-ControlFormat;$ownersCommand=Get-Command Convert-ControlWindowsOwners;$assertCommand=Get-Command Assert-ControlExactPolicy;$equalCommand=Get-Command Test-ControlEqual;$saveCommand=Get-Command Save-AudioControlRecovery
 return {param($change)
  if($change.EndpointId-ine$Entry.endpointId-or$change.VendorSdkLoaded){throw 'Windows policy checkpoint endpoint or implementation mismatch.'}
  if($Kind-eq'format'){$before=& $formatCommand $change.BeforeFormat;$before.rawBase64=[string]$change.BeforeFormat.RawBase64}
  else{$owners=& $ownersCommand $change.BeforeOwners;$roleName=switch($Role){1{'multimedia'}2{'communications'}default{throw 'Invalid saved Windows role.'}};$owner=@($owners|Where-Object {$_.role-ceq$roleName});$before=@{ownerEndpointId=$owner[0].ownerEndpointId;owners=$owners}}
  & $assertCommand $Kind $before
  if($change.Status-ceq'prepared'-and$null-ne$ExpectedBefore-and-not(& $equalCommand $Kind $before $ExpectedBefore)){throw 'Windows policy state changed before the durable write checkpoint.'}
  $Entry.policyBefore=$before
  if(-not$Entry.ContainsKey('recoveryTarget')){$Entry.immediateBefore=$before}
  $Entry.pending=$true;$Entry.policyStatus=[string]$change.Status
  & $saveCommand $Path $Record
 }.GetNewClosure()
}
function Invoke-ControlWindowsPolicySet($Target,[string]$Kind,$State,[int]$Role,[scriptblock]$Checkpoint){
 Initialize-HeadsetWindowsAudio
 if($null-eq$Checkpoint){throw 'A durable policy checkpoint callback is required.'}
 $callback=[Action[PeripheralHub.WindowsAudioPolicyChange]]$Checkpoint
 if($Kind-eq'format'){
  if(Get-ControlProperty $State 'rawBase64'){return [PeripheralHub.WindowsAudioPolicy]::RestoreDefaultFormatRaw($Target.endpointId,[string]$State.rawBase64,$callback)}
  return [PeripheralHub.WindowsAudioPolicy]::SetDefaultFormat($Target.endpointId,[int]$State.channels,[int]$State.bitDepth,[int]$State.sampleRate,$callback)
 }
 if($Kind-eq'default'){
  if(Get-ControlProperty $State 'owners'){
   [PeripheralHub.WindowsAudioDefaultOwner[]]$owners=@(foreach($saved in $State.owners){$owner=[PeripheralHub.WindowsAudioDefaultOwner]::new();$owner.Flow=$saved.flow;$owner.Role=$saved.role;$owner.Status=$saved.status;$owner.OwnerEndpointId=$saved.ownerEndpointId;$owner})
   return [PeripheralHub.WindowsAudioPolicy]::RestoreDefaultRoles($Target.endpointId,$owners,$callback)
  }
  $roleName=switch($Role){1{'multimedia'}2{'communications'}default{throw 'Invalid Windows role.'}}
  return [PeripheralHub.WindowsAudioPolicy]::SetDefaultRole($Target.endpointId,$roleName,$callback)
 }
 throw 'Unknown direct Windows policy operation.'
}
function Clear-ControlPolicyPending($Entry){$Entry.pending=$false;foreach($name in @('immediateBefore','policyBefore','policyStatus','recoveryTarget')){[void]$Entry.Remove($name)}}
function Write-ControlState($sdk,$target,[string]$kind,$state,[string]$sessionId='',[int]$role=0,[scriptblock]$checkpoint=$null){
 Assert-ControlState $kind $state
 if(Test-ControlDirectBackend $sdk){$fresh=Get-ControlEndpoint $target.endpointId $sdk;if($fresh.usbInstanceId-ine$target.usbInstanceId){throw 'Windows audio control target USB identity changed.'}}
 if((Test-ControlDirectBackend $sdk)-and$kind-in@('format','default')){
  $change=Invoke-ControlWindowsPolicySet $target $kind $state $role $checkpoint
  if($change.Status-cnotin@('applied','unchanged')-or-not$change.ReadbackVerified-or$change.RecoveryRequired-or$change.VendorSdkLoaded){throw ('Windows policy operation '+$change.Status+': '+$change.Error+' '+$change.RecoveryError+' '+$change.CheckpointError)}
  $actual=Read-ControlState $sdk $target $kind $sessionId $role
  if(-not(Test-ControlEqual $kind $actual $state)){throw 'Windows policy exact readback does not match the requested state.'};return $actual
 }
 switch($kind){
  'channels' {[void][PeripheralHub.AudioExtras]::SetChannels($target.endpointId,[float[]]$state.levels)}
  'session' {[void][PeripheralHub.AudioExtras]::SetSession($target.endpointId,$sessionId,[nullable[float]][float]$state.volume,[nullable[bool]][bool]$state.muted)}
  'format' {$endpoint=Get-ControlSdkEndpoint $sdk $target;[void]$sdk.WriteFormat($endpoint.Uid,(New-ControlFormat $state))}
  'default' {$snapshot=$sdk.Snapshot();$owners=@($snapshot.Endpoints|Where-Object {try{([string][PeripheralHub.XearAudio]::Scalar($_.Properties['EndpointID'],5))-ceq$state.ownerEndpointId}catch{$false}});if($owners.Count-ne1){throw 'The saved default endpoint is no longer available.'};$expectedFlow=if($target.flow-eq'render'){1}else{2};if([int][PeripheralHub.XearAudio]::Scalar($owners[0].Properties['DataFlow'],2)-ne$expectedFlow){throw 'Default owner direction mismatch.'};[void]$sdk.SetDefaultRole($owners[0].Uid,$role)}
 }
 $actual=Read-ControlState $sdk $target $kind $sessionId $role
 if(-not(Test-ControlEqual $kind $actual $state)){throw 'Audio control readback does not match the requested state.'}
 return $actual
}
function Test-ControlEqual([string]$kind,$left,$right){
 try{Assert-ControlState $kind $left;Assert-ControlState $kind $right}catch{return $false}
 switch($kind){
  'channels' {if($left.levels.Count-ne$right.levels.Count){return $false};for($i=0;$i-lt$left.levels.Count;$i++){if([math]::Abs([double]$left.levels[$i]-[double]$right.levels[$i])-gt0.001){return $false}};return $true}
  'session' {return ([math]::Abs([double]$left.volume-[double]$right.volume)-le0.5-and$left.muted-eq$right.muted)}
  'format' {return $left.channels-eq$right.channels-and$left.bitDepth-eq$right.bitDepth-and$left.sampleRate-eq$right.sampleRate-and(-not(Get-ControlProperty $right 'rawBase64')-or(Get-ControlProperty $left 'rawBase64')-ceq(Get-ControlProperty $right 'rawBase64'))}
  'default' {if($left.ownerEndpointId-cne$right.ownerEndpointId){return $false};$expected=Get-ControlProperty $right 'owners';if($expected){$actual=Get-ControlProperty $left 'owners';if(-not$actual){return $false};foreach($owner in $expected){$match=@($actual|Where-Object {$_.flow-ceq$owner.flow-and$_.role-ceq$owner.role-and$_.status-ceq'read'});if($match.Count-ne1-or$match[0].ownerEndpointId-ine$owner.ownerEndpointId){return $false}}};return $true}
 };return $false
}
function Invoke-ControlChange($sdk,$target,[string]$kind,$desired,[string]$path,[string]$sessionId='',[int]$role=0){
 Assert-ControlState $kind $desired;$record=Read-AudioControlRecovery $path
 if(@($record.entries|Where-Object {$_.pending}).Count){throw 'An earlier audio control operation is unverified. Restore it before changing another control.'}
 $before=Read-ControlState $sdk $target $kind $sessionId $role
 Assert-ControlState $kind $before
 if(Test-ControlEqual $kind $before $desired){return $before}
 $entry=@($record.entries|Where-Object {$_.endpointId-ceq$target.endpointId-and$_.kind-eq$kind-and[string]$_.sessionId-ceq$sessionId-and[int]$_.role-eq$role})|Select-Object -First 1
 if(-not$entry){if($record.entries.Count-ge256){throw 'Audio recovery entry limit reached.'};$entry=@{endpointId=$target.endpointId;usbInstanceId=$target.usbInstanceId;kind=$kind;sessionId=$sessionId;role=$role;state=$before;pending=$false};$record.entries+=@($entry)}
 if($entry.usbInstanceId-ine$target.usbInstanceId){throw 'Audio recovery target identity has changed.'}
 $directPolicy=(Test-ControlDirectBackend $sdk)-and$kind-in@('format','default')
 if($directPolicy){Assert-ControlExactPolicy $kind $entry.state;Assert-ControlExactPolicy $kind $before}
 $entry.immediateBefore=$before;$entry.pending=$true;Save-AudioControlRecovery $path $record
 $callback=if($directPolicy){New-ControlPolicyCheckpoint $path $record $entry $kind $role $before}else{$null}
 try{$actual=Write-ControlState $sdk $target $kind $desired $sessionId $role $callback;Clear-ControlPolicyPending $entry;Save-AudioControlRecovery $path $record;return $actual}
 catch{$applyError=$_.Exception.Message;try{if($directPolicy){$entry.recoveryTarget=$before;Save-AudioControlRecovery $path $record;$callback=New-ControlPolicyCheckpoint $path $record $entry $kind $role};[void](Write-ControlState $sdk $target $kind $before $sessionId $role $callback);Clear-ControlPolicyPending $entry;Save-AudioControlRecovery $path $record}catch{throw ('Audio apply failed: '+$applyError+' Recovery also failed; pending snapshot retained: '+$_.Exception.Message)};throw ('Audio apply failed; the immediate previous state was restored: '+$applyError)}
}
function Convert-ControlChannels([string]$endpointId,$state,[bool]$applied=$false){$channels=@(for($i=0;$i-lt$state.levels.Count;$i++){@{channelRaw=$i;volumeRaw=[double]$state.levels[$i]}});$result=@{endpointId=$endpointId;support='supported';source='windows-system';verified=$true;state=@{channels=$channels}};if($applied){$result.applied=$true};return $result}
function Invoke-HeadsetAudioControl($request,$sdk,[string]$path){
 $action=[string]$request.action
 if($action-eq'headset-audio-controls-restore'){
  $record=Read-AudioControlRecovery $path;$restored=0;$errors=@()
  foreach($savedEntry in @($record.entries|Sort-Object -Property @{Expression={-not$_.pending}})){
   $entry=@($record.entries|Where-Object {$_.endpointId-ceq$savedEntry.endpointId-and$_.kind-ceq$savedEntry.kind-and[string]$_.sessionId-ceq[string]$savedEntry.sessionId-and[int]$_.role-eq[int]$savedEntry.role})|Select-Object -First 1
   if($null-eq$entry){continue}
   try{$target=Get-ControlEndpoint $entry.endpointId $sdk;if($target.usbInstanceId-ine$entry.usbInstanceId){throw 'Saved USB identity mismatch.'};$desired=if($entry.ContainsKey('recoveryTarget')){$entry.recoveryTarget}elseif($entry.pending){$entry.immediateBefore}else{$entry.state};$removeAfter=if($entry.ContainsKey('recoveryRemovesEntry')){$entry.recoveryRemovesEntry}else{-not$entry.pending};$callback=$null
    if((Test-ControlDirectBackend $sdk)-and$entry.kind-in@('format','default')){Assert-ControlExactPolicy $entry.kind $desired;$entry.recoveryTarget=$desired;$entry.recoveryRemovesEntry=$removeAfter;if(-not$entry.pending){$entry.immediateBefore=Read-ControlState $sdk $target $entry.kind $entry.sessionId $entry.role;$entry.pending=$true};Save-AudioControlRecovery $path $record;$callback=New-ControlPolicyCheckpoint $path $record $entry $entry.kind $entry.role}
    [void](Write-ControlState $sdk $target $entry.kind $desired $entry.sessionId $entry.role $callback)
    $candidate=ConvertFrom-Json -InputObject (ConvertTo-Json -InputObject $record -Depth 20 -Compress) -AsHashtable
    $matching=@($candidate.entries|Where-Object {$_.endpointId-ceq$entry.endpointId-and$_.kind-ceq$entry.kind-and[string]$_.sessionId-ceq[string]$entry.sessionId-and[int]$_.role-eq[int]$entry.role})
    if($matching.Count-ne1){throw 'Audio recovery entry disappeared during commit.'};$completed=$matching[0]
    if($removeAfter){$candidate.entries=@($candidate.entries|Where-Object {$_-ne$completed})}else{Clear-ControlPolicyPending $completed;[void]$completed.Remove('recoveryRemovesEntry')}
    Save-AudioControlRecovery $path $candidate;$record=$candidate;$restored++
    }catch{$errors+=($_.Exception.Message+' ['+$entry.kind+']')}
  };return @{restored=$restored;errors=$errors}
 }
 $target=Get-ControlEndpoint ([string]$request.endpointId) $sdk;$id=$target.endpointId
 switch($action){
  'headset-audio-channels-read' {return Convert-ControlChannels $id (Read-ControlState $sdk $target 'channels')}
  'headset-audio-balance-read' {$state=Read-ControlState $sdk $target 'channels';if($state.levels.Count-ne2){throw '左右平衡仅适用于具有两个音量声道的端点。'};return @{endpointId=$id;support='supported';source='windows-system';verified=$true;state=@{leftRaw=$state.levels[0];rightRaw=$state.levels[1]}}}
  'headset-audio-channels-set' {
   $current=Read-ControlState $sdk $target 'channels';$rows=@($request.state.channels);if($rows.Count-ne$current.levels.Count){throw '必须提供完整的实际音量声道。'}
   $desired=@{levels=@(for($i=0;$i-lt$rows.Count;$i++){if($rows[$i].channelRaw-ne$i){throw 'Channel indices must be ordered and complete.'};if(-not(Test-ControlNumber $rows[$i].volumeRaw 0 1)){throw 'Channel scalar must be 0..1.'};[double]$rows[$i].volumeRaw})}
   return Convert-ControlChannels $id (Invoke-ControlChange $sdk $target 'channels' $desired $path) $true
  }
  'headset-audio-balance-set' {$current=Read-ControlState $sdk $target 'channels';if($current.levels.Count-ne2){throw '左右平衡仅适用于两个音量声道。'};$state=Invoke-ControlChange $sdk $target 'channels' @{levels=@($request.state.leftRaw,$request.state.rightRaw)} $path;return @{endpointId=$id;support='supported';source='windows-system';verified=$true;applied=$true;state=@{leftRaw=$state.levels[0];rightRaw=$state.levels[1]}}}
  'headset-audio-peak-read' {return @{endpointId=$id;support='supported';source='windows-system';verified=$true;valuesRaw=@([PeripheralHub.AudioExtras]::GetPeaks($id)|ForEach-Object {[double]$_})}}
  'headset-audio-sessions-list' {return @{endpointId=$id;support='supported';source='windows-system';verified=$true;sessions=@([PeripheralHub.AudioExtras]::ListSessions($id)|ForEach-Object {@{sessionId=$_.InstanceId;processId=[long]$_.ProcessId;description=$_.Description;active=$_.Active;volume=[double]$_.Volume;muted=$_.Muted}})}}
  'headset-audio-sessions-set' {$sessionId=[string]$request.sessionId;$before=Read-ControlState $sdk $target 'session' $sessionId;$desired=@{volume=$before.volume;muted=$before.muted};$hasField=$false;foreach($field in @('volume','muted')){if($request.PSObject.Properties.Name-contains$field){$desired[$field]=$request.$field;$hasField=$true}};if(-not$hasField){throw 'No session changes supplied.'};$actual=Invoke-ControlChange $sdk $target 'session' $desired $path $sessionId;return @{sessionId=$sessionId;volume=$actual.volume;muted=$actual.muted;verified=$true}}
  'headset-audio-format-read' {if(Test-ControlDirectBackend $sdk){return Invoke-HeadsetWindowsAudioRead @{action=$action;endpointId=$id}};return @{endpointId=$id;support='supported';source='sdk';verified=$true;format=(Read-ControlState $sdk $target 'format')}}
  'headset-audio-format-list' {if(Test-ControlDirectBackend $sdk){return Invoke-HeadsetWindowsAudioRead @{action=$action;endpointId=$id}};$endpoint=Get-ControlSdkEndpoint $sdk $target;return @{endpointId=$id;support='supported';source='sdk';verified=$true;formats=@($sdk.ListFormats($endpoint.Uid)|ForEach-Object {Convert-ControlFormat $_})}}
  'headset-audio-format-set' {$desired=@{};foreach($key in @('channels','bitDepth','sampleRate')){$desired[$key]=$request.format.$key};[void](Invoke-ControlChange $sdk $target 'format' $desired $path);return @{applied=$true;verified=$true;warnings=@()}}
  'headset-audio-default-read' {if(Test-ControlDirectBackend $sdk){return Invoke-HeadsetWindowsAudioRead @{action=$action;endpointId=$id}};$endpoint=Get-ControlSdkEndpoint $sdk $target;$flags=$sdk.ReadDefaultRoles($endpoint.Uid);$roles=@();if($flags[0]){$roles+='multimedia'};if($flags[1]){$roles+='communications'};return @{endpointId=$id;support='supported';source='sdk';verified=$true;roles=$roles}}
  'headset-audio-default-set' {$role=switch([string]$request.role){'multimedia'{1};'communications'{2};default{throw 'Invalid audio default role.'}};[void](Invoke-ControlChange $sdk $target 'default' @{ownerEndpointId=$id} $path '' $role);return @{applied=$true;verified=$true;warnings=@()}}
  default {throw 'Unknown fixed headset audio operation.'}
 }
}
