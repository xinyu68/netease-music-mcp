import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let count = 0;
for (const directory of ['src', 'scripts', 'test', 'plugin/scripts']) {
  for (const entry of await readdir(new URL(`../${directory}/`, import.meta.url), {
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
    const file = fileURLToPath(new URL(`../${directory}/${entry.name}`, import.meta.url));
    execFileSync(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true });
    count++;
  }
}
console.log(`Syntax checked: ${count} modules.`);
