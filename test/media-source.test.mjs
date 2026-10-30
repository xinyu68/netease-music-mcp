import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSource, validateMediaUrl } from '../src/media-source.mjs';
const good = () => ({
  code: 200,
  data: [
    {
      id: 1,
      code: 200,
      url: 'http://m801.music.126.net/test.mp3?token=secret-test',
      expi: 1200,
      time: 180000,
      type: 'mp3',
      level: 'exhigh',
      br: 320000,
      freeTrialInfo: null,
    },
  ],
});
test('source parser verifies ID, permission, expiry and upgrades only an allowlisted host to TLS', () => {
  const result = parseSource(good(), '1', 1000);
  assert.equal(result.duration, 180);
  assert.equal(result.expiresAt, 1201000);
  assert.ok(result.url.startsWith('https:'));
  assert.throws(
    () => parseSource(good(), '2'),
    (e) => e.code === 'NO_PLAY_PERMISSION'
  );
  for (const url of [
    'file:///tmp/a',
    'https://music.126.net.evil.test/a',
    'https://user:pass@music.163.com/a',
    'https://127.0.0.1/a',
    'https://music.163.com:8443/a',
  ])
    assert.throws(() => validateMediaUrl(url));
});
test('previews, explicit protected media, unavailable URLs and business failures are rejected', () => {
  for (const [field, value, code] of [
    ['freeTrialInfo', { start: 0, end: 30 }, 'PREVIEW_ONLY'],
    ['isDrm', true, 'PROTECTED_MEDIA'],
    ['url', null, 'NO_PLAY_PERMISSION'],
    ['expi', 0, 'INVALID_RESPONSE'],
  ]) {
    const p = good();
    p.data[0][field] = value;
    assert.throws(
      () => parseSource(p, '1'),
      (e) => e.code === code
    );
  }
  assert.throws(
    () => parseSource({ code: 301 }, '1'),
    (e) => e.code === 'LOGIN_REQUIRED'
  );
  assert.throws(
    () => parseSource({ code: -460 }, '1'),
    (e) => e.code === 'API_ERROR'
  );
});
