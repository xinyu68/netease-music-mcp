import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { projectRoot } from '../src/config.mjs';

test('portable and Codex manifests use the same version and local launch entrypoint', async () => {
  const json = async (file) => JSON.parse(await readFile(path.join(projectRoot, file), 'utf8'));
  const pkg = await json('package.json'),
    portable = await json('plugin/plugin.json'),
    compat = await json('plugin/.codex-plugin/plugin.json');
  assert.equal(portable.version, pkg.version);
  assert.equal(compat.version, pkg.version);
  const mcp = await json('plugin/mcp.json'),
    legacy = await json('plugin/.mcp.json');
  assert.equal(mcp.mcpServers.netease_music.type, 'stdio');
  assert.deepEqual(mcp.mcpServers.netease_music.args, legacy.mcpServers.netease_music.args);
  assert.ok(
    mcp.mcpServers.netease_music.args.every(
      (arg) => arg.startsWith('${PLUGIN_ROOT}/') && !arg.includes('..')
    )
  );
});

test('a fresh plugin startup prints setup instructions without writing credentials, downloading, or opening login', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ncm-plugin-empty-'));
  try {
    const build = spawnSync(
      process.execPath,
      [path.join(projectRoot, 'scripts/build-plugin.mjs')],
      { windowsHide: true, encoding: 'utf8' }
    );
    assert.equal(build.status, 0, build.stderr);
    const env = { ...process.env, NETEASE_MUSIC_STATE_DIR: temp };
    delete env.NETEASE_MCP_CONFIG;
    const run = spawnSync(
      process.execPath,
      [path.join(projectRoot, 'dist/plugin/scripts/launch.mjs')],
      { env, windowsHide: true, encoding: 'utf8', timeout: 10000 }
    );
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /first-time setup/);
    assert.deepEqual(await readdir(temp), []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
