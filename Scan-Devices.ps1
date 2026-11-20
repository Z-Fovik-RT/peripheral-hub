#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'reports'),
    [switch]$OpenReport
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This tool requires Windows and PowerShell 7.' }
if (-not ('PeripheralHub.HidInventory' -as [type])) {
    Add-Type -Path (Join-Path $PSScriptRoot 'native\HidInventory.cs')
}

# Descriptors/capabilities only. No WriteFile, SetFeature, GetFeature or input polling.
$hid = @([PeripheralHub.HidInventory]::Scan())
$warnings = [System.Collections.Generic.List[string]]::new()
$pnp = @()
try {
    $pnp = @(Get-PnpDevice -PresentOnly | Where-Object {
        $_.Class -in @('Mouse', 'Keyboard', 'HIDClass', 'AudioEndpoint', 'MEDIA')
    })
} catch { $warnings.Add('PnP inventory: ' + $_.Exception.Message) }
$properties = @()
if ($pnp.Count) {
    $properties = @(Get-PnpDeviceProperty -InstanceId $pnp.InstanceId -KeyName @(
        'DEVPKEY_Device_ContainerId', 'DEVPKEY_Device_BusReportedDeviceDesc'
    ) -ErrorAction SilentlyContinue)
}
$metadata = @{}
foreach ($p in $properties) {
    if (-not $metadata.ContainsKey($p.InstanceId)) { $metadata[$p.InstanceId] = @{} }
    $metadata[$p.InstanceId][$p.KeyName] = [string]$p.Data
}
# Some devices may appear between the native scan and PnP enumeration; retry missing container metadata individually.
$deviceIds = @(@($hid.InstanceId) + @($pnp.InstanceId) | Where-Object { $_ } | Sort-Object -Unique)
foreach ($deviceId in $deviceIds) {
    if (-not $metadata.ContainsKey($deviceId) -or -not $metadata[$deviceId]['DEVPKEY_Device_ContainerId']) {
        $retry = @(Get-PnpDeviceProperty -InstanceId $deviceId -KeyName @(
            'DEVPKEY_Device_ContainerId', 'DEVPKEY_Device_BusReportedDeviceDesc'
        ) -ErrorAction SilentlyContinue)
        foreach ($property in $retry) {
            if (-not $metadata.ContainsKey($property.InstanceId)) { $metadata[$property.InstanceId] = @{} }
            $metadata[$property.InstanceId][$property.KeyName] = [string]$property.Data
        }
    }
}
function Get-Container([string]$Id) {
    $data = $metadata[$Id]
    if ($data) {
        $value = $data['DEVPKEY_Device_ContainerId']
        if ($value -and $value -ne '{00000000-0000-0000-0000-000000000000}') { return $value.ToLowerInvariant() }
    }
    return ''
}
$pnpRows = @($pnp | ForEach-Object {
    $desc = $null
    if ($metadata[$_.InstanceId]) { $desc = $metadata[$_.InstanceId]['DEVPKEY_Device_BusReportedDeviceDesc'] }
    [pscustomobject]@{
        Class = $_.Class; Name = $_.FriendlyName; Status = $_.Status
        InstanceId = $_.InstanceId; ContainerId = (Get-Container $_.InstanceId)
        BusDescription = $desc
    }
})
$audio = @($pnpRows | Where-Object { $_.Class -in @('MEDIA','AudioEndpoint') })
$hidRows = @($hid | ForEach-Object {
    $container = Get-Container $_.InstanceId
    $key = if ($container) { 'container:' + $container } else { 'interface:' + $_.Path }
    $name = @($pnpRows | Where-Object InstanceId -EQ $_.InstanceId | Select-Object -ExpandProperty Name)
    [pscustomobject]@{
        GroupKey = $key; ContainerId = $container; InstanceId = $_.InstanceId; Path = $_.Path
        VendorId = $_.VendorId; ProductId = $_.ProductId; Manufacturer = $_.Manufacturer
        Product = $_.Product; WindowsName = ($name -join '; ')
        UsagePage = $_.UsagePage; Usage = $_.Usage; Kind = $_.Kind
        InputReportBytes = $_.InputReportBytes; OutputReportBytes = $_.OutputReportBytes
        FeatureReportBytes = $_.FeatureReportBytes; CapsRead = $_.CapsRead; Notes = @($_.Notes)
    }
})
# ContainerId distinguishes physical/virtual device containers, including devices with identical VID/PID.
# A missing ContainerId leaves an individual interface ungrouped rather than merging unrelated receivers.
$groups = @($hidRows | Group-Object GroupKey | ForEach-Object {
    $items = @($_.Group)
    $first = $items[0]
    $matchingAudio = @()
    if ($first.ContainerId) { $matchingAudio = @($audio | Where-Object ContainerId -EQ $first.ContainerId) }
    $names = @($items.Product | Where-Object { $_ } | Sort-Object -Unique)
    if (-not $names.Count) { $names = @($items.WindowsName | Where-Object { $_ } | Sort-Object -Unique) }
    if (-not $names.Count) { $names = @('未返回产品名称') }
    [pscustomobject]@{
        Key = $_.Name; ContainerId = $first.ContainerId; Name = ($names -join ' / ')
        Ids = @($items | Where-Object VendorId | ForEach-Object { $_.VendorId + ':' + $_.ProductId } | Sort-Object -Unique)
        Manufacturers = @($items.Manufacturer | Where-Object { $_ } | Sort-Object -Unique)
        InterfaceCount = $items.Count
        VendorDefinedCount = @($items | Where-Object Kind -EQ 'Vendor-defined').Count
        HasUsbStyleId = [bool](@($items | Where-Object { $_.InstanceId -match '^HID\\VID_' }).Count)
        Interfaces = $items; Audio = $matchingAudio
    }
} | Sort-Object @{Expression='HasUsbStyleId';Descending=$true}, Name)

