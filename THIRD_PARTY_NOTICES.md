# 第三方与来源说明

本项目原创源码使用 MIT 许可证，见 LICENSE；以下第三方组件保留各自原有许可证。源码包和插件包不分发歌曲或播放器二进制。

- `src/lyrics.mjs` 的 LRC 解析改编自用户本地 desk-companion 项目，MIT，Copyright (c) 2026 xinyu.wang；完整许可证保留于 `vendor/desk-companion/LICENSE`
- 官方网页登录窗口从用户本地 netease-cloud-uploader 项目复用并调整为独立状态目录；这里包含源码和构建脚本，运行不引用原项目目录或其凭据
- `@neteasecloudmusicapienhanced/api`：MIT，固定 Git 提交，来源 [api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)。其依赖及各许可证随安装包保留于 node_modules
- `@modelcontextprotocol/sdk`、`zod`：MIT；开发格式工具 `prettier`：MIT。版本与传递依赖由 package-lock.json 锁定
- Windows 登录窗口使用 Microsoft WebView2 SDK，其微软许可证随 NuGet 包提供；本地安装脚本从微软 NuGet 获取、验证 DLL，不在源码交接包分发 SDK 二进制或系统 Runtime
- mpv：独立外部播放器，Windows 使用上游 [mpv-player/mpv](https://github.com/mpv-player/mpv) v0.41.0 稳定发行页面的 mingw-w64 CI 二进制附件，下载与 SHA-256 位于 tools/mpv-manifest.json。mpv 及 FFmpeg 等组件适用各自 GPL/LGPL 等条款，具体以对应构建和源码为准；源码和插件包均不包含播放器二进制。若将来分发完整二进制安装包，应另行附齐该构建的许可证和源码提供要求

早期原型参考的第三方客户端自动化、orpheus 命令与 Windows 内存采集代码已退出正式运行链路，并移入本机忽略的历史目录；当前产品源码没有继续依赖这些适配器。

MCP 文档和 JSON IPC 行为分别参考 [OpenAI MCP 文档](https://learn.chatgpt.com/docs/extend/mcp) 与 [mpv JSON IPC 官方手册](https://mpv.io/manual/stable/#json-ipc)。API 接口为非官方开放接口，项目并非网易云官方产品。
