import { loadConfig } from './config.mjs';
import { AuthStore } from './auth.mjs';
import { ApiClient } from './api-client.mjs';
import { MusicError } from './errors.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { Mutations } from './async.mjs';
export { allowSession } from './auth.mjs';

export class Account {
  constructor({ apiClient, sessionProvider, authStore, worker } = {}) {
    this.api = apiClient;
    this.sessionProvider = sessionProvider;
    this.authStore = authStore;
    this.worker = worker;
    this.writes = new Mutations();
    this.closed = false;
  }
  async session() {
    if (this.sessionProvider) return this.sessionProvider();
    this.authStore ??= new AuthStore(await loadConfig());
    return this.authStore.session();
  }

  async request(apiPath, params = {}) {
    if (
      !/^\/api\/(w\/nuser\/account\/get|user\/playlist|v6\/playlist\/detail|v3\/song\/detail)$/.test(
        apiPath
      )
    )
      throw new Error('Account endpoint not allowlisted');
    const session = await this.session();
    if (!this.api) {
      this.worker ??= new ApiClient((await loadConfig()).api);
      this.api = this.worker.proxy();
    }
    const operation = {
      '/api/w/nuser/account/get': ['login_status', {}],
      '/api/user/playlist': ['user_playlist', params],
      '/api/v6/playlist/detail': ['playlist_detail', params],
      '/api/v3/song/detail': [
        'song_detail',
        {
          ids: JSON.parse(params.c || '[]')
            .map((x) => x.id)
            .join(','),
        },
      ],
    }[apiPath];
    let response;
    try {
      response = await this.api[operation[0]]({
        ...operation[1],
        cookie: session.cookieHeader,
        timestamp: Date.now(),
      });
    } catch (error) {
      if (Number(error?.body?.code) === 301) {
        this.authStore?.clear();
        throw new Error('LOGIN_REQUIRED: Saved session expired');
      }
      if (error instanceof MusicError) throw error;
      throw new Error(`NETEASE_REQUEST_FAILED_${Number(error?.body?.code) || 'UNKNOWN'}`);
    }
    const result = response.body?.data || response.body || response;
    if (Number(result.code) !== 200) {
      if (Number(result.code) === 301) {
        this.authStore?.clear();
        throw new Error('LOGIN_REQUIRED: Saved session expired');
      }
      throw new Error(`NETEASE_BUSINESS_${result.code ?? 'UNKNOWN'}`);
    }
    return result;
  }
  async status() {
    const result = await this.request('/api/w/nuser/account/get');
    const id = result.profile?.userId || result.account?.id;
    if (!id) throw new Error('LOGIN_REQUIRED: Account verification failed');
    return {
      loggedIn: true,
      userId: String(id),
      nickname: result.profile?.nickname || '',
      isVip: Number(result.account?.vipType) > 0,
      vipType: Number(result.account?.vipType) || 0,
    };
  }
  async playlists() {
    const account = await this.status();
    const result = await this.request('/api/user/playlist', {
      uid: account.userId,
      limit: 1000,
      offset: 0,
      includeVideo: true,
    });
    if (!Array.isArray(result.playlist)) throw new Error('Invalid playlist schema');
    return {
      account,
      more: result.more === true,
      playlists: result.playlist.map((p) => ({
        id: String(p.id),
        name: p.name,
        trackCount: p.trackCount,
        specialType: p.specialType,
        owned: String(p.userId) === account.userId,
      })),
    };
  }
  async tracks(id, limit = 20, offset = 0) {
    if (
      !/^[1-9]\d{0,15}$/.test(String(id)) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 10000
    )
      throw new Error('Invalid playlist page');
    const result = await this.request('/api/v6/playlist/detail', {
      id: String(id),
      n: 100000,
      s: 0,
    });
    if (!result.playlist || !Array.isArray(result.playlist.trackIds))
      throw new Error('Playlist contents unavailable');
    const ids = result.playlist.trackIds.slice(offset, offset + limit).map((x) => x.id);
    let songs = [];
    if (ids.length)
      songs =
        (
          await this.request('/api/v3/song/detail', {
            c: JSON.stringify(ids.map((id) => ({ id }))),
          })
        ).songs || [];
    const byId = new Map(songs.map((s) => [String(s.id), s]));
    return {
      playlistId: String(id),
      name: result.playlist.name,
      total: result.playlist.trackIds.length,
      offset,
      more: offset + ids.length < result.playlist.trackIds.length,
      songs: ids.map((id) => {
        const s = byId.get(String(id));
        return {
          id: String(id),
          title: s?.name || '',
          artists: (s?.ar || []).map((a) => a.name),
          album: s?.al?.name || '',
          durationMs: s?.dt || 0,
          fee: s?.fee ?? null,
          available: Boolean(s),
        };
      }),
    };
  }
  async liked(limit = 20, offset = 0) {
    const all = await this.playlists();
    const favorites = all.playlists.filter((p) => p.owned && p.specialType === 5);
    if (favorites.length !== 1) throw new Error('Liked playlist could not be identified uniquely');
    return this.tracks(favorites[0].id, limit, offset);
  }

