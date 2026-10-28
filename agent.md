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

## 0.12 灵活工作台、文档批注和视觉分工

用户追加要求隐藏“请调用某工具读取笔记/PPT页面”等内部提示。externalPrompt改为简洁text+私有instruction/sourceLabel，UI只显示可移除来源卡，不覆盖已写问题；共享草稿/浮窗同步包含私有来源。AI send.sourceInstruction限制8000字，仅在最新用户材料尾部加入，消息text只存用户问题，prompt从UI状态剥离，不改变固定系统前缀或预读全文。旧版自动原图草稿按已知前缀迁移隐藏。中文原图验收需断言输入框不含路径/工具指令、模型请求仍含真实路径，不能再断言路径出现在输入框。

用户已自行升级为0.11冷白青绿/玻璃风格，本轮沿用其styles.css变量与组件，不覆盖主样式。左侧NavigationPanel按笔记/文档/课程分类；隐藏导航/右侧伴学栏，浮出为真实BrowserWindow，可拖移、原生缩放和置顶/停靠。FloatingPanels严格校验窗口、主frame及精确可信URL，只有主窗口可发布选中资料元数据。两处AI共用同一AiService，草稿同步，不新建账号或后台付费请求。小窗位置/置顶D盘保存。

PPTX按虚拟列表按需渲染真实缩略图，标题回退非空文本，不虚构旧PPT图像。方向键/滚轮局限阅读区，编辑框、批注和放大滚动避让。文档导航不以旧列表页码覆盖当前进度。PDF/PPT批注单独存annotations/doc-id/page.json，按不可变revision绑定、CAS版本保存；笔/线/荧光/颜色、整条擦除、撤销/清空和自动/手动保存，MD不提供批注。不能声称批注已嵌入原PDF/PPT。

OCR无新增大模型，公式/曲线/图表默认原图多模态；普通印刷OCR仅保留兼容折叠入口和固定工具，禁止删减23项工具动态清单。VisionRoleSettings独立配置视觉模型和加密密钥，图像工具按最多4图一组送视觉专员（无工具），返回观察+不确定性+来源给文本主模型；像素私有保存便于插图，不暴露UI或再次送主模型。原图历史使用不可变文字投影，分工切换加协议key边界。视觉tokens/次数单列，不混入主模型缓存；实际语义/账单/缓存不能用fixture代替。

学习系统提示要求写课件/视频笔记时就近添加工具返回citation，study-cite定位页、study-video定位秒，禁止编造。用户笔记/字幕/视觉输出仍不可信学习资料，不是写入授权。使用/调研链接见docs/15-灵活工作台与批注.md。所有fixture/profile/temp在D，不改真实库和原文档；保留旧包。新增reader组验证浮窗/批注/双模型/来源跳转和重启，完整工程外回归纳入reader。


### 0.12最终交付验收

check/build/dist-dir/dist-archive通过，82/82单元测试通过，66项工程外原生回归全过：reader9、video5、chinese4、learning5、notes7、media11、workspace-ai13、polish3、documents9。artifacts/standalone/result.json passed=true，cwdOutsideProject=true，copyMethod=physical copy。验收复用同一不可变0.12程序，修复测试脚本后已通过组不重复跑；最终测试副本 D:\StudyMateAcceptance\study-mate-0.12.0-Qcvgf4 已清理。早期失败证据/旧版本保留，不修改真实用户库。

本轮追加隐藏读取提示：输入框仅放自然问题，原图/PPT读取指令、ID和路径使用独立sourceInstruction尾部材料，来源卡可移除；图片导入也不再把路径直接追加到输入框，保留已有问题，浮窗共享草稿含来源引用。视觉配置、来源卡、批注、缩略导航和浮窗截图已查看。批注按pointerId结束笔迹，window接收阅读区外pointerup，避免仅检查捕获状态而漏笔。

