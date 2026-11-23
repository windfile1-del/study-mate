# Android 平板接力：阶段 0–3 已验收

2026-11-06 更新：阶段 4 的连接修复、近期缓存与稳定性范围已完成，见 [局域网连接与近期缓存](19-局域网连接与近期缓存.md)。下文保留阶段 0–3 的验收范围与原始记录。

已完成阶段 0 可行性验证、阶段 1 电脑服务、阶段 2 阅读与对话，以及本轮阶段 3 正式视频播放器与进度接力。三星平板、本地视频和指定 B站课程均有独立证据。阶段 4 缓存与稳定性、阶段 5 正式发布仍为后续工作；下文阶段 0–2 的技术验证与阶段 3 的产品界面验收分别记录。

## 阶段 3：正式课程播放器与进度接力（2026-11-01，已验收）

用户授权继续开发阶段 3。当前汇总为 `artifacts/mobile-stage3/result.json`，完整流程为该目录的 `course/`。本地和真实课程均通过正式 Compose/Media3 界面、进度条、1.5 倍速、横竖屏/全屏、冻结提问、双向接力、进度恢复及实际 Android 前后台生命周期检查。先前阶段 0–2 的文档/过程日志中“阶段 3 为后续”属于历史边界。

最终全量 110/110、受影响远程/存储 8/8、桌面媒体回归 11 项、类型/契约与桌面/Android 构建通过。三星 instrumentation 为 `OK (1 test)`；真实宋浩课程在 30 秒以 1.5 倍速发回电脑，电脑确认后续播，平板再读取电脑位置成功。独立音视频输出复验为 H.264/AAC，3185ms、98 视频帧、183 音频缓冲。已人工查看正式播放器的横屏/竖屏/全屏和桌面接力 PNG，截图方向有尺寸断言且等待真实帧提交。

调试 APK 为 `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`，版本 `0.2.0-stage3`，本轮已安装三星。正式使用仍需与实际电脑实例重新配对；验收存储的连接属于隔离服务。电脑使用当前源码 out，旧 `release/0.14.0` 不包含这些变化。未打正式桌面发行包、未提交或推送 Git。

- 课程入口：平板「课程视频」列出电脑已注册来源，展示本设备上次位置和电脑位置；支持本地视频与 B站，其他网页说明需电脑观看。电脑新增课程后可手动刷新。
- 播放：Media3 正式界面提供播放/暂停、进度条、前后 10 秒、0.5/0.75/1/1.25/1.5/2 倍速、横竖屏、全屏与错误重试。大屏播放器与 AI 对话并列；较窄屏使用独立页面和对话抽屉。
- 生命周期：同一个 ViewModel 持有播放器，布局变化只换显示视图。退到后台暂停并释放播放器，返回按原位置和倍速重新准备，等待用户播放；不提供后台音频服务或画中画。
- 进度：每 5 秒、暂停、跳转、倍速和退后台时向电脑记录一次。本设备、知识库和来源分别保存，电脑观察进度保持独立。开始播放生成新会话，序号排除旧会话和乱序覆盖；向后拖动的较新位置可以保存。
- 电脑到平板：点击「继续电脑学习」「读取电脑进度」或课程行的「接续电脑」，即时读取电脑当前位置与倍速再准备平板播放器。日常选择课程默认接续本平板位置。
- 平板到电脑：点击「发回电脑续播」会暂停平板并提交固定位置。电脑「平板连接」展示课程、设备、时间与倍速，点击「在电脑继续播放」才关闭浮层、显示课程并续播，也可忽略；没有自动抢占或通用远程控制接口。检查当前授权、来源、文件版本、播放时长与切换访问代次，失败显示原因并保留请求供用户处理。
- 视频提问：点击「就此刻提问」暂停并固定课程 ID、位置、时长和时间代次，输入区展示固定时间，可移除；之后跳转不会改变问题。发送仍遵循只读、笔记版本与请求去重策略，模型密钥和平台 Cookie 保留在电脑。
- 接口：`GET /v1/videos`，`POST /v1/playback/start`、`progress`、`handoff`。协议仍为 v1，增加能力；Zod 生成 OpenAPI 与 Kotlin 请求类型。`remote-playback.ts` 将持久进度、待确认接力和已处理编号写入电脑 remote/playback.json，播放器会话仅在当前服务生命周期有效。

