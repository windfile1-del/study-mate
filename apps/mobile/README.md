# Study Mate Android

原生 Kotlin/Compose 学习端，电脑保留模型接入、知识库、检索与视频取证。阶段 0–3 已验收；当前具备课程播放器、视频时间点提问和双向进度接力，三星本地视频与真实 B站课程完整流程通过。缓存与正式发布属于后续阶段。汇总见 `artifacts/mobile-stage3/result.json`。

2026-11-06：阶段 4 的近期缓存与连接稳定性已验收，新 APK 为 `0.3.0-stage4`。支持加密近期笔记/对话、128MiB 视频缓冲、不确定提问与未同步位置保存、断线缓存阅读及自动重连。三星实测两端 VPN 开启，隔离服务中断5秒换端口重连及播放器恢复通过；原有实际电脑配对已恢复并核对连接成功。详见 `docs/19-局域网连接与近期缓存.md`、`artifacts/mobile-stage4/result.json`。不提供完整课程/附件离线下载；正式发布仍为阶段5。

## 开发

Windows 工程与临时文件必须放 D 盘。JDK 默认使用 `D:\VSCode` 中的 17；SDK、Gradle、调试签名与测试资料使用工程 `.cache`。首次运行 `scripts/android-setup.ps1` 准备 SDK/Gradle，并根据 SDK 管理器提示处理许可证。无需让最终用户安装这些开发工具。

```powershell
npm run generate:remote-contracts
npm run check:remote-contracts
npm run check
npm run build
npm run build:android
npm run smoke:remote
npm run smoke:android:video
npm run smoke:android:stable
```

APK：`android/app/build/outputs/apk/debug/app-debug.apk`。设备测试 APK 位于同级 `androidTest/debug`。

`npm run smoke:android` 使用 `STUDYMATE_ANDROID_SERIAL` 指定的 ADB 设备，默认 `emulator-5554`。它启动独立 D 盘 Electron profile 与受控模型服务，安装本应用和 instrumentation 包；自动批准仅限该测试自己创建的隔离电脑实例，检查真实原生 TLS、笔记/双链、问答去重、UI ViewModel 的流式问答、WebView/KaTeX 以及 Media3。真实用户知识库不参与。

测试会在目标设备安装 `dev.studymate.mobile` 调试包，请使用测试设备。设备安装权限被拒绝时不绕过；需要用户允许或改用模拟器。测试不会自动使用真实账号、关闭站点安全检查或复制其他应用 Cookie。

## 使用

电脑打开“平板连接”，选择局域网网卡，开启服务并生成二维码。Android 扫描后，在电脑允许配对。也可复制电脑页面中的完整连接信息后粘贴；连接信息含短时配对密钥，不应公开分享。首版只读取已授权知识库，电脑切库后需重新授权设备。

API 契约：`docs/api/study-mate-v1.openapi.json`。Kotlin 请求类型由脚本生成，不手改 `RemoteContract.kt`。阅读器使用应用本地资源和受限消息桥接，不暴露模型密钥、文件系统或 Electron IPC。

「课程视频」可播放电脑已打开的本地视频和 B站课程，默认恢复本平板进度；「读取电脑进度」从电脑当前课程接续。播放界面支持拖动、倍速和全屏；「就此刻提问」固定该时间并准备问题，等待点击发送。「发回电脑续播」会暂停平板，需在电脑「平板连接」确认。电脑始终需要保持运行；应用退后台会暂停并释放播放器，返回后等待手动播放。

实测与未测范围以 `docs/18-Android平板接力开发.md` 和 `artifacts` 的具体结果为准。
