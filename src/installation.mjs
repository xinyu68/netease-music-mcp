import { readdir, readFile, stat, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { projectRoot, defaultStateDir } from './config.mjs';

// The same source files power both the standalone service and managed plugin runtime.
export async function runtimeFiles(root = projectRoot) {
  const files = [
    'package.json',
    'package-lock.json',
    'config.example.json',
    ...['setup.mjs', 'doctor.mjs', 'setup-player.mjs', 'build-login.mjs', 'login-native.mjs'].map(
      (file) => `scripts/${file}`
    ),
  ];
  for (const dir of ['src', 'tools']) {
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      if (entry.isFile() && /\.(mjs|json)$/.test(entry.name)) files.push(`${dir}/${entry.name}`);
    }
  }
  files.push('vendor/login/windows/WebViewLogin.cs', 'vendor/login/macos/LoginWindow.swift');
  return files.sort();
}

export async function runtimeIdentity(root = projectRoot, stateDir = defaultStateDir()) {
  const files = await runtimeFiles(root);
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file + '\0');
    hash.update(await readFile(path.join(root, file)));
  }
  const fingerprint = hash.digest('hex');
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  return {
    version,
    fingerprint,
    files,
    root: path.join(stateDir, 'runtimes', `${version}-${fingerprint.slice(0, 16)}`),
  };
}

export async function readyRuntime(identity) {
  try {
    const marker = JSON.parse(await readFile(path.join(identity.root, '.ready.json'), 'utf8'));
    const helper =
      process.platform === 'win32'
        ? 'windows-x64/NeteaseWebViewLogin.exe'
        : `macos-${process.arch}/NeteaseWebViewLogin`;
    return (
      marker.fingerprint === identity.fingerprint &&
      (
        await stat(path.join(identity.root, 'node_modules/@modelcontextprotocol/sdk/package.json'))
      ).isFile() &&
      (await stat(path.join(identity.root, 'vendor/login', helper))).isFile() &&
      (process.platform !== 'win32' ||
        (await stat(path.join(identity.root, '.tools/mpv/mpv.exe'))).isFile())
    );
  } catch {
    return false;
  }
}

export async function copyRuntime(sourceRoot, identity) {
  for (const file of identity.files) {
    const target = path.join(identity.root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(sourceRoot, file), target);
  }
}

// Resolve package CLIs without shell interpolation (Windows .cmd wrappers cannot be execFile'd).
export function findCli(name, env = process.env) {
  const dirs = [
    ...new Set(
      [
        path.dirname(process.execPath),
        ...(env.PATH || env.Path || '').split(path.delimiter),
      ].filter(Boolean)
    ),
  ];
  const packageEntry =
    name === 'npm' ? 'npm/bin/npm-cli.js' : name === 'codex' ? '@openai/codex/bin/codex.js' : null;
  for (const dir of dirs) {
    if (packageEntry) {
      for (const base of [
        path.join(dir, 'node_modules'),
        path.resolve(dir, '../lib/node_modules'),
      ]) {
        const script = path.join(base, packageEntry);
        if (existsSync(script)) return { command: process.execPath, args: [script] };
      }
    }
    for (const suffix of process.platform === 'win32' ? ['.exe', '.com'] : ['']) {
      const binary = path.join(dir, name + suffix);
      if (existsSync(binary)) return { command: binary, args: [] };
    }
  }
  throw new Error(`Missing ${name}. Install it and reopen your terminal so PATH is updated.`);
}
