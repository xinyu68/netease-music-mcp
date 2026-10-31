# MCP 工具说明（0.6.1，25 个工具）

协议为本机 stdio。工具正常返回 JSON 文本；业务失败时 `isError=true`，正文为 `{ "code": "…", "message": "…" }`。MCP 参数校验失败由 SDK 返回协议错误。

## 读取工具

| 工具 | 主要参数 | 返回用途 |
| --- | --- | --- |
| `netease_account_status` | 无 | 实际登录状态、账号资料和会员状态；不含凭据 |
| `netease_search` | `query`，可选 `artist`、`source=auto`、`refresh=false`、`limit=5`（1–10） | 同时查喜欢列表和公开曲库，返回 `{ candidates, sources }`，不会自动播放 |
| `netease_song_detail` | `songId` | 标题、歌手、专辑、时长与带时间戳歌词 |
| `netease_lyrics` | `songId` | `lyrics` 时间轴和 `unavailable` |
| `netease_playlists` | 无 | 当前账号歌单摘要、是否自建和是否还有更多 |
| `netease_playlist_tracks` | `playlistId`，`limit=20`，`offset=0` | 歌单歌曲分页，包含总数与 `more` |
| `netease_liked_songs` | `limit=20`，`offset=0` | 按账号所属与特殊类型定位喜欢歌单，再读取歌曲 |
| `netease_status` | 无 | 当前歌曲、实际播放位置、状态和精简队列 |
| `netease_queue` | 无 | 队列名、总数、当前下标和当前起至多五个歌曲 ID |

分页 `limit` 为 1–100，`offset` 为 0–10000。歌曲/歌单 ID 为正整数形式的字符串。歌曲详情可见不等于有权播放。歌单摘要每次最多 1000 个，`more=true` 表示未穷尽账号全部歌单。

### 查找指定歌曲

`query` 传歌名或关键词（1–100 字符），已知歌手单独传 `artist`（1–100 字符）。`source` 可为 `auto`（默认，同时查两个来源）、`liked`（只查收藏）或 `catalog`（只查公开曲库）。例如：

```json
{"name":"netease_search","arguments":{"query":"晴天","artist":"周杰伦","source":"auto"}}
```

**0.6.0 返回格式变化**：原来是歌曲数组，现在为 `{ candidates, sources }`。读取结果的客户端须改用 `result.candidates`。每个候选保留歌曲信息，增加 `sources: ["liked", "catalog"]`（实际来源的子集）、`titleMatch: "exact" / "partial"`、`artistMatch: "matched" / "unknown" / "not_requested"`。同 ID 合并来源，不同 ID 的版本保留。排序先精确歌名、再已知歌手、再收藏来源；已知歌手与指定歌手不符的候选会被排除，歌手缺失的收藏仍保留并明确标为 unknown，不假定为原唱。`playable` 始终是 unknown，播放权限由播放工具验证。

`sources` 按所查来源返回 `{ status: "ok" }` 或 `{ status: "error", code, message }`。一个来源失败时仍返回另一个来源的候选和脱敏错误；所有所查来源都失败才返回工具错误。空候选且有来源失败不能据此断言不存在歌曲或没有播放权限。明确要收藏版本时使用 `source: liked`，不需要调用者分页读取全部收藏。

收藏搜索按当前账号与特殊类型定位自己的喜欢歌单，只读取一次歌曲 ID 快照，每批 100 首、最多 4 个并发详情请求，最多处理 10000 首；超出上限返回 `SEARCH_TOO_LARGE`，不静默截断。完整元数据仅缓存在当前进程内 60 秒，账号或 ID 快照变化即失效；`refresh: true` 强制刷新，失败扫描不缓存。每轮请求前检查 30 秒扫描预算，单轮耗时仍受底层接口超时限制；超时作为来源错误返回，不伪装成已搜索完成。

## 控制工具

除 `netease_launch` 外，以下工具都要求 `requestId`（1–128 字符），推荐每次用户操作一个全局唯一 UUID。播放控制与账号收藏分别去重；各通道内同 ID 换操作或参数会返回 `REQUEST_CONFLICT`。完成历史各最多 128 条、有效期 10 分钟，不是永久操作账本。

| 工具 | 其他参数 | 行为 |
| --- | --- | --- |
| `netease_launch` | 无 | 准备独立播放器，不播放、不打开网易云客户端 |
| `netease_play` | `songId`，可选 `level`、`mode` | 替换队列为单曲，获取授权音源并验证真实播放 |
| `netease_pause` | 无 | 暂停并保留位置；重复调用保持暂停；可取消正在准备的播放 |
| `netease_resume` | 无 | 继续当前歌；音源过期时重取并恢复位置 |
| `netease_stop` | 无 | 取消未完成播放、卸载音频、位置归零；保留队列 |
| `netease_seek` | `seconds` | 定位到 0 至曲目时长之前；暂停时定位仍保持暂停 |
| `netease_volume` | `volume`（0–100 整数） | 设置 mpv 实例音量并保存，重启或升级后恢复；不改系统主音量 |
| `netease_next` | 无 | 队列下一首，越界返回 `QUEUE_BOUNDARY` |
| `netease_previous` | 无 | 队列上一首，越界返回 `QUEUE_BOUNDARY` |
| `netease_play_liked` | 无 | 构建喜欢列表队列并从第一首开始 |
| `netease_play_playlist` | `playlistId` | 构建指定歌单队列并从第一首开始 |
| `netease_play_daily` | 无 | 验证登录后，获取今天的每日推荐并播放 |
| `netease_play_heart_mode` | 可选 `seedSongId`、`playlistId`、`count=30` | 网易云心动模式，默认以喜欢歌单第一首为种子，自动补充下一批推荐 |
| `netease_play_hot_chart` | 无 | 从上游榜单列表唯一识别热歌榜并播放，不用其他榜单代替 |
| `netease_like` | 必填 `liked` 布尔值，可选 `songId` | true 喜欢／false 取消；省略 songId 使用当前歌曲；读前置状态并在必要的写入后验证 |
| `netease_play_mode` | 必填 `mode`：`sequence` / `shuffle` / `repeat_one` | 切换顺序、随机或单曲循环，保留当前歌曲、进度和暂停状态 |

