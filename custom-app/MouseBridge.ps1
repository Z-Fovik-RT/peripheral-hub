#requires -Version 7.0
param([Parameter(Mandatory)][string]$RequestPath,[Parameter(Mandatory)][string]$ResponsePath)
$ErrorActionPreference='Stop'
$exitCode=0;$gate=$null;$owned=$false
try {
 $request=[IO.File]::ReadAllText($RequestPath)|ConvertFrom-Json
 $root=if((Split-Path $PSScriptRoot -Leaf)-eq'custom-app'){Split-Path $PSScriptRoot}else{[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))}
 Add-Type -Path (Join-Path $root 'native\SystemMouse.cs')
 $gate=[Threading.Mutex]::new($false,'Local\PeripheralHub.SystemMouse')
 try{$owned=$gate.WaitOne(10000)}catch [Threading.AbandonedMutexException]{$owned=$true}
 if(-not$owned){throw 'Another Windows mouse preference operation is in progress.'}
 $dir=Join-Path $root 'local-state';[IO.Directory]::CreateDirectory($dir)|Out-Null
 $ledger=Join-Path $dir 'system-mouse-original.json'

 function Assert-ExactProperties($value,[string[]]$expected,[string]$context){
  if($null-eq$value-or$value-is[string]-or$value-isnot[PSCustomObject]){throw "$context must be a JSON object."}
  $actual=@($value.PSObject.Properties.Name)
  if($actual.Count-ne$expected.Count-or@($actual|Where-Object {$_-notin$expected}).Count-gt0-or@($expected|Where-Object {$_-notin$actual}).Count-gt0){throw "$context has missing or unknown fields."}
 }
 function Assert-RequestFields([string[]]$allowed,[string[]]$required){
  $allowed=@($allowed)+@('projectRoot','reportDirectory')
  $actual=@($request.PSObject.Properties.Name)
  if(@($actual|Where-Object {$_-notin$allowed}).Count-gt0-or@($required|Where-Object {$_-notin$actual}).Count-gt0){throw 'Windows mouse request has missing or unknown fields.'}
 }

 function Get-SnapshotData($snapshot){
  return [ordered]@{
   source='windows-system';scope='all-mice'
   settings=[ordered]@{
    pointerSpeed=[int]$snapshot.PointerSpeed;wheelLines=[int]$snapshot.WheelLines
    horizontalCharacters=[int]$snapshot.HorizontalCharacters;doubleClickMs=[int]$snapshot.DoubleClickMs
    enhancedPrecision=[bool]$snapshot.EnhancedPrecision;swapPrimary=[bool]$snapshot.SwapPrimary
    mouseAcceleration=[ordered]@{threshold1=[int]$snapshot.MouseThreshold1;threshold2=[int]$snapshot.MouseThreshold2;mode=[int]$snapshot.MouseAccelerationRaw}
   }
  }
 }
 function ConvertTo-NativeSnapshot($data){
  Assert-ExactProperties $data @('source','scope','settings') 'Windows mouse recovery snapshot'
  if($data.source-cne'windows-system'-or$data.scope-cne'all-mice'){throw 'Windows mouse recovery identity is invalid.'}
  Assert-ExactProperties $data.settings @('pointerSpeed','wheelLines','horizontalCharacters','doubleClickMs','enhancedPrecision','swapPrimary','mouseAcceleration') 'Windows mouse settings snapshot'
  Assert-ExactProperties $data.settings.mouseAcceleration @('threshold1','threshold2','mode') 'Windows mouse acceleration tuple'
  $s=[PeripheralHub.SystemMouse+Snapshot]::new()
  foreach($pair in @(@('PointerSpeed','pointerSpeed'),@('WheelLines','wheelLines'),@('HorizontalCharacters','horizontalCharacters'),@('DoubleClickMs','doubleClickMs'))){$v=$data.settings.($pair[1]);if($v -isnot [long] -and $v -isnot [int]){throw 'Windows mouse snapshot contains a non-integer value.'};$s.($pair[0])=[int]$v}
  foreach($pair in @(@('EnhancedPrecision','enhancedPrecision'),@('SwapPrimary','swapPrimary'))){$v=$data.settings.($pair[1]);if($v -isnot [bool]){throw 'Windows mouse snapshot contains an invalid flag.'};$s.($pair[0])=[bool]$v}
  $acc=$data.settings.mouseAcceleration;if($acc -isnot [PSCustomObject]){throw 'Windows mouse snapshot lacks the complete SPI_GETMOUSE tuple.'}
  foreach($pair in @(@('MouseThreshold1','threshold1'),@('MouseThreshold2','threshold2'),@('MouseAccelerationRaw','mode'))){$v=$acc.($pair[1]);if($v -isnot [long] -and $v -isnot [int]){throw 'Windows mouse SPI_GETMOUSE value is invalid.'};$s.($pair[0])=[int]$v}
  [PeripheralHub.SystemMouse]::ValidateSnapshot($s);return $s
 }
 function Read-Ledger {
  if(-not(Test-Path -LiteralPath $ledger)){return $null}
  if((Get-Item -LiteralPath $ledger).Length-gt16384){throw 'Windows mouse recovery record exceeds size limits; writes are blocked.'}
  try{$r=[IO.File]::ReadAllText($ledger)|ConvertFrom-Json -ErrorAction Stop}catch{throw ('Windows mouse recovery record is unreadable; writes are blocked: '+$_.Exception.Message)}
  if($r.schema -eq 2 -and $r.scope -eq 'windows-user-all-mice'){
   Assert-ExactProperties $r @('schema','scope','baseline') 'Windows mouse v2 recovery record'
   if($null -eq $r.baseline){throw 'Windows mouse recovery baseline is missing; writes are blocked.'}
   return [pscustomobject]@{schema=2;baseline=(ConvertTo-NativeSnapshot $r.baseline);legacyValues=$null}
  }
  if($r.schema -eq 1 -and $r.scope -eq 'windows-user-all-mice'){
   Assert-ExactProperties $r @('schema','scope','values') 'Windows mouse v1 recovery record'
   $values=@{};foreach($p in $r.values.PSObject.Properties){if($p.Value -isnot [long] -and $p.Value -isnot [int]){throw 'Legacy Windows mouse recovery value is invalid; writes are blocked.'};$setting=[string]$p.Name;if($setting -notin @('pointerSpeed','wheelLines','doubleClickMs')){throw 'Legacy Windows mouse recovery field is unknown; writes are blocked.'};[PeripheralHub.SystemMouse]::Validate($setting,[int]$p.Value);$values[$setting]=[int]$p.Value}
   return [pscustomobject]@{schema=1;baseline=$null;legacyValues=$values}
  }
  throw 'Windows mouse recovery record is invalid; writes are blocked.'
 }
 function Write-Ledger($baseline){
  $temp=$ledger+'.'+[guid]::NewGuid().ToString('N')+'.tmp';$data=Get-SnapshotData $baseline
  try{[IO.File]::WriteAllText($temp,(@{schema=2;scope='windows-user-all-mice';baseline=$data}|ConvertTo-Json -Depth 8));[IO.File]::Move($temp,$ledger,$true)}finally{if(Test-Path -LiteralPath $temp){[IO.File]::Delete($temp)}}
 }
 function Write-LegacyLedger($values){
  $temp=$ledger+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  try{[IO.File]::WriteAllText($temp,(@{schema=1;scope='windows-user-all-mice';values=$values}|ConvertTo-Json -Depth 4));[IO.File]::Move($temp,$ledger,$true)}finally{if(Test-Path -LiteralPath $temp){[IO.File]::Delete($temp)}}
 }
 function Ensure-Baseline($before){
  $state=Read-Ledger
  if($state.schema -eq 1 -and $state.legacyValues.Count -gt 0){throw 'An older partial recovery record is active. Restore it fully before creating a complete Windows mouse baseline.'}
  if($state.schema -eq 2){return}
  Write-Ledger $before
 }
 function Get-Snapshot {
  $state=Read-Ledger;$data=Get-SnapshotData ([PeripheralHub.SystemMouse]::Read())
  $data.canRestore=[bool]($null -ne $state -and (($state.schema -eq 2) -or ($state.legacyValues.Count -gt 0)))
  $data.readAt=[datetime]::UtcNow.ToString('o');return $data
 }
 function Read-RequestValue($name){$v=$request.$name;if($null -eq $v -or $v -is [string] -or $v -is [bool] -or [double]$v -ne [math]::Truncate([double]$v)){throw 'Windows mouse preference value must be an integer.'};return [int]$v}
 function Apply-One($setting,$value){[PeripheralHub.SystemMouse]::Validate($setting,[int]$value);$before=[PeripheralHub.SystemMouse]::Read();[PeripheralHub.SystemMouse]::ValidateSnapshot($before);if([PeripheralHub.SystemMouse]::Value($before,$setting) -eq [int]$value){return $before};Ensure-Baseline $before;$script:mouseMutationStarted=$true;return [PeripheralHub.SystemMouse]::Set($setting,[int]$value)}

 switch([string]$request.action){
  'mouse-read' {Assert-RequestFields @('action') @('action');$data=Get-Snapshot}
  'mouse-set' {
   Assert-RequestFields @('action','setting','value') @('action','setting','value')
   if($request.setting -notin @('pointerSpeed','wheelLines','horizontalCharacters','doubleClickMs','enhancedPrecision','swapPrimary')){throw 'Unsupported Windows mouse preference.'}
   $value=Read-RequestValue 'value';$null=Apply-One ([string]$request.setting) $value;$data=Get-Snapshot
   if([PeripheralHub.SystemMouse]::Value([PeripheralHub.SystemMouse]::Read(),[string]$request.setting)-ne$value){throw 'Windows mouse preference readback differs from request.'}
   $data.verification='system-readback'
  }
  'mouse-scroll-set' {
   Assert-RequestFields @('action','verticalLines','horizontalCharacters') @('action')
   $allowed=@('action','verticalLines','horizontalCharacters');foreach($p in $request.PSObject.Properties){if($p.Name-notin$allowed){throw 'Unknown Windows mouse scroll field.'}}
   $changes=@{};foreach($setting in @('wheelLines','horizontalCharacters')){$field=if($setting-eq'wheelLines'){'verticalLines'}else{'horizontalCharacters'};if($request.PSObject.Properties.Name-contains$field){$changes[$setting]=Read-RequestValue $field}}
   if($changes.Count-eq0){throw 'At least one scroll setting is required.'}
   $before=[PeripheralHub.SystemMouse]::Read();[PeripheralHub.SystemMouse]::ValidateSnapshot($before)
   foreach($setting in $changes.Keys){[PeripheralHub.SystemMouse]::Validate($setting,$changes[$setting])}
   Ensure-Baseline $before
   $script:mouseMutationStarted=$false
   try{foreach($setting in $changes.Keys){[void](Apply-One $setting $changes[$setting])};$after=[PeripheralHub.SystemMouse]::Read();foreach($setting in $changes.Keys){if([PeripheralHub.SystemMouse]::Value($after,$setting)-ne$changes[$setting]){throw "Windows $setting readback differs from request."}}}
   catch {
    $failure=$_.Exception
    if($script:mouseMutationStarted){try { [void][PeripheralHub.SystemMouse]::Restore($before) }
    catch { throw [AggregateException]::new('Scroll update failed and immediate full-state recovery failed; original full baseline retained.',$failure,$_.Exception) }}
    throw $failure
   }
   $data=Get-Snapshot;$data.verification='system-readback'
  }
  'mouse-restore' {
   Assert-RequestFields @('action') @('action')
   $state=Read-Ledger;$errors=[Collections.Generic.List[string]]::new();$restored=0
   if($state.schema -eq 1){
    foreach($setting in @($state.legacyValues.Keys)){
     try{[void][PeripheralHub.SystemMouse]::Set($setting,[int]$state.legacyValues[$setting]);$state.legacyValues.Remove($setting);Write-LegacyLedger $state.legacyValues;$restored++}catch{$errors.Add($setting+': '+$_.Exception.Message)}
    }
    if($state.legacyValues.Count -eq 0 -and $errors.Count -eq 0){[IO.File]::Delete($ledger)}
   }elseif($state.schema -eq 2){
    foreach($setting in @('pointerSpeed','wheelLines','horizontalCharacters','mouseAcceleration','swapPrimary','doubleClickMs')){
     try{[PeripheralHub.SystemMouse]::RestoreSetting($state.baseline,$setting);$restored++}catch{$errors.Add($setting+': '+$_.Exception.Message)}
    }
    if($errors.Count-eq0){$after=[PeripheralHub.SystemMouse]::Read();if([PeripheralHub.SystemMouse]::Same($after,$state.baseline)){[IO.File]::Delete($ledger)}else{$errors.Add('complete snapshot: readback mismatch; saved baseline retained')}}
   }
   $data=Get-Snapshot;$data.restored=$restored;$data.errors=@($errors);$data.verification=if($errors.Count-eq0){'system-readback'}else{'partial-restore'}
  }
  default {throw 'Unknown Windows mouse preference action.'}
 }
 $response=@{ok=$true;data=$data}
}catch{$response=@{ok=$false;error=$_.Exception.Message};$exitCode=1}
finally{if($gate){if($owned){$gate.ReleaseMutex()};$gate.Dispose()}}
[IO.File]::WriteAllText($ResponsePath,($response|ConvertTo-Json -Depth 10 -Compress))
exit $exitCode
