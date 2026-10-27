# Study Mate 开发交接

更新日期：2026-10-26。当前实现版本：0.8.0-documents。用户本轮要求修复两篇真实笔记的排版、对话栏快捷切换模型/推理、浏览器纯视频及用户播放控制。学习工具继续保留；新实现见 docs/11-笔记公式与专注播放器.md，接入见 docs/08-AI接入使用指南.md。

## 工作约定

- 所有应用、安装、测试和构建临时目录只放D盘。安装用scripts/install.ps1；开发/验证用根目录npm脚本，避免直接运行会使用系统默认TEMP的工具。
- 保持用户原插件 D:\Codex\OpenAI-Codex-data\plugins\codex-bilibili-video-observer 独立；应用使用vendor/video-observer副本，副本变更记在NOTICE与开发日志。
- 笔记优先复用现成组件，不另造编辑器/Markdown引擎；当前为uiw编辑器、react-arborist、chokidar、Fuse。
- 业务核心在core；Electron与对话框在main；renderer不得直接导入Node文件服务。
- 远程网页preload不导出contextBridge API；只允许绑定当前来源的窄观察上报。
- 用户播放器控制与Agent观察分开。browser:player仅允许可信主窗口发送有限播放命令，不向远程网页或AI提供播放控制工具；observer保持只读。
- 每个问题使用冻结的ContextAnchor；工具显式检查vaultId和allowWrite，不从全局当前页面临时推断目标。
- 保存笔记必须经过VaultService版本检查与范围校验。取消不回滚已经提交的文件写入；不能自动重放不确定写操作。
- 代码变更记录到docs/开发日志.md，记录实测与未测项；模拟Provider测试、受控视频、真实B站和真实模型分别报告。
- 用户目标是一个软件即可使用，无需额外安装工具。优先随包携带运行库，禁止把安装FFmpeg/yt-dlp作为用户操作步骤。允许Electron随包内置的ffmpeg.dll。
- 知识库可在用户选择的任意盘符；只有应用状态、缓存、暂存、备份受D盘限制。跨卷复制提交不宣称原子替换。

## 常用命令

~~~powershell
.\scripts\install.ps1
npm run dev
npm run check
npm test
npm run build
npm run smoke
npm run smoke:dev
npm run smoke:media
npm run smoke:notes
npm run smoke:notes:packed
npm run dist
npm run smoke:packed
npm run format
~~~

依赖已锁在package-lock.json。npm的esbuild安装脚本提示未授权，但本机现有平台包下check/test/build均可运行；不需要为了消除提示扩大脚本授权。

## 当前状态

- Electron45 / React19 / TypeScript7基础工程可编译、原生运行。
- SourceRegistry、TaskManager、VaultService、LearningService、ToolBroker、AgentRuntime已实现。
- HTML视频Canvas预览约1秒同步，0.10起按约2个视频秒采帧、最高640×360 WebP，读取已加载TextTrack和可见字幕；支持后台主动原片读取及按设置定时清理。
- 已修复本项目副本的指纹传递、缺特征误判、p/cid混用，热缓存上限32MiB。
- UI提供Markdown导入、目录切换/Explorer、内置本地视频、课程浏览器、范围抽帧结果及任务状态。
- MediaGateway以短期令牌授权单个媒体资源，只注册在本地播放器/解码会话；远程网页会话没有该协议处理器。
- MediaController通过独立离屏Chromium解码；等待目标mediaTime的requestVideoFrameCallback，不使用seeked回调直接冒充新画面。最高1920×1080，单任务最多12帧，按来源落盘。
- B站走view分P→真实cid→playurl H.264→会话代理；受控接口全链路通过，真实站点在当前网络受限（错误页/ERR_BLOCKED_BY_CLIENT，独立请求HTTP412），不能宣称真实登录解析已通过。
- 旧 AgentRuntime 保留接口与测试替身；产品 AI 由 main/ai-service + core/ai-providers + core/subscription-auth 接入，支持四种 API 协议、SIWC、Antigravity 实验兼容。Codex 接入已移除；此前实现已由用户确认验收；本轮自动化不使用真实账号，不重新评判用户的验收结果。PDF/PPTX 阅读与按页工具已接通，旧 PPT 为文字简化阅读；ASR/OCR 尚未接通。
- 已接入remark/GFM/math/frontmatter、KaTeX、Mermaid12、Callout/双链/图片/脚注/块引用适配与一层笔记嵌入。HTML先sanitize再生成KaTeX；Mermaid strict+DOMPurify，以SVG图片显示。
- 公式/Markdown在最多2个Web Worker排版；大文档首屏预览、JSON结果传输、48MiB估算/8篇缓存、虚拟滚动、图表和图片按需加载。不要将全量同步排版放回React渲染函数。
- worker中实体解码和HTML解析使用不依赖DOM的入口；electron.vite.config.ts有两处resolve alias，避免document/DOMParser异常。
- 目录树仍上限5000/深度16，单笔记2MiB；0.9全文搜索由独立Worker全库持久化索引提供，不受旧500篇/64KB搜索限制。不能声称完整Obsidian/插件兼容。
- 新包在release/0.10.0，旧版不覆盖；启动工作台.cmd优先新版并保持原.local/data。测试必须使用独立D盘profile，不写用户真实知识库。
- 单软件独立验收用node scripts/workspace.mjs smoke-standalone：复制到工程外D盘路径，以独立cwd和系统PATH运行，再测试笔记/媒体；成功后按绝对真实路径边界清理副本。不能仅在工程目录内启动exe就声称排除了node_modules回退。
- 主进程外置的chokidar/fuse.js/zod及原生sherpa-onnx-node是生产依赖，Windows x64平台NAPI/DLL显式asarUnpack；已编译进out的前端库为开发依赖。图表全屏弹层必须portal到body，不能放在带transform的虚拟行内。

