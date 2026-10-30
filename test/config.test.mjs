import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, loadConfig } from '../src/config.mjs';
test('configuration defaults do not require an uploader project or official desktop client', () => {
  const c = validateConfig();
  assert.equal(c.playback.backend, 'direct');
  assert.ok(c.auth.sessionFile.endsWith('session.dpapi'));
  assert.equal(c.uploaderRuntime, undefined);
  assert.equal(c.clientExecutable, undefined);
});
test('configuration rejects invalid timing, buffers, volume, and backend', () => {
  for (const playback of [
    { backend: 'desktop' },
    { volume: 101 },
    { startupTimeoutMs: 0 },
    { bufferBytes: 1 },
    { level: 'unblock' },
  ])
    assert.throws(() => validateConfig({ playback }));
  assert.throws(() => validateConfig({ api: { timeoutMs: -1 } }));
});
test('missing optional local configuration can use defaults', async () => {
  const c = await loadConfig(new URL('../.data/nonexistent-test-config.json', import.meta.url));
  assert.equal(c.playback.level, 'exhigh');
});

test('configuration rejects wrong object types and blank credential paths', () => {
  for (const value of [
    null,
    [],
    true,
    { playback: null },
    { api: [] },
    { auth: false },
    { stateDir: 42 },
    { auth: { sessionFile: '' } },
  ])
    assert.throws(() => validateConfig(value));
});
