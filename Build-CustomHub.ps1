#requires -Version 7.0
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$root=$PSScriptRoot
$runtime=Join-Path $root 'runtime'
& (Join-Path $root 'tools/Get-BuildTools.ps1') -Component Electron

$source=Join-Path $root 'custom-app'
$app=[IO.Path]::GetFullPath((Join-Path $runtime 'resources/app'))
if(Test-Path -LiteralPath $app){
    $build=[IO.Path]::GetFullPath((Join-Path $root 'build'))
    $retired=Join-Path $build ('previous-app-'+[guid]::NewGuid().ToString('N'))
    foreach($dir in @($root,$runtime,(Split-Path $app -Parent),$app,$build)){
        if((Get-Item -LiteralPath $dir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Build directories must not be reparse points.'}
    }
    [IO.Directory]::Move($app,$retired)
}
Copy-Item -LiteralPath $source -Destination $app -Recurse
Write-Host "Desktop app ready: $runtime"