开发验证命令新增 `npm run smoke:android:video`。通过 `STUDYMATE_ANDROID_SERIAL` 指定已连接的 ADB 序列号；支持 mDNS 自动连接的序列号，不把未执行 connect 的 IP 当作已经存在的序列号。该测试在独立 profile 中运行真实 Compose/Media3、课程进度和桌面确认，额外保存播放器横屏/竖屏/全屏与接力证据；指定 `STUDYMATE_BILIBILI_URL` 复验真实课程。缓存/弱网长期可靠性、全平台播放器、后台音频和正式签名发行均不属于本阶段。

播放器生命周期、主线程调用与视图绑定依据 Android 官方 [ExoPlayer 入门](https://developer.android.com/media/media3/exoplayer/hello-world) 和 [PlayerView](https://developer.android.com/media/media3/ui/playerview)；沿用已锁定的 Media3 1.11.1，没有在本轮扩大到其他播放引擎。

## 产品与权限

Android 原生 Kotlin/Compose，阅读组件复用桌面 React/KaTeX/Mermaid。电脑继续提供模型、资料与知识库检索。平板只读；不可保存笔记、恢复备份、保存图片或创建定时任务。允许产生对话记录、切换会话和记录学习位置。模型密钥、账号凭据与浏览器 Cookie 不向平板下发。

HTTPS/WSS 使用电脑身份和每设备凭据；扫码之后仍需电脑批准。配对码 3 分钟、访问令牌 15 分钟、刷新令牌 90 天。设备授权绑定当前知识库，电脑切库后需重新授权。所有请求使用明确路由，禁止通用 IPC 转发。生成中两端共用一个活动 AI 实例，请求 ID 持久化，不自动重放崩溃时不确定的模型调用。

## 工程约定

原有未提交修改已备份到 `.cache/mobile-baseline-20261030`，仅在现有代码上定点增量修改。新增业务能力记录到本文、开发日志和 agent.md。所有 Windows 临时文件、SDK、Gradle 与测试数据位于 D 盘。真实用户知识库不用于写入测试。

## 验证状态

阶段 0–2 已在本文范围通过。实机为三星 SM-X808U 平板（Android 13 / API33，1752×2800，340dpi），无线 ADB 连接端口由 mDNS 发现，配对码不写入项目文档。原 JLH-AN00 手机拒绝测试 APK 安装，不再尝试该手机。Android SDK 37 的仓库包名为 `platforms;android-37.0`；SDK、Gradle 和编译缓存位于工程 `.cache`。

已通过 107/107 全量单元测试、后续 6 项远程受影响测试、类型与契约检查、Android app/instrumentation 构建、真实 Electron 网络头验证和桌面媒体回归。`artifacts/remote-android-192.168.1.4_36693-course/result.json` 为完整真机流程的通过结果：真实 HTTPS/WSS、电脑批准、只读工具、去重、笔记/图片/公式/图表、历史对话、本地首帧、真实课程双轨及设备撤销。

2026-10-30 13:43 完整流程通过。用户指定免登录课程 BV1CAxaeHEeH，时长 2076 秒；在可见隔离窗口正常播放后，电脑准备独立 H.264/AAC 轨道，三星实际播放到 3107ms，输出 95 个视频帧、178 个音频缓冲，音频输出时钟推进，截图确认为宋浩高数课程。指标与画面见同目录 `android-bilibili.json` / `android-bilibili.png`，instrumentation 为 `OK (1 test)`。

此前 `ERR_BLOCKED_BY_CLIENT` 的一部分由手工完整跨来源 Referer 在本地被取消导致，并非全部为站点拒绝。已按 Chromium 默认策略在同来源保留无 fragment 路径、跨来源仅发送 origin、HTTPS 降级不发送 Referer，覆盖解析、字幕与代理。早期 412、WebView 高度为 0、主线程清理连接和取证超时均有原始记录；最新通过结果包含相应修复，未关闭 webSecurity、改变 UA/代理或复制其他 profile 的 Cookie。

| 阶段 | 已验证要求 | 主要证据 |
| --- | --- | --- |
| 0 | 平板配对/TLS、可见中文公式/图表、本地解码、真实 B站音视频合并 | `remote-android-192.168.1.4_36693-course` 的 instrumentation、PNG、解码指标 |
| 1 | 身份和凭据、明确路由、只读、切库授权、撤销、请求去重/重启、WSS | `tests/remote.test.ts`、完整真机结果、`docs/api/study-mate-v1.openapi.json` |
| 2 | 目录/全文检索、笔记和图片、双链、新建/历史会话、流式问答、资源版本、横竖屏 | 同一真机流程及阅读 PNG；远程时间/版本单元测试 |

## 实现入口

| 层次 | 入口 | 职责 |
| --- | --- | --- |
| 共享服务 | main/application-services.ts | IPC/LAN 共用一个 AiService 和调度器，组装最小只读 DTO |
| 认证 | core/remote-auth.ts | 电脑身份、TLS 固定、单次配对、电脑批准、凭据轮换和撤销 |
| 局域网 | core/remote-host.ts | 受限路由、鉴权、请求台账、WSS 序号与恢复 |
| 课程 PoC | core/remote-course.ts | 已注册 B站来源、真实 cid、短时不透明轨道和 CDN 代理 |
| 网络策略 | core/http-referrer.ts | 与 Chromium 默认策略一致的来源头；每次媒体跳转重新计算 |
| 原生状态 | Android StudyViewModel.kt / LanClient.kt | 保存配对、重连、冻结提问资源、只读笔记与会话 |
| 阅读 | ReadingView.kt / mobile/reader | 本地 WebView、受限桥接，复用桌面 Markdown/KaTeX/Mermaid |
| 契约 | shared/remote.ts / scripts/generate-remote-contracts.ts | Zod、OpenAPI 与 Kotlin 请求类型一致性 |

## 阶段 0–2 原始验收范围

- 服务：真实 HTTPS/WSS、未配对及浏览器来源拒绝、设备撤销、切库权限、去重和重启台账，均有自动化证据。
- 只读：任务创建、保存/恢复/插图等写工具由服务端 principal 拒绝；笔记版本变化不调用模型；平板时间不跟随电脑跳转。
- 平板：三星 Android 13，实测应用配对、加密连接保存/恢复、搜索、笔记阅读及图片、公式/图表、双链、新建及历史对话、只读问答、横竖屏和本地 Media3 首帧。
- 真实课程：指定课程的桌面抽帧、平板 H.264/AAC 合并与持续输出通过；未验证长时间播放或所有平台/课程。平台权限和挑战仍按原站限制处理。
- 未覆盖：其他 OEM、Android 17 运行时局域网权限、摄像头现场扫码、真实模型语义表现、长时弱网播放。本轮证据不推广为这些范围已经通过。

## 联调与交付路径

桌面需使用本次源码构建的 out，而非 release/0.14.0 旧包；在工程执行 `npm run build` 后 `npm run start`。打开「平板连接」，选择与平板同网段的网卡后开启，生成二维码，Android 扫描/粘贴连接信息并在电脑批准。模型设置仍在电脑配置。

Android 调试 APK 为 `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`。`npm run build:android` 同时编译阅读资源和 instrumentation。通过 `STUDYMATE_ANDROID_SERIAL` 指定无线 ADB 连接地址；它不是 Study Mate 配对地址。`npm run smoke:android` 使用隔离 profile，不触及用户真实知识库；增加 `STUDYMATE_BILIBILI_URL` 可运行指定课程的真实双轨验证。

需要人工在原站确认正常访问时，设置 `STUDYMATE_INTERACTIVE_COURSE=1` 显示隔离窗口；明确正常播放后才写入控制文件继续，超时不视为确认。可用 `STUDYMATE_REMOTE_SMOKE_REUSE` 复用本测试带专用 marker 的目录名，限制为 `.cache/remote-smoke-数字` 且校验 realpath；不复制平时 profile。真实课程证据使用独立 `-course` 目录。`npm run smoke:network-referrer` 只访问本地 HTTP 验证真实 Electron 请求头；`npm run smoke:media` 验证电脑原有媒体能力。

后续记录需分别列出：纯服务 HTTPS/WSS 自动化、真实 Electron 受控 Provider、Android 构建与设备、真实 B站，以及未验证范围。任何未通过或不可用项保持未完成，不把新增代码视作验收。
