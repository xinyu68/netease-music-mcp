import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { runtimeIdentity, readyRuntime } from '../runtime/src/installation.mjs';
import { loadConfig } from '../runtime/src/config.mjs';

try {
  const config = await loadConfig();
  const identity = await runtimeIdentity(undefined, config.stateDir);
  if (!(await readyRuntime(identity))) {
    const root = fileURLToPath(new URL('../', import.meta.url));
    process.stderr.write(
      `NetEase Music needs first-time setup. Run: node "${path.join(root, 'runtime/scripts/setup.mjs')}" --plugin\n`
    );
    process.exitCode = 1;
  } else await import(pathToFileURL(path.join(identity.root, 'src/server.mjs')).href);
} catch {
  process.stderr.write(
    'NetEase Music could not start. Run the packaged setup script again and check the installation guide.\n'
  );
  process.exitCode = 1;
}
