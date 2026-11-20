#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][ValidateSet('Electron','NSIS')][string]$Component)
$ErrorActionPreference='Stop'
if(!$IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64'){throw 'Build requires Windows x64.'}
$root=Split-Path $PSScriptRoot
$cache=Join-Path $root 'build/tools'
[void][IO.Directory]::CreateDirectory($cache)

function Get-Archive([string]$Name,[string]$Url,[string]$Algorithm,[string]$Digest){
    $file=Join-Path $cache $Name
    if(!(Test-Path -LiteralPath $file -PathType Leaf)){
        $partial=$file+'.'+[guid]::NewGuid().ToString('N')+'.download'
        try{
            Invoke-WebRequest -Uri $Url -OutFile $partial -MaximumRetryCount 2 -TimeoutSec 300
            if((Get-FileHash -LiteralPath $partial -Algorithm $Algorithm).Hash -ine $Digest){throw "Checksum mismatch for $Name."}
            [IO.File]::Move($partial,$file,$true)
        }finally{if(Test-Path -LiteralPath $partial -PathType Leaf){Remove-Item -LiteralPath $partial}}
    }
    if((Get-FileHash -LiteralPath $file -Algorithm $Algorithm).Hash -ine $Digest){throw "Invalid cached archive: $file. Remove it and retry."}
    return $file
}

if($Component -eq 'Electron'){
    $version='45.4.1'
    $name="electron-v$version-win32-x64.zip"
    $digest='2ba6223afa9121f42831fefe92c434334907540165294fc56697449d12e7cfe9'
    $runtime=Join-Path $root 'runtime'
    $stamp=Join-Path $cache "runtime-$digest.txt"
    $exe=Join-Path $runtime 'PeripheralHub.exe'
    if(Test-Path -LiteralPath $runtime){
        if(!(Test-Path -LiteralPath $exe -PathType Leaf) -or !(Test-Path -LiteralPath $stamp -PathType Leaf) -or (Get-Content -LiteralPath $stamp -Raw).Trim() -ne (Get-FileHash -LiteralPath $exe).Hash -or (Test-Path -LiteralPath (Join-Path $runtime 'resources/app.asar'))){throw 'Existing runtime is not the pinned public runtime. Use a clean checkout or move the old runtime aside.'}
        return
    }
    $archive=Get-Archive $name "https://github.com/electron/electron/releases/download/v$version/$name" SHA256 $digest
    $tmp=Join-Path $cache ('electron-'+[guid]::NewGuid().ToString('N'))
    Expand-Archive -LiteralPath $archive -DestinationPath $tmp
    Move-Item -LiteralPath (Join-Path $tmp 'electron.exe') -Destination (Join-Path $tmp 'PeripheralHub.exe')
    [IO.Directory]::Move($tmp,$runtime)
    Set-Content -LiteralPath $stamp -Encoding ascii -Value (Get-FileHash -LiteralPath $exe).Hash
    return
}

$name='nsis-3.0.4.1.7z'
$digest=[Convert]::ToHexString([Convert]::FromBase64String('VKMiizYdmNdJOWpRGz4trl4lD++BvYP2irAXpMilheUP0pc93iKlWAoP843Vlraj8YG19CVn0j+dCo/hURz9+Q=='))
$archive=Get-Archive $name "https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-3.0.4.1/$name" SHA512 $digest
$nsis=Join-Path $cache 'nsis-3.0.4.1'
$compiler=Join-Path $nsis 'makensis.exe'
if(!(Test-Path -LiteralPath $compiler -PathType Leaf)){
    $tmp=Join-Path $cache ('nsis-'+[guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($tmp)
    & "$env:SystemRoot/System32/tar.exe" -xf $archive -C $tmp
    if($LASTEXITCODE -or !(Test-Path -LiteralPath (Join-Path $tmp 'makensis.exe') -PathType Leaf)){throw 'Windows tar could not extract the pinned NSIS compiler.'}
    [IO.Directory]::Move($tmp,$nsis)
}
return $compiler