## 下一步

本轮继续完善笔记并接入 AI 已获用户授权，不再沿用旧版“AI 暂缓”的范围限制。下一步可继续真实账号验收、复杂 MathJax 扩展、深层嵌入、全量索引和更多规模压力。真实B站仍需正常访问网络独立验收；不关闭webSecurity或绕过访问挑战。

保持源文件模块化。视频解码已在独立renderer进程，文件服务仍在main侧；增加ASR/OCR时再增加计算Worker。原生媒体测试使用带正常索引的MDN CC0 MP4；MediaRecorder碎片化MP4不能作为精确seek的可靠样片，不能放宽时间校验掩盖失败。

## 当前维护要点

- KaTeX 主样式固定 0.16.47，与 rehype-katex 渲染器一致。中文分式仅在 AST 中增加 displaystyle / 零宽 rule；必须保留 remark-math 的 hChildren code 包装，不能改写源笔记。
- 混排 $$ 块先经过 math-source.normalizeDisplayMath，再进入remark；worker首屏切分使用同一规范化输入。代码围栏/行内源码不得改写；两篇真实笔记复制到独立fixture验收，原文件前后逐字节比较。
- 对话 select 请求只改变后续请求配置，当前生成使用发送时快照；模型目录保留并以revision丢弃过时查询。不得重写既有原始推理记录来强行适配新模型。
- 纯视频用同一网页video节点与独立宿主工具条，样式/controls/字幕轨可恢复；不搬运源流、不绕过跨域/DRM/站点挑战。字幕仅切换已有字幕，不能承诺移除烧录字幕或弹幕。
- 笔记标签/草稿/历史由 workspace 模块管理。预览恢复像素位置需同时保留 TanStack Virtual 的 takeSnapshot / initialMeasurementsCache，缓存最多 8 篇；不能仅恢复 scrollTop。
- 三种分隔条使用 React Pointer Capture；原生视频视图在拖动、缩放与模态窗口期间隐藏。
- SIWC 使用独立 Study Mate 动态注册与签发 client ID、稳定匿名 host ID、PKCE/state/nonce、JWKS 签名身份校验。身份验证与套餐授权分开，缺 direct scope 不可推理；固定 api.openai.com/v1 原生 Responses。不得恢复 Codex 登录、导入旧凭据或读其他应用账户。
- Antigravity 只读参考用户 D:\agent移动端 的实现；非官方兼容、有账户风险且会员不保证可用，界面必须清晰标识。禁止自动付费回退。
- 笔记首次只附路径；StudyTools 0.10提供固定23个学习工具，按需读取，写入需本轮 allowWrite、已读版本与草稿检查。全量保存现有笔记前需读完所有行；优先精确替换。现有 VaultService 备份/版本机制复用；没有 shell/任意文件读写/MCP 服务工具。
- 缓存必须保留历史前缀和各协议原始推理/签名/工具调用与结果；冻结本次 user.prompt，动态状态放尾部。工具清单不可按只读/读写模式增删。原始 native 与图片保存在 main，不要通过500ms界面轮询发送整份像素；IPC仅返回轻量工具摘要。累计用量与最后请求输入分开，不把替身固定缓存数当作真实命中率。
- 压缩保留原消息/最近三轮，成功缩短后才提交摘要，取消/失败保留旧摘要；新问题不得丢失。压缩会有一次历史前缀变更。
- 用量 null 与 0 必须区分；价格是手填估算，模型列表不代表可推理权限。真实 API/订阅、协议替身、无依赖包验收分别报告。
- 新增 npm run smoke:workspace 和 smoke:workspace:packed；工程外独立验收同时覆盖笔记、媒体、AI/分栏。

