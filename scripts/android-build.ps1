param([string[]]$Task=@('assembleDebug','assembleDebugAndroidTest'))
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
if(-not $projectRoot.StartsWith('D:\',[System.StringComparison]::OrdinalIgnoreCase)){throw 'Android builds and temp files must stay on D:.'}
$env:TEMP=Join-Path $projectRoot '.cache\temp';$env:TMP=$env:TEMP
$env:JAVA_HOME='D:\VSCode'
$env:GRADLE_USER_HOME=Join-Path $projectRoot '.cache\gradle'
$env:ANDROID_USER_HOME=Join-Path $projectRoot '.cache\android-home'
$env:ANDROID_AVD_HOME=Join-Path $projectRoot '.cache\avd'
$env:ANDROID_HOME=Join-Path $projectRoot '.cache\android-sdk';$env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
$env:PATH='D:\VSCode\bin;C:\Windows\System32;'+$env:PATH
Push-Location $projectRoot
try {
    & node node_modules/vite/bin/vite.js build --config scripts/mobile-reader.config.ts
    if($LASTEXITCODE -ne 0){throw 'Reader build failed.'}
    & (Join-Path $projectRoot '.cache\toolchains\gradle-9.3.1\bin\gradle.bat') -p apps/mobile/android --console=plain $Task
    if($LASTEXITCODE -ne 0){throw 'Android build failed.'}
} finally {Pop-Location}
