# MCP 工具说明（0.3.0）

协议为本机 stdio。工具正常返回 JSON 文本；业务失败时 `isError=true`，正文为 `{ "code": "…", "message": "…" }`。MCP 参数校验失败由 SDK 返回协议错误。

## 读取工具

| 工具 | 主要参数 | 返回用途 |
| --- | --- | --- |
| `netease_account_status` | 无 | 实际登录状态、账号资料和会员状态；不含凭据 |
| `netease_search` | `query`，`limit=5`（1–10） | 歌曲候选，不会自动播放 |
| `netease_song_detail` | `songId` | 标题、歌手、专辑、时长与带时间戳歌词 |
| `netease_lyrics` | `songId` | `lyrics` 时间轴和 `unavailable` |
| `netease_playlists` | 无 | 当前账号歌单摘要、是否自建和是否还有更多 |
| `netease_playlist_tracks` | `playlistId`，`limit=20`，`offset=0` | 歌单歌曲分页，包含总数与 `more` |
| `netease_liked_songs` | `limit=20`，`offset=0` | 按账号所属与特殊类型定位喜欢歌单，再读取歌曲 |
| `netease_status` | 无 | 当前歌曲、实际播放位置、状态和精简队列 |
| `netease_queue` | 无 | 队列名、总数、当前下标和当前起至多五个歌曲 ID |

分页 `limit` 为 1–100，`offset` 为 0–10000。歌曲/歌单 ID 为正整数形式的字符串。歌曲详情可见不等于有权播放。歌单摘要每次最多 1000 个，`more=true` 表示未穷尽账号全部歌单。

## 控制工具

除 `netease_launch` 外，以下工具都要求 `requestId`（1–128 字符），推荐每次用户操作一个 UUID。网络重试沿用同一 ID，新的用户意图使用新 ID；同 ID 换操作或参数会返回 `REQUEST_CONFLICT`。去重仅在当前进程内有效，完成历史最多 128 条、有效期 10 分钟，不是永久操作账本。

| 工具 | 其他参数 | 行为 |
| --- | --- | --- |
| `netease_launch` | 无 | 准备独立播放器，不播放、不打开网易云客户端 |
| `netease_play` | `songId`，可选 `level` | 替换队列为单曲，获取授权音源并验证真实播放 |
| `netease_pause` | 无 | 暂停并保留位置；重复调用保持暂停；可取消正在准备的播放 |
| `netease_resume` | 无 | 继续当前歌；音源过期时重取并恢复位置 |
| `netease_stop` | 无 | 取消未完成播放、卸载音频、位置归零；保留队列 |
| `netease_seek` | `seconds` | 定位到 0 至曲目时长之前；暂停时定位仍保持暂停 |
| `netease_volume` | `volume`（0–100 整数） | 仅设置 mpv 实例音量，不改系统主音量 |
| `netease_next` | 无 | 队列下一首，越界返回 `QUEUE_BOUNDARY` |
| `netease_previous` | 无 | 队列上一首，越界返回 `QUEUE_BOUNDARY` |
| `netease_play_liked` | 无 | 构建喜欢列表队列并从第一首开始 |
| `netease_play_playlist` | `playlistId` | 构建指定歌单队列并从第一首开始 |

队列最多 10000 首，空列表或超过上限会报错。当前顺序播放，不含随机、单曲循环、队列编辑或持久化；播放到无权播放的歌曲会明确报错，不自动找替代版本。暂停准备中的新歌后，继续会重新解析该歌；停止后继续从当前歌开头播放。

## 状态语义

- `phase`：`idle / starting / playing / paused / stopped / ended / error`
- `position`、`duration`：秒；`volume`：播放器音量；`songId`：当前歌曲
- `playing`：当前控制状态为播放且引擎未暂停、空闲或缓冲
- `verified`：该流曾通过音频设备就绪及实际推进检查；调用者应同时检查 `playing`，不能只看历史验证标记
- `buffering`：播放器等待网络缓存；`lastError`：脱敏后的错误，不含底层请求内容
- `queue.index`：从 0 开始；`queue.items` 只是当前起的精简预览，不是全部列表

自然曲尾会顺序播放下一首，队列耗尽则变为 `ended`。到期源在暂停恢复时重新解析；播放中只有接近到期的源错误会自动尝试刷新一次，普通网络失败不做无限重试。停止与服务退出会释放本服务拥有的播放器，不操作用户另开的网易云或其他音频程序。

## 调用例子

```json
{"name":"netease_play","arguments":{"songId":"316157","requestId":"user-operation-unique-id"}}
```

```json
{"name":"netease_seek","arguments":{"seconds":42,"requestId":"another-unique-id"}}
```

当前没有“返回音频 URL”工具。小车若要接收 PCM/Opus/MP3，应在受控的桥接数据层接入音源，不把签名地址绕道发给模型或永久写进固件。