所有 `netease_play*` 播放入口（指定歌曲、喜欢列表、指定歌单、每日推荐、心动模式和热歌榜）均接受可选 `mode`。例如随机播放喜欢列表可以一次调用完成，无需先开始顺序播放。`netease_play_mode` 本身要求显式 mode；省略 mode 的播放操作沿用本进程当前模式。默认顺序；停止或换列表不重置模式，服务重启后恢复默认。

音量在播放器确认设置后保存至 `stateDir/playback-preferences.json`，包含整数 `volume`，也支持 0% 静音。文件不在版本运行目录中，因此升级仍读取同一份设置。启动时保存值优先于 `config.local.json` 的初始音量；没有偏好文件时才使用配置值或默认 30%。临时文件写入后通过原子替换提交；播放、切歌、暂停、停止和退出不会自行覆盖保存值。`PREFERENCES_READ_FAILED` 表示保存文件损坏或不可读，需修复该文件，服务不会静默重置；`VOLUME_SAVE_FAILED` 表示当前播放器已调整，但未能保存，重启可能恢复旧值。

队列最多 10000 首，空列表或超过上限会报错。不含队列编辑或持久化；播放到无权播放的歌曲会明确报错，不自动找替代版本。暂停准备中的新歌后，继续会重新解析该歌；停止后继续从当前歌开头播放。

- `sequence`：按原列表顺序播放，到末尾结束
- `shuffle`：新列表从全列表随机选择第一首，之后按打乱的队列顺序播放，队列中的每项一次，到末尾结束；原列表若有重复歌曲 ID，仍按独立队列项处理。播放中切换随机时保留当前歌曲，将其余队列项打乱；手动上一首/下一首沿本轮实际顺序前后移动。返回顺序时保留当前歌曲，从其在原列表的位置继续
- `repeat_one`：自然曲尾从零重播当前歌曲，并重新解析授权音源；不会对播放错误无限重播。手动上一首/下一首仍按原列表切歌。暂停或停止后不会因旧曲尾事件自行播放

心动模式基于真实 `playmode_intelligence_list` 接口。指定种子须属于所选歌单，空歌单返回 `NO_HEART_SEED`；count 是 1–100 的请求提示，实际返回数量由上游决定。批次结束或末尾“下一首”会由程序自动取下一批，不经模型。内存最多保留 10000 首的队列窗口。普通播放、其他列表和 stop 会退出自动补充；暂停保留模式，补充失败明确报错，不循环请求。

收藏调用 `netease_like` 时必须有明确用户意图。目标已满足时 `changed=false` 且不写入；写入后返回 `verified=true` 才能确认完成。底层写接口不自动超时重试，超时通过读取实际状态判断结果；仍无法确认返回 `MUTATION_UNCERTAIN`，不要盲目重发。不能将 true/false 变成“切换”命令。

## 状态语义

- `phase`：`idle / starting / playing / paused / stopped / ended / error`
- `position`、`duration`：秒；`volume`：播放器音量；`songId`：当前歌曲
- `playing`：当前控制状态为播放且引擎未暂停、空闲或缓冲
- `verified`：该流曾通过音频设备就绪及实际推进检查；调用者应同时检查 `playing`，不能只看历史验证标记
- `buffering`：播放器等待网络缓存；`lastError`：脱敏后的错误，不含底层请求内容
- `queue.index`：从 0 开始；`queue.items` 只是当前起的精简预览，不是全部列表
- `queue.mode`：`sequence` 或 `heart`，表示普通队列或自动补充的心动推荐队列；它与播放顺序独立
- `queue.playbackMode`：`sequence`、`shuffle` 或 `repeat_one`；随机模式的 index 和 items 按打乱后的顺序预览。收藏工具的 verified 指账号状态读回确认，不是音频播放状态

自然曲尾按当前模式播放下一首或重复当前歌曲，普通队列耗尽则变为 `ended`。心动模式保留自动补充，随机时播完当前打乱批次再补充；单曲循环时不自动取下一批，直到手动下一首越过当前批次末尾或关闭循环。到期源在暂停恢复时重新解析；播放中只有接近到期的源错误会自动尝试刷新一次，普通网络失败不做无限重试。停止与服务退出会释放本服务拥有的播放器，不操作用户另开的网易云或其他音频程序。

## 调用例子

```json
{"name":"netease_play","arguments":{"songId":"316157","requestId":"user-operation-unique-id"}}
```

```json
{"name":"netease_seek","arguments":{"seconds":42,"requestId":"another-unique-id"}}
```

当前没有“返回音频 URL”工具。小车若要接收 PCM/Opus/MP3，应在受控的桥接数据层接入音源，不把签名地址绕道发给模型或永久写进固件。
