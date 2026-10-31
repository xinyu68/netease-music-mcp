# 网易云音乐 MCP 与 Codex 插件

用自己的网易云账号，在 Codex 中点歌，让电脑播放音乐。**一个项目，两种入口：独立 MCP 和本地 Codex 插件。** 不需要 ESP32、其他外接设备或网易云桌面客户端。

当前版本 **0.6.1**，源代码使用 [MIT 许可证](LICENSE)。插件包含音乐 Skill 和 MCP 配置，播放核心只有一份。音频由独立 mpv 播放器获取和解码，不经过语言模型；声音输出到电脑当前扬声器或耳机。

## 可以做什么

- 同时查找喜欢列表和公开曲库，区分精确版本、翻唱与缺失歌手的收藏候选，再播放指定歌曲
- 播放“我喜欢的音乐”或指定歌单，顺序切歌
- 播放每日推荐、网易云热歌榜；开启心动模式并自动补充智能推荐队列
- 根据明确指令喜欢或取消喜欢歌曲，写入后读回确认
- 暂停、继续、停止、上一首、下一首、定位与独立音量；记住明确设置的音量，重启或升级后自动恢复
- 顺序播放、随机播放、单曲循环；切换模式保留歌曲、进度及暂停状态
- 查询实际播放状态、读取歌单和带时间戳歌词
- 用自己的账号及会员权限播放；不会解锁无权播放的歌曲

可以直接说：“播放我喜欢的音乐”“播放陈奕迅的十年”“下一首”“暂停一下”“音量调到二十”。当前没有独立播放器图形界面。

也可以说：“开启心动模式”“播放今天的每日推荐”“播放热歌榜”“喜欢这首歌”“取消喜欢这首歌”。心动模式默认需要喜欢列表中已有歌曲；普通点歌、播放其他列表或停止会退出心动模式。

“随机播放我喜欢的音乐”可以一次调用完成，从整个列表随机选第一首，再按打乱后的顺序播放，每轮列表内不重复抽选，播完结束。“单曲循环这首歌”只改变自然曲尾行为，手动上一首/下一首仍会切歌；“恢复顺序播放”可退出。模式在本次 MCP 进程内保留，换歌单和停止不会重置，重启服务后默认为顺序播放。心动推荐来源与播放模式独立，随机心动在当前批次播完后继续补充。

## 查找收藏中的歌曲

点歌会同时查喜欢列表和公开曲库；即使公开搜索只有翻唱，也能定位收藏中的独立歌曲 ID。已知歌手单独传 `artist`，明确找收藏时传 `source: liked`。缺失歌手只标为未知候选，不冒充已匹配原唱。某个 ID 无权限不代表同名收藏版本也无权限。

`netease_search` 的返回值从数组改为 `{ candidates, sources }`，客户端需读取 `candidates` 并检查来源状态。详见 [MCP 工具说明](docs/MCP工具说明.md)。

## 平台与准备

| 平台 | 状态 | 首次准备 |
| --- | --- | --- |
| Windows x64 | 已做本机实际验收 | Node.js >=22.13；Edge WebView2 Runtime（多数电脑已有） |
| macOS Apple Silicon / Intel | 已验证收藏检索；完整安装和播放验收待补 | Node.js >=22.13；Xcode Command Line Tools；已有 mpv，或已有 Homebrew 供脚本安装 mpv |
| Linux / Windows ARM64 | 暂不提供完整首次登录安装流程 | 不作为当前开箱即用平台承诺 |

Codex 插件需要支持本地插件的桌面/CLI。自动注册需要终端能执行 `codex plugin`；当前用 Codex CLI 0.153.4 验证。只有 Codex 桌面而没有 CLI 时，也可在项目中准备后从本地插件源手动安装。网页版或云端会话不能直接让这台电脑发声。