  async likedTracks({ refresh = false } = {}) {
    if (this.closed) throw new MusicError('CANCELLED');
    const all = await this.playlists();
    const favorites = all.playlists.filter((p) => p.owned && p.specialType === 5);
    if (favorites.length !== 1) throw new MusicError('INVALID_RESPONSE');
    const playlist = await this.playlistIds(favorites[0].id);
    if (playlist.ids.length > 10000) throw new MusicError('SEARCH_TOO_LARGE');
    if (playlist.ids.some((id) => !/^[1-9]\d{0,15}$/.test(id)))
      throw new MusicError('INVALID_RESPONSE');
    const key = JSON.stringify([all.account.userId, favorites[0].id, playlist.ids]);
    const cached = this.likedSearchCache;
    if (!refresh && cached?.key === key && Date.now() - cached.createdAt < 60000)
      return cached.promise;
    const entry = { key, createdAt: Date.now() };
    entry.promise = this.loadLikedTracks(playlist.ids);
    this.likedSearchCache = entry;
    try {
      return await entry.promise;
    } catch (error) {
      if (this.likedSearchCache === entry) this.likedSearchCache = null;
      throw error;
    }
  }

  async loadLikedTracks(ids) {
    const tracks = [];
    const deadline = Date.now() + 30000;
    // One playlist snapshot, batches of 100, at most four detail requests in flight.
    for (let start = 0; start < ids.length; start += 400) {
      if (this.closed) throw new MusicError('CANCELLED');
      if (Date.now() >= deadline) throw new MusicError('API_TIMEOUT');
      const batches = [];
      for (let offset = start; offset < Math.min(start + 400, ids.length); offset += 100) {
        const page = ids.slice(offset, offset + 100);
        batches.push(
          this.request('/api/v3/song/detail', {
            c: JSON.stringify(page.map((id) => ({ id }))),
          }).then((result) => {
            if (!Array.isArray(result.songs)) throw new MusicError('INVALID_RESPONSE');
            const byId = new Map(result.songs.filter(Boolean).map((s) => [String(s.id), s]));
            return page.map((id) => {
              const song = byId.get(id);
              return {
                id,
                title: typeof song?.name === 'string' ? song.name : '',
                artists: (song?.ar ?? song?.artists ?? [])
                  .map((artist) => artist?.name)
                  .filter((name) => typeof name === 'string' && name.trim()),
                album: song?.al?.name ?? song?.album?.name ?? '',
                durationMs: Number(song?.dt ?? song?.duration ?? 0),
                playable: 'unknown',
              };
            });
          })
        );
      }
      tracks.push(...(await Promise.all(batches)).flat());
    }
    if (this.closed) throw new MusicError('CANCELLED');
    return tracks;
  }
  async raw(method, params) {
    if (!['song_url_v1'].includes(method)) throw new Error('Endpoint not allowlisted');
    if (!this.api) {
      this.worker ??= new ApiClient((await loadConfig()).api);
      this.api = this.worker.proxy();
    }
    const session = await this.session();
    return this.api[method]({
      ...params,
      cookie: session.cookieHeader,
      unblock: 'false',
      crypto: 'eapi',
    });
  }
  async playlistIds(id) {
    if (!/^[1-9]\d{0,15}$/.test(String(id))) throw new Error('Invalid playlist ID');
    const result = await this.request('/api/v6/playlist/detail', {
      id: String(id),
      n: 100000,
      s: 0,
    });
    if (!result.playlist || !Array.isArray(result.playlist.trackIds))
      throw new Error('Playlist contents unavailable');
    return { name: result.playlist.name, ids: result.playlist.trackIds.map((x) => String(x.id)) };
  }
  async likedIds() {
    const all = await this.playlists();
    const p = all.playlists.filter((x) => x.owned && x.specialType === 5);
    if (p.length !== 1) throw new Error('Liked playlist could not be identified uniquely');
    return this.playlistIds(p[0].id);
  }
  close() {
    this.closed = true;
    this.likedSearchCache = null;
    this.worker?.close();
  }

