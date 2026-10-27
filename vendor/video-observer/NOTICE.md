# Video Observer 来源记录

本目录来自用户现有插件的 src，版本0.4.0（插件清单0.4.0+codex.20260831081152）。

原始目录：D:\Codex\OpenAI-Codex-data\plugins\codex-bilibili-video-observer

原清单作者：Local developer；清单声明license为MIT。保留来源记录，未复制二进制工具、MCP宿主、控制台或任何运行数据。

2026-10-25，本项目副本的适配：

- p与真实cid分离，来源的分P身份由SourceRegistry管理。
- 归一化与帧校验保留实际图像指纹。
- 缺少比较特征时返回known:false，不把缺特征误报为场景切换。
- SceneDetector首帧比较也显式标注known:false，统一比较结果合约。
- 热缓存字节上限改为32MiB。

应用只导入时间轴、帧、字幕、归档相关模块，不启动原HTTP桥接，不使用原插件缓存。FrameArchive由应用显式指定D盘目录和clearOnReboot:false。

原始插件目录没有被修改。后续对本副本的修改继续在开发日志中记录。

2026-10-27，0.10 视频后台阅读适配（仅项目副本）：TemporalIndex允许应用显式使用1秒墙钟归档节流，前端按约2个视频秒采640×360预览；FrameArchive增加按已验证路径读取指定帧、2400帧/96MB滚动上限及实际归档计数；SubtitleTimeline增加字幕去重索引和20000条容量边界。独立VideoCacheManager按用户设置定时清理过期/超额自动preview文件，旧缓存保持可读，不调用原插件工具或改动原插件目录。
