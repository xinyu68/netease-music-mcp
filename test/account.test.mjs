import test from 'node:test';
import assert from 'node:assert/strict';
import { Account, allowSession } from '../src/account.mjs';
const sessionProvider = async () => ({
  cookieHeader: 'MUSIC_U=test-fixture; __csrf=fixture',
  csrfToken: 'fixture',
});

test('session provider keeps only authentication fields and rejects header injection', () => {
  const s = allowSession('MUSIC_U=test-fixture; tracking=never-return; __csrf=fixture');
  assert.equal(s.cookieHeader, 'MUSIC_U=test-fixture; __csrf=fixture');
  assert.throws(() => allowSession('MUSIC_U=bad\r\nInjected=x'));
  assert.throws(() => allowSession('__csrf=fixture'));
});
test('HTTP/API success without actual account identity is not login success', async () => {
  const account = new Account({
    sessionProvider,
    apiClient: {
      login_status: async () => ({ body: { data: { code: 200, account: null, profile: null } } }),
    },
  });
  await assert.rejects(account.status(), /LOGIN_REQUIRED/);
});
test('uploader API nested status response verifies member identity without returning cookie', async () => {
  const account = new Account({
    sessionProvider,
    apiClient: {
      login_status: async () => ({
        body: {
          data: {
            code: 200,
            account: { id: 1, vipType: 11 },
            profile: { userId: 1, nickname: 'test' },
          },
        },
      }),
    },
  });
  const result = await account.status();
  assert.equal(result.isVip, true);
  assert.equal(result.userId, '1');
  assert.ok(!JSON.stringify(result).includes('test-fixture'));
});
test('provider business failure stays a failure rather than an empty playlist', async () => {
  const a = new Account({
    sessionProvider,
    apiClient: { login_status: async () => ({ body: { code: -460 } }) },
  });
  await assert.rejects(a.status(), /BUSINESS_-460/);
});
test('expired and thrown upstream errors are sanitized', async () => {
  for (const code of [301, 502]) {
    const a = new Account({
      sessionProvider,
      apiClient: {
        login_status: async () => {
          throw {
            body: { code, message: 'MUSIC_U=test-fixture' },
            headers: { Cookie: 'test-fixture' },
          };
        },
      },
    });
    await assert.rejects(
      a.status(),
      (error) =>
        !error.message.includes('test-fixture') &&
        error.message.includes(code === 301 ? 'LOGIN_REQUIRED' : '502')
    );
  }
});
test('liked playlist is selected by owner and special type, not translated display name', async () => {
  const a = new Account();
  a.playlists = async () => ({
    playlists: [
      { id: '2', specialType: 5, owned: false },
      { id: '3', specialType: 5, owned: true, name: '任何名称' },
    ],
  });
  a.tracks = async (id, limit, offset) => ({ id, limit, offset });
  assert.deepEqual(await a.liked(4, 8), { id: '3', limit: 4, offset: 8 });
  a.playlists = async () => ({
    playlists: [
      { id: '3', specialType: 5, owned: true },
      { id: '4', specialType: 5, owned: true },
    ],
  });
  await assert.rejects(a.liked(), /uniquely/);
});
test('playlist pagination preserves track ID order even when details are reordered', async () => {
  const a = new Account();
  a.request = async (route) =>
    route.includes('/playlist/')
      ? { playlist: { name: 'test', trackIds: [{ id: 1 }, { id: 2 }, { id: 3 }] } }
      : {
          songs: [
            { id: 3, name: 'third', fee: 1 },
            { id: 2, name: 'second', fee: 8 },
          ],
        };
  const r = await a.tracks('123', 2, 1);
  assert.deepEqual(
    r.songs.map((s) => s.id),
    ['2', '3']
  );
  assert.equal(r.total, 3);
  assert.equal(r.more, false);
  await assert.rejects(a.tracks('123', 200, 0));
});
