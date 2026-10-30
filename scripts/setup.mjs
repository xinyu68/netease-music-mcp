#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, open, unlink, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot, loadConfig } from '../src/config.mjs';
import { runtimeIdentity, readyRuntime, copyRuntime, findCli } from '../src/installation.mjs';

const flags = new Set(process.argv.slice(2));
const allowed = new Set(['--plugin', '--no-login', '--check', '--install-plugin', '--help']);
if ([...flags].some((flag) => !allowed.has(flag)))
  throw new Error('Unknown setup option; use --help');
if (flags.has('--help')) {
  console.log(
    'node scripts/setup.mjs [--plugin] [--no-login] [--check] [--install-plugin]\n--plugin prepares an upgrade-safe per-user runtime. --install-plugin also installs the local Codex plugin.'
  );
  process.exit(0);
}
if (flags.has('--install-plugin') && !flags.has('--plugin'))
  throw new Error('--install-plugin requires --plugin');

function run(command, args, cwd = projectRoot, timeout = 600000, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    windowsHide: true,
    stdio: 'inherit',
    timeout,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      'Setup step failed; see the preceding diagnostic and retry setup after fixing it.'
    );
}
function node(script, root, args = []) {
  run(process.execPath, [path.join(root, 'scripts', script), ...args], root);
}

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) throw new Error('Node.js >=22.13 is required.');
if (
  !(
    (process.platform === 'win32' && process.arch === 'x64') ||
    (process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch))
  )
)
  throw new Error('Supported setup targets: Windows x64; macOS arm64/x64 (preview).');
const npm = findCli('npm');
if (flags.has('--install-plugin')) findCli('codex');
if (process.platform === 'win32') {
  await access(
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
  ).catch(() => {
    throw new Error('The Windows .NET Framework C# compiler is missing. See docs/安装与使用.md');
  });
} else {
  const tools = spawnSync('xcode-select', ['-p'], { stdio: 'ignore', timeout: 5000 });
  if (tools.status !== 0)
    throw new Error('Install Xcode Command Line Tools first: xcode-select --install');
}
const config = await loadConfig();
const identity = await runtimeIdentity(projectRoot, config.stateDir);
if (flags.has('--check')) {
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        prerequisitesReady: true,
        managedRuntimeReady: await readyRuntime(identity),
      },
      null,
      2
    )
  );
  process.exit(0);
}

await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
const lockPath = path.join(config.stateDir, 'setup.lock');
const lock = await open(lockPath, 'wx').catch(() => {
  throw new Error(
    'Another setup may be running (setup.lock exists). See the installation troubleshooting guide.'
  );
});
await lock.writeFile(String(process.pid));
try {
  const managed = flags.has('--plugin');
  const root = managed ? identity.root : projectRoot;
  if (!managed || !(await readyRuntime(identity))) {
    if (managed) await copyRuntime(projectRoot, identity);
    console.log('Installing locked Node dependencies (this may take several minutes)...');
    run(
      npm.command,
      [...npm.args, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
      root
    );
    if (process.platform === 'darwin') {
      const mpv = spawnSync(config.playback.mpvPath, ['--version'], {
        stdio: 'ignore',
        timeout: 5000,
      });
      if (mpv.status !== 0) {
        const brew = findCli('brew');
        run(brew.command, [...brew.args, 'install', 'mpv'], root);
      }
    }
    node('setup-player.mjs', root);
    node('build-login.mjs', root);
    if (managed)
      await writeFile(
        path.join(root, '.ready.json'),
        JSON.stringify({
          version: identity.version,
          fingerprint: identity.fingerprint,
          preparedAt: new Date().toISOString(),
        })
      );
  }
  // Use the same non-secret config when preparing a managed runtime. No credentials are copied.
  const env = { ...process.env, NETEASE_MUSIC_STATE_DIR: config.stateDir };
  run(
    process.execPath,
    [path.join(root, 'scripts/doctor.mjs'), '--dependencies-only'],
    root,
    30000,
    env
  );
  if (!flags.has('--no-login')) {
    run(process.execPath, [path.join(root, 'scripts/login-native.mjs')], root, 900000, env);
    run(process.execPath, [path.join(root, 'scripts/doctor.mjs'), '--online'], root, 60000, env);
  }
  if (managed) {
    console.log(`Managed runtime prepared: ${root}`);
    try {
      await access(path.join(projectRoot, 'plugin/plugin.json'));
      node('build-plugin.mjs', projectRoot);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (flags.has('--install-plugin')) node('install-plugin.mjs', projectRoot);
  }
  console.log(
    flags.has('--no-login')
      ? 'Dependencies prepared. Complete login before playing music.'
      : 'Setup and account verification completed.'
  );
} finally {
  await lock.close();
  await unlink(lockPath);
}
