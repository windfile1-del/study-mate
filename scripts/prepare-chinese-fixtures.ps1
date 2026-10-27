$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $projectRoot.StartsWith('D:\', [StringComparison]::OrdinalIgnoreCase)) { throw '测试暂存只允许D盘' }
$fixtureRoot = Join-Path $projectRoot '.cache\fixtures'
New-Item -ItemType Directory -Force -Path $fixtureRoot | Out-Null
$env:TEMP = Join-Path $projectRoot '.cache\temp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
$humanFile = Join-Path $fixtureRoot 'sensevoice-zh.wav'
if (-not (Test-Path -LiteralPath $humanFile)) {
    Invoke-WebRequest -Uri 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/test_wavs/zh.wav' -OutFile $humanFile
}
if ((Get-Item -LiteralPath $humanFile).Length -ne 178988) { throw '公开中文语音样本大小错误' }
$technicalFile = Join-Path $fixtureRoot 'speech-zh-control.wav'
if (-not (Test-Path -LiteralPath $technicalFile)) {
    Add-Type -AssemblyName System.Speech
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try {
        $synth.SelectVoice('Microsoft Huihui Desktop')
        $synth.SetOutputToWaveFile($technicalFile)
        $synth.Speak('现在讲解二阶系统的阶跃响应。阻尼比为零点五时，系统会出现超调。拉普拉斯变换可以把微分方程转换成代数方程。分析闭环主导极点时，需要同时考虑稳定性和调节时间。')
    } finally { $synth.Dispose() }
}
Write-Output '已准备真人普通话与中文合成术语样本；后者不等于真人课堂。实际模糊课件可通过STUDYMATE_CHINESE_BOARD指定。'
