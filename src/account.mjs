import { loadConfig } from './config.mjs';
import { AuthStore } from './auth.mjs';
import { ApiClient } from './api-client.mjs';
import { MusicError } from './errors.mjs';
export { allowSession } from './auth.mjs';

export class Account {
  constructor({ apiClient, sessionProvider, authStore, worker } = {}) {
    this.api = apiClient;
    this.sessionProvider = sessionProvider;
    this.authStore = authStore;
    this.worker = worker;
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
    this.worker?.close();
  }
}
