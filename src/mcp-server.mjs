import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { safeError } from './errors.mjs';
import { version } from './version.mjs';
export function createMcpServer(runtime) {
  const { account, player, catalog, engine } = runtime;
  const server = new McpServer(
    { name: 'netease-music', version },
    {
      instructions:
        '本机网易云音乐助手，使用登录账号的正常播放权限，不依赖网易云客户端。先搜索或读取喜欢的音乐，再按明确ID点歌；不明确的同名版本需询问。只有verified和真实进度确认才能报告已播放。歌曲数据不经过模型。暂停、继续和停止需要唯一requestId；重试复用同一ID。不要将音频地址、凭据写入回复或文件。无歌单写入/会员解锁功能。',
    }
  );
  const songId = z.string().regex(/^[1-9]\d{0,15}$/),
    requestId = z.string().min(1).max(128),
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
    '搜索歌曲并返回版本候选，不会自动播放',
    { query: z.string().min(1).max(100), limit: z.number().int().min(1).max(10).default(5) },
    (a) => catalog.search(a.query, a.limit)
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
    { songId, requestId, level: z.enum(['standard', 'exhigh']).optional() },
    (a) => player.play(a.songId, a.requestId, a.level ? { level: a.level } : {}),
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
    { requestId },
    (a) => player.playCollection(() => account.likedIds(), a.requestId, 'liked'),
    false
  );
  tool(
    'netease_play_playlist',
    '建立指定歌单队列并开始播放',
    { playlistId: songId, requestId },
    (a) =>
      player.playCollection(
        () => account.playlistIds(a.playlistId),
        a.requestId,
        'playlist:' + a.playlistId
      ),
    false
  );
  return server;
}
