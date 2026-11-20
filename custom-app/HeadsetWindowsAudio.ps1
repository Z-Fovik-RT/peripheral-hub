#requires -Version 7.0
[CmdletBinding()]
param([string]$EndpointId,[switch]$ListFormats)

function Initialize-HeadsetWindowsAudio {
 $nativeRoot=if((Split-Path $PSScriptRoot -Leaf)-eq'custom-app'){Join-Path (Split-Path $PSScriptRoot) 'native'}else{[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\native'))}
 if(-not('PeripheralHub.WindowsAudioPolicy'-as[type])){Add-Type -Path (Join-Path $nativeRoot 'WindowsAudioPolicy.cs')}
 if(-not('PeripheralHub.IkfDirectAudio'-as[type])){Add-Type -Path (Join-Path $nativeRoot 'IkfDirectAudio.cs')}
}
function Read-HeadsetWindowsDeviceFormat {param([string]$Id);Initialize-HeadsetWindowsAudio;[PeripheralHub.WindowsAudioPolicy]::ReadDefaultFormat($Id)}
function Read-HeadsetWindowsFormatQueries {param([string]$Id);Initialize-HeadsetWindowsAudio;[PeripheralHub.WindowsAudioPolicy]::ListFormatSupport($Id)}
function Read-HeadsetWindowsRoleSnapshot {param([string]$Id);Initialize-HeadsetWindowsAudio;[PeripheralHub.WindowsAudioPolicy]::ReadDefaultRoles($Id)}
function Read-HeadsetWindowsAecSnapshot {param([string]$Id);Initialize-HeadsetWindowsAudio;[PeripheralHub.IkfDirectAudio]::ReadCaptureAec($Id)}
function Convert-HeadsetWindowsFormat {param($Format);@{channels=[int]$Format.Channels;bitDepth=[int]$Format.BitDepth;sampleRate=[int]$Format.SampleRate}}
function Invoke-HeadsetWindowsAudioRead {
 param($Request)
 $keys=if($Request-is[Collections.IDictionary]){@($Request.Keys)}else{@($Request.PSObject.Properties.Name)}
 if($keys.Count-ne2-or'action'-cnotin$keys-or'endpointId'-cnotin$keys){throw 'Windows audio reads accept only action and endpointId.'}
 $id=[string]$Request.endpointId
 if($Request.endpointId-isnot[string]-or$id-cnotmatch'^\{0\.0\.[01]\.00000000\}\.\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$'){throw 'An exact Windows endpoint ID is required.'}
 switch -CaseSensitive ([string]$Request.action){
  'headset-audio-format-read' {
   $format=Read-HeadsetWindowsDeviceFormat $id
   if(-not$format){throw 'Windows did not return a verified device default format.'}
   return @{endpointId=$id;support='supported';source='windows-system';verified=$true;format=(Convert-HeadsetWindowsFormat $format)}
  }
  'headset-audio-format-list' {
   $queries=@(Read-HeadsetWindowsFormatQueries $id)
   if($queries.Count-ne180){throw 'The complete fixed format candidate query was not returned.'}
   if(@($queries|Where-Object {$null-eq$_.Supported-or$_.Status-notin@('supported','unsupported')}).Count){throw 'A Windows exact-format query failed; a partial list is not returned as complete.'}
   return @{endpointId=$id;support='supported';source='windows-system';verified=$true;formats=@($queries|Where-Object {$_.Supported}|ForEach-Object {Convert-HeadsetWindowsFormat $_.Format})}
  }
  'headset-audio-default-read' {
   $snapshot=Read-HeadsetWindowsRoleSnapshot $id
   if(-not$snapshot.Verified-or$null-eq$snapshot.Roles){throw 'One or more Windows default role queries failed; unknown roles were not converted to disabled.'}
   return @{endpointId=$id;support='supported';source='windows-system';verified=$true;roles=@($snapshot.Roles)}
  }
  'headset-aec-read' {
   if($id-cnotmatch'^\{0\.0\.1\.00000000\}\.'){throw 'AEC diagnostics require a capture endpoint.'}
   $snapshot=Read-HeadsetWindowsAecSnapshot $id
   if(-not$snapshot.IdentityVerified-or-not$snapshot.AllPropertiesRead-or$snapshot.Error-or-not$snapshot.States.ContainsKey('mic.aec')){throw 'The exact target AEC property store did not return all three fields.'}
   $state=$snapshot.States['mic.aec']
   return @{endpointId=$id;support='supported';source='windows-effect-store';verified=$true;state=@{enabled=[bool]$state['enabled'];levelRaw=[int]$state['levelRaw'];delayRaw=[int]$state['delayRaw']}}
  }
  default {throw 'This helper exposes only verified Windows reads; no default-format, role or AEC setter is dispatched.'}
 }
}

if($MyInvocation.InvocationName-ne'.'){
 $ErrorActionPreference='Stop'
 Initialize-HeadsetWindowsAudio
 $ids=if($EndpointId){@($EndpointId)}else{@('{0.0.0.00000000}.{6b7ec279-e8a9-472b-bcb8-29bcb2a9042e}','{0.0.1.00000000}.{3a8c6c6a-8cce-41f2-9309-c049c8679136}')}
 $readings=@(foreach($id in $ids){[ordered]@{formats=[PeripheralHub.WindowsAudioPolicy]::ReadFormats($id);roles=[PeripheralHub.WindowsAudioPolicy]::ReadDefaultRoles($id);formatQueries=$(if($ListFormats){@([PeripheralHub.WindowsAudioPolicy]::ListFormatSupport($id))}else{$null});aec=$(if($id-like'{0.0.1.*'){[PeripheralHub.IkfDirectAudio]::ReadCaptureAec($id)}else{$null})}})
 [ordered]@{capturedAt=[datetime]::UtcNow.ToString('o');source='windows-system';readings=$readings;vendorSdkLoaded=$false;settingsWrites=0;driverChanges=0;formatSetterVerified=$false;roleSetterVerified=$false}|ConvertTo-Json -Depth 20
}
