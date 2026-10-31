import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp-server.mjs';
import { MusicError } from '../src/errors.mjs';
async function rig({ likedTracks } = {}) {
  const calls = [];
  const runtime = {
    account: {
      status: async () => ({ loggedIn: true, isVip: true }),
      likedTracks:
        likedTracks ??
        (async () => {
          throw new MusicError('LOGIN_REQUIRED');
        }),
      setLiked: async (...args) => {
        calls.push(['like', ...args]);
        return { liked: args[1], verified: true };
      },
    },
    catalog: {
      search: async () => {
        throw Error('MUSIC_U=must-not-leak https://cdn.test/signed?secret=x');
      },
    },
    player: {
      play: async (...args) => {
        calls.push(args);
        return { verified: true, songId: args[0] };
      },
      playCollection: async (_loader, requestId, _signature, options) => {
        calls.push(['collection', requestId, options]);
        return { queue: { playbackMode: options.mode } };
      },
      setPlaybackMode: async (...args) => {
        calls.push(['mode', ...args]);
        return { queue: { playbackMode: args[0] } };
      },
      status: async () => ({ phase: 'playing', songId: '1' }),
      stop: async () => ({ phase: 'stopped' }),
    },
    engine: { start: async () => {} },
  };
  const server = createMcpServer(runtime),
    client = new Client({ name: 'test', version: '0.1.0' }),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    client,
    server,
    calls,
    async close() {
      await client.close();
      await server.close();
    },
  };
}
test('MCP lists the supported music tools without exposing raw URLs or unrelated account writes', async () => {
  const r = await rig();
  try {
    const tools = (await r.client.listTools()).tools;
    assert.equal(tools.length, 25);
    assert.equal(tools.find((t) => t.name === 'netease_like').annotations.readOnlyHint, false);
    assert.ok(tools.some((t) => t.name === 'netease_play_liked'));
    assert.ok(!tools.some((t) => /download|cookie|create_playlist|delete/.test(t.name)));
  } finally {
    await r.close();
  }
});

test('favorite tool requires a boolean and resolves current-song unlike without flipping the intent', async () => {
  const r = await rig();
  try {
    const bad = await r.client.callTool({
      name: 'netease_like',
      arguments: { requestId: 'bad', liked: 'false' },
    });
    assert.equal(bad.isError, true);
    assert.equal(r.calls.length, 0);
    const good = await r.client.callTool({
      name: 'netease_like',
      arguments: { requestId: 'good', liked: false },
    });
    assert.notEqual(good.isError, true);
    assert.deepEqual(r.calls[0], ['like', '1', false, 'good']);
  } finally {
    await r.close();
  }
});
test('MCP validates IDs and request IDs before calling the playback backend', async () => {
  const r = await rig();
  try {
    const bad = await r.client.callTool({
      name: 'netease_play',
      arguments: { songId: '../1', requestId: 'bad' },
    });
    assert.equal(bad.isError, true);
    assert.equal(r.calls.length, 0);
    const missing = await r.client.callTool({ name: 'netease_play', arguments: { songId: '1' } });
    assert.equal(missing.isError, true);
    const good = await r.client.callTool({
      name: 'netease_play',
      arguments: { songId: '1', requestId: 'ok' },
    });
    assert.notEqual(good.isError, true);
    assert.equal(r.calls.length, 1);
  } finally {
    await r.close();
  }
});
test('MCP never forwards untrusted dependency errors, cookies or URLs to tool results', async () => {
  const r = await rig();
  try {
    const result = await r.client.callTool({
      name: 'netease_search',
      arguments: { query: 'test' },
    });
    assert.equal(result.isError, true);
    const text = JSON.stringify(result);
    assert.ok(!text.includes('must-not-leak'));
    assert.ok(!text.includes('cdn.test'));
    assert.ok(text.includes('INTERNAL_ERROR'));
  } finally {
    await r.close();
  }
});

test('MCP search exposes scoped favorite candidates and source errors without playing or guessing artist metadata', async () => {
  const reads = [];
  const r = await rig({
    likedTracks: async (options) => {
      reads.push(options);
      return [{ id: '2000000001', title: '晴天', artists: [], album: '', durationMs: 269000 }];
    },
  });
  try {
    for (const args of [
      { query: '   ' },
      { query: '晴天', source: 'all' },
      { query: '晴天', artist: '' },
      { query: '晴天', refresh: 'true' },
    ]) {
      assert.equal(
        (await r.client.callTool({ name: 'netease_search', arguments: args })).isError,
        true
      );
    }
    assert.equal(reads.length, 0);
    const result = await r.client.callTool({
      name: 'netease_search',
      arguments: { query: '晴天', artist: '周杰伦', source: 'liked', refresh: true },
    });
    assert.notEqual(result.isError, true);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.candidates[0].id, '2000000001');
    assert.equal(body.candidates[0].artistMatch, 'unknown');
    assert.deepEqual(body.sources, { liked: { status: 'ok' } });
    assert.deepEqual(reads, [{ refresh: true }]);
    const auto = await r.client.callTool({
      name: 'netease_search',
      arguments: { query: '晴天' },
    });
    assert.notEqual(auto.isError, true);
    assert.equal(JSON.parse(auto.content[0].text).sources.catalog.code, 'INTERNAL_ERROR');
    assert.ok(!JSON.stringify(auto).includes('must-not-leak'));
    assert.ok(!JSON.stringify(auto).includes('cdn.test'));
    assert.equal(r.calls.length, 0);
  } finally {
    await r.close();
  }
});

test('MCP exposes explicit playback modes, rejects unknown values and forwards single-call playback choices', async () => {
  const r = await rig();
  try {
    for (const mode of [undefined, 'loop_all', true]) {
      const invalid = await r.client.callTool({
        name: 'netease_play_mode',
        arguments: { requestId: 'bad', mode },
      });
      assert.equal(invalid.isError, true);
    }
    assert.equal(r.calls.length, 0);
    for (const mode of ['shuffle', 'repeat_one', 'sequence']) {
      const result = await r.client.callTool({
        name: 'netease_play_mode',
        arguments: { requestId: mode, mode },
      });
      assert.notEqual(result.isError, true);
      assert.equal(JSON.parse(result.content[0].text).queue.playbackMode, mode);
    }
    const play = await r.client.callTool({
      name: 'netease_play',
      arguments: { songId: '1', requestId: 'play', mode: 'repeat_one' },
    });
    assert.notEqual(play.isError, true);
    assert.equal(r.calls.at(-1)[2].mode, 'repeat_one');
    for (const name of [
      'netease_play_liked',
      'netease_play_playlist',
      'netease_play_daily',
      'netease_play_heart_mode',
      'netease_play_hot_chart',
    ]) {
      const result = await r.client.callTool({
        name,
        arguments: { requestId: name, playlistId: '1', mode: 'shuffle' },
      });
      assert.notEqual(result.isError, true);
      assert.deepEqual(r.calls.at(-1), ['collection', name, { mode: 'shuffle' }]);
    }
    const invalidPlay = await r.client.callTool({
      name: 'netease_play_liked',
      arguments: { requestId: 'bad-play', mode: 'random' },
    });
    assert.equal(invalidPlay.isError, true);
  } finally {
    await r.close();
  }
});
