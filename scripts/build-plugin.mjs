import {
  mkdir,
  readFile,
  copyFile,
  readdir,
  writeFile,
  lstat,
  realpath,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../src/config.mjs';
import { runtimeFiles } from '../src/installation.mjs';

const destination = path.join(projectRoot, 'dist/plugin');
const { version } = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(projectRoot, 'plugin/plugin.json'), 'utf8'));
if (manifest.version !== version) throw new Error('Package and plugin versions differ');
await mkdir(path.join(projectRoot, 'dist'), { recursive: true });
const resolvedRoot = await realpath(projectRoot);
const resolvedDist = await realpath(path.join(projectRoot, 'dist'));
if (resolvedDist !== path.join(resolvedRoot, 'dist'))
  throw new Error('Refusing a redirected build directory');
try {
  if ((await lstat(destination)).isSymbolicLink())
    throw new Error('Refusing a symlinked plugin build directory');
  const previous = JSON.parse(await readFile(path.join(destination, 'plugin.json'), 'utf8'));
  if (previous.name !== manifest.name)
    throw new Error('Refusing to replace an unrelated build directory');
  // Absolute target has been verified to be this project's dist/plugin directory.
  await rm(destination, { recursive: true, force: true });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
async function copyTree(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Plugin source must not contain symlinks');
    if (entry.isDirectory())
      await copyTree(path.join(source, entry.name), path.join(target, entry.name));
    else if (entry.isFile())
      await copyFile(path.join(source, entry.name), path.join(target, entry.name));
  }
}
await copyTree(path.join(projectRoot, 'plugin'), destination);
for (const file of await runtimeFiles()) {
  const target = path.join(destination, 'runtime', file);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(projectRoot, file), target);
}
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md'])
  await copyFile(path.join(projectRoot, file), path.join(destination, file));
await writeFile(
  path.join(destination, 'README.md'),
  'This is the generated desktop plugin. See the source repository documentation. Run node runtime/scripts/setup.mjs --plugin to prepare the local runtime, then restart the Codex chat.\n'
);
console.log(`Plugin built: ${destination}`);
