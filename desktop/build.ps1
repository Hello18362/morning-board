param([string]$Output = (Join-Path $PSScriptRoot 'build'))
$ErrorActionPreference = 'Stop'
$version = '1.0.4258.31'
$hash = '56F7F4B8BF9AEE4B8EFEFBBDD4F67D5F74EBD1B100ED0806DA71BF76AF481AA9'
$cache = Join-Path $PSScriptRoot '.cache'
$zip = Join-Path $cache "webview2-$version.zip"
$sdk = Join-Path $cache "webview2-$version"
New-Item -ItemType Directory -Path $cache, $Output -Force | Out-Null
if (!(Test-Path -LiteralPath $zip)) {
    Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$version/microsoft.web.webview2.$version.nupkg" -UseBasicParsing -OutFile $zip
}
if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $hash) { throw 'WebView2 SDK 校验失败。' }
if (!(Test-Path -LiteralPath (Join-Path $sdk 'lib/net462/Microsoft.Web.WebView2.Core.dll'))) { Expand-Archive -LiteralPath $zip -DestinationPath $sdk -Force }
$package = Join-Path ([System.IO.Path]::GetFullPath($Output)) '晨间看板-电脑桌面版'
New-Item -ItemType Directory -Path $package -Force | Out-Null
$core = (Resolve-Path (Join-Path $sdk 'lib/net462/Microsoft.Web.WebView2.Core.dll')).Path
$forms = (Resolve-Path (Join-Path $sdk 'lib/net462/Microsoft.Web.WebView2.WinForms.dll')).Path
$csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$exe = Join-Path $package 'MorningBoard.exe'
& $csc /nologo /target:winexe /platform:x64 /optimize+ "/out:$exe" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/reference:$core" "/reference:$forms" (Join-Path $PSScriptRoot 'DesktopBoard.cs')
if ($LASTEXITCODE -ne 0) { throw '桌面宿主编译失败。' }
Copy-Item -LiteralPath $core, $forms -Destination $package -Force
Copy-Item -LiteralPath (Join-Path $sdk 'runtimes/win-x64/native/WebView2Loader.dll') -Destination $package -Force
Copy-Item -LiteralPath (Join-Path $sdk 'LICENSE.txt') -Destination (Join-Path $package 'WebView2-LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $sdk 'NOTICE.txt') -Destination (Join-Path $package 'WebView2-NOTICE.txt') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Install.cmd'), (Join-Path $PSScriptRoot '使用说明.txt') -Destination $package -Force
$site = Split-Path $PSScriptRoot
$app = Join-Path $package 'app'
New-Item -ItemType Directory -Path $app, (Join-Path $app 'data') -Force | Out-Null
foreach ($file in @('index.html','style.css','app.js','excel-import.js','desktop-view.css','desktop-view.js','manifest.webmanifest','sw.js','icon.svg','icon-192.png','icon-512.png')) {
    Copy-Item -LiteralPath (Join-Path $site $file) -Destination $app -Force
}
Copy-Item -LiteralPath (Join-Path $site 'vendor') -Destination $app -Recurse -Force
foreach ($file in @('config.json','schedule.json','items.json','plan.json')) {
    Copy-Item -LiteralPath (Join-Path $site "data/$file") -Destination (Join-Path $app 'data') -Force
}
# 单独的课程更新包：旧安装保留个人 data，用户预览确认后再替换课程。
$schedule = Get-Content -LiteralPath (Join-Path $site 'data/schedule.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$courseUpdate = @{ schedule = @($schedule) } | ConvertTo-Json -Depth 20
[IO.File]::WriteAllText((Join-Path $package '整学期课程更新.json'), $courseUpdate, [Text.UTF8Encoding]::new($false))
Compress-Archive -LiteralPath $package -DestinationPath (Join-Path $Output '晨间看板-电脑桌面版.zip') -Force
Write-Host "已生成：$package"
