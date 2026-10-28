import fs from 'node:fs/promises';

const content = `# Study Mate

> **优雅而克制的本地学习工作台** —— 融汇沉浸阅读器的版式美感、现代 IDE 的多栏自由排布与无感伴学体验。AI 可在后台静默观看分析课程、管理与编辑笔记、随堂出题并智能批改作业。

---

## 🌟 核心特色：AI 原生视频无感伴学与全流程学习闭环

### 1. 视频无感观察：边看视频边提问，后台静默分析不打扰
- **后台静默观看与时间定位**：用户在观看 B 站网课或本地视频时，可随时在右侧伴学栏直接发问（例如 *“刚才这一步推导为什么成立？”*、*“解释 14:20 处的公式含义”*）。
- **前台零打扰**：AI 在后台基于已缓冲的画面、时间轴字幕和离屏原片进行自主抽样分析，**绝不暂停、不跳转、不拖动用户当前的视频播放进度**，也不会发出任何干扰声音。
- **多模态原图级理解**：如果视频画面出现手写板书或模糊公式，模型可按需调取真实高清画面进行多模态视觉理解，不依赖易错的 OCR 机械转录。

### 2. 深度参与学习闭环：笔记管理、智能出题与作业批改
AI 在 Study Mate 中不只是简单的“聊天问答机器人”，而是全流程参与的智能学伴：
- **智能管理与修改笔记**：在用户授权「允许保存」后，AI 可以根据当前讲解内容自主创建新笔记、插入精准的视频/课件插图，或对现有笔记执行原子级精确替换修改；原笔记在修改前均会自动留存多版本备份。
- **随堂练习生成**：针对刚看完的视频难点或选定课件章节，让 AI 依据课程关键定理即时生成判断题、选择题与综合计算题。
- **智能作业与试卷批改**：将学生的解题过程记入笔记或直接拍照粘贴，AI 会逐步骤进行严谨的数学推导核验、给出得分判断并指出易错盲区。

![智能笔记管理、出题与批改作业](images/08-quiz-and-grading.png)

---

## 📸 完整功能图解与使用方法

### 1. 个人学习空间与多任务工作台

启动 Study Mate 后，首先呈现的是清晰整洁的个人学习空间主页（Bento 灵动看板）。顶部面包屑胶囊支持多标签自由切换，底部提供核心服务状态指示。

![学习工作台主页](images/01-workbench-home.png)

- **一键起步**：可粘贴 B 站视频链接开启无感伴学观察、打开本地音视频、导入外部 Markdown，或直接新建空白笔记。
- **多栏灵活工作台**：支持双栏并排、左右拖拽交换面板、多标签页快速切换或收缩侧栏，轻松搭建“左侧看视频/课件，中间写笔记，右侧 AI 伴学”的专业学习环境。

---

### 2. Markdown 知识库与公式排版

完美兼容 Obsidian 知识库排版，支持在只读阅读、实时分栏与源码模式间自由切换。

![笔记排版与公式渲染](images/02-note-editor.png)

- **KaTeX 数学排版**：行内公式与独立居中多行公式排版考究，分子分母间距自然，长公式自适应换行，告别未渲染的代码块。
- **Mermaid 流程图表**：原生支持 Mermaid 矢量图表实时渲染，支持一键放大、全屏阅读与源码折叠。
- **双链与目录导航**：左侧提供笔记分类目录树与秒级全文检索，正文支持 Obsidian 风格双链引用与反向链接追踪。

---

### 3. PDF 与 PowerPoint 本地课件阅读

支持本地 \`.pdf\`、\`.pptx\` 以及旧版二进制 \`.ppt\` 文件的离线矢量化渲染，不依赖任何云端转换服务或 Microsoft Office。

![课件与讲义阅读器](images/04-document-reader.png)

- **缩略图与目录导航**：左侧自动生成高清缩略图，支持缩放比例调节与滚轮平滑翻页。
- **内置批注工具条**：自带荧光笔、划线、矩形框选与手写批注工具，学习批注与课件无缝结合。
- **AI 视界联动**：点击「让 AI 看本页」，可将当前课件或框选区域原图交由多模态 AI 直接分析。

---

### 4. 本地采音转写与多模态学习引擎

点击左下角「识别与全库检索」，呼出完全离线运行的本地学习计算中心。

![本地采音与学习引擎](images/03-learning-engine.png)

- **无字幕课程采音**：内置工业级 SenseVoice 语音模型（纯 CPU 本地推理），可捕捉当前播放课程的原声并生成带时间轴的文字实录，支持倍速对齐与回跳复听。
- **全库混合检索**：基于 SQLite FTS5 全文搜索与本地 384 维向量语义检索，快速跨笔记、跨课件检索知识点。

![全库检索与语义关联](images/06-knowledge-search.png)

---

### 5. 智能视频缓存与自动清理

播放视频或网课时，系统会在后台自动缓存低分辨率关键画面，方便提问时快速定位视频内容。

![视频缓存与自动清理设置](images/04-video-cache.png)

- **低分辨率抽帧**：每隔约 2 秒保存一帧 640×360 画面，占用极低磁盘空间。
- **定时清理与配额控制**：用户可自定义缓存保留时长（24小时 ~ 30天）、总空间上限（32MB ~ 2GB）以及自动清理频率，严格控制在缓存目录内淘汰，绝不触碰用户的笔记和原始课件。

---

### 6. 多平台 AI 接入与会话管理

右侧伴学面板深度整合现代大语言模型，支持按需工具调用与多会话独立管理。

![模型接入与设置](images/05-ai-settings.png)

- **丰富接入渠道**：
  - **官方 ChatGPT 订阅 (SIWC)**：支持通过 Sign in with ChatGPT 官方授权方式直接复用订阅额度。
  - **Antigravity 订阅兼容**：兼容 Gemini 会员与 Google 授权。
  - **主流 API 协议**：支持 OpenAI API、DeepSeek、通义千问、Anthropic Claude、Google Gemini、OpenRouter 及本地/自定义兼容接口。
- **工具感知（Tool Calling）**：模型在回答时可按需自主触发笔记检索、精确替换、课件按页读取、视频后台解析等 28 种学习专用工具。

---

## 🚀 快速启动指南

### 绿色便携版运行（推荐）

1. 从 Releases 页面下载最新发布的 \`Study-Mate-0.14.0-Windows-x64.zip\`。
2. 解压到任意目录（建议存放在 D 盘等非系统盘）。
3. 双击根目录下的 \`启动工作台.cmd\` 或 \`Study Mate.exe\` 即可直接进入工作台。
4. 本应用自带所有必要的解码与模型组件，**无需安装 Node.js、Python、FFmpeg、Office 或配置系统环境**。

### 开发者源码构建

```powershell
# 1. 克隆代码仓库
git clone https://github.com/windfile1-del/study-mate.git
cd study-mate

# 2. 安装项目依赖
.\\scripts\\install.ps1

# 3. 启动本地开发模式
npm run dev

# 4. 运行全套自动化测试
node scripts/workspace.mjs check
node scripts/workspace.mjs test

# 5. 生产环境打包
npm run build
node scripts/workspace.mjs dist-dir
```

---

## 🛠️ 技术架构

- **前端架构**：React 19 + TypeScript + Vite 8 + Lucide Icons + TanStack Virtual
- **桌面容器**：Electron 45 + WebContentsView 进程级沙箱隔离
- **排版引擎**：KaTeX 0.16 + Mermaid 12 + rehype/remark AST 管道
- **文档引擎**：PDF.js + pptx-browser (静态矢量化解析)
- **本地识别**：sherpa-onnx (SenseVoice CPU 离线转写) + Transformers.js (多语言向量嵌入) + Tesseract.js (可选 OCR)
- **存储检索**：SQLite WAL + FTS5 全文索引 + 原子 JSON 文件持久化
`;

await fs.writeFile('D:/study-mate/docs/README-preview.md', content);
console.log('README-preview.md updated successfully');