# Match only identities supported by the supplied vendor package evidence.
$profilePath = Join-Path $PSScriptRoot 'device-profiles.json'
$profiles = @()
if (Test-Path -LiteralPath $profilePath) {
    $profileData = [IO.File]::ReadAllText($profilePath) | ConvertFrom-Json
    $profiles = @($profileData.devices)
}
foreach ($group in $groups) {
    $matches = @(foreach ($profile in $profiles) {
        foreach ($hardware in $profile.hardware) {
            $id = ($hardware.vid + ':' + $hardware.pid).ToUpperInvariant()
            if ($id -notin $group.Ids) { continue }
            if ($profile.productContains -and -not $group.Name.Contains([string]$profile.productContains, [StringComparison]::OrdinalIgnoreCase)) { continue }
            [pscustomobject]@{
                ProfileId = $profile.id; Name = $profile.name; Category = $profile.category
                HardwareId = $id; Connection = $hardware.connection
                ControlStatus = $profile.privateControlStatus; Evidence = @($profile.evidence)
            }
        }
    })
    $displayName = if ($matches.Count) { ($matches.Name | Sort-Object -Unique) -join ' / ' } else { $group.Name }
    $group | Add-Member -NotePropertyName ProfileMatches -NotePropertyValue $matches
    $group | Add-Member -NotePropertyName DisplayName -NotePropertyValue $displayName
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$base = Join-Path $OutputDirectory ('devices-' + $stamp)
$jsonPath = $base + '.json'
$htmlPath = $base + '.html'
$payload = [ordered]@{
    SchemaVersion = 1; CapturedAt = [DateTimeOffset]::Now.ToString('o'); Platform = 'Windows'
    Scope = 'Present HID metadata and PnP audio/input inventory; no configuration or input reports read.'
    HidInterfaceCount = $hidRows.Count; HidGroupCount = $groups.Count
    Warnings = @($warnings); Groups = $groups; HidInterfaces = $hidRows; AudioDevices = $audio; PnpDevices = $pnpRows
}
$payload | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath $jsonPath -Encoding utf8

function ConvertTo-HtmlText($value) { [System.Net.WebUtility]::HtmlEncode([string]$value) }
function Cap($row, [string]$property) { if ($row.CapsRead) { return [string]$row.$property } else { return '—' } }
$cards = foreach ($group in $groups) {
    $rows = foreach ($row in $group.Interfaces) {
        $status = if ($row.CapsRead) { '已读描述信息' } else { '元数据未读到' }
        '<tr><td>' + (ConvertTo-HtmlText $row.Kind) + '</td><td><code>' + (ConvertTo-HtmlText $row.UsagePage) + ':' + (ConvertTo-HtmlText $row.Usage) + '</code></td><td>' +
        (Cap $row 'InputReportBytes') + '</td><td>' + (Cap $row 'OutputReportBytes') + '</td><td>' +
        (Cap $row 'FeatureReportBytes') + '</td><td>' + (ConvertTo-HtmlText $status) + '</td></tr>'
    }
    $ids = $group.Ids -join ' / '
    $label = if ($group.ProfileMatches.Count) { '厂商包标识匹配 · 控制待适配' } elseif ($group.VendorDefinedCount) { '存在厂商自定义接口 · 协议待确认' } else { '已枚举 · 控制能力待确认' }
    $audioText = if ($group.Audio.Count) { '<p>同一容器音频：' + (ConvertTo-HtmlText (($group.Audio.Name | Sort-Object -Unique) -join '；')) + '</p>' } else { '' }
    $details = $group.Interfaces | ForEach-Object { '<li><code>' + (ConvertTo-HtmlText $_.InstanceId) + '</code>' + (ConvertTo-HtmlText ($_.Notes -join '；')) + '</li>' }
    '<article data-search="' + (ConvertTo-HtmlText ($group.DisplayName + ' ' + $group.Name + ' ' + $ids + ' ' + ($group.Manufacturers -join ' '))) + '"><header><div><h2>' +
    (ConvertTo-HtmlText $group.DisplayName) + '</h2><p>' + (ConvertTo-HtmlText $group.Name) + ' · ' + (ConvertTo-HtmlText ($group.Manufacturers -join ' / ')) + ' · <code>' + (ConvertTo-HtmlText $ids) + '</code></p></div><span class="tag">' +
    (ConvertTo-HtmlText $label) + '</span></header>' + $audioText + '<div class="table-wrap"><table><thead><tr><th>接口用途</th><th>Usage Page:Usage</th><th>Input 字节</th><th>Output 字节</th><th>Feature 字节</th><th>状态</th></tr></thead><tbody>' +
    ($rows -join '') + '</tbody></table></div><details><summary>查看 Windows 接口标识</summary><ul>' + ($details -join '') + '</ul></details></article>'
}
$audioRows = $audio | ForEach-Object {
    '<tr><td>' + (ConvertTo-HtmlText $_.Name) + '</td><td>' + (ConvertTo-HtmlText $_.Class) + '</td><td>' + (ConvertTo-HtmlText $_.Status) + '</td></tr>'
}
$warningHtml = if ($warnings.Count) { '<p class="note">扫描提示：' + (ConvertTo-HtmlText ($warnings -join '；')) + '</p>' } else { '' }
$html = @"
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>外设统一控制 · 设备检测报告</title>
<style>
:root{color-scheme:dark;--bg:#0d1424;--panel:#172237;--line:#30415f;--ink:#eaf0ff;--muted:#b4c1d9;--accent:#64d6bb}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 "Segoe UI","Microsoft YaHei",sans-serif}main{max-width:1180px;margin:auto;padding:32px 20px 60px}h1{font-size:28px;margin:0}h2{font-size:19px;margin:0}p{color:var(--muted);margin:8px 0}header{display:flex;justify-content:space-between;gap:16px;align-items:start;flex-wrap:wrap}article,.panel{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:22px;margin:18px 0}.tag{font-size:12px;background:#173e3c;color:#8aecd3;padding:6px 10px;border-radius:8px}.stats{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}.stats div{padding:14px 20px;background:var(--panel);border:1px solid var(--line);border-radius:12px}.stats b{font-size:24px;color:var(--accent);margin-right:8px}input{width:100%;padding:12px 14px;background:var(--panel);border:1px solid var(--line);border-radius:10px;color:var(--ink);font:inherit}input:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.table-wrap{overflow:auto;margin-top:16px}table{border-collapse:collapse;width:100%;white-space:nowrap;text-align:left}td,th{padding:10px;border-bottom:1px solid var(--line)}th{font-size:12px;color:var(--muted)}details{margin-top:16px;color:var(--muted)}summary{cursor:pointer}code{overflow-wrap:anywhere;font-size:13px}ul{padding-left:20px}.note{border-left:3px solid var(--accent);padding-left:14px}a{color:#8aecd3}[hidden]{display:none!important}@media(max-width:600px){main{padding:20px 12px}article,.panel{padding:16px}h1{font-size:23px}.stats{gap:8px}.stats div{padding:10px 12px}}
</style></head><body><main><header><div><h1>外设统一控制 · 设备检测</h1><p>本机只读扫描 · $(ConvertTo-HtmlText $payload.CapturedAt)</p></div><span class="tag">阶段 1 / 设备发现</span></header>
<p class="note">这是接口检测报告，尚未接入 DPI、灯效、宏、EQ 等控制。HID 接口存在不代表已支持其控制协议；一个接收器可能同时暴露鼠标和键盘接口。报告长度采用 Windows HidP_GetCaps 定义（含报告 ID 位置），不是可直接发送的命令。</p>
<div class="stats"><div><b>$($hidRows.Count)</b>HID 接口</div><div><b>$($groups.Count)</b>设备容器 / 未分组接口</div><div><b>$(@($hidRows | Where-Object Kind -EQ 'Vendor-defined').Count)</b>厂商自定义接口</div><div><b>$($audio.Count)</b>音频 PnP 节点</div></div>
$warningHtml
<label for="filter">筛选设备名称、厂商或 VID:PID</label><input id="filter" type="search" placeholder="例如 iKF、3554、Wireless" autocomplete="off"><p id="filter-status" role="status" aria-live="polite"></p>
<section id="devices">$($cards -join "`n")</section><p id="empty" hidden>没有匹配设备。清空筛选可显示全部。</p>
<section class="panel"><h2>音频设备与端点</h2><p>来自 Windows 当前存在的 PnP 节点，可能包括内置声卡、虚拟设备和蓝牙配置；存在并不等于正在播放或已连接。耳机厂商的 7.1/EQ 处理需要单独适配。</p><div class="table-wrap"><table><thead><tr><th>名称</th><th>类型</th><th>状态</th></tr></thead><tbody>$($audioRows -join '')</tbody></table></div></section>
<p>结构化结果：<a href="$(ConvertTo-HtmlText ([IO.Path]::GetFileName($jsonPath)))">打开同目录 JSON</a>。完整接口路径与设备标识仅保存在本地输出中。</p>
</main><script>
const field=document.getElementById('filter');const cards=[...document.querySelectorAll('#devices article')];
function filter(){const q=field.value.trim().toLowerCase();let visible=0;for(const card of cards){card.hidden=!card.dataset.search.toLowerCase().includes(q);if(!card.hidden)visible++;}document.getElementById('filter-status').textContent='显示 '+visible+' / '+cards.length+' 组';document.getElementById('empty').hidden=visible!==0;}
field.addEventListener('input',filter);filter();
</script></body></html>
"@
$html | Set-Content -LiteralPath $htmlPath -Encoding utf8
[pscustomobject]@{
    HidInterfaces = $hidRows.Count; MetadataRead = @($hidRows | Where-Object CapsRead).Count
    DeviceGroups = $groups.Count; AudioNodes = $audio.Count
    JsonReport = $jsonPath; HtmlReport = $htmlPath; Warnings = @($warnings)
}
if ($OpenReport) { Start-Process -FilePath $htmlPath }
