import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp-server.mjs';
import { MusicError } from '../src/errors.mjs';
async function rig() {
  const calls = [];
  const runtime = {
    account: { status: async () => ({ loggedIn: true, isVip: true }) },
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
      status: async () => ({ phase: 'idle' }),
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
test('MCP lists the formal direct-stream tools without exposing raw URL or account write tools', async () => {
  const r = await rig();
  try {
    const tools = (await r.client.listTools()).tools;
    assert.equal(tools.length, 20);
    assert.ok(tools.some((t) => t.name === 'netease_play_liked'));
    assert.ok(!tools.some((t) => /download|cookie|create_playlist|delete/.test(t.name)));
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
