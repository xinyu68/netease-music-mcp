import { mkdir, readFile, copyFile, writeFile, stat, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { projectRoot } from '../src/config.mjs';
const root = projectRoot;
if (process.platform === 'win32' && process.arch === 'x64') {
  const manifest = JSON.parse(
      await readFile(path.join(root, 'tools/webview2-manifest.json'), 'utf8')
    ),
    target = path.join(root, 'vendor/login/windows-x64');
  await mkdir(target, { recursive: true });
  let ready = true;
  for (const [name, item] of Object.entries(manifest.files)) {
    try {
      if (
        createHash('sha256')
          .update(await readFile(path.join(target, name)))
          .digest('hex') !== item.sha256
      )
        ready = false;
    } catch {
      ready = false;
    }
  }
  if (!ready) {
    const archive = path.join(root, '.tools/webview2-sdk.nupkg'),
      unpacked = path.join(root, '.tools/webview2-sdk');
    await mkdir(unpacked, { recursive: true });
    execFileSync(
      'curl.exe',
      [
        '--fail',
        '--location',
        '--retry',
        '1',
        '--connect-timeout',
        '15',
        '--max-time',
        '120',
        '--output',
        archive,
        manifest.url,
      ],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'] }
    );
    execFileSync('tar', ['-xf', archive, '-C', unpacked], { windowsHide: true, stdio: 'pipe' });
    for (const [name, item] of Object.entries(manifest.files)) {
      const file = path.join(unpacked, item.path);
      if (
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex') !== item.sha256
      )
        throw new Error('WebView2 SDK checksum mismatch: ' + name);
      await copyFile(file, path.join(target, name));
    }
  }
  const compiler = path.join(
    process.env.WINDIR || 'C:\\Windows',
    'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
  );
  execFileSync(
    compiler,
    [
      '/nologo',
      '/target:winexe',
      '/platform:x64',
      '/out:' + path.join(target, 'NeteaseWebViewLogin.exe'),
      '/r:System.Windows.Forms.dll',
      '/r:System.Security.dll',
      ...['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll'].map(
        (name) => '/r:' + path.join(target, name)
      ),
      path.join(root, 'vendor/login/windows/WebViewLogin.cs'),
    ],
    { windowsHide: true, stdio: 'inherit' }
  );
  console.log('Windows official-page login helper built; SDK hashes verified.');
} else if (process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch)) {
  const target = path.join(root, 'vendor/login/macos-' + process.arch);
  await mkdir(target, { recursive: true });
  const binary = path.join(target, 'NeteaseWebViewLogin');
  execFileSync(
    'swiftc',
    [
      path.join(root, 'vendor/login/macos/LoginWindow.swift'),
      '-o',
      binary,
      '-framework',
      'Cocoa',
      '-framework',
      'WebKit',
    ],
    { stdio: 'inherit' }
  );
  await chmod(binary, 0o755);
  console.log('macOS official-page login helper built; validate interactive login on this Mac.');
} else throw new Error('No native login helper build for this platform');
