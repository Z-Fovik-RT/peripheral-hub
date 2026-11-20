#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$RequestPath,[Parameter(Mandatory)][string]$ResponsePath)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$exitCode=0
function Assert-Shape($Value,[string[]]$Names){
    if($Value -isnot [Collections.IDictionary]){throw 'Expected a JSON object.'}
    if($Value.Count -ne $Names.Count){throw 'Unknown or missing draft field.'}
    foreach($name in $Names){if(-not$Value.Contains($name) -or $null -eq $Value[$name]){throw "Missing draft field: $name"}}
}
function Get-Integer($Value,[string]$Name){
    if($Value -isnot [int] -and $Value -isnot [long]){throw "Draft field must be an integer: $Name"}
    if($Value -lt [int]::MinValue -or $Value -gt [int]::MaxValue){throw "Draft integer exceeds range: $Name"}
    return [int]$Value
}
try{
    if((Get-Item -LiteralPath $RequestPath).Length -gt 8192){throw 'AULA draft request exceeds the size limit.'}
    $request=[IO.File]::ReadAllText($RequestPath) | ConvertFrom-Json -AsHashtable -ErrorAction Stop
    Assert-Shape $request @('action','contentBase64','patch')
    if($request.action -cne 'keyboard-draft-patch'){throw 'Unknown AULA local draft action.'}
    $content=$request.contentBase64
    if($content -isnot [string] -or $content.Length -gt 684 -or $content.Length -lt 4 -or $content -cnotmatch '^[A-Za-z0-9+/]+={0,2}$' -or $content.Length%4 -ne 0){throw 'Expected bounded canonical base64.'}
    [byte[]]$bytes=[Convert]::FromBase64String($content)
    if([Convert]::ToBase64String($bytes) -cne $content){throw 'Base64 content is not canonical.'}
    if($bytes.Length -notin @(490,504,512)){throw 'Expected an exact captured 490/504-byte block or complete 512-byte block.'}
    $patch=$request.patch
    if($patch -isnot [Collections.IDictionary] -or -not$patch.Contains('kind')){throw 'Missing local draft patch kind.'}
    $shapes=@{
        keyboard=@('kind','layer','keyId','modifiers','primaryUsage','secondaryUsage')
        consumer=@('kind','layer','keyId','consumerUsage')
        palette=@('kind','modeId','colorIndex','r','g','b')
    }
    $kind=$patch.kind
    if($kind -isnot [string] -or $kind -cnotin @('keyboard','consumer','palette')){throw 'Unsupported local draft patch kind.'}
    Assert-Shape $patch $shapes[$kind]
    foreach($field in $shapes[$kind]){if($field -notin @('kind','keyId')){$patch[$field]=Get-Integer $patch[$field] $field}}
    if($kind -cne 'palette' -and $patch.keyId -isnot [string]){throw 'Physical key ID must be a string.'}
    $root=if((Split-Path $PSScriptRoot -Leaf) -eq 'custom-app'){[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))}else{[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))}
    Add-Type -Path @((Join-Path $root 'native/AulaConfigurationCodec.cs'),(Join-Path $root 'native/AulaReadModels.cs'),(Join-Path $root 'native/AulaDraftCodec.cs'))
    $draft=switch -CaseSensitive ($kind){
        'keyboard'{[PeripheralHub.AulaDraftCodec]::PatchKeyboard($bytes,$patch.layer,$patch.keyId,$patch.modifiers,$patch.primaryUsage,$patch.secondaryUsage)}
        'consumer'{[PeripheralHub.AulaDraftCodec]::PatchConsumer($bytes,$patch.layer,$patch.keyId,$patch.consumerUsage)}
        'palette'{[PeripheralHub.AulaDraftCodec]::PatchPaletteColor($bytes,$patch.modeId,$patch.colorIndex,$patch.r,$patch.g,$patch.b)}
    }
    $response=@{ok=$true;data=@{
        source='local-draft';contentBase64=[Convert]::ToBase64String($draft.Data)
        originalSha256=$draft.OriginalSha256;sha256=$draft.Sha256;changedOffsets=@($draft.ChangedOffsets)
        blockKind=$draft.BlockKind;layer=$draft.Layer;actualLength=$draft.ActualLength
        completeBlockProvided=$draft.CompleteBlockCaptured;writeBaselineEligible=$false;hardwareIO=$false
    }}
}catch{$response=@{ok=$false;error=$_.Exception.Message};$exitCode=1}
[IO.File]::WriteAllText($ResponsePath,($response | ConvertTo-Json -Depth 8 -Compress),[Text.UTF8Encoding]::new($false))
exit $exitCode
