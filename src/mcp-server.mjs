import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MusicError, safeError } from './errors.mjs';
import { version } from './version.mjs';
import { MusicSearch } from './music-search.mjs';
export function createMcpServer(runtime) {
  const { account, player, catalog, engine } = runtime;
  const search = new MusicSearch({ account, catalog });
  const server = new McpServer(
    { name: 'netease-music', version },
    {
      instructions:
        '本机网易云音乐助手，使用账号正常权限播放，不依赖桌面网易云。点歌先用netease_search，query传歌名、artist单独传歌手；默认同时查喜欢列表和公开曲库，返回candidates与sources。收藏缺失歌手不代表原唱已匹配；来源失败不等于没有歌，某个ID无权限不代表收藏版本无权限；不猜ID、不用翻唱替代原唱。用户指定收藏歌曲时用source=liked，不手动分页翻收藏。支持喜欢列表、每日推荐、心动模式、热歌榜和喜欢/取消喜欢。播放入口可传mode=sequence/shuffle/repeat_one；只切换模式用netease_play_mode，保留当前歌曲和进度。明确目标后直接调用对应播放入口，同名版本不明确时询问。只有playing和verified都为true才能报告已播放。控制操作需唯一requestId；重试复用原ID。收藏必须传明确liked布尔值，仅按用户意图修改；状态不确定时不反复写。音源地址和凭据不写入回复或文件。无歌单编辑/会员解锁。',
    }
  );
  const songId = z.string().regex(/^[1-9]\d{0,15}$/),
    requestId = z.string().min(1).max(128),
    mode = z.enum(['sequence', 'shuffle', 'repeat_one']).optional(),
    page = {
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).max(10000).default(0),
    };
  function tool(name, description, inputSchema, action, readOnly = true) {
    server.registerTool(
      name,
      {
        description,
        inputSchema,
        annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: true },
      },
      async (args) => {
        try {
          return { content: [{ type: 'text', text: JSON.stringify(await action(args)) }] };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify(safeError(error)) }],
          };
        }
      }
    );
  }
  tool('netease_account_status', '验证网易云登录及会员状态，不返回凭据', {}, () =>
    account.status()
  );
  tool(
    'netease_search',
    '同时查找喜欢列表和公开曲库，返回 candidates 与各来源状态；query 只传歌名，已知歌手另传 artist，source=liked 只查收藏。缺失歌手不代表已匹配，不会自动播放',
    {
      query: z.string().trim().min(1).max(100),
      artist: z.string().trim().min(1).max(100).optional(),
      source: z.enum(['auto', 'liked', 'catalog']).default('auto'),
      refresh: z.boolean().default(false),
      limit: z.number().int().min(1).max(10).default(5),
    },
    (a) => search.search(a.query, a.limit, a)
  );
  tool('netease_song_detail', '读取歌曲信息和歌词，详情可见不代表具有播放权限', { songId }, (a) =>
    catalog.track(a.songId)
  );
  tool('netease_lyrics', '读取用于显示的带时间戳歌词；不是播放状态', { songId }, async (a) => {
    const t = await catalog.track(a.songId);
    return { songId: a.songId, lyrics: t.lyrics, unavailable: t.lyricUnavailable };
  });
  tool('netease_playlists', '读取当前账号的歌单摘要', {}, () => account.playlists());
  tool('netease_playlist_tracks', '分页读取歌单歌曲', { playlistId: songId, ...page }, (a) =>
    account.tracks(a.playlistId, a.limit, a.offset)
  );
  tool('netease_liked_songs', '分页读取我喜欢的音乐', page, (a) =>
    account.liked(a.limit, a.offset)
  );
  tool('netease_status', '读取独立播放器真实位置和状态，verified=false时不可报告已播放', {}, () =>
    player.status()
  );
  tool(
    'netease_launch',
    '准备独立播放引擎，不启动网易云桌面客户端',
    {},
    async () => {
      await engine.start();
      return { ready: true, backend: 'direct-mpv' };
    },
    false
  );
  tool(
    'netease_play',
    '直接取流播放明确歌曲ID并验证真实进度',
    { songId, requestId, level: z.enum(['standard', 'exhigh']).optional(), mode },
    (a) =>
      player.play(a.songId, a.requestId, {
        ...(a.level ? { level: a.level } : {}),
        ...(a.mode ? { mode: a.mode } : {}),
      }),
    false
  );
  tool(
    'netease_pause',
    '确保暂停，保留当前位置，重复暂停不会反向播放',
    { requestId },
    (a) => player.pause(a.requestId),
    false
  );
  tool(
    'netease_resume',
    '继续当前歌曲，必要时刷新已过期的音频地址',
    { requestId },
    (a) => player.resume(a.requestId),
    false
  );
  tool(
    'netease_stop',
    '立即停止并卸载音频、归零进度，保留队列；会取消尚未完成的点歌',
    { requestId },
    (a) => player.stop(a.requestId),
    false
  );
  tool(
    'netease_seek',
    '定位到歌曲中的秒数；暂停状态定位后仍保持暂停',
    { seconds: z.number().min(0), requestId },
    (a) => player.seek(a.seconds, a.requestId),
    false
  );
  tool(
    'netease_volume',
    '设置此播放器音量0到100，不改变系统主音量',
    { volume: z.number().int().min(0).max(100), requestId },
    (a) => player.volume(a.volume, a.requestId),
    false
  );
  tool('netease_queue', '读取当前队列摘要及当前位置之后至多五首ID', {}, () => player.queue());
  tool('netease_next', '播放队列下一首', { requestId }, (a) => player.move(1, a.requestId), false);
  tool(
    'netease_previous',
    '播放队列上一首',
    { requestId },
    (a) => player.move(-1, a.requestId),
    false
  );
  tool(
    'netease_play_liked',
    '建立我喜欢的音乐队列并开始播放',
    { requestId, mode },
    (a) => player.playCollection(() => account.likedIds(), a.requestId, 'liked', { mode: a.mode }),
    false
  );
  tool(
    'netease_play_playlist',
    '建立指定歌单队列并开始播放',
    { playlistId: songId, requestId, mode },
    (a) =>
      player.playCollection(
        () => account.playlistIds(a.playlistId),
        a.requestId,
        'playlist:' + a.playlistId,
        { mode: a.mode }
      ),
    false
  );
  tool(
    'netease_play_daily',
    '播放账号今天的每日推荐歌曲',
    { requestId, mode },
    (a) => player.playCollection(() => account.dailyIds(), a.requestId, 'daily', { mode: a.mode }),
    false
  );
  tool(
    'netease_play_heart_mode',
    '开启网易云心动模式；默认基于我喜欢的音乐，队列结束自动获取下一批推荐',
    {
      requestId,
      mode,
      seedSongId: songId.optional(),
      playlistId: songId.optional(),
      count: z.number().int().min(1).max(100).default(30),
    },
    (a) =>
      player.playCollection(
        () =>
          account.heartModeIds({
            seedSongId: a.seedSongId,
            playlistId: a.playlistId,
            count: a.count,
          }),
        a.requestId,
        JSON.stringify(['heart', a.seedSongId, a.playlistId, a.count]),
        { mode: a.mode }
      ),
    false
  );
  tool(
    'netease_play_hot_chart',
    '识别并播放网易云热歌榜，不替换为其他榜单',
    { requestId, mode },
    (a) =>
      player.playCollection(() => account.hotChartIds(), a.requestId, 'hot-chart', {
        mode: a.mode,
      }),
    false
  );
  tool(
    'netease_like',
    '按明确意图喜欢或取消喜欢歌曲；liked为true/false，省略songId时使用当前歌曲，写入后读回验证',
    { requestId, songId: songId.optional(), liked: z.boolean() },
    async (a) => {
      let id = a.songId;
      if (!id) {
        const state = await player.status();
        if (!state.songId || ['idle', 'starting', 'error'].includes(state.phase))
          throw new MusicError('NOTHING_TO_PLAY');
        id = state.songId;
      }
      return account.setLiked(id, a.liked, a.requestId);
    },
    false
  );
  tool(
    'netease_play_mode',
    '切换顺序、随机或单曲循环，保留当前歌曲、进度和暂停状态；随机队列每首一次，单曲循环不阻止手动切歌',
    { mode: z.enum(['sequence', 'shuffle', 'repeat_one']), requestId },
    (a) => player.setPlaybackMode(a.mode, a.requestId),
    false
  );
  return server;
}
