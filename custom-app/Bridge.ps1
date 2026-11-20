#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$RequestPath, [Parameter(Mandatory)][string]$ResponsePath)
$ErrorActionPreference='Stop'
$exitCode=0
try {
    $request=[IO.File]::ReadAllText($RequestPath) | ConvertFrom-Json
    $root=[IO.Path]::GetFullPath([string]$request.projectRoot)
    Add-Type -Path (Join-Path $root 'native\CoreAudio.cs')
    function Get-TargetAudio {
        return @([PeripheralHub.CoreAudio]::ListEndpoints() | Where-Object { $_.Name -match '(?i)iKF[ -]?V11\s*Pro' })
    }
    function Get-Endpoint([string]$Id) {
        if (-not $Id -or $Id.Length -gt 2048) { throw 'Invalid audio endpoint identifier.' }
        $endpoint=@(Get-TargetAudio | Where-Object Id -EQ $Id)
        if ($endpoint.Count -ne 1) { throw 'The selected iKF endpoint is no longer active. Refresh devices.' }
        return $endpoint[0]
    }
    function Convert-Audio($endpoint) {
        [ordered]@{id=$endpoint.Id;name=$endpoint.Name;flow=$endpoint.Flow;volume=$endpoint.Volume;muted=$endpoint.Muted}
    }
    switch ([string]$request.action) {
        'snapshot' {
            $audio=@();$warnings=[System.Collections.Generic.List[string]]::new()
            try { $audio=@(Get-TargetAudio | ForEach-Object {Convert-Audio $_}) } catch { $warnings.Add('音频读取失败：'+$_.Exception.Message) }
            $result=& (Join-Path $root 'Scan-Devices.ps1') -OutputDirectory ([string]$request.reportDirectory)
            $scan=[IO.File]::ReadAllText($result.JsonReport) | ConvertFrom-Json
            $profiles=([IO.File]::ReadAllText((Join-Path $root 'device-profiles.json')) | ConvertFrom-Json).devices
            $devices=@(foreach($profile in $profiles){
                $groups=@($scan.Groups | Where-Object { $profile.id -in @($_.ProfileMatches.ProfileId) })
                [ordered]@{
                    id=$profile.id;name=$profile.name;category=$profile.category;connected=($groups.Count -gt 0)
                    connection=(@($groups.ProfileMatches | Where-Object ProfileId -EQ $profile.id | Select-Object -ExpandProperty Connection -Unique) -join ' / ')
                    hardwareIds=@($groups.Ids | Sort-Object -Unique)
                    interfaceCount=[int](($groups | Measure-Object -Property InterfaceCount -Sum).Sum)
                    privateControlStatus=$profile.privateControlStatus
                }
            })
            foreach($warning in $scan.Warnings){$warnings.Add([string]$warning)}
            $data=[ordered]@{scannedAt=$scan.CapturedAt;devices=$devices;audio=$audio;warnings=@($warnings)}
        }
        'audio-list' {
            $data=@(Get-TargetAudio | ForEach-Object {Convert-Audio $_})
        }
        'audio-read' {
            $data=Convert-Audio (Get-Endpoint ([string]$request.id))
        }
        'audio-set' {
            $endpoint=Get-Endpoint ([string]$request.id)
            [Nullable[float]]$volume=$null
            [Nullable[bool]]$muted=$null
            if($null -ne $request.volume){
                $v=[double]$request.volume
                if([double]::IsNaN($v) -or [double]::IsInfinity($v) -or $v -lt 0 -or $v -gt 100){throw 'Volume must be between 0 and 100.'}
                $volume=[float]$v
            }
            if($null -ne $request.muted){
                if($request.muted -isnot [bool]){throw 'Muted must be a boolean.'}
                $muted=[bool]$request.muted
            }
            if($null -eq $volume -and $null -eq $muted){throw 'No audio change requested.'}
            $data=Convert-Audio ([PeripheralHub.CoreAudio]::Set($endpoint.Id,$volume,$muted))
        }
        default { throw 'Unknown bridge operation.' }
    }
    $response=@{ok=$true;data=$data}
} catch {
    $response=@{ok=$false;error=$_.Exception.Message}
    $exitCode=1
}
$response | ConvertTo-Json -Depth 12 -Compress | Set-Content -LiteralPath $ResponsePath -Encoding utf8
exit $exitCode
