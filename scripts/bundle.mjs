import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { projectRoot } from '../src/config.mjs';

const { version } = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const directory = path.join(projectRoot, '.data', 'releases');
await mkdir(directory, { recursive: true });
const archive = path.join(directory, `netease-music-mcp-${version}.tar.gz`);
// Explicit source-only allowlist: never recurse into local runtime/state directories.
const files = [
  'package.json',
  'package-lock.json',
  '.prettierrc.json',
  '.gitignore',
  '.gitattributes',
  '.github',
  '.agents/plugins/marketplace.json',
  'plugin',
  'examples',
  'LICENSE',
  'CONTRIBUTING.md',
  'README.md',
  'AGENTS.md',
  'CHANGELOG.md',
  'THIRD_PARTY_NOTICES.md',
  'config.example.json',
  'src',
  'scripts',
  'test',
  'tools',
  'docs/MCP工具说明.md',
  'docs/安装与使用.md',
  'docs/登录与凭据.md',
  'docs/架构与维护.md',
  'docs/本机验收记录.md',
  'docs/无客户端音频流可行性.md',
  'vendor/login/windows/WebViewLogin.cs',
  'vendor/login/macos/LoginWindow.swift',
  'vendor/desk-companion/LICENSE',
];
execFileSync('tar', ['-czf', archive, '-C', projectRoot, ...files], {
  windowsHide: true,
  stdio: 'pipe',
});
const entries = execFileSync('tar', ['-tzf', archive], {
  encoding: 'utf8',
  windowsHide: true,
}).split(/\r?\n/);
if (
  entries.some((entry) =>
    /(^|\/)(node_modules|evidence|\.data|\.tools|webview2-profile|history)(\/|$)|\.local\.json$|session\.dpapi$|\.(exe|dll|nupkg)$/.test(
      entry
    )
  )
) {
  throw new Error('Source archive contains an excluded runtime or local file');
}
const sha256 = createHash('sha256')
  .update(await readFile(archive))
  .digest('hex');
await writeFile(`${archive}.sha256`, `${sha256}  ${path.basename(archive)}\n`);
console.log(
  JSON.stringify({ archive, sha256, includesCredentials: false, includesBinaries: false }, null, 2)
);
execFileSync(process.execPath, [path.join(projectRoot, 'scripts/build-plugin.mjs')], {
  windowsHide: true,
  stdio: 'inherit',
});
const pluginArchive = path.join(directory, `netease-music-mcp-${version}-plugin.tar.gz`);
execFileSync('tar', ['-czf', pluginArchive, '-C', path.join(projectRoot, 'dist/plugin'), '.'], {
  windowsHide: true,
  stdio: 'pipe',
});
const pluginEntries = execFileSync('tar', ['-tzf', pluginArchive], {
  encoding: 'utf8',
  windowsHide: true,
}).split(/\r?\n/);
if (
  pluginEntries.some((entry) =>
    /(^|\/)(node_modules|evidence|\.data|\.tools|webview2-profile|history)(\/|$)|\.local\.json$|session\.dpapi$|\.(exe|dll|nupkg)$/.test(
      entry
    )
  )
)
  throw new Error('Plugin archive contains an excluded runtime or local file');
const pluginSha256 = createHash('sha256')
  .update(await readFile(pluginArchive))
  .digest('hex');
await writeFile(`${pluginArchive}.sha256`, `${pluginSha256}  ${path.basename(pluginArchive)}\n`);
console.log(
  JSON.stringify(
    { pluginArchive, sha256: pluginSha256, includesCredentials: false, includesBinaries: false },
    null,
    2
  )
);
