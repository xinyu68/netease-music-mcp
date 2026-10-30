import { MusicError } from './errors.mjs';
export function validateMediaUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new MusicError('SOURCE_UNAVAILABLE');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    !/(^|\.)(music\.126\.net|music\.163\.com)$/.test(url.hostname)
  )
    throw new MusicError('SOURCE_UNAVAILABLE');
  url.protocol = 'https:';
  return url.href;
}
export function parseSource(body, id, now = Date.now()) {
  if (Number(body?.code) !== 200)
    throw new MusicError(Number(body?.code) === 301 ? 'LOGIN_REQUIRED' : 'API_ERROR');
  const item = body.data?.find?.((x) => String(x.id) === String(id));
  if (!item || Number(item.code) !== 200 || !item.url) throw new MusicError('NO_PLAY_PERMISSION');
  if (item.freeTrialInfo != null && item.freeTrialInfo !== 'null')
    throw new MusicError('PREVIEW_ONLY');
  if (item.isDrm === true || item.isDrm === 1) throw new MusicError('PROTECTED_MEDIA');
  if (
    !Number.isFinite(item.expi) ||
    item.expi <= 0 ||
    !Number.isFinite(item.time) ||
    item.time <= 0
  )
    throw new MusicError('INVALID_RESPONSE');
  return {
    songId: String(id),
    url: validateMediaUrl(item.url),
    expiresAt: now + item.expi * 1000,
    format: item.type,
    level: item.level,
    bitrate: item.br,
    duration: item.time / 1000,
  };
}
export class MediaResolver {
  constructor(account) {
    this.account = account;
  }
  async resolve(id, level = 'exhigh') {
    if (!/^[1-9]\d{0,15}$/.test(String(id)) || !['standard', 'exhigh'].includes(level))
      throw new MusicError('INVALID_ARGUMENT');
    const response = await this.account.raw('song_url_v1', { id: String(id), level });
    return parseSource(response.body || response, id);
  }
}
