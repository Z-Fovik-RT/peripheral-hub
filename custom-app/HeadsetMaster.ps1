# Official master switch: durable intent and enabled flags only. HeadsetEffects.ps1 must be loaded first.
function Get-HeadsetMasterKeys($Object) {
 if($Object -is [Collections.IDictionary]) { return @($Object.Keys) }
 if($null -ne $Object -and $Object -is [pscustomobject]) { return @($Object.PSObject.Properties.Name) }
 throw 'Master state must be an object.'
}
function Assert-HeadsetMasterKeys($Object,[string[]]$Names) {
 $keys=@(Get-HeadsetMasterKeys $Object)
 if($keys.Count -ne $Names.Count) { throw 'Missing or extra master fields.' }
 foreach($name in $Names) { if($name -cnotin $keys) { throw ('Missing master field: '+$name) } }
}
function Get-HeadsetMasterFlow($EndpointId) {
 if($EndpointId -isnot [string] -or $EndpointId -cnotmatch '^\{0\.0\.([01])\.00000000\}\.\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$') { throw 'Invalid master endpoint identity.' }
 if($Matches[1] -eq '0') { return 'render' }; return 'capture'
}
function Get-HeadsetMasterFeatures([string]$Flow) {
 $map=Get-XearEffectMap
 $categories=if($Flow -eq 'render') { @(5,12,11,7,17,18,19) } elseif($Flow -eq 'capture') { @(1,14) } else { throw 'Invalid master direction.' }
 return @(foreach($category in $categories) {
  $features=@($map.Keys | Where-Object { $map[$_].flow -eq $Flow -and $map[$_].license -eq $category })
  if($features.Count -ne 1) { throw 'The fixed master effect map is incomplete.' }; [string]$features[0]
 })
}
function Assert-HeadsetMasterFlags($Flags,[string]$Flow) {
 $order=@(Get-HeadsetMasterFeatures $Flow)
 if($Flags -isnot [array] -or $Flags.Count -lt 1 -or $Flags.Count -gt $order.Count) { throw 'Invalid master flags array.' }
 $last=-1
 foreach($flag in $Flags) {
  Assert-HeadsetMasterKeys $flag @('feature','enabled')
  if($flag.feature -isnot [string] -or $flag.enabled -isnot [bool]) { throw 'Master flags require a known feature and a strict boolean.' }
  $index=[array]::IndexOf($order,$flag.feature)
  if($index -le $last) { throw 'Unknown, duplicate or unordered master feature.' }; $last=$index
 }
}
function Assert-HeadsetMasterRecord($Record) {
 Assert-HeadsetMasterKeys $Record @('schemaVersion','entries')
 if(($Record.schemaVersion -isnot [int] -and $Record.schemaVersion -isnot [long]) -or $Record.schemaVersion -ne 1 -or $Record.entries -isnot [array] -or $Record.entries.Count -gt 128) { throw 'Invalid master recovery record.' }
 $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
 foreach($entry in $Record.entries) {
  if($entry.pending -isnot [bool]) { throw 'Invalid master pending flag.' }
  $keys=@('endpointId','usbInstanceId','baselineFlags','disabledFlags','enabled','pending')
  if($entry.pending) { $keys+=@('immediateBefore','desiredFlags','previousEnabled','desiredEnabled') }
  Assert-HeadsetMasterKeys $entry $keys
  $flow=Get-HeadsetMasterFlow $entry.endpointId
  if(-not $seen.Add($entry.endpointId) -or $entry.usbInstanceId -isnot [string] -or $entry.usbInstanceId.Length -gt 2048 -or $entry.usbInstanceId -notmatch '^USB\\VID_0E6A&PID_0110\\[^\\\x00-\x1f]+$' -or $entry.enabled -isnot [bool]) { throw 'Invalid master recovery identity or intent.' }
  Assert-HeadsetMasterFlags $entry.baselineFlags $flow
  Assert-HeadsetMasterFlags $entry.disabledFlags $flow
  if($entry.pending) {
   Assert-HeadsetMasterFlags $entry.immediateBefore $flow
   Assert-HeadsetMasterFlags $entry.desiredFlags $flow
   if($entry.previousEnabled -isnot [bool] -or $entry.desiredEnabled -isnot [bool] -or $entry.enabled -ne $entry.previousEnabled -or (($entry.immediateBefore.feature | ConvertTo-Json -Compress) -cne ($entry.desiredFlags.feature | ConvertTo-Json -Compress))) { throw 'Invalid master pending transaction.' }
  }
 }
}
function Read-HeadsetMasterLedger([string]$LedgerPath) {
 if(-not [IO.File]::Exists($LedgerPath)) { return @{schemaVersion=1;entries=@()} }
 try {
  if((Get-Item -LiteralPath $LedgerPath -ErrorAction Stop).Length -gt 1048576) { throw 'Master recovery file exceeds the size limit.' }
  $record=ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($LedgerPath)) -AsHashtable -ErrorAction Stop
  Assert-HeadsetMasterRecord $record
  return $record
 } catch { throw ('Master recovery record is corrupt; original preserved: '+$_.Exception.Message) }
}
function Save-HeadsetMasterLedger([string]$LedgerPath,$Record) {
 Assert-HeadsetMasterRecord $Record
 $bytes=[Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $Record -Depth 16 -Compress))
 if($bytes.Length -gt 1048576) { throw 'Master recovery file exceeds the size limit.' }
 $absolute=[IO.Path]::GetFullPath($LedgerPath); $parent=[IO.Path]::GetDirectoryName($absolute)
 [void][IO.Directory]::CreateDirectory($parent)
 $temp=$absolute+'.'+[guid]::NewGuid().ToString('N')+'.tmp'; $stream=$null
 try {
  $stream=[IO.FileStream]::new($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true); $stream.Dispose(); $stream=$null
  [IO.File]::Move($temp,$absolute,$true)
 } finally { if($stream) { $stream.Dispose() }; if([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) } }
}
function Copy-HeadsetMasterValue($Value) { return ConvertFrom-Json -InputObject (ConvertTo-Json -InputObject $Value -Depth 16 -Compress) -AsHashtable }
function Get-HeadsetMasterEntry($Record,[string]$EndpointId) {
 foreach($entry in $Record.entries) { if($entry.endpointId -ieq $EndpointId) { return $entry } }; return $null
}
function Get-HeadsetMasterEndpoint($Sdk,[string]$EndpointId,[string]$ExpectedUsb='') {
 $flow=Get-HeadsetMasterFlow $EndpointId
 if(Test-HeadsetDirectBackend $Sdk){
  $endpoint=$Sdk.FindTarget($EndpointId,$flow)
  if($ExpectedUsb-and$endpoint.UsbInstanceId-ine$ExpectedUsb){throw 'Master target USB identity or direction changed.'}
  $features=@(Get-HeadsetMasterFeatures $flow|Where-Object {$endpoint.Snapshot.States.ContainsKey($_)})
  if($features.Count-ne@(Get-HeadsetMasterFeatures $flow).Count){throw 'One or more target effect families are unreadable; a grouped master/profile transaction is unavailable.'}
  return @{endpointId=$EndpointId;flow=$flow;usbInstanceId=$endpoint.UsbInstanceId;endpoint=$endpoint;features=$features}
 }
 $endpoint=$Sdk.FindTarget($EndpointId,$flow)
 $usb=[PeripheralHub.XearAudio]::Scalar($endpoint.Properties['USBDeviceInstanceID'],5)
 $id=[PeripheralHub.XearAudio]::Scalar($endpoint.Properties['EndpointID'],5)
 $actualFlow=[PeripheralHub.XearAudio]::Scalar($endpoint.Properties['DataFlow'],2)
 if($id -isnot [string] -or $id -ine $EndpointId -or $usb -isnot [string] -or $usb.Length -gt 2048 -or $usb -notmatch '^USB\\VID_0E6A&PID_0110\\[^\\\x00-\x1f]+$' -or $actualFlow -ne $(if($flow -eq 'render'){1}else{2}) -or ($ExpectedUsb -and $usb -ine $ExpectedUsb)) { throw 'Master target USB identity or direction changed.' }
 $license=$endpoint.Properties['SupportedLicenseCategory']
 if($null -eq $license -or $license.Error -ne 0 -or $license.DataType -ne 2 -or $license.ValidationError -or $license.Value -isnot [array] -or $license.Count -ne $license.Value.Count -or $license.Count -lt 1 -or $license.Count -gt 10) { throw 'Invalid master supported-license list.' }
 $map=Get-XearEffectMap; $order=@(Get-HeadsetMasterFeatures $flow); $seen=@{}
 foreach($category in $license.Value) {
  if($category -isnot [int] -or $seen.ContainsKey($category) -or ($category -ne 0 -and $category -notin @($order | ForEach-Object { $map[$_].license }))) { throw 'Unknown, duplicate or extraneous master license category.' }; $seen[$category]=$true
 }
 $features=@($order | Where-Object { $map[$_].license -in $license.Value })
 if($features.Count -eq 0) { throw 'This endpoint has no supported licensed effect families.' }
 return @{endpointId=$EndpointId;flow=$flow;usbInstanceId=$usb;endpoint=$endpoint;features=$features}
}
function Read-HeadsetMasterSnapshot($Sdk,$Target) {
 $states=[ordered]@{}
 foreach($feature in $Target.features) { $state=Read-XearEffectState $Sdk $Target.endpoint $feature; Assert-XearState $feature $state; $states[$feature]=$state }
 return $states
}
function Get-HeadsetMasterFlags($Snapshot) { return ,@(foreach($feature in $Snapshot.Keys) { @{feature=[string]$feature;enabled=[bool]$Snapshot[$feature].enabled} }) }
function Test-HeadsetMasterSnapshot($Left,$Right,[bool]$IgnoreEnabled=$false) {
 if(($Left.Keys -join '|') -cne ($Right.Keys -join '|')) { return $false }
 foreach($feature in $Left.Keys) {
  foreach($field in (Get-XearEffectMap)[$feature].fields.Keys) {
   if($IgnoreEnabled -and $field -eq 'enabled') { continue }
   if((ConvertTo-Json -InputObject $Left[$feature][$field] -Compress) -cne (ConvertTo-Json -InputObject $Right[$feature][$field] -Compress)) { return $false }
  }
 }; return $true
}
function Select-HeadsetMasterFlags($Snapshot,$SavedFlags) {
 return ,@(foreach($feature in $Snapshot.Keys) {
  $saved=@($SavedFlags | Where-Object { $_.feature -ceq $feature })
  @{feature=[string]$feature;enabled=$(if($saved.Count -eq 1){$saved[0].enabled}else{$Snapshot[$feature].enabled})}
 })
}
function Write-HeadsetMasterFlags($Sdk,$Target,$DesiredFlags,$PreserveSnapshot,[bool]$RequireSame=$false) {
 Assert-HeadsetMasterFlags $DesiredFlags $Target.flow
 # Validate every full effect state before the first enabled-property write.
 $fresh=Get-HeadsetMasterEndpoint $Sdk $Target.endpointId $Target.usbInstanceId
 $current=Read-HeadsetMasterSnapshot $Sdk $fresh
 if(($current.Keys -join '|') -cne ($PreserveSnapshot.Keys -join '|') -or ($DesiredFlags.feature -join '|') -cne ($current.Keys -join '|')) { throw 'Licensed master effect families changed during the operation.' }
 if($RequireSame -and -not (Test-HeadsetMasterSnapshot $current $PreserveSnapshot)) { throw 'Effect state changed before the master transaction could apply.' }
 foreach($flag in $DesiredFlags) {
  if($current[$flag.feature].enabled -ne $flag.enabled) {
   $resolved=Get-HeadsetMasterEndpoint $Sdk $Target.endpointId $Target.usbInstanceId
   if(($resolved.features -join '|') -cne ($current.Keys -join '|')) { throw 'Licensed master effect families changed during the operation.' }
   if(Test-HeadsetDirectBackend $Sdk){$state=Read-XearEffectState $Sdk $resolved.endpoint $flag.feature;$state.enabled=$flag.enabled;[void](Set-XearEffectState $Sdk $resolved.endpoint $flag.feature $state)}
   else{$property=(Get-XearEffectMap)[$flag.feature].fields.enabled.property;[void]$Sdk.WriteInt32($resolved.endpoint.Uid,$property,[int]$flag.enabled)}
  }
 }
 $resolved=Get-HeadsetMasterEndpoint $Sdk $Target.endpointId $Target.usbInstanceId
 $actual=Read-HeadsetMasterSnapshot $Sdk $resolved
 if(-not (Test-HeadsetMasterSnapshot $actual $PreserveSnapshot $true)) { throw 'Master readback changed another effect parameter; enabled-only recovery required.' }
 foreach($flag in $DesiredFlags) { if($actual[$flag.feature].enabled -ne $flag.enabled) { throw 'Master enabled flags did not match readback.' } }
 return $actual
}
function Clear-HeadsetMasterPending($Entry) {
 $Entry.pending=$false
 foreach($key in @('immediateBefore','desiredFlags','previousEnabled','desiredEnabled')) { [void]$Entry.Remove($key) }
}
function New-HeadsetMasterReceipt([string]$EndpointId,$Snapshot,$Record,$Backend=$null) {
 $entry=Get-HeadsetMasterEntry $Record $EndpointId
 return @{endpointId=$EndpointId;support='supported';source=(Get-HeadsetEffectSource $Backend);verified=$true;state=@{enabled=$(if($entry){$entry.enabled}else{$true});effects=(Get-HeadsetMasterFlags $Snapshot)};recoveryPending=[bool]($entry -and $entry.pending);canRestore=[bool]($null -ne $entry)}
}
function Assert-HeadsetMasterAllowsEffects([string]$EndpointId,[string]$LedgerPath) {
 [void](Get-HeadsetMasterFlow $EndpointId)
 $record=Read-HeadsetMasterLedger $LedgerPath; $entry=Get-HeadsetMasterEntry $record $EndpointId
 if($entry -and ($entry.pending -or -not $entry.enabled)) { throw 'The master effect switch is off or recovery is pending; enable or restore it before changing individual effects.' }
}
function Invoke-HeadsetMasterControl($Request,$Sdk,[string]$LedgerPath) {
 $keys=@(Get-HeadsetMasterKeys $Request)
 $action=$Request.action
 if($action -isnot [string] -or $action -cnotin @('headset-master-read','headset-master-set','headset-master-restore')) { throw 'Unknown fixed master operation.' }
 $required=@('action','endpointId'); if($action -eq 'headset-master-set') { $required+='enabled' }
 Assert-HeadsetMasterKeys $Request $required
 [void](Get-HeadsetMasterFlow $Request.endpointId)
 if($action -eq 'headset-master-set' -and $Request.enabled -isnot [bool]) { throw 'Master enabled must be a strict boolean.' }
 $record=Read-HeadsetMasterLedger $LedgerPath; $entry=Get-HeadsetMasterEntry $record $Request.endpointId
 $expectedUsb=if($entry){$entry.usbInstanceId}else{''}
 $target=Get-HeadsetMasterEndpoint $Sdk $Request.endpointId $expectedUsb
 $before=Read-HeadsetMasterSnapshot $Sdk $target
 if($action -eq 'headset-master-read') { return New-HeadsetMasterReceipt $Request.endpointId $before $record $Sdk }
 if($action -eq 'headset-master-set' -and @($record.entries | Where-Object { $_.pending }).Count) { throw 'A master operation is pending recovery; restore it before setting the master switch.' }
 if($action -eq 'headset-master-restore' -and $entry -and $entry.pending) {
  # Recover the immediate failed transaction first. Keep the original baseline for a later explicit restore.
  $desired=Select-HeadsetMasterFlags $before $entry.immediateBefore
  $actual=Write-HeadsetMasterFlags $Sdk $target $desired $before
  $entry.enabled=$entry.previousEnabled; Clear-HeadsetMasterPending $entry
  Save-HeadsetMasterLedger $LedgerPath $record
  $receipt=New-HeadsetMasterReceipt $Request.endpointId $actual $record $Sdk; $receipt.restored=$true; return $receipt
 }
 if($action -eq 'headset-master-restore' -and -not $entry) {
  $receipt=New-HeadsetMasterReceipt $Request.endpointId $before $record $Sdk; $receipt.restored=$false; return $receipt
 }
 if($action -eq 'headset-master-set' -and $Request.enabled -and (-not $entry -or $entry.enabled)) {
  $receipt=New-HeadsetMasterReceipt $Request.endpointId $before $record $Sdk; $receipt.applied=$true; return $receipt
 }
 $beforeFlags=Get-HeadsetMasterFlags $before
 $desiredEnabled=if($action -eq 'headset-master-restore'){$true}else{$Request.enabled}
 $desired=if($action -eq 'headset-master-restore') { Select-HeadsetMasterFlags $before $entry.baselineFlags }
  elseif($desiredEnabled) { Select-HeadsetMasterFlags $before $entry.disabledFlags }
  else { ,@(foreach($flag in $beforeFlags) { @{feature=$flag.feature;enabled=$false} }) }
 # Repeated off is a no-op when actual flags are already off. First off still persists master intent.
 if($action -eq 'headset-master-set' -and $entry -and -not $entry.enabled -and -not $desiredEnabled -and -not @($beforeFlags | Where-Object { $_.enabled }).Count) {
  $receipt=New-HeadsetMasterReceipt $Request.endpointId $before $record $Sdk; $receipt.applied=$true; return $receipt
 }
 if(-not $entry) {
  if($record.entries.Count -ge 128) { throw 'Master recovery entry limit reached.' }
  $entry=@{endpointId=$Request.endpointId;usbInstanceId=$target.usbInstanceId;baselineFlags=$beforeFlags;disabledFlags=$beforeFlags;enabled=$true;pending=$false}
  $record.entries+=@($entry)
 }
 $entry.immediateBefore=$beforeFlags; $entry.desiredFlags=$desired; $entry.previousEnabled=$entry.enabled; $entry.desiredEnabled=$desiredEnabled; $entry.pending=$true
 Save-HeadsetMasterLedger $LedgerPath $record
 # Keep the persisted pending object untouched until a separate commit has reached disk.
 try {
  $actual=Write-HeadsetMasterFlags $Sdk $target $desired $before $true
  $committed=Copy-HeadsetMasterValue $record; $committedEntry=Get-HeadsetMasterEntry $committed $Request.endpointId
  if($action -eq 'headset-master-restore') { $committed.entries=@($committed.entries | Where-Object { $_.endpointId -ine $Request.endpointId }) }
  else { $committedEntry.enabled=$desiredEnabled; if(-not $desiredEnabled) { $committedEntry.disabledFlags=$beforeFlags }; Clear-HeadsetMasterPending $committedEntry }
  Save-HeadsetMasterLedger $LedgerPath $committed
  $receipt=New-HeadsetMasterReceipt $Request.endpointId $actual $committed $Sdk
  if($action -eq 'headset-master-restore') { $receipt.restored=$true } else { $receipt.applied=$true }; return $receipt
 } catch {
  $failure=$_.Exception.Message
  try {
   [void](Write-HeadsetMasterFlags $Sdk $target $beforeFlags $before)
   $rollback=Copy-HeadsetMasterValue $record; $rollbackEntry=Get-HeadsetMasterEntry $rollback $Request.endpointId
   $rollbackEntry.enabled=$rollbackEntry.previousEnabled; Clear-HeadsetMasterPending $rollbackEntry
   Save-HeadsetMasterLedger $LedgerPath $rollback
  } catch { throw ('Master apply failed: '+$failure+'; enabled-only recovery failed, pending record retained: '+$_.Exception.Message) }
  throw ('Master apply failed; immediate enabled flags restored and verified: '+$failure)
 }
}
