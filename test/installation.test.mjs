import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runtimeIdentity, copyRuntime, readyRuntime, findCli } from '../src/installation.mjs';

test('packaged sources and repository produce the same runtime identity, and changed code invalidates it', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ncm-runtime-test-'));
  try {
    const identity = await runtimeIdentity(undefined, temp);
    const { projectRoot } = await import('../src/config.mjs');
    await copyRuntime(projectRoot, identity);
    assert.equal((await runtimeIdentity(identity.root, temp)).fingerprint, identity.fingerprint);
    assert.equal(await readyRuntime(identity), false);
    assert.ok(
      identity.files.every(
        (file) => !/(^|\/)session\.dpapi$|\.local\.json$|node_modules/.test(file)
      )
    );
    await writeFile(
      path.join(identity.root, 'src/version.mjs'),
      'export const version = "changed";'
    );
    assert.notEqual((await runtimeIdentity(identity.root, temp)).fingerprint, identity.fingerprint);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('partial installation is never considered a prepared plugin runtime', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ncm-partial-test-'));
  try {
    const id = { root: temp, fingerprint: 'expected' };
    await writeFile(path.join(temp, '.ready.json'), JSON.stringify({ fingerprint: 'wrong' }));
    assert.equal(await readyRuntime(id), false);
    await writeFile(path.join(temp, '.ready.json'), JSON.stringify({ fingerprint: 'expected' }));
    assert.equal(await readyRuntime(id), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('npm is invoked through an actual executable or Node entrypoint rather than a shell command string', () => {
  const cli = findCli('npm');
  assert.ok(path.isAbsolute(cli.command));
  assert.ok(!/cmd\.exe|powershell/i.test(cli.command));
});
