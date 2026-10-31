import test from 'node:test';
import assert from 'node:assert/strict';
import { MusicSearch } from '../src/music-search.mjs';
import { MusicError } from '../src/errors.mjs';

const track = (id, title = '晴天', artists = ['周杰伦']) => ({
  id,
  title,
  artists,
  album: '',
  durationMs: 269000,
});
function searcher(liked, catalog = []) {
  return new MusicSearch({
    account: { likedTracks: async () => liked },
    catalog: { search: async () => catalog },
  });
}

test('finds a favorite-only ID with missing artist without identifying it as the requested singer', async () => {
  const search = searcher(
    [track('2000000001', '晴天', [])],
    [track('2', '晴天 (原唱 周杰伦)', ['翻唱歌手']), track('3', '晴天和猫', ['花粥'])]
  );
  const result = await search.search('晴天', 5, { artist: '周杰伦' });
  assert.deepEqual(
    result.candidates.map((s) => s.id),
    ['2000000001']
  );
  assert.equal(result.candidates[0].artistMatch, 'unknown');
  assert.equal(result.candidates[0].titleMatch, 'exact');
  assert.equal(result.candidates[0].playable, 'unknown');
  assert.deepEqual(result.candidates[0].sources, ['liked']);
  assert.deepEqual(result.sources, { liked: { status: 'ok' }, catalog: { status: 'ok' } });
});

test('ranks exact title and verified artist metadata before partial names and unknown artists', async () => {
  const search = searcher(
    [track('1', '像晴天像雨天'), track('2', '晴天', []), track('3', '晴天 (Live)')],
    [track('4')]
  );
  assert.deepEqual(
    (await search.search('晴天', 4, { artist: '周杰伦' })).candidates.map((s) => s.id),
    ['4', '2', '1', '3']
  );
  assert.equal((await search.search('晴天', 1)).candidates.length, 1);
});

test('deduplicates identical IDs across sources, enriches missing metadata and keeps different versions', async () => {
  const result = await searcher([track('1', '晴天', [])], [track('1'), track('2')]).search(
    '晴天',
    5,
    { artist: '周杰伦' }
  );
  assert.deepEqual(
    result.candidates.map((s) => s.id),
    ['1', '2']
  );
  assert.deepEqual(result.candidates[0].sources, ['liked', 'catalog']);
  assert.deepEqual(result.candidates[0].artists, ['周杰伦']);
  assert.equal(result.candidates[0].artistMatch, 'matched');
});

test('supports legacy keyword queries and normalizes case, whitespace and punctuation', async () => {
  const search = searcher([track('1'), track('2', 'Ｆｏｏ — Bar', ['Some Singer'])]);
  assert.equal((await search.search('周杰伦 晴天')).candidates[0].id, '1');
  assert.equal(
    (await search.search('foo bar', 5, { artist: 'some singer' })).candidates[0].id,
    '2'
  );
});

test('source selection avoids unrelated network calls and forwards refresh and artist independently', async () => {
  const search = new MusicSearch({
    account: {
      likedTracks: async (options) => {
        assert.equal(options.refresh, true);
        return [track('1')];
      },
    },
    catalog: { search: async () => assert.fail('Unexpected catalog search') },
  });
  assert.equal(
    (await search.search('晴天', 5, { source: 'liked', refresh: true })).candidates[0].id,
    '1'
  );
  search.account.likedTracks = async () => assert.fail('Unexpected account search');
  search.catalog.search = async (query, limit) => {
    assert.equal(query, '周杰伦 晴天');
    assert.equal(limit, 10);
    return [track('2')];
  };
  assert.equal(
    (await search.search('晴天', 5, { source: 'catalog', artist: '周杰伦' })).candidates[0].id,
    '2'
  );
});

test('partial failures are explicit and sanitized; failed sources are never reported as empty successes', async () => {
  const search = searcher([], [track('1')]);
  search.account.likedTracks = async () => {
    throw new MusicError('LOGIN_REQUIRED');
  };
  const result = await search.search('晴天');
  assert.equal(result.candidates[0].id, '1');
  assert.equal(result.sources.liked.code, 'LOGIN_REQUIRED');
  search.account.likedTracks = async () => [track('2')];
  search.catalog.search = async () => {
    throw Error('MUSIC_U=private https://cdn.test/signed');
  };
  const partial = await search.search('晴天');
  assert.equal(partial.sources.catalog.code, 'INTERNAL_ERROR');
  assert.ok(!JSON.stringify(partial).includes('private'));
  assert.ok(!JSON.stringify(partial).includes('cdn.test'));
  search.account.likedTracks = async () => {
    throw new MusicError('API_TIMEOUT');
  };
  await assert.rejects(search.search('晴天', 5, { source: 'liked' }), { code: 'API_TIMEOUT' });
  await assert.rejects(search.search('晴天'), /MUSIC_U=private/);
});

test('rejects invalid queries and options before accessing account or network', async () => {
  const search = searcher([]);
  search.account.likedTracks = search.catalog.search = async () => assert.fail('Unexpected read');
  for (const query of ['', '   ', '!!!', null, 'a'.repeat(101)])
    await assert.rejects(search.search(query), { code: 'INVALID_ARGUMENT' });
  for (const options of [{ source: 'all' }, { artist: ' ' }, { refresh: 'yes' }])
    await assert.rejects(search.search('晴天', 5, options), { code: 'INVALID_ARGUMENT' });
});
