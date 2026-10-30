import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export function defaultStateDir() {
  if (process.env.NETEASE_MUSIC_STATE_DIR) return path.resolve(process.env.NETEASE_MUSIC_STATE_DIR);
  return process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'netease-music-mcp')
    : path.join(os.homedir(), '.local', 'state', 'netease-music-mcp');
}
export function validateConfig(input = {}) {
  const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (
    !record(input) ||
    ['playback', 'api', 'auth'].some((key) => input[key] !== undefined && !record(input[key]))
  )
    throw new Error('Configuration must contain objects');
  if (
    input.stateDir !== undefined &&
    (typeof input.stateDir !== 'string' || !input.stateDir.trim())
  )
    throw new Error('Invalid state directory');
  const stateDir = path.resolve(input.stateDir || defaultStateDir());
  const defaults = {
    backend: 'direct',
    mpvPath:
      process.platform === 'win32' ? path.join(projectRoot, '.tools', 'mpv', 'mpv.exe') : 'mpv',
    level: 'exhigh',
    volume: 30,
    startupTimeoutMs: 12000,
    commandTimeoutMs: 5000,
    bufferBytes: 4 * 1024 * 1024,
    cacheSeconds: 10,
  };
  const playback = { ...defaults, ...input.playback };
  if (
    playback.backend !== 'direct' ||
    !['standard', 'exhigh'].includes(playback.level) ||
    typeof playback.mpvPath !== 'string' ||
    !playback.mpvPath ||
    !Number.isInteger(playback.volume) ||
    playback.volume < 0 ||
    playback.volume > 100
  )
    throw new Error('Invalid playback configuration');
  for (const [key, min, max] of [
    ['startupTimeoutMs', 1000, 30000],
    ['commandTimeoutMs', 500, 15000],
    ['bufferBytes', 1048576, 16777216],
    ['cacheSeconds', 1, 30],
  ])
    if (!Number.isInteger(playback[key]) || playback[key] < min || playback[key] > max)
      throw new Error('Invalid playback configuration: ' + key);
  const api = { timeoutMs: 12000, ...input.api };
  if (!Number.isInteger(api.timeoutMs) || api.timeoutMs < 1000 || api.timeoutMs > 30000)
    throw new Error('Invalid API timeout');
  const auth = {
    sessionFile: path.join(stateDir, 'session.dpapi'),
    loginHelper:
      process.platform === 'win32'
        ? path.join(projectRoot, 'vendor', 'login', 'windows-x64', 'NeteaseWebViewLogin.exe')
        : path.join(projectRoot, 'vendor', 'login', 'macos-' + process.arch, 'NeteaseWebViewLogin'),
    ...input.auth,
  };
  if (
    typeof auth.sessionFile !== 'string' ||
    !auth.sessionFile.trim() ||
    typeof auth.loginHelper !== 'string' ||
    !auth.loginHelper.trim()
  )
    throw new Error('Invalid auth configuration');
  auth.sessionFile = path.resolve(projectRoot, auth.sessionFile);
  auth.loginHelper = path.resolve(projectRoot, auth.loginHelper);
  if (/[\\/]/.test(playback.mpvPath))
    playback.mpvPath = path.resolve(projectRoot, playback.mpvPath);
  return { stateDir, playback, api, auth };
}
export async function loadConfig(
  file = process.env.NETEASE_MCP_CONFIG || path.join(projectRoot, 'config.local.json')
) {
  let input = {};
  try {
    input = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' || process.env.NETEASE_MCP_CONFIG)
      throw new Error('Cannot read music configuration');
  }
  return validateConfig(input);
}
