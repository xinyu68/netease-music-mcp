import test from 'node:test';
import assert from 'node:assert/strict';
import { Account } from '../src/account.mjs';
import { MusicError } from '../src/errors.mjs';

function account(apiClient = {}) {
  const a = new Account({
    sessionProvider: async () => ({ cookieHeader: 'MUSIC_U=fixture' }),
    apiClient,
  });
  a.status = async () => ({ loggedIn: true, userId: '99' });
  return a;
}

test('daily recommendations support current and legacy bodies, preserve order and reject malformed IDs', async () => {
  for (const body of [
    { code: 200, data: { dailySongs: [{ id: 2 }, { id: 1 }, { id: 2 }] } },
    { code: 200, recommend: [{ id: 2 }, { id: 1 }] },
  ]) {
    const a = account({ recommend_songs: async () => ({ body }) });
    assert.deepEqual((await a.dailyIds()).ids, ['2', '1']);
  }
  const a = account({
    recommend_songs: async () => ({
      body: { code: 200, data: { dailySongs: [{ name: 'missing' }] } },
    }),
  });
  await assert.rejects(a.dailyIds(), (error) => error.code === 'INVALID_RESPONSE');
});

test('hot chart discovery cannot silently choose the first chart or an ambiguous namesake', async () => {
  const a = account({
    toplist: async () => ({
      body: {
        code: 200,
        list: [
          { id: 1, name: '飙升榜' },
          { id: 2, name: '热歌榜' },
        ],
      },
    }),
  });
  a.playlistIds = async (id) => {
    assert.equal(id, '2');
    return { ids: ['3'] };
  };
  assert.deepEqual(await a.hotChartIds(), { name: '热歌榜', ids: ['3'] });
  a.invoke = async () => ({
    list: [
      { id: 1, name: '热歌榜' },
      { id: 2, name: '云音乐热歌榜' },
    ],
  });
  await assert.rejects(a.hotChartIds(), (error) => error.code === 'HOT_CHART_UNAVAILABLE');
});

test('heart mode uses a favorite seed and preserves it when requesting the next batch', async () => {
  const a = account();
  const calls = [];
  a.favoritePlaylist = async () => ({ id: '10' });
  a.playlistIds = async () => ({ ids: ['1', '2'] });
  a.invoke = async (method, args) => {
    calls.push({ method, args });
    return { data: [{ songInfo: { id: 3 } }, { id: 4 }] };
  };
  const c = await a.heartModeIds();
  assert.equal(c.mode, 'heart');
  assert.deepEqual(c.ids, ['3', '4']);
  await c.refill('4');
  assert.deepEqual(calls[0].args, { id: '1', pid: '10', sid: '1', count: 30 });
  assert.deepEqual(calls[1].args, { id: '1', pid: '10', sid: '4', count: 30 });
  await assert.rejects(
    a.heartModeIds({ seedSongId: '9' }),
    (error) => error.code === 'INVALID_HEART_SEED'
  );
  a.invoke = async () => ({ data: [null] });
  await assert.rejects(a.heartModeIds(), (error) => error.code === 'INVALID_RESPONSE');
  a.playlistIds = async () => ({ ids: [] });
  await assert.rejects(a.heartModeIds(), (error) => error.code === 'NO_HEART_SEED');
});

test('liking a song already in the desired state does not write to the account', async () => {
  const a = account();
  a.isLiked = async () => true;
  a.invoke = async () => assert.fail('Unexpected account write');
  assert.deepEqual(await a.setLiked('1', true, 'same'), {
    songId: '1',
    liked: true,
    changed: false,
    verified: true,
  });
});

test('like and unlike pass explicit strings to the provider and verify the resulting account state', async () => {
  for (const liked of [false, true]) {
    const a = account();
    let reads = 0,
      writes = 0;
    a.isLiked = async () => (reads++ === 0 ? !liked : liked);
    a.invoke = async (method, params) => {
      writes++;
      assert.equal(method, 'like');
      assert.equal(params.like, String(liked));
    };
    const result = await a.setLiked('1', liked, 'write');
    assert.equal(result.liked, liked);
    assert.equal(result.verified, true);
    assert.equal(writes, 1);
  }
});

test('a timed-out favorite write is reconciled by a read without repeating the write', async () => {
  const a = account();
  let reads = 0,
    writes = 0;
  a.isLiked = async () => reads++ > 0;
  a.invoke = async () => {
    writes++;
    throw new MusicError('API_TIMEOUT');
  };
  assert.equal((await a.setLiked('1', true, 'write')).verified, true);
  assert.equal(writes, 1);
});

test('unconfirmed favorite state remains uncertain and request IDs deduplicate account writes', async () => {
  const a = account();
  let writes = 0;
  a.isLiked = async () => true;
  a.invoke = async () => {
    writes++;
    throw new MusicError('API_TIMEOUT');
  };
  const p = a.setLiked('1', false, 'same');
  const q = a.setLiked('1', false, 'same');
  await assert.rejects(p, (error) => error.code === 'MUTATION_UNCERTAIN');
  await assert.rejects(q);
  assert.equal(writes, 1);
  await assert.rejects(a.setLiked('1', true, 'same'), (error) => error.code === 'REQUEST_CONFLICT');
  a.close();
  await assert.rejects(a.setLiked('1', false, 'later'), (error) => error.code === 'CANCELLED');
});
