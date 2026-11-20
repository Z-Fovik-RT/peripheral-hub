# Restore coordinator. Load HeadsetEffects.ps1 and HeadsetMaster.ps1 first.
function Assert-HeadsetRecoveryEntry($Entry) {
 $keys=if($Entry -is [Collections.IDictionary]){@($Entry.Keys)}else{@($Entry.PSObject.Properties.Name)}
 $expected=@('endpointId','usbInstanceId','feature','state','pending'); if($Entry.pending) {$expected+='immediateBefore'}
 if($keys.Count -ne $expected.Count) { throw 'Effect recovery entry has missing or extra fields.' }
 foreach($name in $expected) { if($name -cnotin $keys) { throw ('Effect recovery entry is missing '+$name) } }
 $map=Get-XearEffectMap; $definition=$map[$Entry.feature]
 if(-not $definition -or $Entry.feature -isnot [string]) { throw 'Effect recovery contains an unsupported feature.' }
 if($Entry.pending -isnot [bool]) { throw 'Effect recovery pending flag must be boolean.' }
 if($Entry.endpointId -isnot [string] -or $Entry.endpointId -cnotmatch '^\{0\.0\.([01])\.00000000\}\.\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$') { throw 'Effect recovery endpoint identity is invalid.' }
 $expectedFlow=if($Matches[1] -eq '0'){'render'}else{'capture'}
 if($definition.flow -cne $expectedFlow) { throw 'Effect recovery feature direction does not match its endpoint.' }
 if($Entry.usbInstanceId -isnot [string] -or $Entry.usbInstanceId -notmatch '^USB\\VID_0E6A&PID_0110\\[^\\\x00-\x1f]+$') { throw 'Effect recovery USB identity is invalid.' }
 Assert-XearState $Entry.feature $Entry.state
 if($Entry.pending) { Assert-XearState $Entry.feature $Entry.immediateBefore }
}
function Copy-HeadsetRecoveryRecord($Record) {
 return ConvertFrom-Json -InputObject (ConvertTo-Json -InputObject $Record -Depth 16 -Compress) -AsHashtable
}
function Get-HeadsetRecoveryEndpoint($Sdk,$Entry) {
 $definition=(Get-XearEffectMap)[$Entry.feature]
 if(Test-HeadsetDirectBackend $Sdk){$endpoint=$Sdk.FindTarget($Entry.endpointId,$definition.flow);if($endpoint.UsbInstanceId-cne$Entry.usbInstanceId){throw 'Effect restore target identity or direction changed.'};return $endpoint}
 $endpoint=$Sdk.FindTarget($Entry.endpointId,$definition.flow)
 $id=[PeripheralHub.XearAudio]::Scalar($endpoint.Properties['EndpointID'],5)
 $usb=[PeripheralHub.XearAudio]::Scalar($endpoint.Properties['USBDeviceInstanceID'],5)
 $dataFlow=[PeripheralHub.XearAudio]::Scalar($endpoint.Properties['DataFlow'],2)
 $expectedDataFlow=if($definition.flow -eq 'render'){1}else{2}
 if($id -isnot [string] -or $id -ine $Entry.endpointId -or $usb -isnot [string] -or $usb -cne $Entry.usbInstanceId -or $dataFlow -ne $expectedDataFlow) { throw 'Effect restore target identity or direction changed.' }
 return $endpoint
}
function Invoke-HeadsetRecovery($Sdk,[string]$RecoveryPath,[string]$MasterPath) {
 # Read and validate both ledgers before any device write.
 $record=Read-XearRecovery $RecoveryPath
 $masterRecord=Read-HeadsetMasterLedger $MasterPath
 foreach($entry in $record.entries) { Assert-HeadsetRecoveryEntry $entry }
 $restored=0; $errors=[Collections.Generic.List[string]]::new()
 if(Test-HeadsetDirectBackend $Sdk){try{$restored+=Invoke-HeadsetDirectPendingRecovery $Sdk}catch{$errors.Add(('Direct raw recovery: '+$_.Exception.Message));return @{restored=[int]$restored;errors=[string[]]$errors.ToArray()}}}
 $blocked=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
 foreach($masterEntry in @($masterRecord.entries)) {
  try {
   $receipt=Invoke-HeadsetMasterControl @{action='headset-master-restore';endpointId=$masterEntry.endpointId} $Sdk $MasterPath
   if($receipt.recoveryPending -isnot [bool] -or $receipt.canRestore -isnot [bool]) { throw 'Master restore returned an invalid recovery receipt.' }
   if($receipt.recoveryPending -or $receipt.canRestore) {
    $receipt=Invoke-HeadsetMasterControl @{action='headset-master-restore';endpointId=$masterEntry.endpointId} $Sdk $MasterPath
   }
   if($receipt.recoveryPending -isnot [bool] -or $receipt.canRestore -isnot [bool] -or $receipt.recoveryPending -or $receipt.canRestore) { throw 'Master baseline remains pending after two restore calls.' }
   if($receipt.restored -isnot [bool] -or -not $receipt.restored) { throw 'Master baseline was not confirmed restored.' }
   $restored++
  } catch {
   [void]$blocked.Add([string]$masterEntry.endpointId)
   $errors.Add(('Master '+$masterEntry.endpointId+': '+$_.Exception.Message))
  }
 }
 foreach($entry in @($record.entries)) {
  if($blocked.Contains([string]$entry.endpointId)) {
   $errors.Add(('Effects for '+$entry.endpointId+' retained because its master switch is not restored.'))
   continue
  }
  try {
   $endpoint=Get-HeadsetRecoveryEndpoint $Sdk $entry
   $desired=if($entry.pending){$entry.immediateBefore}else{$entry.state}
   [void](Set-XearEffectState $Sdk $endpoint $entry.feature $desired)

   # Save a detached candidate and only commit it in memory after its durable save succeeds.
   $candidate=Copy-HeadsetRecoveryRecord $record
   $index=-1
   for($i=0;$i -lt $candidate.entries.Count;$i++) {
    if($candidate.entries[$i].endpointId -ieq $entry.endpointId -and $candidate.entries[$i].feature -ceq $entry.feature) { $index=$i; break }
   }
   if($index -lt 0) { throw 'Effect recovery entry disappeared from its transaction record.' }
   if($candidate.entries[$index].pending) {
    $candidate.entries[$index].pending=$false
    [void]$candidate.entries[$index].Remove('immediateBefore')
   } else {
    $candidate.entries=@(for($i=0;$i -lt $candidate.entries.Count;$i++){if($i -ne $index){$candidate.entries[$i]}})
   }
   Save-XearRecovery $RecoveryPath $candidate
   $record=$candidate
   $restored++
  } catch { $errors.Add(('Effect '+$entry.endpointId+'/'+$entry.feature+': '+$_.Exception.Message)) }
 }
 if(Test-HeadsetDirectBackend $Sdk){try{Clear-HeadsetDirectRecoveredBaselines $Sdk $RecoveryPath $MasterPath}catch{$errors.Add(('Direct baseline cleanup: '+$_.Exception.Message))}}
 return @{restored=[int]$restored;errors=[string[]]$errors.ToArray()}
}
