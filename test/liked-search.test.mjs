import test from 'node:test';
import assert from 'node:assert/strict';
import { Account } from '../src/account.mjs';
import { MusicError } from '../src/errors.mjs';
import { setImmediate } from 'node:timers/promises';

function fixture(count = 405) {
  const a = new Account();
  const state = {
    userId: '99',
    ids: Array.from({ length: count }, (_, i) => String(i + 1)),
    calls: [],
  };
  a.playlists = async () => ({
    account: { userId: state.userId },
    playlists: [
      { id: '5', owned: false, specialType: 5 },
      { id: '10', owned: true, specialType: 5 },
    ],
  });
  a.playlistIds = async (id) => {
    assert.equal(id, '10');
    return { ids: state.ids };
  };
  a.request = async (route, params) => {
    assert.equal(route, '/api/v3/song/detail');
    const ids = JSON.parse(params.c).map((s) => s.id);
    assert.ok(ids.length <= 100);
    state.calls.push(ids);
    return {
      songs: ids.toReversed().map((id) => ({
        id,
        name: id === '405' ? '晴天' : '其他歌',
        ar: [{ name: null }, null],
        dt: 269000,
      })),
    };
  };
  return { a, state };
}

test('loads one favorite snapshot in bounded batches and finds songs after the first 400 tracks', async () => {
  const { a, state } = fixture();
  const songs = await a.likedTracks();
  assert.equal(state.calls.length, 5);
  assert.deepEqual(
    songs.map((s) => s.id),
    state.ids
  );
  assert.equal(songs.at(-1).title, '晴天');
  assert.deepEqual(songs.at(-1).artists, []);
  assert.equal(songs.at(-1).playable, 'unknown');
});

test('reuses and coalesces metadata reads but refreshes changed playlists, explicit refreshes and changed accounts', async () => {
  const { a, state } = fixture(1);
  await Promise.all([a.likedTracks(), a.likedTracks()]);
  await a.likedTracks();
  assert.equal(state.calls.length, 1);
  await a.likedTracks({ refresh: true });
  assert.equal(state.calls.length, 2);
  state.ids = ['2'];
  assert.equal((await a.likedTracks())[0].id, '2');
  assert.equal(state.calls.length, 3);
  state.userId = '100';
  await a.likedTracks();
  assert.equal(state.calls.length, 4);
  a.likedSearchCache.createdAt -= 60001;
  await a.likedTracks();
  assert.equal(state.calls.length, 5);
  a.close();
  assert.equal(a.likedSearchCache, null);
  await assert.rejects(a.likedTracks(), { code: 'CANCELLED' });
});

test('does not cache incomplete scans or mistake missing song metadata for a playable track', async () => {
  const { a } = fixture(1);
  a.request = async () => {
    throw new MusicError('API_TIMEOUT');
  };
  await assert.rejects(a.likedTracks(), { code: 'API_TIMEOUT' });
  assert.equal(a.likedSearchCache, null);
  a.request = async () => ({ songs: [] });
  const songs = await a.likedTracks();
  assert.equal(songs[0].title, '');
  assert.equal(songs[0].playable, 'unknown');
  a.request = async () => ({});
  await assert.rejects(a.likedTracks({ refresh: true }), { code: 'INVALID_RESPONSE' });
});

test('empty, oversized and malformed playlists have explicit outcomes without reading arbitrary song IDs', async () => {
  const { a, state } = fixture(0);
  assert.deepEqual(await a.likedTracks(), []);
  assert.equal(state.calls.length, 0);
  state.ids = Array(10001).fill('1');
  await assert.rejects(a.likedTracks(), { code: 'SEARCH_TOO_LARGE' });
  state.ids = ['../private'];
  await assert.rejects(a.likedTracks(), { code: 'INVALID_RESPONSE' });
  assert.equal(state.calls.length, 0);
});

test('limits in-flight details to four and discards a partially loaded snapshot when a later batch fails', async () => {
  const { a, state } = fixture();
  const request = a.request;
  let active = 0,
    maximum = 0;
  a.request = async (...args) => {
    active++;
    maximum = Math.max(maximum, active);
    try {
      await setImmediate();
      return await request(...args);
    } finally {
      active--;
    }
  };
  await a.likedTracks();
  assert.equal(maximum, 4);
  assert.equal(active, 0);
  state.calls = [];
  a.request = async (route, params) => {
    if (JSON.parse(params.c)[0].id === '401') throw new MusicError('API_TIMEOUT');
    return request(route, params);
  };
  await assert.rejects(a.likedTracks({ refresh: true }), { code: 'API_TIMEOUT' });
  assert.equal(a.likedSearchCache, null);
  a.request = request;
  assert.equal((await a.likedTracks()).at(-1).id, '405');
  assert.equal(state.calls.length, 9);
});
