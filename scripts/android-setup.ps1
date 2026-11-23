# All downloads, SDK state and build caches stay under this D: workspace.
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
if(-not $projectRoot.StartsWith('D:\',[StringComparison]::OrdinalIgnoreCase)){throw 'Use a D: workspace.'}
$toolRoot=Join-Path $projectRoot '.cache\toolchains'
$sdkRoot=Join-Path $projectRoot '.cache\android-sdk'
$env:TEMP=Join-Path $projectRoot '.cache\temp';$env:TMP=$env:TEMP
$env:JAVA_HOME='D:\VSCode';$env:PATH='D:\VSCode\bin;C:\Windows\System32;'+$env:PATH
$env:ANDROID_USER_HOME=Join-Path $projectRoot '.cache\android-home'
$env:ANDROID_AVD_HOME=Join-Path $projectRoot '.cache\avd'
$env:GRADLE_USER_HOME=Join-Path $projectRoot '.cache\gradle'
New-Item -ItemType Directory -Force -Path $toolRoot,$sdkRoot,$env:TEMP,$env:ANDROID_USER_HOME,$env:ANDROID_AVD_HOME | Out-Null
if(-not (Test-Path -LiteralPath "$toolRoot\gradle-9.3.1\bin\gradle.bat")){
    Invoke-WebRequest -Uri 'https://services.gradle.org/distributions/gradle-9.3.1-bin.zip' -OutFile "$toolRoot\gradle.zip"
    Expand-Archive -LiteralPath "$toolRoot\gradle.zip" -DestinationPath $toolRoot -Force
}
if(-not (Test-Path -LiteralPath "$sdkRoot\cmdline-tools\latest\bin\sdkmanager.bat")){
    Invoke-WebRequest -Uri 'https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip' -OutFile "$toolRoot\commandline.zip"
    Expand-Archive -LiteralPath "$toolRoot\commandline.zip" -DestinationPath "$toolRoot\android-extract" -Force
    New-Item -ItemType Directory -Force -Path "$sdkRoot\cmdline-tools\latest" | Out-Null
    Copy-Item -Path "$toolRoot\android-extract\cmdline-tools\*" -Destination "$sdkRoot\cmdline-tools\latest" -Recurse -Force
}
# SDK licenses are presented by sdkmanager; acceptance stays interactive.
& "$sdkRoot\cmdline-tools\latest\bin\sdkmanager.bat" --sdk_root=$sdkRoot 'platforms;android-37.0' 'build-tools;36.0.0' 'platform-tools'
if($LASTEXITCODE -ne 0){throw 'SDK installation failed.'}
Write-Output 'Android toolchain is ready. Run npm run build:android.'
