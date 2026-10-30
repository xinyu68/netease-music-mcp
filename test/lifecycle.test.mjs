import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

test('real stdio process starts lazily without credentials or mpv, returns a login error and exits on client close', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'netease-mcp-lifecycle-'));
  const config = path.join(temporary, 'config.json');
  await writeFile(
    config,
    JSON.stringify({ stateDir: temporary, playback: { mpvPath: 'missing-test-player' } })
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))],
    env: { ...process.env, NETEASE_MCP_CONFIG: config },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  const client = new Client({ name: 'offline-lifecycle-test', version: '1.0' });
  let pid;
  try {
    await client.connect(transport);
    pid = transport.pid;
    assert.equal((await client.listTools()).tools.length, 25);
    const state = await client.callTool({ name: 'netease_status', arguments: {} });
    assert.equal(JSON.parse(state.content[0].text).phase, 'idle');
    const mode = await client.callTool({
      name: 'netease_play_mode',
      arguments: { mode: 'shuffle', requestId: 'mode-before-login' },
    });
    assert.notEqual(mode.isError, true);
    assert.equal(JSON.parse(mode.content[0].text).queue.playbackMode, 'shuffle');
    const result = await client.callTool({ name: 'netease_account_status', arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).code, 'LOGIN_REQUIRED');
  } finally {
    await client.close();
    await delay(100);
    if (pid) assert.throws(() => process.kill(pid, 0));
    assert.equal(stderr, '');
    // Only the unique directory created above is removed, never a user state directory.
    await rm(temporary, { recursive: true, force: true });
  }
});
