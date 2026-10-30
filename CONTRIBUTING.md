# 参与开发

本仓库同时维护独立 MCP 与 Codex 插件，改动音乐业务只修改 `src/`，不要复制一套实现到插件中。`plugin/` 是包装和 Skill 源码；`dist/plugin` 是可删除、可重建的生成产物。

## 本地开发

```text
npm ci --ignore-scripts
npm run check
npm run plugin:build
```

安装新依赖需要更新 lockfile。API 固定到源码提交的 HTTPS tarball，并由 lockfile 保存完整性；不要恢复到依赖个人 SSH 密钥的地址。Windows mpv 固定上游稳定发行标签和 SHA-256，不使用滚动的 git-release 资源。

插件运行目录的指纹由核心源码、运行脚本、依赖清单和工具清单计算。修改这些文件后重新 setup；不修改 Codex 缓存的已安装副本。普通用户使用生产依赖，开发者执行 npm ci 安装格式工具等完整依赖。

## 验证

- `npm run check`：无账号、无声的离线测试
- `npm run verify:plugin -- --online`：隔离 Codex 配置安装，验证真实缓存入口、20 个工具及当前账号；要求先准备插件运行目录
- `npm run verify`：会发声，使用当前账号和喜欢列表，验证全部工具及连续播放；明确准备好再运行，结束会停止并退出
- Mac 与其他系统变更需要对应实机记录，不能将 Windows 测试算作跨平台验收

## 提交问题与改动

提供操作系统/架构、Node 和 Codex 版本、入口类型、脱敏错误码及重现步骤。不要上传会话、浏览器登录资料、Cookie、临时歌曲地址、node_modules 或播放器二进制。账号权限失败与代码故障应区分。

许可证为 MIT，贡献者须有权提交对应代码，保留第三方许可证和来源说明。官方目录上架与 GitHub 开源分发分开处理；此仓库不包含云端部署流程或公网上传授权。
