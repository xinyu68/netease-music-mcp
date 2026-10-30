export class MusicError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'MusicError';
    this.code = code;
  }
}
export function safeError(error) {
  const text = String(error?.message || '');
  const code =
    error instanceof MusicError
      ? error.code
      : /^LOGIN_REQUIRED/.test(text)
        ? 'LOGIN_REQUIRED'
        : /NETEASE|NetEase/.test(text)
          ? 'API_ERROR'
          : /Invalid |must be|must contain|required/i.test(text)
            ? 'INVALID_ARGUMENT'
            : 'INTERNAL_ERROR';
  const messages = {
    LOGIN_REQUIRED: '请先完成网易云账号登录',
    NO_PLAY_PERMISSION: '当前账号未取得该曲目的完整播放权限',
    PREVIEW_ONLY: '该曲目只返回试听，未作为完整歌曲播放',
    PROTECTED_MEDIA: '该资源需要当前后端不支持的保护播放通道',
    API_TIMEOUT: '网易云接口超时，请重试',
    API_ERROR: '网易云接口请求失败',
    INVALID_RESPONSE: '网易云返回的数据不完整',
    SOURCE_UNAVAILABLE: '未取得可用的歌曲音频',
    MPV_NOT_FOUND: '未找到独立播放器，请运行 npm run setup:player',
    PLAYER_TIMEOUT: '播放器响应超时',
    PLAYER_DISCONNECTED: '播放器连接已断开',
    PLAYER_FAILED: '音频播放失败',
    PLAYER_COMMAND_FAILED: '播放器未接受操作',
    CANCELLED: '操作已被后续停止或暂停取消',
    REQUEST_CONFLICT: '同一请求标识不能用于不同操作',
    QUEUE_FULL: '待处理操作过多，请稍后再试',
    NOTHING_TO_PLAY: '当前没有可以继续播放的歌曲',
    INVALID_ARGUMENT: '参数无效',
    QUEUE_BOUNDARY: '已到播放队列边界',
    HOT_CHART_UNAVAILABLE: '未能唯一识别网易云热歌榜，请稍后重试',
    NO_HEART_SEED: '歌单中还没有歌曲，暂时无法开启心动模式',
    INVALID_HEART_SEED: '心动模式的起始歌曲需要属于所选歌单',
    MUTATION_UNCERTAIN: '暂未确认收藏状态，请先查询或稍后核实，不要连续重复提交',
  };
  return { code, message: messages[code] || '音乐操作失败，请查看本地诊断状态' };
}
