#requires -Version 7.0
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$root=if((Split-Path $PSScriptRoot -Leaf)-eq'custom-app'){Split-Path $PSScriptRoot}else{[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))}
Add-Type -Path (Join-Path $root 'native/CoreAudio.cs')
Add-Type -Path (Join-Path $root 'native/IkfDirectAudio.cs')
. (Join-Path $PSScriptRoot 'HeadsetDiagnostics.ps1')
$identity=Get-HeadsetSystemEvidence
$snapshots=@(foreach($device in $identity.devices){[PeripheralHub.IkfDirectAudio]::ReadEndpoint($device.endpointId)})
[ordered]@{
 schemaVersion=1;capturedAt=[datetime]::UtcNow.ToString('o');source='Windows IAudioSystemEffectsPropertyStore.OpenUserPropertyStore(STGM_READ)'
 vendorSdkLoaded=$false;vendorApplicationLaunched=$false;propertyWrites=0;driverChanges=0
 identityWarnings=$identity.warnings;endpoints=$snapshots
 licenseVerified=$false;effectBehaviorVerified=$false;writeSupported=$false
}|ConvertTo-Json -Depth 14
