import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defaultStateDir } from '../src/config.mjs';
const root = new URL('../', import.meta.url),
  manifest = JSON.parse(await readFile(new URL('tools/mpv-manifest.json', root), 'utf8'));
if (process.platform + '-' + process.arch !== manifest.platform) {
  const { loadConfig } = await import('../src/config.mjs');
  const config = await loadConfig();
  try {
    execFileSync(config.playback.mpvPath, ['--version'], { stdio: 'pipe', timeout: 5000 });
    console.log('Existing mpv is ready for this platform.');
    process.exit(0);
  } catch {
    throw new Error(
      'Install mpv for this platform (on macOS: brew install mpv), then run setup again or configure playback.mpvPath.'
    );
  }
}
const target = new URL('.tools/mpv/', root),
  archive = new URL('.tools/mpv-download.zip', root);
const cache = path.join(defaultStateDir(), 'downloads', `mpv-${manifest.sha256}.zip`);
await mkdir(target, { recursive: true });
let bytes;
for (const candidate of [archive, cache]) {
  try {
    const cached = await readFile(candidate);
    if (createHash('sha256').update(cached).digest('hex') === manifest.sha256) {
      bytes = cached;
      break;
    }
  } catch {}
}
if (!bytes) {
  try {
    const response = await fetch(manifest.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('download failed');
    const chunks = [];
    let size = 0;
    for await (const c of response.body) {
      size += c.length;
      if (size > 100 * 1024 * 1024) throw new Error('Unexpected archive size');
      chunks.push(c);
    }
    bytes = Buffer.concat(chunks);
  } catch {
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
        fileURLToPath(archive),
        manifest.url,
      ],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'] }
    );
    bytes = await readFile(archive);
  }
}
const hash = createHash('sha256').update(bytes).digest('hex');
if (hash !== manifest.sha256) throw new Error('mpv checksum mismatch');
await writeFile(archive, bytes);
await mkdir(path.dirname(cache), { recursive: true });
await writeFile(cache, bytes);
execFileSync('tar', ['-xf', fileURLToPath(archive), '-C', fileURLToPath(target)], {
  windowsHide: true,
  stdio: 'pipe',
});
if (manifest.innerArchive) {
  if (path.basename(manifest.innerArchive) !== manifest.innerArchive)
    throw new Error('Invalid inner archive path');
  execFileSync(
    'tar',
    ['-xf', path.join(fileURLToPath(target), manifest.innerArchive), '-C', fileURLToPath(target)],
    { windowsHide: true, stdio: 'pipe' }
  );
}
execFileSync(path.join(fileURLToPath(target), 'mpv.exe'), ['--version'], {
  windowsHide: true,
  stdio: 'pipe',
  timeout: 5000,
});
console.log(JSON.stringify({ installed: true, directory: fileURLToPath(target), sha256: hash }));
