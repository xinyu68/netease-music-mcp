import { loadConfig } from '../src/config.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { createRuntime } from '../src/runtime.mjs';
const config = await loadConfig(),
  runtime = createRuntime(config),
  report = {
    node: process.version,
    platform: process.platform,
    backend: 'direct-mpv',
    requiresNeteaseClient: false,
  };
try {
  report.player = await promisify(execFile)(config.playback.mpvPath, ['--version'], {
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 65536,
  })
    .then((r) => ({ ready: true, version: r.stdout.split(/\r?\n/)[0] }))
    .catch(() => ({
      ready: false,
      error: 'Run npm run setup:player or configure playback.mpvPath',
    }));
  report.sessionPresent = await stat(config.auth.sessionFile)
    .then((x) => x.isFile())
    .catch(() => false);
  report.sessionProtection =
    process.platform === 'win32' ? 'current-user-dpapi' : 'base64-owner-only-file';
  report.loginHelper = await stat(config.auth.loginHelper)
    .then((x) => x.isFile())
    .catch(() => false);
  report.loginReady = report.loginHelper;
  if (process.platform === 'win32' && report.loginHelper)
    report.loginRuntime = await promisify(execFile)(config.auth.loginHelper, ['--probe'], {
      windowsHide: true,
      timeout: 5000,
    })
      .then(() => ({ ready: true }))
      .catch(() => ({ ready: false }));
  if (report.loginRuntime) report.loginReady = report.loginRuntime.ready;
  if (process.argv.includes('--online')) {
    try {
      const a = await runtime.account.status();
      report.account = { loggedIn: a.loggedIn, isVip: a.isVip };
    } catch (error) {
      report.account = { loggedIn: false, error: error.code || 'API_ERROR' };
    }
  }
  report.ready =
    report.player.ready &&
    report.loginReady &&
    (process.argv.includes('--dependencies-only') || report.sessionPresent) &&
    (!process.argv.includes('--online') || report.account?.loggedIn === true);
  if (!report.ready) process.exitCode = 1;
  console.log(JSON.stringify(report, null, 2));
} finally {
  await runtime.close();
}