安装 [Node.js](https://nodejs.org/en/download) 后，重新打开终端。下载本项目源码 ZIP 并解压，或克隆仓库，再进入项目目录。下载 ZIP 使用时**不要求安装 Git**；API 依赖固定为 HTTPS 源码包并由 lockfile 校验。

源码仓库：[xinyu68/netease-music-mcp](https://github.com/xinyu68/netease-music-mcp)。可以下载 [源码 ZIP](https://github.com/xinyu68/netease-music-mcp/archive/refs/heads/main.zip)，或使用 Git：

```text
git clone https://github.com/xinyu68/netease-music-mcp.git
cd netease-music-mcp
```

## 推荐：在 Codex 中作为插件使用

在项目根目录执行：

```text
node scripts/setup.mjs --plugin --install-plugin
```

这一条命令依次完成：检查环境 → 在用户目录准备固定依赖 → 安装播放器/编译登录窗口 → 必要时打开官方网页登录 → 在线检查账号 → 构建并注册本地 Codex 插件。

登录由你本人在官方页面完成，不需要把 Cookie 发给 Codex。准备完成后**重新打开 Codex 聊天**，选择“网易云音乐”插件，直接点歌即可。

不希望脚本注册插件、或者没有 `codex` 命令时：

```text
node scripts/setup.mjs --plugin
```

然后使用项目的本地插件源安装；详细步骤见 [安装与使用](docs/安装与使用.md)。插件正常启动不下载依赖、不打开登录窗口，只加载已经准备好的本地运行目录。

## 也可以只使用独立 MCP

在项目根目录执行：

```text
node scripts/setup.mjs
```

准备完成后，以 stdio 启动 `node /项目绝对路径/src/server.mjs`。在 Codex 或其他兼容 MCP 客户端配置该入口。生成本机路径的 TOML 示例：

```text
node scripts/print-mcp-config.mjs
```

只复制输出的配置，不需要手动常驻一个终端。独立入口支持相同的 25 个工具，不要求安装 Codex 插件。**插件和独立 MCP 二选一启用**，避免同一个客户端启动两份播放实例。示例见 [examples/codex-mcp.toml](examples/codex-mcp.toml)。

## 首次登录、升级与配置

- 插件的依赖和播放器存放于用户状态目录的 `runtimes/<版本-源码指纹>/`；Codex 插件缓存中只放源码，更新插件时不会把登录凭据打包进去
- Windows 状态目录：`%LOCALAPPDATA%\netease-music-mcp`，会话用当前用户 DPAPI 加密
- Mac 状态目录：`~/.local/state/netease-music-mcp`，当前会话为 Base64 加 0600 权限，**不是加密存储**；Mac 登录仍须实机验收
- 下载新版本后重新执行相同的 setup 命令。有效会话会复用，旧版本运行目录保留；新依赖准备失败不会覆盖旧版本
- `--no-login` 只准备依赖；`--check` 只检查前置条件，不安装、不登录
- 可设置 `NETEASE_MUSIC_STATE_DIR` 指定状态目录；必须在 setup 和实际 MCP/Codex 进程中保持相同环境值
- 高级设置参考 `config.example.json`；`NETEASE_MCP_CONFIG` 可指定不含凭据的本机配置文件，插件启动和准备阶段应使用同一配置

完整说明见 [登录与凭据](docs/登录与凭据.md)、[安装与使用](docs/安装与使用.md) 和 [MCP 工具说明](docs/MCP工具说明.md)。

## 开发与验证

源码开发安装完整依赖（普通用户无需执行此节）：

```text
npm ci --ignore-scripts
npm run check
npm run plugin:build
```

| 命令 | 用途 |
| --- | --- |
| `node scripts/setup.mjs --help` | 查看首次准备选项，执行前不依赖 node_modules |
| `npm run check` | 格式、语法和离线回归 |
| `npm run verify` | 实际账号、全部工具及播放验收；**会发声**，最后停止 |
| `npm run verify:plugin -- --online` | 在隔离 Codex 配置中安装插件，从真实缓存入口验证工具和账号；不修改你原来的 Codex 配置 |
| `npm run bundle` | 生成源码包和本地插件包，均不含个人凭据或依赖二进制 |

0.4.0 的 Windows 独立播放验收已调用验证 24 个工具，会员曲目实际连续播放超过 32 秒。日推、心动模式、热歌榜已实际播放；收藏的真实账号验收使用已符合目标的状态，不为测试主动更改收藏。0.5.0 的 61 项离线测试及安装后 25 工具发现、播放模式切换检查通过；新增模式的真实音频曲尾实播尚未验收。0.6.0 在 macOS 通过 74 项离线测试和当前账号的只读收藏检索，未运行新版真实音频全工具验收。详见 [本机验收记录](docs/本机验收记录.md)。远端 CI 结果以对应提交的 Actions 为准。

## 边界与常见问题

- 需要联网访问网易云、歌曲 CDN；首次准备还需访问 npm、GitHub 和微软 NuGet
- 会员状态、能搜到歌曲、能看到歌词，都不代表该曲目有完整播放权限；试听/无权/不支持的保护资源会明确报错
- 非官方 API 可能随平台变化；不保证全部地区、账号和曲库都能播放
- 本项目不提供歌曲下载、会员解锁、自定义歌单编辑或修改系统音频路由
- 当前不需要也不包含 ESP32 输出适配；硬件集成属于其他项目，不影响电脑独立使用
- `MPV_NOT_FOUND`、`LOGIN_REQUIRED`、`API_TIMEOUT` 等排障见安装指南；不要将会话文件、Cookie 或音源地址发到 Issue

本项目通过 GitHub 分发开源源码和本地插件构建流程，尚未发布 npm 或上架官方插件目录。公开源码分发和官方目录上架是不同流程。

## 参与开发

阅读 [CONTRIBUTING.md](CONTRIBUTING.md)、[架构与维护](docs/架构与维护.md)、[CHANGELOG.md](CHANGELOG.md) 和 [第三方说明](THIRD_PARTY_NOTICES.md)。问题反馈请提供系统、Node/Codex 版本和脱敏错误码，使用你自己的网易云账号。
