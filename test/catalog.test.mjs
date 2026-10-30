import test from 'node:test';
import assert from 'node:assert/strict';
import { NeteaseCatalog } from '../src/netease.mjs';
test('public search rejects HTTP 200 business failures', async () => {
  const c = new NeteaseCatalog({
    fetchImpl: async () => new Response(JSON.stringify({ code: -460 }), { status: 200 }),
  });
  await assert.rejects(c.search('test'), /code -460/);
});
test('catalog query cannot inject arbitrary network destinations', async () => {
  let observed;
  const c = new NeteaseCatalog({
    fetchImpl: async (url) => {
      observed = url;
      return new Response(JSON.stringify({ code: 200, result: { songs: [] } }));
    },
  });
  await c.search('https://example.invalid/?cookie=placeholder');
  assert.equal(observed.origin, 'https://music.163.com');
});
