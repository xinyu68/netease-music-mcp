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
function rig(options = {}) {
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
  const c = new PlaybackController({
    engine,
    resolver,
    catalog,
    config: validateConfig(),
    ...options,
  });
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

test('heart mode automatically refills at EOF and ordinary playback exits the mode', async () => {
  const { c, engine } = rig();
  let calls = 0;
  await c.playCollection(
    async () => ({
      name: '心动模式',
      ids: ['1'],
      refill: async (last) => {
        calls++;
        assert.equal(last, '1');
        return { ids: ['1', '2', '2'] };
      },
    }),
    'heart',
    'heart'
  );
  engine.emit('end-file', { reason: 'eof', generation: engine.generation });
  await until(() => c.state.songId === '2' && c.state.phase === 'playing');
  assert.equal(calls, 1);
  assert.equal(c.queue().mode, 'heart');
  await c.play('9', 'ordinary');
  assert.equal(c.queue().mode, 'sequence');
  engine.emit('end-file', { reason: 'eof', generation: engine.generation });
  await until(() => c.state.phase === 'ended');
  assert.equal(calls, 1);
});

test('next at the end of a heart batch obtains another batch without model involvement', async () => {
  const { c } = rig();
  await c.playCollection(
    async () => ({ ids: ['1'], refill: async () => ({ ids: ['2'] }) }),
    'heart',
    'heart'
  );
  assert.equal((await c.move(1, 'next')).songId, '2');
});

test('stop cancels a heart refill and late recommendations cannot restart playback', async () => {
  const { c, engine } = rig();
  let release;
  await c.playCollection(
    async () => ({
      ids: ['1'],
      refill: () =>
        new Promise((r) => {
          release = r;
        }),
    }),
    'heart',
    'heart'
  );
  engine.emit('end-file', { reason: 'eof', generation: engine.generation });
  await until(() => Boolean(release));
  await c.stop('stop');
  release({ ids: ['2'] });
  await delay(20);
  assert.equal(engine.loads.length, 1);
  assert.equal(c.state.phase, 'stopped');
  assert.equal(c.queue().mode, 'sequence');
});

test('pause during heart refill preserves the ability to continue into a new batch', async () => {
  const { c, engine } = rig();
  let release,
    calls = 0;
  await c.playCollection(
    async () => ({
      ids: ['1'],
      refill: () =>
        ++calls === 1
          ? new Promise((r) => {
              release = r;
            })
          : Promise.resolve({ ids: ['3'] }),
    }),
    'heart',
    'heart'
  );
  engine.emit('end-file', { reason: 'eof', generation: engine.generation });
  await until(() => Boolean(release));
  await c.pause('pause');
  release({ ids: ['2'] });
  await delay(10);
  assert.equal(c.state.phase, 'paused');
  assert.equal((await c.resume('resume')).songId, '3');
});

test('mode switching preserves playback and pause position, deduplicates and rejects invalid modes', async () => {
  const { c, engine } = rig({ randomIndex: () => 0 });
  await c.playCollection(async () => ({ ids: ['1', '2', '3'] }), 'list', 'list');
  await c.seek(42, 'seek');
  const shuffled = await c.setPlaybackMode('shuffle', 'mode');
  assert.equal(shuffled.playing, true);
  assert.equal(shuffled.songId, '1');
  assert.ok(shuffled.position >= 42);
  assert.equal(shuffled.queue.playbackMode, 'shuffle');
  assert.equal(shuffled.changed, true);
  await c.setPlaybackMode('shuffle', 'mode');
  assert.equal((await c.setPlaybackMode('shuffle', 'same-mode')).changed, false);
  assert.equal(engine.loads.length, 1);
  await assert.rejects(c.setPlaybackMode('sequence', 'mode'), (e) => e.code === 'REQUEST_CONFLICT');
  await assert.rejects(c.setPlaybackMode('invalid', 'bad'), (e) => e.code === 'INVALID_ARGUMENT');
  await c.pause('pause');
  const paused = await c.setPlaybackMode('repeat_one', 'repeat');
  assert.equal(paused.paused, true);
  assert.equal(paused.songId, '1');
  assert.ok(paused.position >= 42);
  assert.equal(engine.loads.length, 1);
  const resumed = await c.resume('resume');
  assert.equal(resumed.queue.playbackMode, 'repeat_one');
  assert.equal(resumed.playing, true);
});

test('shuffle chooses from the full queue, preserves navigation history and visits every item once', async () => {
  const { c, engine } = rig({ randomIndex: () => 0 });
  const first = await c.playCollection(async () => ({ ids: ['1', '2', '3'] }), 'list', 'list', {
    mode: 'shuffle',
  });
  assert.equal(first.songId, '2');
  assert.deepEqual(first.queue.items, ['2', '3', '1']);
  const next = await c.move(1, 'next');
  assert.equal(next.songId, '3');
  assert.equal(next.queue.index, 1);
  assert.equal((await c.move(-1, 'back')).songId, '2');
  assert.equal((await c.move(1, 'forward')).songId, '3');
  engine.emit('end-file', { reason: 'eof', generation: engine.generation });
  await until(() => c.state.songId === '1' && c.state.phase === 'playing');
  const final = await c.status();
  assert.equal(final.queue.index, 2);
  assert.deepEqual(final.queue.items, ['1']);
  await assert.rejects(c.move(1, 'boundary'), (e) => e.code === 'QUEUE_BOUNDARY');
  engine.emit('end-file', { reason: 'eof', generation: engine.generation });
  await until(() => c.state.phase === 'ended');
  assert.deepEqual(
    engine.loads.map((load) => load.source.songId),
    ['2', '3', '2', '3', '1']
  );
});

test('returning from shuffle to sequence preserves the song and restores the original list order', async () => {
  const { c, engine } = rig({ randomIndex: () => 0 });
  await c.playCollection(async () => ({ ids: ['1', '2', '3', '4'] }), 'list', 'list', {
    mode: 'shuffle',
  });
  assert.equal(c.state.songId, '2');
  const sequential = await c.setPlaybackMode('sequence', 'sequence');
  assert.equal(sequential.songId, '2');
  assert.deepEqual(sequential.queue.items, ['2', '3', '4']);
  assert.equal(engine.loads.length, 1);
  assert.equal((await c.move(1, 'next')).songId, '3');
});

test('repeat-one replays EOF from zero, ignores stale events and still allows manual track changes', async () => {
  const { c, engine } = rig();
  await c.playCollection(async () => ({ ids: ['1', '2', '3'] }), 'list', 'list', {
    mode: 'repeat_one',
  });
  const old = engine.generation;
  await c.seek(179, 'near-end');
  engine.emit('end-file', { reason: 'eof', generation: old });
  await until(() => engine.loads.length === 2 && c.state.phase === 'playing');
  assert.equal(c.state.songId, '1');
  assert.equal(engine.loads[1].options.position, 0);
  engine.emit('end-file', { reason: 'eof', generation: old });
  await delay(20);
  assert.equal(engine.loads.length, 2);
  assert.equal((await c.move(1, 'next')).songId, '2');
  engine.emit('end-file', { reason: 'eof', generation: engine.generation });
  await until(() => engine.loads.length === 4 && c.state.phase === 'playing');
  assert.equal(c.state.songId, '2');
  await c.setPlaybackMode('sequence', 'sequence');
  engine.emit('end-file', { reason: 'eof', generation: engine.generation });
  await until(() => c.state.songId === '3' && c.state.phase === 'playing');
});

test('repeat-one does not restart a paused song or a stopped in-flight replay', async () => {
  const { c, engine, resolver } = rig();
  await c.play('1', 'play', { mode: 'repeat_one' });
  await c.pause('pause');
  engine.emit('end-file', { reason: 'eof', generation: engine.generation });
  await delay(20);
  assert.equal(c.state.phase, 'paused');
  assert.equal(engine.loads.length, 1);
  await c.resume('resume');
  let release;
  resolver.resolve = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  engine.emit('end-file', { reason: 'eof', generation: engine.generation });
  await until(() => Boolean(release));
  await c.stop('stop');
  release({
    songId: '1',
    url: 'https://m801.music.126.net/test',
    duration: 180,
    expiresAt: Date.now() + 60000,
  });
  await delay(20);
  assert.equal(c.state.phase, 'stopped');
  assert.equal(engine.loads.length, 1);
});

test('shuffle and repeat-one coexist with heart recommendations without premature refill', async () => {
  const { c, engine } = rig({ randomIndex: () => 0 });
  let calls = 0;
  await c.playCollection(
    async () => ({
      ids: ['1', '2', '3'],
      refill: async () => {
        calls++;
        return { ids: ['4', '5'] };
      },
    }),
    'heart',
    'heart',
    { mode: 'shuffle' }
  );
  assert.equal(c.state.songId, '2');
  assert.equal((await c.move(1, 'next-1')).songId, '3');
  assert.equal((await c.move(1, 'next-2')).songId, '1');
  assert.equal(calls, 0);
  const refilled = await c.move(1, 'refill');
  assert.equal(refilled.songId, '5');
  assert.equal(refilled.queue.mode, 'heart');
  assert.equal(refilled.queue.playbackMode, 'shuffle');
  assert.deepEqual(refilled.queue.items, ['5', '4']);
  assert.equal(calls, 1);
  assert.equal((await c.move(-1, 'previous')).songId, '1');
  await c.setPlaybackMode('repeat_one', 'repeat');
  const loads = engine.loads.length;
  engine.emit('end-file', { reason: 'eof', generation: engine.generation });
  await until(() => engine.loads.length === loads + 1 && c.state.phase === 'playing');
  assert.equal(c.state.songId, '1');
  assert.equal(calls, 1);
});

test('playback mode persists across queue replacement and stop; explicit mode is part of deduplication', async () => {
  const { c } = rig({ randomIndex: () => 0 });
  await c.setPlaybackMode('shuffle', 'mode');
  const playing = await c.playCollection(async () => ({ ids: ['1', '2'] }), 'list', 'list');
  assert.equal(playing.songId, '2');
  await assert.rejects(
    c.playCollection(async () => ({ ids: ['1', '2'] }), 'list', 'list', { mode: 'repeat_one' }),
    (e) => e.code === 'REQUEST_CONFLICT'
  );
  assert.equal((await c.stop('stop')).queue.playbackMode, 'shuffle');
  const next = await c.play('3', 'play', { mode: 'repeat_one' });
  assert.equal(next.queue.playbackMode, 'repeat_one');
  assert.equal((await c.play('4', 'play-again')).queue.playbackMode, 'repeat_one');
});

test('shuffle heart refill remaps navigation history when the bounded queue drops old entries', async () => {
  const { c } = rig({ randomIndex: () => 0 });
  await c.playCollection(
    async () => ({ ids: ['1', '2', '3'], refill: async () => ({ ids: ['4', '5'] }) }),
    'heart',
    'heart',
    { mode: 'shuffle' }
  );
  await c.move(1, 'next-1');
  await c.move(1, 'next-2');
  // Represent an already-consumed history window without playing ten thousand fake tracks.
  const prefix = Array.from({ length: 9997 }, (_, i) => String(i + 100));
  c.ids = [...prefix, ...c.ids];
  c.index += prefix.length;
  c.shuffleOrder = [
    ...prefix.map((_, i) => i),
    ...c.shuffleOrder.map((index) => index + prefix.length),
  ];
  c.shufflePosition += prefix.length;
  const refilled = await c.move(1, 'refill');
  assert.equal(refilled.queue.length, 10000);
  assert.equal(refilled.queue.index, 9998);
  assert.deepEqual(refilled.queue.items, ['5', '4']);
  assert.ok(c.shuffleOrder.every((index) => index >= 0 && index < c.ids.length));
  assert.equal((await c.move(-1, 'back')).songId, '1');
  assert.equal((await c.move(1, 'forward')).songId, '5');
  assert.equal((await c.move(1, 'next-new')).songId, '4');
});

test('repeat-one stops on an authorization failure instead of repeatedly retrying a protected song', async () => {
  const { c, engine, resolver } = rig();
  await c.play('1', 'play', { mode: 'repeat_one' });
  let calls = 0;
  resolver.resolve = async () => {
    calls++;
    throw new MusicError('NO_PLAY_PERMISSION');
  };
  engine.emit('end-file', { reason: 'eof', generation: engine.generation });
  await until(() => c.state.phase === 'error');
  await delay(20);
  assert.equal(calls, 1);
  assert.equal(engine.loads.length, 1);
  assert.equal(c.state.lastError.code, 'NO_PLAY_PERMISSION');
});
