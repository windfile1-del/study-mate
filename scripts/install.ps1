$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $projectRoot.StartsWith('D:\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw '项目与临时目录必须放在 D 盘。'
}
$cacheRoot = Join-Path $projectRoot '.cache'
New-Item -ItemType Directory -Force -Path (Join-Path $cacheRoot 'temp') | Out-Null
$env:TEMP = Join-Path $cacheRoot 'temp'
$env:TMP = $env:TEMP
$env:npm_config_cache = Join-Path $cacheRoot 'npm'
$env:ELECTRON_CACHE = Join-Path $cacheRoot 'electron'
$env:ELECTRON_BUILDER_CACHE = Join-Path $cacheRoot 'builder'
Push-Location $projectRoot
try {
    if (Test-Path -LiteralPath 'package-lock.json') { & npm ci } else { & npm install }
    if ($LASTEXITCODE -ne 0) { throw "依赖安装失败，退出码 $LASTEXITCODE" }
    & node node_modules/electron/install.js
    if ($LASTEXITCODE -ne 0) { throw "Electron 运行时安装失败，退出码 $LASTEXITCODE" }
} finally {
    Pop-Location
}