  async invoke(method, params = {}) {
    if (
      !['recommend_songs', 'playmode_intelligence_list', 'toplist', 'likelist', 'like'].includes(
        method
      )
    )
      throw new MusicError('INVALID_ARGUMENT');
    const session = await this.session();
    if (!this.api) {
      this.worker ??= new ApiClient((await loadConfig()).api);
      this.api = this.worker.proxy();
    }
    const response = await this.api[method]({
      ...params,
      cookie: session.cookieHeader,
      timestamp: Date.now(),
    });
    const body = response.body || response;
    if (Number(body.code) === 301) {
      this.authStore?.clear();
      throw new MusicError('LOGIN_REQUIRED');
    }
    if (Number(body.code) !== 200) throw new MusicError('API_ERROR');
    return body;
  }

  collectionIds(items, getId = (item) => item?.id) {
    if (!Array.isArray(items)) throw new MusicError('INVALID_RESPONSE');
    const ids = [...new Set(items.map(getId).map((id) => String(id)))];
    if (ids.some((id) => !/^[1-9]\d{0,15}$/.test(id))) throw new MusicError('INVALID_RESPONSE');
    if (!ids.length) throw new MusicError('NOTHING_TO_PLAY');
    return ids;
  }

  async favoritePlaylist() {
    const all = await this.playlists();
    const matches = all.playlists.filter((p) => p.owned && p.specialType === 5);
    if (matches.length !== 1) throw new MusicError('INVALID_RESPONSE');
    return matches[0];
  }

  async dailyIds() {
    await this.status();
    const body = await this.invoke('recommend_songs');
    return { name: '每日推荐', ids: this.collectionIds(body.data?.dailySongs ?? body.recommend) };
  }

  async hotChartIds() {
    await this.status();
    const body = await this.invoke('toplist');
    if (!Array.isArray(body.list)) throw new MusicError('INVALID_RESPONSE');
    const matches = body.list.filter((item) =>
      ['热歌榜', '云音乐热歌榜', '网易云热歌榜'].includes(item.name)
    );
    if (matches.length !== 1) throw new MusicError('HOT_CHART_UNAVAILABLE');
    const collection = await this.playlistIds(String(matches[0].id));
    return { ...collection, name: '热歌榜' };
  }

  async intelligencePage(seedSongId, playlistId, startSongId, count) {
    const body = await this.invoke('playmode_intelligence_list', {
      id: seedSongId,
      pid: playlistId,
      sid: startSongId,
      count,
    });
    return {
      name: '心动模式',
      ids: this.collectionIds(body.data, (item) => item?.songInfo?.id ?? item?.id),
    };
  }

  async heartModeIds({ seedSongId, playlistId, count = 30 } = {}) {
    if (!Number.isInteger(count) || count < 1 || count > 100)
      throw new MusicError('INVALID_ARGUMENT');
    const id = playlistId ?? (await this.favoritePlaylist()).id;
    const base = await this.playlistIds(id);
    if (!base.ids.length) throw new MusicError('NO_HEART_SEED');
    const seed = seedSongId ?? base.ids[0];
    if (!base.ids.includes(String(seed))) throw new MusicError('INVALID_HEART_SEED');
    const first = await this.intelligencePage(String(seed), String(id), String(seed), count);
    return {
      ...first,
      mode: 'heart',
      refill: (lastSongId) => this.intelligencePage(String(seed), String(id), lastSongId, count),
    };
  }

  async isLiked(songId) {
    const account = await this.status();
    const body = await this.invoke('likelist', { uid: account.userId });
    if (!Array.isArray(body.ids)) throw new MusicError('INVALID_RESPONSE');
    return body.ids.some((id) => String(id) === String(songId));
  }

  setLiked(songId, liked, requestId) {
    return this.writes.submit(requestId, JSON.stringify(['like', String(songId), liked]), () => {
      if (this.closed) throw new MusicError('CANCELLED');
      return this.applyLiked(songId, liked);
    });
  }

  async applyLiked(songId, liked) {
    if (!/^[1-9]\d{0,15}$/.test(String(songId)) || typeof liked !== 'boolean')
      throw new MusicError('INVALID_ARGUMENT');
    const before = await this.isLiked(songId);
    if (before === liked) return { songId: String(songId), liked, changed: false, verified: true };
    let failure;
    // This provider expects a string; passing boolean false would be interpreted as true.
    try {
      await this.invoke('like', { id: String(songId), like: String(liked) });
    } catch (error) {
      failure = error;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await delay(250);
      try {
        if ((await this.isLiked(songId)) === liked)
          return { songId: String(songId), liked, changed: true, verified: true };
      } catch {
        break;
      }
    }
    if (failure && failure.code !== 'API_TIMEOUT') throw failure;
    throw new MusicError('MUTATION_UNCERTAIN');
  }
}
