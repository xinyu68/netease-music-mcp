import { MusicError, safeError } from './errors.mjs';

const normalize = (value) =>
  String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');

export class MusicSearch {
  constructor({ account, catalog }) {
    this.account = account;
    this.catalog = catalog;
  }

  async search(query, limit = 5, { artist, source = 'auto', refresh = false } = {}) {
    if (
      typeof query !== 'string' ||
      !query.trim() ||
      query.length > 100 ||
      !normalize(query) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 10 ||
      (artist !== undefined &&
        (typeof artist !== 'string' || !normalize(artist) || artist.length > 100)) ||
      !['auto', 'liked', 'catalog'].includes(source) ||
      typeof refresh !== 'boolean'
    )
      throw new MusicError('INVALID_ARGUMENT');
    const sources = {};
    const candidates = new Map();
    const selected = source === 'auto' ? ['liked', 'catalog'] : [source];
    const results = await Promise.allSettled(
      selected.map(async (name) =>
        name === 'liked'
          ? this.account.likedTracks({ refresh })
          : this.catalog.search([artist?.trim(), query.trim()].filter(Boolean).join(' '), 10)
      )
    );
    for (let index = 0; index < selected.length; index++) {
      const name = selected[index];
      const result = results[index];
      if (result.status === 'rejected') {
        sources[name] = { status: 'error', ...safeError(result.reason) };
        continue;
      }
      sources[name] = { status: 'ok' };
      for (const track of result.value) {
        const existing = candidates.get(track.id);
        candidates.set(track.id, {
          ...(existing ?? track),
          title: existing?.title || track.title,
          artists: existing?.artists?.length ? existing.artists : track.artists,
          album: existing?.album || track.album,
          sources: [...(existing?.sources ?? []), name],
          playable: 'unknown',
        });
      }
    }
    if (results.every((result) => result.status === 'rejected')) throw results.at(-1).reason;
    const title = normalize(query);
    const tokens = query.trim().split(/\s+/).map(normalize).filter(Boolean);
    const ranked = [];
    for (const candidate of candidates.values()) {
      const songTitle = normalize(candidate.title);
      const artists = (candidate.artists ?? []).filter((name) => typeof name === 'string');
      const artistMatch = !artist
        ? 'not_requested'
        : !artists.length
          ? 'unknown'
          : artists.some((name) => normalize(name) === normalize(artist))
            ? 'matched'
            : 'mismatched';
      if (!songTitle || artistMatch === 'mismatched') continue;
      const exact = songTitle === title;
      const combined = normalize([candidate.title, ...artists].join(' '));
      if (!exact && !tokens.every((token) => combined.includes(token))) continue;
      ranked.push({ ...candidate, titleMatch: exact ? 'exact' : 'partial', artistMatch });
    }
    ranked.sort(
      (a, b) =>
        Number(b.titleMatch === 'exact') - Number(a.titleMatch === 'exact') ||
        Number(a.artistMatch === 'unknown') - Number(b.artistMatch === 'unknown') ||
        Number(b.sources.includes('liked')) - Number(a.sources.includes('liked'))
    );
    return { candidates: ranked.slice(0, limit), sources };
  }
}
