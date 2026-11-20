#requires -Version 7.0
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$root=$PSScriptRoot
& node (Join-Path $root 'tools/generate-api.cjs')
if($LASTEXITCODE){throw 'API contract generation failed.'}
& (Join-Path $root 'Build-CustomHub.ps1')
$compiler=& (Join-Path $root 'tools/Get-BuildTools.ps1') -Component NSIS

$stage=Join-Path $root ('build/payload-'+[guid]::NewGuid().ToString('N'))
$dist=Join-Path $root 'dist'
[void][IO.Directory]::CreateDirectory($stage)
[void][IO.Directory]::CreateDirectory($dist)
foreach($dir in @('runtime','native')){Copy-Item -LiteralPath (Join-Path $root $dir) -Destination $stage -Recurse}
foreach($file in @('Start-Hub.cmd','Scan-Devices.ps1','device-profiles.json','THIRD-PARTY-NOTICES.md')){Copy-Item -LiteralPath (Join-Path $root $file) -Destination $stage}
$docs=Join-Path $stage 'docs'
[void][IO.Directory]::CreateDirectory($docs)
foreach($file in @('HUB-使用说明.md','docs/feature-api.md','docs/headset-feature-coverage.md','docs/api-catalog.json','docs/api-request.schema.json')){Copy-Item -LiteralPath (Join-Path $root $file) -Destination $docs}

$package=Get-Content -LiteralPath (Join-Path $root 'custom-app/package.json') -Raw | ConvertFrom-Json
$output=Join-Path $dist ('PeripheralHub-'+$package.version+'-'+$package.edition+'-x64-Setup.exe')
$temporary=Join-Path $dist ('setup-'+[guid]::NewGuid().ToString('N')+'.exe')
& $compiler '/V2' '/INPUTCHARSET' 'UTF8' ('/DPAYLOAD='+$stage) ('/DOUTPUT='+$temporary) ('/DAPPVERSION='+$package.version) (Join-Path $root 'installer/PeripheralHub.nsi')
if($LASTEXITCODE){throw 'NSIS compilation failed.'}
[IO.File]::Move($temporary,$output,$true)
$hash=(Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash
Set-Content -LiteralPath ($output+'.sha256') -Value ($hash+'  '+[IO.Path]::GetFileName($output)) -Encoding ascii
[pscustomobject]@{ Installer=$output; Staging=$stage; SHA256=$hash }
