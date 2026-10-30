import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { PlaybackController } from '../src/playback-controller.mjs';
import { validateConfig } from '../src/config.mjs';
import { MusicError } from '../src/errors.mjs';
class FakeEngine extends EventEmitter {
  constructor() {
    super();
    this.s = { idle: true, paused: true, position: 0, duration: 180, audioReady: true, volume: 30 };
    this.loads = [];
    this.actions = [];
  }
  async snapshot() {
    if (!this.s.idle && !this.s.paused) this.s.position += 0.05;
    return { ...this.s };
  }
  async load(source, options) {
    this.loads.push({ source, options });
    this.generation = options.generation;
    this.s = {
      ...this.s,
      idle: false,
      paused: false,
      position: options.position,
      duration: source.duration,
    };
  }
  async stop() {
    this.actions.push('stop');
    this.s.idle = true;
    this.s.position = 0;
  }
  async pause(value) {
    this.actions.push(value ? 'pause' : 'resume');
    this.s.paused = value;
  }
  async seek(value) {
    this.s.position = value;
  }
  async volume(value) {
    this.s.volume = value;
  }
  async close() {
    this.s.idle = true;
    this.s.paused = true;
  }
}
function rig() {
  const engine = new FakeEngine();
  let resolves = 0;
  const resolver = {
    async resolve(id) {
      resolves++;
      return {
        songId: id,
        url: 'https://m801.music.126.net/a.mp3?token=secret-test',
        duration: 180,
        expiresAt: Date.now() + 60000,
        level: 'exhigh',
        format: 'mp3',
        bitrate: 320000,
      };
    },
  };
  const catalog = {
    async track(id) {
      return { id, title: 'track ' + id, artists: ['test'] };
    },
  };
  const c = new PlaybackController({ engine, resolver, catalog, config: validateConfig() });
  return { c, engine, resolver, count: () => resolves };
}
async function until(predicate) {
  for (let i = 0; i < 60; i++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail('State transition timed out');
}
test('play waits for actual progress; pause is idempotent; resume does not resolve a valid source again', async () => {
  const { c, engine, count } = rig();
  const playing = await c.play('1', 'p');
  assert.equal(playing.playing, true);
  assert.equal(playing.verified, true);
  const paused = await c.pause('a'),
    again = await c.pause('b');
  assert.equal(paused.paused, true);
  assert.equal(again.changed, false);
  assert.equal(engine.actions.filter((x) => x === 'pause').length, 1);
  await c.resume('r');
  assert.equal(count(), 1);
  await c.stop('s');
  const state = await c.status();
  assert.equal(state.phase, 'stopped');
  assert.equal(state.position, 0);
  assert.equal(state.playing, false);
});
test('stop cancels an in-flight resolution and queued old commands; late responses never restart audio', async () => {
  const { c, engine, resolver } = rig();
  let release;
  resolver.resolve = () =>
    new Promise((r) => {
      release = r;
    });
  const p = c.play('1', 'p'),
    rejected = assert.rejects(p, (e) => e.code === 'CANCELLED');
  await until(() => Boolean(release));
  const q = c.play('2', 'q'),
    qRejected = assert.rejects(q, (e) => e.code === 'CANCELLED');
  await c.stop('stop');
  await rejected;
  await qRejected;
  release({
    songId: '1',
    duration: 180,
    url: 'https://m801.music.126.net/a',
    expiresAt: Date.now() + 60000,
  });
  await delay(10);
  assert.equal(engine.loads.length, 0);
  assert.equal((await c.status()).phase, 'stopped');
});
test('same request deduplicates; changing params with the same ID is rejected', async () => {
  const { c, engine } = rig();
  await Promise.all([c.play('1', 'same'), c.play('1', 'same')]);
  assert.equal(engine.loads.length, 1);
  await assert.rejects(c.play('2', 'same'), (e) => e.code === 'REQUEST_CONFLICT');
});
test('an expired paused source is refreshed at the retained position', async () => {
  const { c, engine, count } = rig();
  await c.play('1', 'p');
  await c.pause('a');
  await c.seek(42, 'seek');
  c.source.expiresAt = Date.now() - 1;
  await c.resume('r');
  assert.equal(count(), 2);
  assert.equal(engine.loads[1].options.position, 42);
  assert.equal((await c.status()).songId, '1');
});
test('seek while paused preserves pause; invalid seeks and volume are rejected', async () => {
  const { c } = rig();
  await c.play('1', 'p');
  await c.pause('a');
  const s = await c.seek(32, 'seek');
  assert.equal(s.position, 32);
  assert.equal(s.paused, true);
  await assert.rejects(c.seek(999, 'bad'), (e) => e.code === 'INVALID_ARGUMENT');
  await assert.rejects(c.volume(101, 'volume'), (e) => e.code === 'INVALID_ARGUMENT');
  assert.equal((await c.volume(15, 'v')).volume, 15);
});
test('natural end advances the queue; stale end events cannot advance a newer stream', async () => {
  const { c, engine } = rig();
  await c.playCollection(async () => ({ name: 'list', ids: ['1', '2'] }), 'queue', 'queue');
  const old = engine.generation;
  engine.emit('end-file', { reason: 'eof', generation: old });
  await until(() => c.state.songId === '2' && c.state.phase === 'playing');
  engine.emit('end-file', { reason: 'eof', generation: old });
  await delay(20);
  assert.equal(c.state.songId, '2');
  assert.equal(c.state.phase, 'playing');
  engine.emit('end-file', { reason: 'eof', generation: engine.generation });
  await until(() => c.state.phase === 'ended');
  assert.equal(c.state.position, 180);
});
test('pause cancels pending playlist preparation and prevents future playback', async () => {
  const { c, engine } = rig();
  let release;
  const p = c.playCollection(
    () =>
      new Promise((r) => {
        release = r;
      }),
    'queue',
    'queue'
  );
  const rejected = assert.rejects(p, (e) => e.code === 'CANCELLED');
  await until(() => Boolean(release));
  await c.pause('a');
  await rejected;
  release({ ids: ['1'], name: 'late' });
  await delay(10);
  assert.equal(engine.loads.length, 0);
  assert.equal(c.state.phase, 'paused');
});
test('expired-stream error has at most one automatic recovery; repeated failure becomes explicit', async () => {
  const { c, engine, count } = rig();
  await c.play('1', 'p');
  c.source.expiresAt = Date.now() - 1;
  engine.emit('end-file', { reason: 'error', generation: engine.generation });
  await until(() => engine.loads.length === 2 && c.state.phase === 'playing');
  assert.equal(count(), 2);
  c.source.expiresAt = Date.now() - 1;
  engine.emit('end-file', { reason: 'error', generation: engine.generation });
  await until(() => c.state.phase === 'error');
  assert.equal(count(), 2);
  assert.equal(c.state.lastError.code, 'PLAYER_FAILED');
});
test('preview failure remains an error without leaking the signed URL', async () => {
  const { c, resolver } = rig();
  resolver.resolve = async () => {
    throw new MusicError('PREVIEW_ONLY', 'secret-url-should-not-appear');
  };
  await assert.rejects(c.play('1', 'p'));
  const s = await c.status();
  assert.equal(s.phase, 'error');
  assert.equal(s.verified, false);
  assert.equal(s.lastError.code, 'PREVIEW_ONLY');
  assert.ok(!JSON.stringify(s).includes('secret-url'));
});
test('public state never exposes private playback URLs and close cancels pending work', async () => {
  const { c } = rig();
  await c.play('1', 'p');
  const s = await c.status();
  assert.ok(!JSON.stringify(s).includes('secret-test'));
  assert.ok(!JSON.stringify(s).includes('https://'));
  await c.close();
  await assert.rejects(c.play('2', 'late'), (e) => e.code === 'CANCELLED');
});
