#requires -Version 7.0
param([Parameter(Mandatory)][string]$Installer)
$ErrorActionPreference='Stop'
$exe=(Resolve-Path -LiteralPath $Installer).Path
$temp=[IO.Directory]::CreateTempSubdirectory('hub-setup-smoke-').FullName
$target=Join-Path $temp 'installed'
$process=Start-Process -FilePath $exe -ArgumentList @('/S','/TEST',('/D='+$target)) -Wait -PassThru -WindowStyle Hidden
if($process.ExitCode -ne 0){throw "Installation failed: $($process.ExitCode)"}
foreach($file in @('peripheral-hub-public.marker','runtime/PeripheralHub.exe','runtime/LICENSE','runtime/LICENSES.chromium.html','runtime/resources/app/main.cjs','runtime/resources/app/renderer/index.html','native/CoreAudio.cs','docs/feature-api.md')){
    if(!(Test-Path -LiteralPath (Join-Path $target $file) -PathType Leaf)){throw "Missing installed file: $file"}
}
foreach($file in @('runtime/MCHOSE HUB.exe','runtime/resources/app/audio-driver','runtime/resources/app/in9-default-profiles','runtime/resources/app/audio-sdk','runtime/resources/app/renderer/assets/voice-test','runtime/resources/app/renderer/assets/background.webm')){
    if(Test-Path -LiteralPath (Join-Path $target $file)){throw "Retired private payload: $file"}
}
$preserved=Join-Path $target 'local-state/sentinel.txt'
[void][IO.Directory]::CreateDirectory((Split-Path $preserved -Parent))
[IO.File]::WriteAllText($preserved,'keep')
$remove=Start-Process -FilePath (Join-Path $target 'Uninstall.exe') -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden
if($remove.ExitCode -ne 0 -or [IO.File]::ReadAllText($preserved) -ne 'keep' -or (Test-Path -LiteralPath (Join-Path $target 'runtime'))){throw 'Uninstall or user data preservation failed.'}
Write-Host 'Installer smoke test passed (no driver or device changes).'
