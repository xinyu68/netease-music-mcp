import { readFile, stat, copyFile, mkdir, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { MusicError } from './errors.mjs';
export function allowSession(raw) {
  const pairs = new Map();
  for (const entry of String(raw).split(';')) {
    const at = entry.indexOf('=');
    if (at < 1) continue;
    const name = entry.slice(0, at).trim(),
      value = entry.slice(at + 1).trim();
    if (['MUSIC_U', '__csrf'].includes(name) && value && !/[\r\n]/.test(value))
      pairs.set(name, value);
  }
  if (!pairs.has('MUSIC_U')) throw new MusicError('LOGIN_REQUIRED');
  return {
    cookieHeader: [...pairs].map(([k, v]) => `${k}=${v}`).join('; '),
    csrfToken: pairs.get('__csrf') || '',
  };
}
export class AuthStore {
  constructor(config) {
    this.config = config;
    this.cached = null;
    this.cachedAt = 0;
  }
  clear() {
    this.cached = null;
    this.cachedAt = 0;
  }
  async session() {
    if (this.cached && Date.now() - this.cachedAt < 15000) return this.cached;
    const file = this.config.auth.sessionFile;
    const metadata = await stat(file).catch(() => {
      throw new MusicError('LOGIN_REQUIRED');
    });
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > 32768)
      throw new MusicError('LOGIN_REQUIRED');
    const encrypted = await readFile(file, 'utf8');
    let raw;
    if (process.platform === 'win32') {
      raw = await new Promise((resolve, reject) => {
        const code =
          'Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd();$b=[Convert]::FromBase64String($v);$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Text.Encoding]::UTF8.GetString($p)';
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'ignore'],
        });
        let output = '',
          tooLarge = false;
        const timer = setTimeout(() => {
          child.kill();
          reject(new MusicError('LOGIN_REQUIRED'));
        }, 8000);
        child.stdout.on('data', (c) => {
          output += c;
          if (output.length > 32768) {
            tooLarge = true;
            child.kill();
          }
        });
        child.on('error', () => {
          clearTimeout(timer);
          reject(new MusicError('LOGIN_REQUIRED'));
        });
        child.on('close', (status) => {
          clearTimeout(timer);
          status === 0 && !tooLarge
            ? resolve(output.trim())
            : reject(new MusicError('LOGIN_REQUIRED'));
        });
        child.stdin.on('error', () => {});
        child.stdin.end(encrypted);
      });
    } else {
      if (metadata.mode & 0o077) throw new MusicError('LOGIN_REQUIRED');
      raw = Buffer.from(encrypted, 'base64').toString('utf8');
    }
    this.cached = allowSession(raw);
    this.cachedAt = Date.now();
    return this.cached;
  }
  async importEncrypted(source) {
    const target = this.config.auth.sessionFile;
    if (path.resolve(source) === path.resolve(target)) throw new MusicError('INVALID_ARGUMENT');
    const metadata = await stat(source);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > 32768)
      throw new MusicError('LOGIN_REQUIRED');
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const { constants } = await import('node:fs');
    await copyFile(source, target, constants.COPYFILE_EXCL);
    if (process.platform !== 'win32') await chmod(target, 0o600);
    this.clear();
    await this.session();
    return { imported: true };
  }
}