## 0.8 文档阶段

用户已验收此前实现，本轮按方案 T34/T35 加入 PDF + PowerPoint。实现/用法/限制见 docs/12-PDF与PowerPoint阅读.md。PDF.js 和 pptx-browser 隔离在隐藏 renderer，所有字体/CMap/WASM 本地打包，不要求安装 Office。PPTX 三处构建适配位于 scripts/document-adapter.ts，禁止删除源码锚点校验。旧 PPT 只提取文字，不能声称保真或提供虚构图像。文档由用户选择注册为不可变内容快照，AI 只接受已授权ID，首次仅附元数据/主动选区；不读取任意路径。新增4个工具固定加入清单，不能因当前页面增删定义。

文档测试 npm run smoke:documents / smoke:documents:packed；完整独立包测试增加 documents 组。测试仅使用 D 盘隔离 profile 和自动生成课件，不改用户库。实际供应商语义效果、大型复杂课件、加密 PDF 组合另行验证，不把受控 Provider 的缓存用量当真实命中保证。

0.8 最终证据：check通过、69/69单元测试、工程外独立包43项回归全部通过（notes7/media11/workspace-ai13/polish3/documents9）。artifacts/standalone/result.json 与 artifacts/documents-packed/result.json。加密PDF已实测错误/正确密码与重启重新解锁；复杂组合仍未穷尽。最终ZIP160858203字节。并行压缩时一次截图超时已在压缩结束后完整重跑通过，不放宽验收。

## 0.9 中文采音、原图理解与持久化检索（覆盖上文旧状态）

用户要求中文识别优先，模糊/复杂图片以视觉模型查看原图为主，OCR不强制。产品入口“识别与全库检索”；图片、文档页/选区、视频进度可直接准备AI问题，无需先OCR，也不自动发送。首次只附路径/来源元数据，工具调用后才发送真实像素。多模态模型需用户自行接入，本地采音/OCR/向量无需密钥。

ASR是随包SenseVoice int8 + sherpa-onnx-node生产依赖，在独立Node Worker运行；不使用实验Whisper/SoundTouch，不依赖系统FFmpeg/Python。Electron只采当前课程WebContents标签音轨，不录麦克风或系统回环。采音连接完成后才进入capturing。200ms音轨时钟、12秒分批、最多6批积压；倍速按原视频映射，暂停/跳转/访问变化切epoch，异常段明确缺口，不跨跳转插值，不把未识别当作无讲解。转写保存来源、访问、epoch、时间和未校准提示，提问只读证据截止时间内的记录。数学术语仍可能出现同音误识别。

OCR是可折叠的Tesseract中英参考工具，低于70保留低置信和原图入口，原图优先；真实模糊课件36分的差结果是已知边界，不要为了通过测试强行改成可靠文字。模型和本地运行库全部随包，vendor/recognition提供许可，SenseVoice模型许可与源码MIT必须区分。

KnowledgeDb在Worker中持久化SQLite WAL/FTS5、400字符分片、384维多语向量和双链/Markdown/YAML别名反链，监听也在Worker。全库搜索不再受旧500篇/64KB或目录树5000展示上限；单笔记2MiB/UTF8与忽略目录仍有效，语义覆盖进度和暂停可见，按库持久化开关。向量是后台遍历而非ANN，不声称十万级恒定性能。路径解析与AI引用不再以目录展示数组授权，必须实际校验库边界与文件。

固定19个学习工具；新增search_knowledge/get_backlinks/read_transcript/ocr_document_page/ocr_image。历史原始协议数据和工具定义顺序必须稳定；不为当前页/权限动态改清单，不额外全文注入。模型资产准备scripts/prepare-learning-models.mjs固定revision与大小/SHA，打包过滤只包含SenseVoice和多语MiniLM。所有fixture/profile/cache必须D盘，真实用户库只读复制，旧0.8包保留。

