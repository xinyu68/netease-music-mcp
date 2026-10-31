import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PlaybackPreferences } from '../src/playback-preferences.mjs';
import { loadConfig } from '../src/config.mjs';
import { createRuntime } from '../src/runtime.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ncm-volume-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, 'config.json');
  await writeFile(configFile, JSON.stringify({ stateDir: directory, playback: { volume: 45 } }));
  return { directory, configFile, preferences: new PlaybackPreferences(directory) };
}

test('first startup uses configured volume without creating a preference, then restores 100 and zero across fresh runtimes', async (t) => {
  const { directory, configFile, preferences } = await fixture(t);
  assert.equal((await loadConfig(configFile)).playback.volume, 45);
  assert.deepEqual(await readdir(directory), ['config.json']);
  const first = createRuntime(await loadConfig(configFile));
  let volume = 45;
  // Exercise the runtime's real preference wiring without starting audio or account workers.
  first.player.engine = {
    volume: async (value) => {
      volume = value;
    },
    snapshot: async () => ({ idle: true, paused: true, volume }),
    stop: async () => {},
    close: async () => {},
  };
  assert.equal((await first.player.volume(100, 'remember')).volume, 100);
  await first.close();
  assert.deepEqual(JSON.parse(await readFile(preferences.file, 'utf8')), { volume: 100 });
  for (const value of [100, 0]) {
    if (value === 0) await preferences.writeVolume(0);
    const fresh = createRuntime(await loadConfig(configFile));
    try {
      assert.equal((await fresh.player.status()).volume, value);
      assert.equal(fresh.engine.config.playback.volume, value);
    } finally {
      await fresh.close();
    }
  }
  assert.deepEqual((await readdir(directory)).sort(), ['config.json', 'playback-preferences.json']);
});

test('preferences survive source/config-directory changes when the user state directory is shared', async (t) => {
  const { directory, configFile, preferences } = await fixture(t);
  await preferences.writeVolume(100);
  const upgraded = path.join(directory, 'next-version');
  await mkdir(upgraded);
  const nextConfig = path.join(upgraded, 'config.json');
  await writeFile(nextConfig, JSON.stringify({ stateDir: directory }));
  assert.equal((await loadConfig(configFile)).playback.volume, 100);
  assert.equal((await loadConfig(nextConfig)).playback.volume, 100);
});

test('invalid saved settings fail explicitly instead of silently resetting the user volume', async (t) => {
  const { configFile, preferences } = await fixture(t);
  for (const text of [
    '{',
    'null',
    '[]',
    '{}',
    '{"volume":"100"}',
    '{"volume":101}',
    '{"volume":-1}',
  ]) {
    await writeFile(preferences.file, text);
    await assert.rejects(loadConfig(configFile), { code: 'PREFERENCES_READ_FAILED' });
  }
  await preferences.writeVolume(100);
  for (const volume of [-1, 101, 1.5, '100', null])
    await assert.rejects(preferences.writeVolume(volume), { code: 'INVALID_ARGUMENT' });
  assert.equal(await preferences.readVolume(30), 100);
});

test('an atomic replacement failure reports unsaved volume and cleans up only its own temporary file', async (t) => {
  const { directory, preferences } = await fixture(t);
  await mkdir(preferences.file);
  await assert.rejects(preferences.writeVolume(100), { code: 'VOLUME_SAVE_FAILED' });
  await assert.rejects(preferences.readVolume(30), { code: 'PREFERENCES_READ_FAILED' });
  assert.deepEqual((await readdir(directory)).sort(), ['config.json', 'playback-preferences.json']);
});
