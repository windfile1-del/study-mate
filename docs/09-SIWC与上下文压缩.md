# 0.5.0：SIWC、上下文压缩与路径附件

> 本文记录历史范围。用户已在0.6.0明确授权工具层开发，当前实现见 [学习工具与缓存](10-学习工具与缓存.md)。

本轮替换订阅接入、参考用户 Harness-Mate 增加 Antigravity、修复拖拽卡住并增加上下文压缩。按最新要求，笔记只附路径，不开发供模型调用的读取、搜索、修改工具。现有人工笔记编辑与保存保留。

| 模块 | 职责 |
| --- | --- |
| core/subscription-auth.ts | SIWC / Google OAuth、127.0.0.1 回调、PKCE/state/nonce、签名校验、加密凭据、账户隔离、串行续期与退出撤销 |
| core/ai-providers.ts | SIWC 原生 Responses；Antigravity 包装 Gemini 请求和嵌套 SSE；API 四协议及用量归一化 |
| core/chat-context.ts | 路径元数据、历史摘要桥接、完整轮次切分与用量累计；说明无文件工具 |
| main/ai-service.ts | 设置、聊天持久化、取消、模型压缩与摘要提交；原始消息保留 |
| renderer/App.tsx | Pointer Capture 标签拖拽、阈值、目标命中与取消；拖动时隐藏原生视频 |
| renderer/ai/AiPanel.tsx | 接入向导、账户与模型、风险标识、压缩摘要/统计和路径附件说明 |

SIWC 以 Study Mate 名称、稳定匿名 host ID 独立注册，保留签发的 client ID；申请 openid/profile/email/offline_access/resource.invoke/chatgpt.tokens.use.direct。资源固定 api.openai.com/v1，推理固定 /responses，store=false。不再使用或打包 Codex app-server，也不导入旧凭据。

验证回调方法、Host、路径、重复参数、state、issued client；验证身份令牌 JWKS RSA 签名、issuer、aud/azp、nonce、有效期、subject。只授权身份则保留身份并禁用套餐；相同邮箱的独立注册不合并。刷新串行化，轮转凭据持久化；退出即使远端失败也清除本地并提示未确认撤销。

Antigravity 只读参考 D:\agent移动端\src\dev\wind\agent\modelprovider 中 SubscriptionOAuth.kt、SubscriptionClient.kt、ProviderHttp.kt、ModelDiscovery.kt、ReasoningWire.kt。用户原项目与账户数据不修改。沿用公开桌面 OAuth 配置和兼容标识，loadCodeAssist/onboardUser、fetchAvailableModels、streamGenerateContent 协议。非官方第三方入口，会员额度不保证可用；条款存在账户停用风险。无自动付费 API 回退或换号逻辑。

压缩把旧摘要和较早完整问答按预算分批生成摘要，保留最近三轮；本次问题在压缩后加入。摘要完整且缩短上下文才原子提交。covered/lastCoveredId 绑定历史，启动拒绝不匹配摘要。原消息不删除，失败/取消不替换已有摘要，超预算显式报错。压缩用量单列，未返回仍为未知。

笔记附件从授权目录索引验证路径，仅构造相对/绝对路径和 vaultId，不调用 vault.read 或会读取正文的 resolveNotePath。没有模型工具定义、执行循环或隐式全文回退。首次发出路径不代表 AI 已取得文件内容。

拖拽超阈值后开始，document.elementFromPoint 命中主区或右区；pointerup、pointercancel、lostpointercapture、窗口失焦、Escape 均清理。提示层绝对定位且不拦截指针，取消恢复原生视图。

## 验证边界

- check、test：50 项通过，含签名篡改、畸形回调、身份/套餐分离、账户替换、续期并发、终止刷新、撤销失败、流中额度失败、Antigravity 包装、压缩切分和无文件工具约束。
- workspace-ai-smoke：真实指针拖拽/取消、双向视频分栏、流取消、参数/用量、请求仅路径无正文/无 tools、手动/自动压缩及失败回滚。OAuth 验证授权地址与取消，不使用真实账户。
- 工程外独立包验收：复制到 D 盘新目录，独立 cwd、仅系统 PATH、独立 profile；覆盖笔记、媒体、工作区/AI。结果见 artifacts/standalone/result.json 及分项报告。
- 未使用用户真实模型账户或额度，不将协议替身和打开授权链接等同于真实订阅验收。

参考：[SIWC 登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[身份与会话](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)、[模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、[Antigravity 条款](https://www.antigravity.google/terms)。