开发入口npm run smoke:chinese / smoke:learning，完整工程外验收含chinese、learning及原五组。中文真人公开短音频与Windows中文合成术语样本分开报告，不把合成音等同真人课堂；受控Provider仅证明原图工具/协议传输，不证明真实模型语义、计费或缓存命中。使用方法与边界见docs/13-中文采音与多模态检索.md。

0.9最终：check/build/dist通过，73/73单测、工程外独立包52项全过（chinese4/learning5/notes7/media11/workspace-ai13/polish3/documents9），artifacts/standalone/result.json。5006篇首次索引31902ms，扫描UI心跳最大63.9ms；不等于全库语义或十万级承诺。ZIP473271052字节，release/0.9.0，原0.8与运行实例不动。首轮停止采音等待条件存在测试时序竞争，已明确等待capturing=false再检查队列，完整重跑通过，记录见开发日志。已查看新增最终界面截图；无需额外扩大验证范围。

## 0.10 视频主动阅读与缓存清理

用户要求后台低清缓存、自然语言时间定位、模型自行读取合适片段，并明确不能仅依赖缓存照片，在线课程也应可后台读取；必须有定时清理。新增固定read_video_frames/read_video_subtitles/search_video_subtitles/watch_video四工具，总23项，清单不按当前来源增删。问题仅附冻结课程元数据/时间提示，模型按需拿字幕/像素，原始历史和缓存前缀机制保留。“自动看课”默认勾选，不再要求先读取课程上下文。

watch_video后台读取用户选中原课的0至120秒片段，6或12帧连续时间取样，模型可继续选段/缩小范围，不直接上传视频容器、不等于逐帧完整观看或听到声音。原生流解码仍在独立renderer；web/B站直接读取失败时尝试独立隐藏网页，使用应用自己的会话、静音、只控制该后台页视频。不能移动前台播放器；sourceId/访问在提问时冻结，切课也不能改读新课。跨域内嵌、DRM、站点挑战等明确失败，不绕过限制。

后台缓存最高640×360、约每2个视频秒，墙钟最短900ms；FrameArchive定向读所选帧，不再把整段所有像素读进内存。单课2400帧/96MB，默认7天/512MB/10分钟自动清理；清理只扫描应用evidence下24hex来源的videos/session/preview，校验真实边界/文件元数据，保留原视频/字幕/转写/笔记/native-media手动原片解析。启动清理异步，不阻塞窗口；设置在“识别与全库检索→视频缓存”，保存后重启有效，显示最近检查结果。

字幕读取已加载TextTrack，按批发送完整cue，补充可见DOM；本地自动读同目录同名UTF8 SRT/VTT，B站按真实分P cid读/x/player/wbi/v2字幕并优先中文，字段已核对当前yt-dlp原项目实现。未加载/无权限明确缺口。字幕去重/20000条容量；发送时冻结已取得字幕，不接入后到或他课文本。未启动采音时没有声音证据，read_transcript仍按证据截止时间读取。

当前check/build通过、78/78单元测试通过，原生video组5项通过；最终包回归与ZIP记录在开发日志补齐。打包模型用afterPack从固定模型目录创建只读硬链接（跨卷回退复制），ZIP仍包含实际资产。D盘空间紧张，外部验收可用STUDYMATE_ACCEPTANCE_HARDLINKS=1创建独立目录的不可变文件硬链接，仍用外部cwd和系统PATH；这种模式保留验收目录，不再删除旧验收副本。不得将硬链接验收描述成逐字节物理复制或存储介质隔离，不改用户运行实例或真实库。dist-dir先验收，dist-archive用--prepackaged封装同一目录，避免压缩时并跑截图。

0.10最终：78单测、57项工程外回归（video5/chinese4/learning5/notes7/media11/workspace-ai13/polish3/documents9）全过；artifacts/standalone/result.json。独立硬链接验收目录保留，resumedSameImmutablePackage=true，不描述为物理隔离。原图草稿测试需等effect填入路径后再断言；固定工具23项后手动压缩测试预算12288，自动压缩仍8192，全部安全/历史断言保留。dist-archive已封装同一目录为0.10 ZIP，473283729字节，启动脚本指向0.10并保留旧数据。真实模型语义/服务缓存/真实站点权限仍独立验收，不扩大已通过结论。最终记录见开发日志。
