# Pure/profile bridge helpers for the official IN9 local PSF codec.
# This file never opens HID on preview/export. Apply/restore require a root-owned native sender.
Set-StrictMode -Version Latest
$script:In9Domains = @('dpi','dpiColors','polling','lighting','buttons','debounce','power','motion','lift')
$script:In9MaxProfileBytes = 1MB
$script:In9Sha256 = '8DB0F8B4BBF818F299B6C7131E4B4B94C9168846AEB9FD65347866D11BC502BC'

function Get-In9Root {
    param([string]$Root)
    if ($Root) { return [IO.Path]::GetFullPath($Root) }
    if ((Split-Path $PSScriptRoot -Leaf) -eq 'custom-app') { return [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')) }
    return [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
}
function Initialize-In9Types {
    param([Parameter(Mandatory)][string]$Root,[switch]$Transport)
    if (-not ('PeripheralHub.Inphic.In9Codec' -as [type])) {
        $files=@((Join-Path $Root 'native\In9Codec.cs'),(Join-Path $Root 'native\In9KeyTranslation.cs'),(Join-Path $Root 'native\In9OfficialPsf.cs'),(Join-Path $Root 'native\In9ApplyPlan.cs'))
        foreach($file in $files){if(-not[IO.File]::Exists($file)){throw "IN9 codec source is missing: $([IO.Path]::GetFileName($file))"}}
        Add-Type -Path $files
    }
    if($Transport -and -not('PeripheralHub.In9Transport' -as[type])){
        $sender=Join-Path $Root 'native\In9Transport.cs';if(-not[IO.File]::Exists($sender)){throw 'IN9 generated-frame sender is not installed.'}
        Add-Type -Path @((Join-Path $Root 'native\HidInventory.cs'),(Join-Path $Root 'native\HidConfigTransport.cs'),$sender,(Join-Path $Root 'native\In9FeatureProtocol.cs'))
    }
}
function Get-In9PropertyNames($Object){if($Object -is[Collections.IDictionary]){return @($Object.Keys)};return @($Object.PSObject.Properties.Name)}
function Assert-In9RequestShape {
    param([Parameter(Mandatory)]$Request,[Parameter(Mandatory)][string[]]$Allowed,[Parameter(Mandatory)][string[]]$Required)
    if($Request -isnot[Collections.IDictionary]){throw 'Request JSON must be an object.'}
    $names=Get-In9PropertyNames $Request
    foreach($name in $names){if($name -notin $Allowed){throw "Unknown request field: $name"}}
    foreach($name in $Required){if($name -notin $names -or $null -eq $Request[$name]){throw "Missing request field: $name"}}
}
function Convert-In9Content {
    param([Parameter(Mandatory)][string]$ContentBase64)
    if($ContentBase64.Length -lt4 -or $ContentBase64.Length -gt1400000 -or $ContentBase64 -notmatch '^[A-Za-z0-9+/]*={0,2}$' -or ($ContentBase64.Length%4)-ne0){throw 'contentBase64 is not a bounded canonical base64 value.'}
    try{[byte[]]$bytes=[Convert]::FromBase64String($ContentBase64)}catch{throw 'contentBase64 is invalid.'}
    if($bytes.Length -lt1 -or $bytes.Length -gt$script:In9MaxProfileBytes){throw 'PSF content must be between1 byte and1MiB.'}
    return ,$bytes
}
function Get-In9TextDocument {
    param([Parameter(Mandatory)][byte[]]$Bytes)
    try{return [PeripheralHub.Inphic.OfficialPsfDocument]::ParseBytes($Bytes)}catch{throw ('Official IN9 PSF rejected: '+$_.Exception.Message)}
}
function Get-In9Domains {
    param([Parameter(Mandatory)]$Domains,[switch]$Historical)
    $allowed=$script:In9Domains
    if($Historical){$allowed+= 'macros'}
    if($Domains -isnot[Array] -or $Domains.Count -lt1 -or $Domains.Count -gt$allowed.Count){throw 'Invalid number of IN9 profile domains.'}
    $result=[Collections.Generic.List[string]]::new()
    foreach($domain in $Domains){if($domain -isnot[string] -or $domain -cnotin$allowed -or $result.Contains([string]$domain)){throw 'domains contains an unknown or duplicate domain.'};$result.Add([string]$domain)}
    return ,$result.ToArray()
}
function Get-In9ProfileSummary {
    param([Parameter(Mandatory)]$Document,[Parameter(Mandatory)]$Profile)
    $keys=@()
    $gameFiles=[object[]]::new(3)
    for($i=0;$i-lt3;$i++){$gameFiles[$i]=$Document.Get("GameFile$i")}
    for($i=0;$i-lt6;$i++){
        $value=$Profile.KeyTriples[$i]
        $keys+=[ordered]@{index=$i;name=$Document.GetKeyField($i,"Key${i}Name");valueHex=([PeripheralHub.Inphic.In9Codec]::Hex($value));macroName=$Document.GetKeyField($i,"MacroKey${i}Name");macroActionCount=($(try{[int]$Document.GetKeyField($i,'MacroActionNum')}catch{$null}));hasStoredMacro=([bool]($Document.GetKeyField($i,'AllAction')))}
    }
    [ordered]@{source=$Profile.SourceKind;hardwareReadback=[bool]$Profile.IsHardwareReadback;profileName=$Document.Get('ProfileName');linkedGameFiles=$gameFiles;sensorCode=37;enabledMask=[int]$Profile.EnabledMask;currentEnabledOrdinal=[int]$Profile.CurrentEnabledOrdinal;dpiSlots=@($Profile.DpiSlots);dpiColorsRgb=@($Profile.DpiColorsRgb);pollingRateHz=[int]$Profile.PollingRateHz;lighting=$(if($Profile.Light){[ordered]@{mode=[int]$Profile.Light.Mode;enabled=[bool]$Profile.Light.Enabled;speedIndex=[int]$Profile.Light.SpeedIndex;brightnessIndex=[int]$Profile.Light.BrightnessIndex;direction=[int]$Profile.Light.Direction;colorCount=@($Profile.Light.ColorsRgb).Count}}else{$null});keyCount=$keys.Count;keys=$keys;powerDownTimeRaw=$Profile.PowerDownTimeRaw;keyDebounceRaw=$Profile.KeyDebounceRaw;moveClosesLight=$Profile.MoveClosesLight;motionWakeup=$Profile.MotionWakeup}
}
function Get-In9InstalledProfilePreview {
    param([Parameter(Mandatory)][string]$Root,[string[]]$InstallationDirectories,[string]$ApplicationDataRoot)
    $appDataRoot=if($PSBoundParameters.ContainsKey('ApplicationDataRoot')){[IO.Path]::GetFullPath($ApplicationDataRoot)}else{[Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)}
    $appDataConfig=if($appDataRoot){Join-Path $appDataRoot 'GamingMouseData20230908A\config'}else{$null}
    $candidates=if($PSBoundParameters.ContainsKey('InstallationDirectories')){$InstallationDirectories}else{@($appDataConfig,'D:\Program Files\Inphic IN9 Gaming Mouse\config','C:\Program Files\Inphic IN9 Gaming Mouse\config'|Where-Object {$_})}
    $directory=$null
    $source=$null
    $profileFiles=@()
    foreach($candidate in $candidates){
        if(-not[IO.Directory]::Exists($candidate)){continue}
        Assert-In9PlainDirectory $candidate
        $profileFiles=@(Get-ChildItem -LiteralPath $candidate -File -Filter 'default*.psf'|Where-Object {$_.Name -match '^default[0-4]\.psf$'}|Sort-Object Name)
        if($profileFiles.Count){$directory=$candidate;$source=if([IO.Path]::GetFullPath($candidate).TrimEnd('\') -ieq [IO.Path]::GetFullPath($appDataConfig).TrimEnd('\')){'official-user-data'}else{'official-install'};break}
    }
    if(-not$profileFiles.Count){return [ordered]@{found=$false;source=$null;directory=$null;profileCount=0;hardwareIO=$false;applied=$false;stagedOnly=$true;profiles=@();warning='No local IN9 PSF files were found. Import a PSF you exported from the vendor utility.'}}
    $profiles=@($profileFiles|ForEach-Object{
        if($_.Attributes-band[IO.FileAttributes]::ReparsePoint){throw 'IN9 PSF source files must not be links or reparse points.'}
        if($_.Length-lt1-or$_.Length-gt$script:In9MaxProfileBytes){throw 'IN9 PSF must be between1 byte and1MiB.'}
        $bytes=[IO.File]::ReadAllBytes($_.FullName);$document=Get-In9TextDocument $bytes;$profile=$document.Decode3325(37)
        [ordered]@{file=$_.Name;path=$_.FullName;profile=(Get-In9ProfileSummary $document $profile);contentSha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes));contentBase64=[Convert]::ToBase64String($bytes);hardwareReadback=$false;stagedOnly=$true;applied=$false}
    })
    $warning=if($source-eq'bundled-defaults'){'Bundled default PSF templates are local presets, not the mouse current state.'}elseif($source-eq'official-user-data'){'Official Roaming AppData PSF files are local desired profiles, not hardware readback.'}else{'Installed IN9 PSF files are local desired profiles, not hardware readback.'}
    [ordered]@{found=$true;source=$source;directory=$directory;profileCount=$profiles.Count;profiles=$profiles;hardwareIO=$false;applied=$false;stagedOnly=$true;warning=$warning}
}
function Assert-In9PlainDirectory {
    param([Parameter(Mandatory)][string]$Path)
    $current=[IO.Path]::GetFullPath($Path)
    while($true){
        $item=Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if(-not$item.PSIsContainer-or($item.Attributes-band[IO.FileAttributes]::ReparsePoint)){throw 'IN9 archive source/destination directory chains must not contain links or reparse points.'}
        $parent=[IO.Directory]::GetParent($current)
        if($null-eq$parent-or$parent.FullName-ieq$current){break}
        $current=$parent.FullName
    }
}
function Assert-In9ArchiveDirectoryChain {
    param([Parameter(Mandatory)][string]$Root,[Parameter(Mandatory)][string]$Directory)
    $rootPath=[IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $target=[IO.Path]::GetFullPath($Directory)
    if($target-ine$rootPath-and-not$target.StartsWith($rootPath+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'IN9 archive destination escaped the application state root.'}
    Assert-In9PlainDirectory $rootPath
    $relative=[IO.Path]::GetRelativePath($rootPath,$target)
    $current=$rootPath
    foreach($part in $relative.Split([IO.Path]::DirectorySeparatorChar,[StringSplitOptions]::RemoveEmptyEntries)){
        $current=Join-Path $current $part
        if(-not[IO.Directory]::Exists($current)){[void][IO.Directory]::CreateDirectory($current)}
        Assert-In9PlainDirectory $current
    }
}
function Get-In9ArchiveSourceDefinitions {
    $sources=[Collections.Generic.List[object]]::new()
    $appData=[Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
    if($appData){[void]$sources.Add(@{source='official-user-data';path=(Join-Path $appData 'GamingMouseData20230908A\config')})}
    [void]$sources.Add(@{source='official-install';path='D:\Program Files\Inphic IN9 Gaming Mouse\config'})
    [void]$sources.Add(@{source='official-install';path='C:\Program Files\Inphic IN9 Gaming Mouse\config'})
    return ,$sources.ToArray()
}
function Assert-In9VendorProcessesStopped {
    $processes=@(Get-Process -Name @('Inphic IN9 GM','Inphic IN9 Gaming Mouse') -ErrorAction SilentlyContinue)
    try{if($processes.Count){throw 'Close the official IN9 application before archiving its local configuration; no process was stopped.'}}
    finally{foreach($process in $processes){$process.Dispose()}}
}
function Save-In9VendorConfigArchive {
    param([Parameter(Mandatory)][string]$Root,[object[]]$SourceDirectories)
    $rootPath=[IO.Path]::GetFullPath($Root);Assert-In9PlainDirectory $rootPath
    Assert-In9VendorProcessesStopped
    if($PSBoundParameters.ContainsKey('SourceDirectories')){$sources=[object[]]$SourceDirectories}else{$sources=[object[]](Get-In9ArchiveSourceDefinitions)}
    $captured=[Collections.Generic.List[object]]::new();$totalBytes=0
    for($sourceIndex=0;$sourceIndex-lt$sources.Count;$sourceIndex++){
        $source=$sources[$sourceIndex]
        if($source-isnot[Collections.IDictionary]){throw 'IN9 archive source definition must be a fixed object.'}
        if($source.source-cnotin@('official-user-data','official-install')){throw 'IN9 archive source kind is not allowlisted.'}
        if($source.path-isnot[string]){throw 'IN9 archive source path must be a string.'}
        $sourcePath=[IO.Path]::GetFullPath($source.path)
        if(-not[IO.Directory]::Exists($sourcePath)){continue}
        Assert-In9PlainDirectory $sourcePath
        $items=@(Get-ChildItem -LiteralPath $sourcePath -File -Force -ErrorAction Stop|Where-Object {$_.Extension-ieq'.psf'-or$_.Name-ieq'config.ini'-or$_.Name-ieq'MacroLibraryFile.mlf'}|Sort-Object Name)
        foreach($file in $items){
            if($captured.Count-ge64){throw 'IN9 archive exceeds the 64-file cap.'}
            if($file.Attributes-band[IO.FileAttributes]::ReparsePoint){throw ('IN9 archive refuses linked source files: '+$file.Name)}
            if($file.Name-notmatch'^[A-Za-z0-9_. -]{1,128}$'-or$file.Name-match'(^|\.)\.($|\.)'){throw 'IN9 archive source filename is invalid.'}
            $max=if($file.Extension-ieq'.psf'){1048576}elseif($file.Name-ieq'MacroLibraryFile.mlf'){8388608}else{1048576}
            if($file.Length-lt1-or$file.Length-gt$max){throw ('IN9 archive source file exceeds its size cap: '+$file.Name)}
            [byte[]]$bytes=[IO.File]::ReadAllBytes($file.FullName)
            if($bytes.Length-ne$file.Length){throw ('IN9 archive source changed while being read: '+$file.Name)}
            $digest=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))
            $current=Get-Item -LiteralPath $file.FullName -Force -ErrorAction Stop
            if($current.Attributes-band[IO.FileAttributes]::ReparsePoint-or$current.Length-ne$file.Length-or$current.LastWriteTimeUtc-ne$file.LastWriteTimeUtc-or(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash-cne$digest){throw ('IN9 archive source changed during snapshot: '+$file.Name)}
            $totalBytes+=$bytes.Length;if($totalBytes-gt33554432){throw 'IN9 archive exceeds the 32 MiB total cap.'}
            [void]$captured.Add(@{source=[string]$source.source;sourceIndex=$sourceIndex;sourcePath=$file.FullName;sourceLength=$file.Length;sourceLastWriteTimeUtc=$file.LastWriteTimeUtc;fileName=$file.Name;bytes=$bytes;sha256=$digest})
        }
    }
    $createdAt=[datetime]::UtcNow.ToString('o')
    if(-not$captured.Count){return [ordered]@{archiveCreated=$false;archiveId=$null;archiveRelativeDirectory=$null;createdAt=$createdAt;files=@();hardwareReadback=$false;sourceFilesModified=$false;warnings=@('No eligible IN9 PSF, config.ini, or MacroLibraryFile.mlf files were found in the fixed vendor directories.')}}
    $archiveId=[guid]::NewGuid().ToString('D');$stateRoot=Join-Path $rootPath 'local-state'
    if(-not[IO.Directory]::Exists($stateRoot)){[void][IO.Directory]::CreateDirectory($stateRoot)}
    Assert-In9PlainDirectory $stateRoot
    $archiveBase=Join-Path $stateRoot 'vendor-config-archives\in9';Assert-In9ArchiveDirectoryChain $rootPath $archiveBase
    Assert-In9VendorProcessesStopped
    $staging=Join-Path $archiveBase ('.pending-'+$archiveId);$final=Join-Path $archiveBase $archiveId
    if([IO.Directory]::Exists($staging)-or[IO.File]::Exists($staging)-or[IO.Directory]::Exists($final)-or[IO.File]::Exists($final)){throw 'IN9 archive identifier collision.'}
    [void][IO.Directory]::CreateDirectory($staging)
    try{
        $manifestFiles=[Collections.Generic.List[object]]::new();$resultFiles=[Collections.Generic.List[object]]::new()
        foreach($item in $captured){
            $folder='source-'+$item.sourceIndex;$folderPath=Join-Path $staging $folder;[void][IO.Directory]::CreateDirectory($folderPath);Assert-In9PlainDirectory $folderPath
            $relative=$folder+'/'+$item.fileName;$destination=Join-Path $folderPath $item.fileName
            $stream=[IO.FileStream]::new($destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
            try{$stream.Write($item.bytes,0,$item.bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
            if((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash-cne$item.sha256){throw ('IN9 archive destination hash mismatch: '+$relative)}
            [void]$manifestFiles.Add([ordered]@{source=$item.source;fileName=$item.fileName;relativePath=$relative;byteLength=$item.bytes.Length;sha256=$item.sha256})
            [void]$resultFiles.Add([ordered]@{source=$item.source;fileName=$item.fileName;relativePath=($relative.Replace('\','/'));byteLength=$item.bytes.Length;sha256=$item.sha256})
        }
        $manifest=[ordered]@{schemaVersion=1;archiveId=$archiveId;createdAt=$createdAt;scope='in9-local-vendor-files';hardwareReadback=$false;sourceFilesModified=$false;files=@($manifestFiles.ToArray());warning='Raw local files only. This archive is not a mouse hardware snapshot or recovery baseline.'}
        $manifestBytes=[Text.UTF8Encoding]::new($false).GetBytes(($manifest|ConvertTo-Json -Depth 8))
        $manifestPath=Join-Path $staging 'manifest.json';$stream=[IO.FileStream]::new($manifestPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
        try{$stream.Write($manifestBytes,0,$manifestBytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
        Assert-In9VendorProcessesStopped
        foreach($item in $captured){
            if(-not[IO.File]::Exists($item.sourcePath)){throw ('IN9 archive source disappeared before commit: '+$item.fileName)}
            $current=Get-Item -LiteralPath $item.sourcePath -Force -ErrorAction Stop
            if($current.Attributes-band[IO.FileAttributes]::ReparsePoint-or$current.Length-ne$item.sourceLength-or$current.LastWriteTimeUtc-ne$item.sourceLastWriteTimeUtc-or(Get-FileHash -LiteralPath $item.sourcePath -Algorithm SHA256).Hash-cne$item.sha256){throw ('IN9 archive source changed before commit: '+$item.fileName)}
        }
        [IO.Directory]::Move($staging,$final)
        return [ordered]@{archiveCreated=$true;archiveId=$archiveId;archiveRelativeDirectory=('local-state/vendor-config-archives/in9/'+$archiveId);createdAt=$createdAt;files=@($resultFiles.ToArray());hardwareReadback=$false;sourceFilesModified=$false;warnings=@('Raw vendor-local configuration copy only; it does not establish current device settings or a hardware restore baseline.')}
    }catch{
        if([IO.Directory]::Exists($staging)){Assert-In9PlainDirectory $staging;[IO.Directory]::Delete($staging,$true)}
        throw
    }
}
function Get-In9Warnings {
    param([Parameter(Mandatory)]$Document,[Parameter(Mandatory)]$Profile)
    $warnings=[Collections.Generic.List[string]]::new()
    [void]$warnings.Add('PSF is a user-selected local profile; it is not a hardware readback or original-device backup.')
    if($null-eq$Profile.PowerDownTimeRaw -or $null-eq$Profile.MoveClosesLight){[void]$warnings.Add('PowerDownTime/MoveLightingOnOffMode is absent; power domain remains unavailable until explicitly supplied.')}
    if($null-eq$Profile.KeyDebounceRaw){[void]$warnings.Add('KeyDebounce is absent; debounce domain remains unavailable until explicitly supplied.')}
    if($null-eq$Profile.MotionWakeup){[void]$warnings.Add('MotionWakeup is absent; motion domain remains unavailable until explicitly supplied.')}
    if($null-eq$Document.Get('LiftDetectionHeight')){[void]$warnings.Add('LiftDetectionHeight is absent; LiftDetectionValue is not substituted.')}
    if(-not$Profile.Light.Enabled -and $Profile.Light.Mode-ne0){[void]$warnings.Add('Lighting OffOn=false with nonzero mode has no proven wire transform and is rejected by apply planning.')}
    [void]$warnings.Add('No complete IN9 settings readback exists; transmitted frames are not verified hardware state.')
    return $warnings.ToArray()
}
function New-In9Preview {
    param([Parameter(Mandatory)][byte[]]$Bytes,[Parameter(Mandatory)][byte]$Sensor,[Parameter(Mandatory)][string[]]$Domains)
    if($Sensor-ne37){throw 'Only the statically traced sensor25/3325 branch is accepted.'}
    $document=Get-In9TextDocument $Bytes;$profile=$document.Decode3325($Sensor)
    $plan=[PeripheralHub.Inphic.In9ApplyPlan]::FromOfficialPsf($document,$Sensor,0,$Domains)
    [ordered]@{profile=(Get-In9ProfileSummary $document $profile);packetCount=@($plan.Packets).Count;domains=@($Domains);warnings=@(Get-In9Warnings $document $profile);hardwareReadback=$false;verified=$false;transmitted=$false;applied=$false;contentBase64=[Convert]::ToBase64String($Bytes);contentSha256=([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)))}
}
function Read-In9JsonFile {
    param([Parameter(Mandatory)][string]$Path)
    if(-not[IO.File]::Exists($Path)){return $null}
    if((Get-Item -LiteralPath $Path).Length-gt8MB){throw 'IN9 profile ledger exceeds8MiB; writes are blocked.'}
    try{$record=([IO.File]::ReadAllText($Path)|ConvertFrom-Json -AsHashtable -ErrorAction Stop);if($null-eq$record-or$record-isnot[Collections.IDictionary]){throw 'Ledger must contain a JSON object.'};return $record}catch{throw ('IN9 profile ledger is corrupt; writes are blocked: '+$_.Exception.Message)}
}
function Write-In9AtomicJson {
    param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)]$Value)
    $dir=Split-Path -Parent $Path;[IO.Directory]::CreateDirectory($dir)|Out-Null
    $tmp=$Path+'.'+[guid]::NewGuid().ToString('N')+'.tmp';$stream=$null
    try{
        $bytes=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 20 -Compress));if($bytes.Length-gt8MB){throw 'IN9 profile ledger exceeds8MiB.'}
        $stream=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true);$stream.Dispose();$stream=$null;[IO.File]::Move($tmp,$Path,$true)
    }finally{if($stream){$stream.Dispose()};if([IO.File]::Exists($tmp)){[IO.File]::Delete($tmp)}}
}
function Get-In9ContainerId {
    if(-not('PeripheralHub.In9Transport' -as[type])){throw 'IN9 generated-frame transport is unavailable.'}
    $method=[PeripheralHub.In9Transport].GetMethod('In9ContainerId',[Type[]]@());if($null-eq$method){throw 'IN9 container identity method is not installed; refusing unbound write.'}
    $id=[string]$method.Invoke($null,@());$parsed=[guid]::Empty
    if(-not[guid]::TryParse($id,[ref]$parsed)-or$parsed-eq[guid]::Empty){throw 'IN9 container identity is invalid.'};return $parsed.ToString('D').ToLowerInvariant()
}
function Get-In9HardwareInfo {
    param([Parameter(Mandatory)][byte]$Sequence)
    if(-not('PeripheralHub.HidConfigTransport' -as[type])-or-not('PeripheralHub.Analysis.In9FeatureProtocol' -as[type])){throw 'IN9 info transport is unavailable.'}
    $query=[PeripheralHub.Analysis.In9FeatureProtocol]::BuildInfoQuery($Sequence);$reply=[PeripheralHub.HidConfigTransport]::In9Exchange($query,$true);$info=[PeripheralHub.Analysis.In9FeatureProtocol]::ParseInfo($reply,$Sequence)
    [ordered]@{sensorCode=[int]$info.SensorCode;sensorName=$info.SensorName;family=$info.Family;batteryPercent=[int]$info.OfficialDisplayBatteryPercent;charging=[bool]$info.IsCharging;activityFlagRaw=[int]$info.ActivityFlagRaw;readAt=[datetime]::UtcNow.ToString('o')}
}
function Convert-In9Packets {
    param([Parameter(Mandatory)]$Plan)
    $result=[byte[][]]::new(@($Plan.Packets).Count);for($i=0;$i-lt@($Plan.Packets).Count;$i++){$result[$i]=[byte[]]$Plan.Packets[$i].Bytes};return ,$result
}
function Send-In9Plan {
    param([Parameter(Mandatory)]$Plan,[Parameter(Mandatory)][string]$ContainerId)
    if(-not('PeripheralHub.In9Transport' -as[type])){throw 'IN9 generated-frame sender is not installed; no write attempted.'}
    $method=[PeripheralHub.In9Transport].GetMethod('In9SendConfiguration',[Type[]]@([byte[][]],[string]));if($null-eq$method){throw 'IN9 generated-frame sender is not installed; no write attempted.'}
    $packets=Convert-In9Packets $Plan
    try{$sent=[int]$method.Invoke($null,[object[]]@($packets,$ContainerId))}catch{
        $cause=$_.Exception;while($cause.InnerException){$cause=$cause.InnerException}
        $sendException=[InvalidOperationException]::new(('IN9 generated-frame transmission failed: '+$cause.Message),$cause)
        if($cause.Data.Contains('OSAcceptedCount')){$sendException.Data['OSAcceptedCount']=[int]$cause.Data['OSAcceptedCount']}
        throw $sendException
    }
    if($sent-lt0-or$sent-gt$packets.Length){throw 'IN9 sender returned an invalid transmitted count.'}
    if($sent-ne$packets.Length){throw "IN9 transmission was partial ($sent/$($packets.Length)); pending ledger retained."};return $sent
}
function Assert-In9Ledger {
    param($Ledger)
    if($null-eq$Ledger){return}
    try{
        if($Ledger-isnot[Collections.IDictionary]-or$Ledger.schema-ne1-or$Ledger.deviceId-ne'inphic-in9'){throw 'Invalid schema.'}
        foreach($name in @('containerId','pending','active','previousApplied','updatedAt')){if(-not$Ledger.Contains($name)){throw 'Missing ledger field.'}}
        $parsed=[guid]::Empty;if(-not[guid]::TryParse([string]$Ledger.containerId,[ref]$parsed)-or$parsed-eq[guid]::Empty){throw 'Invalid container identity.'}
        foreach($name in @('pending','active','previousApplied')){
            $entry=$Ledger[$name];if($null-eq$entry){continue};if($entry-isnot[Collections.IDictionary]){throw 'Invalid profile receipt.'}
            $bytes=Convert-In9Content ([string]$entry.contentBase64);if($entry.contentSha256-cne[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))){throw 'Profile receipt checksum mismatch.'}
            $domains=Get-In9Domains $entry.domains -Historical;$null=New-In9Preview $bytes 37 $domains
            if($name-ne'pending'-and($entry.transmitted-isnot[bool]-or-not$entry.transmitted-or$entry.hardwareReadback-isnot[bool]-or$entry.hardwareReadback-or$entry.verified-isnot[bool]-or$entry.verified)){throw 'Invalid transmission provenance.'}
        }
    }catch{throw ('IN9 profile ledger is corrupt; writes are blocked and the file is preserved: '+$_.Exception.Message)}
}
function New-In9ProfileLedgerRecord {
    param([string]$ContainerId,$Pending,$Active,$Previous)
    [ordered]@{schema=1;deviceId='inphic-in9';containerId=$ContainerId;updatedAt=[datetime]::UtcNow.ToString('o');pending=$Pending;active=$Active;previousApplied=$Previous}
}
function New-In9ProfileMeta {
    param([Parameter(Mandatory)][byte[]]$Bytes,[Parameter(Mandatory)][string[]]$Domains,[Parameter(Mandatory)][int]$PacketCount)
    [ordered]@{contentBase64=[Convert]::ToBase64String($Bytes);contentSha256=([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)));domains=@($Domains);packetCount=$PacketCount;selectedAt=[datetime]::UtcNow.ToString('o')}
}
function Update-In9ProfileBytes {
    param([byte[]]$Bytes,$Updates)
    if($null-eq$Updates){return ,$Bytes}
    if($Updates-isnot[Collections.IDictionary]-or$Updates.Count-gt64){throw 'updates must be an object with at most64 string fields.'}
    $doc=Get-In9TextDocument $Bytes
    foreach($name in $Updates.Keys){
        if($name-isnot[string]-or$Updates[$name]-isnot[string]-or$Updates[$name].Length-gt8192){throw 'PSF updates require bounded string names and values.'}
        $allowed=$name-match '^(ProfileName|GameFile[0-2]|DPIOffOnFlagValue|CurrentDPILevelValue|XYSetting[1-8]Value|DPILevelIndication[0-7]Valuer|PollingRateName|PollingRateValue|Lighting1(Name|ModeValue|OffOn|Speed|Brightness|ColorSelected|FixedColor|Direction)|Key[0-5](Name|Value)|PowerDownTime|MoveLightingOnOffMode|KeyDebounce|MotionWakeup|LiftDetectionHeight)$'
        if($name-eq'ProfileName'-and$Updates[$name].Length-gt256){throw 'ProfileName is limited to256 characters.'}
        if($name-match '^GameFile[0-2]$'-and$Updates[$name].Length-gt512){throw "$name is limited to512 characters."}
        if(-not$allowed){throw "Unsupported PSF update field: $name"}
        if($name-eq'LiftDetectionHeight'-and$Updates[$name]-notin@('1','2')){throw 'LiftDetectionHeight must be decimal1 or2.'}
        $doc.Set([string]$name,[string]$Updates[$name])
    }
    $null=$doc.Decode3325(37)
    return ,$doc.ExportUtf16Le()
}
function Get-In9ReceiptSummary {
    param($Entry)
    if($null-eq$Entry){return $null}
    [ordered]@{contentSha256=$Entry.contentSha256;domains=@($Entry.domains);packetCount=$Entry.packetCount;selectedAt=$Entry.selectedAt;transmitted=$true;hardwareReadback=$false;verified=$false}
}
function Convert-In9HubMacroEvents {
    param([Parameter(Mandatory)]$Macro)
    Assert-In9RequestShape $Macro @('id','name','folderId','events','repeat') @('id','name','events','repeat')
    if($Macro.name-isnot[string]-or[string]::IsNullOrWhiteSpace($Macro.name)-or$Macro.name.Length-gt60){throw 'Macro name must contain1..60 characters.'}
    if($Macro.events-isnot[Array]-or$Macro.events.Count-lt1-or$Macro.events.Count-gt4096){throw 'Macro events must contain1..4096 entries.'}
    $events=[Collections.Generic.List[PeripheralHub.Inphic.In9HubMacroEvent]]::new()
    foreach($item in $Macro.events){
        if($item-isnot[Collections.IDictionary]-or-not$item.Contains('kind')){throw 'Macro event must be a structured object.'}
        $event=[PeripheralHub.Inphic.In9HubMacroEvent]::new();$event.Kind=[string]$item.kind
        switch($item.kind){
            {$_-in@('keyDown','keyUp')}{
                Assert-In9RequestShape $item @('kind','code') @('kind','code')
                if(($item.code-isnot[int]-and$item.code-isnot[long])-or$item.code-lt0-or$item.code-gt65535){throw 'Keyboard code must be an integer HID usage.'};$event.Code=[int]$item.code
            }
            {$_-in@('mouseDown','mouseUp')}{
                Assert-In9RequestShape $item @('kind','button') @('kind','button')
                if($item.button-isnot[string]-or$item.button-notin@('left','right','middle','back','forward')){throw 'Mouse macro button is unsupported.'};$event.Button=$item.button
            }
            'delay'{
                Assert-In9RequestShape $item @('kind','duration','unit') @('kind','duration','unit')
                if(($item.duration-isnot[int]-and$item.duration-isnot[long])-or$item.duration-lt0-or$item.duration-gt4095-or$item.unit-cne'milliseconds'){throw 'IN9 requires explicit millisecond delays0..4095; unsupported values are not truncated.'};$event.Duration=[int]$item.duration;$event.Unit=$item.unit
            }
            'move'{
                Assert-In9RequestShape $item @('kind','x','y') @('kind','x','y')
                if(($item.x-isnot[int]-and$item.x-isnot[long])-or($item.y-isnot[int]-and$item.y-isnot[long])){throw 'Cursor movement axes must be integers.'}
                $event.X=[int]$item.x;$event.Y=[int]$item.y
            }
            default{throw "Macro event is not supported by the proven IN9 codec: $($item.kind)"}
        }
        $events.Add($event)
    }
    return ,$events.ToArray()
}
function Invoke-In9ProfileAction {
    param([Parameter(Mandatory)][string]$Root,[Parameter(Mandatory)][Collections.IDictionary]$Request)
    $root=Get-In9Root $Root;Initialize-In9Types $root
    $ledgerPath=Join-Path $root 'local-state\in9-profiles.json'
    $action=[string]$Request.action
    switch($action){
        'mouse-profile-status-read'{
            Assert-In9RequestShape $Request @('action') @('action')
            Initialize-In9Types $root -Transport
            [byte]$sequence=Get-Random -Minimum 1 -Maximum 255
            $info=Get-In9HardwareInfo $sequence
            return [ordered]@{source='live-hardware-feature20';scope='identity-power-activity';hardwareReadback=$true;writePerformed=$false;sensorCode=$info.sensorCode;sensorName=$info.sensorName;family=$info.family;batteryPercent=$info.batteryPercent;charging=$info.charging;activityFlagRaw=$info.activityFlagRaw;readAt=$info.readAt;warnings=@('This live read proves only Feature20 identity and power/activity status. DPI, polling, buttons, lighting, sleep, and macro settings were not read back.')}
        }
        'mouse-profile-installed-list'{
            Assert-In9RequestShape $Request @('action') @('action')
            return Get-In9InstalledProfilePreview $root
        }
        'mouse-profile-archive-installed'{
            Assert-In9RequestShape $Request @('action') @('action')
            return Save-In9VendorConfigArchive -Root $root
        }
        'mouse-profile-preview'{
            Assert-In9RequestShape $Request @('action','contentBase64','sensor','domains','updates') @('action','contentBase64','sensor','domains')
            if($Request.sensor-isnot[int]-and$Request.sensor-isnot[long]){throw 'sensor must be integer37.'};if($Request.sensor-ne37){throw 'Only sensor37/3325 is supported.'}
            $bytes=Convert-In9Content ([string]$Request.contentBase64);if($Request.Contains('updates')){$bytes=Update-In9ProfileBytes $bytes $Request.updates};$domains=Get-In9Domains $Request.domains
            return New-In9Preview $bytes 37 $domains
        }
        'mouse-profile-export'{
            Assert-In9RequestShape $Request @('action','contentBase64','format','updates') @('action','contentBase64','format')
            $bytes=Convert-In9Content ([string]$Request.contentBase64);if($Request.Contains('updates')){$bytes=Update-In9ProfileBytes $bytes $Request.updates};$doc=Get-In9TextDocument $bytes
            if($Request.format-eq'preserve'){$out=$doc.ExportUtf16Le()}
            else{throw 'format must be preserve.'}
            return [ordered]@{contentBase64=[Convert]::ToBase64String($out);contentSha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($out));byteLength=$out.Length;format=[string]$Request.format;hardwareReadback=$false;warnings=@('Exported values are a selected local profile, not hardware state.')}
        }
        'mouse-profile-read'{
            Assert-In9RequestShape $Request @('action') @('action')
            $ledger=Read-In9JsonFile $ledgerPath;Assert-In9Ledger $ledger
            $canRestore=$false
            $warnings=@('Local receipts prove only previous generated-frame transmission; no original hardware snapshot exists.')
            if($ledger){
                $target=if($ledger.pending){$ledger.active}else{$ledger.previousApplied}
                $reference=if($ledger.pending){$ledger.pending}else{$ledger.active}
                if($reference -and 'macros' -cin $reference.domains){$warnings+='旧版宏传输记录仅供查看，新版不能重发该范围。'}
                elseif($target -and $reference){$canRestore=(@($target.domains|Sort-Object)-join'|') -ceq (@($reference.domains|Sort-Object)-join'|')}
            }
            return [ordered]@{source='local-transmission-ledger';hardwareReadback=$false;verified=$false;hasOriginalHardwareBaseline=$false;active=$(if($ledger){Get-In9ReceiptSummary $ledger.active}else{$null});previousApplied=$(if($ledger){Get-In9ReceiptSummary $ledger.previousApplied}else{$null});recoveryPending=([bool]($ledger-and$ledger.pending));canRestorePrevious=$canRestore;containerId=$(if($ledger){$ledger.containerId}else{$null});warnings=$warnings}
        }
        {$_-in@('mouse-profile-apply','mouse-profile-restore')}{
            if($action-eq'mouse-profile-apply'){
                Assert-In9RequestShape $Request @('action','contentBase64','domains','acceptReplaceUnknown') @('action','contentBase64','domains','acceptReplaceUnknown')
            }else{Assert-In9RequestShape $Request @('action','acceptReplaceUnknown') @('action','acceptReplaceUnknown')}
            if($Request.acceptReplaceUnknown-isnot[bool]-or-not$Request.acceptReplaceUnknown){throw 'acceptReplaceUnknown=true is required to replace unknown current settings with the selected profile.'}
            $ledger=Read-In9JsonFile $ledgerPath;Assert-In9Ledger $ledger
            $pendingReplay=$false;$pendingRecovery=$false
            if($action-eq'mouse-profile-restore'){
                if(-not$ledger){throw 'No transmitted profile is available; unknown original hardware settings cannot be restored.'}
                if($ledger.pending){
                    if(-not$ledger.active){throw 'First transmission is unresolved and no earlier receipt exists. Explicitly apply the same selected profile/domains to retry; unknown original settings cannot be restored.'}
                    $target=$ledger.active;$pendingRecovery=$true;$expectedDomains=@($ledger.pending.domains|Sort-Object)
                }else{
                    if(-not$ledger.previousApplied){throw 'No previously transmitted profile is available; unknown original hardware settings cannot be restored.'}
                    $target=$ledger.previousApplied;$expectedDomains=@($ledger.active.domains|Sort-Object)
                }
                $bytes=Convert-In9Content ([string]$target.contentBase64);$domains=Get-In9Domains $target.domains
                $a=@($expectedDomains);$b=@($domains|Sort-Object);if(($a-join'|')-cne($b-join'|')){throw 'Recovery profile covers different domains; restoring unknown hardware domains is not permitted.'}
            }else{
                $bytes=Convert-In9Content ([string]$Request.contentBase64);$domains=Get-In9Domains $Request.domains
                if($ledger-and$ledger.pending){
                    $hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes));$a=@($ledger.pending.domains|Sort-Object);$b=@($domains|Sort-Object)
                    if($hash-cne$ledger.pending.contentSha256-or($a-join'|')-cne($b-join'|')){throw 'An unresolved transmission may only replay the same explicitly accepted selected profile and domains, or restore an earlier known receipt.'}
                    $pendingReplay=$true
                }
            }
            # Validate generated bytes and all fields before querying the device or persisting a pending write.
            $preview=New-In9Preview $bytes 37 $domains
            if($preview.packetCount-lt1-or$preview.packetCount-gt256){throw 'IN9 apply requires1..256 generated packets; the selected domains produce no transmissible configuration.'}
            Initialize-In9Types $root -Transport
            $container=Get-In9ContainerId
            if($ledger-and$ledger.containerId-ine$container){throw 'IN9 profile receipts belong to a different receiver; writes are blocked.'}
            [byte]$seq=Get-Random -Minimum 1 -Maximum 255;$info=Get-In9HardwareInfo $seq
            if($info.family-ne'M909'-or$info.sensorCode-ne37){throw 'Live IN9 family/sensor does not match the selected3325 profile.'}
            if((Get-In9ContainerId)-ine$container){throw 'IN9 receiver identity changed during preparation; no configuration was sent.'}
            $doc=Get-In9TextDocument $bytes;$plan=[PeripheralHub.Inphic.In9ApplyPlan]::FromOfficialPsf($doc,37,([byte](($seq+1)%256)),$domains)
            $pending=New-In9ProfileMeta $bytes $domains @($plan.Packets).Count;$pending.action=$action
            $active=$(if($ledger){$ledger.active}else{$null});$previous=$(if($ledger){$ledger.previousApplied}else{$null})
            $next=New-In9ProfileLedgerRecord $container $pending $active $previous;Write-In9AtomicJson $ledgerPath $next
            try{$sent=Send-In9Plan $plan $container}
            catch{
                $next.pending.failure='Native sender failed; the failing report may have reached hardware. No automatic replay occurred.'
                $cause=$_.Exception;while($cause.InnerException){$cause=$cause.InnerException}
                if($cause.Data.Contains('OSAcceptedCount')){$next.pending.osAcceptedCount=[int]$cause.Data['OSAcceptedCount']}else{$next.pending.osAcceptedCount=$null}
                Write-In9AtomicJson $ledgerPath $next;throw
            }
            $receipt=New-In9ProfileMeta $bytes $domains $sent;$receipt.transmitted=$true;$receipt.hardwareReadback=$false;$receipt.verified=$false;$receipt.transmittedAt=[datetime]::UtcNow.ToString('o')
            $completed=New-In9ProfileLedgerRecord $container $null $receipt $active;Write-In9AtomicJson $ledgerPath $completed
            $preview.transmitted=$true;$preview.transmittedCount=$sent;$preview.packetCount=$sent;$preview.hardwareReadback=$false;$preview.verified=$false;$preview.applied=$false;$preview.containerId=$container;$preview.info=$info;$preview.baselineKind='explicitly-selected-desired-profile';$preview.restoreKind=$(if($pendingRecovery){'known-receipt-before-pending-transmission'}elseif($action-eq'mouse-profile-restore'){'previous-transmitted-profile'}else{$null});$preview.pendingReplay=$pendingReplay
            $preview.warnings+= 'All generated packets were accepted by the OS sender; physical effects and hardware storage have not been read back.'
            return $preview
        }
        default{throw 'Unknown IN9 profile action.'}
    }
}
