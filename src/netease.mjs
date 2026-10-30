import { parseLrc } from './lyrics.mjs';

// Public, undocumented read-only endpoints. No login, audio URL, or playback control.
export class NeteaseCatalog {
  constructor({ fetchImpl = fetch, timeoutMs = 8000, maxBytes = 1024 * 1024 } = {}) {
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
  }

  async request(path, params) {
    const url = new URL(path, 'https://music.163.com');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const response = await this.fetch(url, {
      headers: {
        Referer: 'https://music.163.com/',
        'User-Agent': 'Mozilla/5.0 LocalNetEaseMusicMCP/0.2',
      },
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`NetEase HTTP ${response.status}`);
    if (!response.body) throw new Error('NetEase empty response');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > this.maxBytes) throw new Error('NetEase response too large');
      chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (data.code !== 200) throw new Error(`NetEase API code ${data.code ?? 'missing'}`);
    return data;
  }

  async search(query, limit = 5) {
    if (typeof query !== 'string' || !query.trim() || query.length > 120)
      throw new Error('Query must contain 1–120 characters');
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('Limit must be 1–10');
    const data = await this.request('/api/search/get/web', {
      s: query.trim(),
      type: 1,
      offset: 0,
      limit,
    });
    const songs = data.result?.songs;
    if (songs != null && !Array.isArray(songs)) throw new Error('Unexpected NetEase songs schema');
    return (songs ?? []).slice(0, limit).map(normalizeTrack);
  }

  async track(id) {
    assertId(id);
    const [detail, lyric] = await Promise.all([
      this.request('/api/song/detail/', { id, ids: JSON.stringify([id]) }),
      this.request('/api/song/lyric', { id, lv: -1, tv: -1 }),
    ]);
    const song = detail.songs?.find((item) => String(item.id) === String(id));
    if (!song) throw new Error('Requested track not found');
    return {
      ...normalizeTrack(song),
      lyrics: parseLrc(lyric.lrc?.lyric, lyric.tlyric?.lyric),
      lyricUnavailable: !lyric.lrc?.lyric,
    };
  }
}

function assertId(id) {
  if (!/^\d{1,16}$/.test(String(id))) throw new Error('Invalid track ID');
}

function normalizeTrack(song) {
  assertId(song.id);
  if (typeof song.name !== 'string') throw new Error('Missing song name');
  return {
    id: String(song.id),
    title: song.name,
    artists: (song.artists ?? song.ar ?? [])
      .map((a) => a.name)
      .filter((x) => typeof x === 'string'),
    album: (song.album ?? song.al)?.name ?? '',
    durationMs: Number(song.duration ?? song.dt ?? 0),
    playable: 'unknown',
  };
}

const norm = (s) =>
  String(s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');

// Never silently choose the first search result or claim that metadata implies playback rights.
export function chooseTrack(candidates, { title, artist, durationMs } = {}) {
  if (!title) return { status: 'needs_selection', candidates };
  const matches = candidates.filter(
    (song) =>
      norm(song.title) === norm(title) &&
      (!artist || song.artists.some((name) => norm(name) === norm(artist))) &&
      (durationMs == null || Math.abs(song.durationMs - durationMs) <= 3000)
  );
  return matches.length === 1
    ? { status: 'matched', track: matches[0] }
    : {
        status: matches.length ? 'ambiguous' : 'not_found',
        candidates: matches.length ? matches : candidates,
      };
}
