import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { projectRoot } from '../src/config.mjs';
import { findCli } from '../src/installation.mjs';

await mkdir(path.join(projectRoot, '.data'), { recursive: true });
const temporary = await mkdtemp(path.join(projectRoot, '.data', 'plugin-acceptance-'));
const codex = findCli('codex');
const env = { ...process.env, CODEX_HOME: temporary };
const report = {
  observedAt: new Date().toISOString(),
  actualUserCodexConfigChanged: false,
  physicalHardwareRequired: false,
};
function run(args) {
  const r = spawnSync(codex.command, [...codex.args, ...args], {
    cwd: temporary,
    env,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 1024 * 1024,
  });
  if (r.error || r.status !== 0)
    throw new Error(`Isolated Codex command failed: ${args.slice(0, 3).join(' ')}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
async function findInstalled(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.isFile() && item.name === 'plugin.json' && path.basename(dir) !== '.codex-plugin') {
      const p = JSON.parse(await readFile(path.join(dir, item.name), 'utf8'));
      if (p.name === 'netease-music-mcp') return dir;
    }
    if (item.isDirectory()) {
      const found = await findInstalled(path.join(dir, item.name));
      if (found) return found;
    }
  }
}
let client;
try {
  report.marketplace = run(['plugin', 'marketplace', 'add', projectRoot, '--json']);
  report.install = run(['plugin', 'add', 'netease-music-mcp@netease-music-local', '--json']);
  const installed = await findInstalled(path.join(temporary, 'plugins', 'cache'));
  assert.ok(installed, 'Plugin was not copied into the isolated Codex cache');
  const config = JSON.parse(await readFile(path.join(installed, '.mcp.json'), 'utf8')).mcpServers
    .netease_music;
  const skill = await readFile(path.join(installed, 'skills/netease-music/SKILL.md'), 'utf8');
  assert.ok(skill.startsWith('---\nname: netease-music\n'));
  report.cachedSkillPresent = true;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: config.args.map((arg) => arg.replaceAll('${PLUGIN_ROOT}', installed)),
    cwd: installed,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  client = new Client({ name: 'cached-plugin-acceptance', version: '0.3.0' });
  await client.connect(transport);
  report.toolCount = (await client.listTools()).tools.length;
  assert.equal(report.toolCount, 20);
  const state = await client.callTool({ name: 'netease_status', arguments: {} });
  assert.equal(state.isError, undefined);
  report.idleStatus = JSON.parse(state.content[0].text).phase;
  assert.equal(report.idleStatus, 'idle');
  if (process.argv.includes('--online')) {
    const result = await client.callTool({ name: 'netease_account_status', arguments: {} });
    assert.equal(result.isError, undefined);
    const account = JSON.parse(result.content[0].text);
    report.account = { loggedIn: account.loggedIn, isVip: account.isVip };
  }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await client?.close();
  await mkdir(path.join(projectRoot, 'evidence'), { recursive: true });
  await writeFile(
    path.join(projectRoot, 'evidence/plugin-live.json'),
    JSON.stringify(report, null, 2)
  );
  console.log(
    JSON.stringify(
      {
        passed: report.passed,
        cachedSkillPresent: report.cachedSkillPresent,
        toolCount: report.toolCount,
        account: report.account,
        error: report.error,
      },
      null,
      2
    )
  );
}