验收脚本修正：Windows截图/滚轮先激活测试窗口；Callout按实际内容定位，不以全局数量固定为1；主页和分类中同名视频入口用exact名称定位。稳定系统提示增加来源索引指导，自动压缩fixture预算改10240、手动仍12288，保持最近三轮完整历史/失败/取消/当前问题全部断言，未放宽产品预算保护。图片引用断言改为输入框无路径/工具命令、来源卡存在、实际请求仍具备路径。

5006篇首次索引60884ms、扫描UI心跳最大86.5ms；6600块长笔记仅挂载23块，首次渲染1273ms、完整后台排版3261ms、缓存返回471ms。仅为本机fixture记录，不推广为所有知识库性能。中文真实音频/板书与合成样本分开记录；复杂图像仍以视觉模型观察为主，保留OCR低置信。受控Provider只证明图像实际传输、双模型分工、权限、来源与协议，不代表真实模型语义/服务商缓存命中/计费或账号验收。

最终ZIP release/0.12.0/Study-Mate-0.12.0-Windows-x64.zip，473305695字节，7-Zip完整性检查Everything is Ok（117文件，展开992015274字节）。由同一win-unpacked封装，无新增本地模型；启动工作台.cmd优先0.12，继续.local/data。使用与限制见 docs/15-灵活工作台与批注.md。


## 2026-10-28 · 0.13 会话、自动资料与学习记录

保持用户主styles.css不变，沿用冷白青绿组件变量。工作台按实际可见页面生成最多两份路径/页码/课程引用；同一PPT并排页码分别记录，隐藏标签不附加，独立浮窗共享主工作台引用，未自动发送笔记全文。

新增持久会话库和全局用量账本：新建/切换/搜索/重命名/删除，迁移旧归档并防删除后重现；独立草稿和压缩记忆；重启会把中断回答标记失败并补全未确认的工具结果，不声称保存成功；压缩边界不匹配则恢复原始历史。累计覆盖全部轮次、工具循环、视觉和压缩，删除会话仍保留全局统计，缺失供应商指标不编造。

资料与备份管理列出真实目录，支持元数据/预览/CAS恢复/清理；旧哈希备份不猜路径。删除笔记先备份后入回收站，未保存草稿/外部修改拒绝覆盖；移除课程/课件记录保留原件。模型get_note_backups可查目录，不赋予模型恢复/删除能力。源码与阅读共享比例进度，分栏双向同步。播放器新增独立中文听写按钮，与已有字幕开关分离。自动帧保留上限24h、清理检查上限1440分钟，按到期时间重新调度，重启补清理；单课提高为43200帧/512MB，整体空间预算仍生效。

最近学习记录保存真实访问/进度/观看区间。上一节课程按当前视频排除最近同源记录选择；优先中文SRT/已有ASR关键词，再核对原视频帧。无文字时先粗采样最多六个片段，再细看，前台播放不受影响；不能据此声称看完课程。固定工具从23扩为27：search_conversation_history/list_recent_learning/locate_video_segment/get_note_backups。

参考OpenAI与Claude公开文档，使用跨接口增量明文摘要，保留最近三轮完整历史、固定摘要段、原话/来源/保存结果和有界工具原始摘录；原始会话及工具返回可检索，像素/不透明签名不进入文字检索。压缩失败或未缩小不提交；软阈值滞回避免每轮压缩，稳定系统/工具前缀、Claude独立系统缓存断点、官方OpenAI稳定会话缓存键。未调用或仿造供应商原生压缩项，不保证实际命中率。

验证：check/build/dist-dir通过；新增和受影响的29项单元检查通过（10项工作流+19项相关回归/工具摘录保护），11组打包程序原生窗口检查通过。包括单页/并排/隐藏引用、同PPT不同页、七轮累计840tokens、会话与草稿、增量/失败/自动压缩和稳定前缀、备份恢复清理与草稿冲突、应用内移除、双向42%/74%滚动、上一课中文字幕定位与六个真实原视频片段、播放器听写入口、小浮窗和重启持久化。仅用受控接口，不冒充真实模型理解/账号/账单/缓存验收；不重跑旧ASR声学、数学排版、文档绘制和全库性能组。成功与源码依赖指纹保存在artifacts/0.13，最后一次运行复用29项单元和11组原生成功记录。使用说明docs/16-会话与学习资料管理.md。


