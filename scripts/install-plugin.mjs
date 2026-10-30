import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot, loadConfig } from '../src/config.mjs';
import { findCli, runtimeIdentity, readyRuntime } from '../src/installation.mjs';

const config = await loadConfig();
if (!(await readyRuntime(await runtimeIdentity(projectRoot, config.stateDir))))
  throw new Error('Prepare the plugin runtime first: node scripts/setup.mjs --plugin');
await access(path.join(projectRoot, 'dist/plugin/plugin.json'));
const codex = findCli('codex');
for (const args of [
  ['plugin', 'marketplace', 'add', projectRoot, '--json'],
  ['plugin', 'add', 'netease-music-mcp@netease-music-local', '--json'],
]) {
  const result = spawnSync(codex.command, [...codex.args, ...args], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: 'inherit',
    timeout: 60000,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      'Codex plugin installation failed. See docs/安装与使用.md for the manual commands and supported Codex version.'
    );
}
console.log(
  'Plugin installed. Start a new Codex chat. Use either the plugin or the standalone MCP connection, not both.'
);
