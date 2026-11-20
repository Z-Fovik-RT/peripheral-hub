#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$RequestPath,[Parameter(Mandatory)][string]$ResponsePath)
$ErrorActionPreference='Stop'
$exitCode=0;$gate=$null;$owned=$false
try {
    . (Join-Path $PSScriptRoot 'In9Profiles.ps1')
    if ((Get-Item -LiteralPath $RequestPath).Length -gt 1600000) { throw 'IN9 profile request exceeds the size limit.' }
    $request=[IO.File]::ReadAllText($RequestPath) | ConvertFrom-Json -AsHashtable -ErrorAction Stop
    $root=Get-In9Root
    $action=[string]$request.action
    $allowed=@('mouse-profile-status-read','mouse-profile-installed-list','mouse-profile-archive-installed','mouse-profile-preview','mouse-profile-read','mouse-profile-export','mouse-profile-apply','mouse-profile-restore')
    if ($action -notin $allowed) { throw 'Unknown IN9 profile action.' }
    $gate=[Threading.Mutex]::new($false,'Local\PeripheralHub.In9Profiles')
    try { $owned=$gate.WaitOne(10000) } catch [Threading.AbandonedMutexException] { $owned=$true }
    if (-not $owned) { throw 'Another IN9 profile operation is in progress.' }
    $data=Invoke-In9ProfileAction -Root $root -Request $request
    $response=@{ok=$true;data=$data}
} catch { $response=@{ok=$false;error=$_.Exception.Message};$exitCode=1 }
finally { if ($gate) { if ($owned) { $gate.ReleaseMutex() };$gate.Dispose() } }
[IO.File]::WriteAllText($ResponsePath,($response | ConvertTo-Json -Depth 16 -Compress),[Text.UTF8Encoding]::new($false))
exit $exitCode