0.13最终包：release/0.13.0/Study-Mate-0.13.0-Windows-x64.zip，473324818字节；7-Zip完整性检查Everything is Ok，118文件、展开992087417字节。最终会话恢复代码重新构建并通过受影响的会话/浮窗重启两组，其余9组复用；ZIP同步最终exe、app.asar与使用说明后再验证一次完整性。验收汇总artifacts/0.13/acceptance.json。启动工作台.cmd优先0.13并沿用.local/data；0.12旧ZIP保留，真实知识库与用户数据未修改。


## 2026-10-28 · 0.14 逐篇备份恢复与紧凑伴学区

按用户反馈重排备份为按原路径分组、同名显示目录、逐版本预览和恢复；只有当前笔记的选中版本可清理，旧版未知归属单列。恢复先备份当前内容，草稿和CAS冲突保持保护。新增固定工具restore_note_backup（总28项）；必须有写权限、read_note当前版本和属于同一路径的backup_id，拒绝跨笔记/未知归属/脏草稿/外部变更。保存结果返回backup_id、previous_version，系统要求按行核对修改后反馈，发现误改及时调用恢复；不保证真实模型能发现所有语义错误。

AI输入栏参照用户提供Codex布局但沿用冷白青绿风格：右下模型菜单/思考滑条，上下文竖向进度条悬浮详情，累计用量移至输入框下方。按用户后续要求进一步缩小卡片到模型248 CSS px、思考216 CSS px；长说明用title，手动ID折叠，列表更紧凑。消息与通知独立滚动，右侧资料区限制高度，输入区可收缩，覆盖小窗口/图像引用/错误提示；菜单portal避开裁剪，原生视频在菜单覆盖期间隐藏视图，播放会话不变。修复快速切换会话后草稿恢复覆盖新输入的时序：草稿在layout effect中切换，准备请求期间禁用会话切换。

分隔条rAF直接更新CSS预览，不再每个pointermove更新App状态；松手提交，Esc取消，键盘仍可用，最终布局继续保存。采样时隐藏原生视频且不重复发同类布局，PPT/PDF拖动期间不重复栅格化，结束按最终尺寸更新。主styles.css保持原字节，样式放在组件CSS。

check/build/dist-dir通过，本轮16项受影响单元测试、5组打包原生窗口检查通过；无关登录、ASR、OCR、全库检索性能、批注和数学解析不重跑。验证涵盖两篇同名笔记隔离、同篇多个版本恢复/清理、模型真实读写→核对→恢复、只读/草稿/版本保护、实时模型和强度、上下文hover与底部累计、1024×640/1280×720/1480×950并排笔记和原生视频、图片与错误并存、PPT拖动后真实页面、浮窗340×500。48次指针移动期间布局ARIA提交0次、结束1次；最终本机采样P95 16.8ms，最大33.4ms，不推广为所有设备指标。成功依赖指纹与截图artifacts/0.14，最后一次调用复用16项单元及全部5组。说明docs/17-逐篇恢复与紧凑伴学界面.md。


0.14最终交付：release/0.14.0/Study-Mate-0.14.0-Windows-x64.zip，501865319字节，ZIP完整性Everything is Ok，119文件、展开992114914字节。采用压缩级别3缩短封装时间，无新增模型。工程外cwd启动检查通过，系统PATH无Node/Python依赖；临时验收目录D:\StudyMateAcceptance\study-mate-0.14-ui-BChERj已按边界校验清理，截图与结果artifacts/0.14/external-startup.*。当前启动器优先0.14并沿用.local/data，0.13及原用户知识库保持不变。最终截图已查看：缩小的模型/思考卡、按篇版本列表、图像引用与错误并存的小屏输入区、PPT最终缩放及浮窗。
