import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MusicError, safeError } from './errors.mjs';
import { abortable, Mutations } from './async.mjs';

const validId = (id) => /^[1-9]\d{0,15}$/.test(String(id));
export class PlaybackController {
  constructor({ engine, resolver, catalog, config }) {
    this.engine = engine;
    this.resolver = resolver;
    this.catalog = catalog;
    this.config = config;
    this.mutations = new Mutations();
    this.epoch = 0;
    this.generation = 0;
    this.active = null;
    this.closed = false;
    this.source = null;
    this.ids = [];
    this.index = -1;
    this.queueName = '';
    this.queueMode = 'sequence';
    this.refill = null;
    this.needsRefill = false;
    this.recovery = 0;
    this.state = {
      phase: 'idle',
      songId: null,
      title: '',
      artists: [],
      position: 0,
      duration: 0,
      volume: config.playback.volume,
      verified: false,
      lastError: null,
    };
    engine.on?.('end-file', (event) => this.onEnd(event));
    engine.on?.('engine-error', () => {
      if (!this.closed && !['idle', 'stopped', 'ended'].includes(this.state.phase)) {
        this.state.phase = 'error';
        this.state.verified = false;
        this.state.lastError = safeError(new MusicError('PLAYER_DISCONNECTED'));
      }
    });
    engine.on?.('progress', (event) => {
      if (event.generation === this.generation && Number.isFinite(event.position))
        this.state.position = event.position;
    });
  }
  queue() {
    return {
      name: this.queueName,
      mode: this.queueMode,
      length: this.ids.length,
      index: this.index,
      items: this.ids.slice(Math.max(0, this.index), Math.max(0, this.index) + 5),
    };
  }
  async status() {
    const generation = this.generation;
    const s = await this.engine.snapshot();
    if (
      generation === this.generation &&
      !s.idle &&
      ['playing', 'paused', 'starting'].includes(this.state.phase)
    ) {
      this.state.position = s.position;
      this.state.duration = s.duration || this.state.duration;
      this.state.volume = s.volume ?? this.state.volume;
    }
    return {
      ...this.state,
      backend: 'direct-mpv',
      generation: this.generation,
      playing: this.state.phase === 'playing' && !s.paused && !s.idle && !s.buffering,
      paused: this.state.phase === 'paused',
      buffering: !s.idle && s.buffering,
      queue: this.queue(),
    };
  }
  check(epoch, signal) {
    if (this.closed || epoch !== this.epoch || signal?.aborted) throw new MusicError('CANCELLED');
  }
  async waitPlaying(position, epoch, signal) {
    const end = Date.now() + this.config.playback.startupTimeoutMs;
    let previous = null;
    while (Date.now() < end) {
      this.check(epoch, signal);
      const s = await this.engine.snapshot();
      if (
        !s.idle &&
        !s.paused &&
        !s.buffering &&
        s.audioReady &&
        previous != null &&
        s.position > previous + 0.02
      ) {
        this.state.position = s.position;
        this.state.duration = s.duration;
        return;
      }
      previous = s.position;
      await abortable(delay(100), signal);
    }
    throw new MusicError('PLAYER_TIMEOUT');
  }
  async startTrack(id, position, epoch, level = this.config.playback.level) {
    this.check(epoch);
    const active = new AbortController();
    this.active = active;
    const signal = active.signal;
    const generation = ++this.generation;
    this.state = {
      ...this.state,
      phase: 'starting',
      songId: String(id),
      title: '',
      artists: [],
      duration: 0,
      position,
      verified: false,
      lastError: null,
    };
    try {
      await this.engine.stop();
      this.check(epoch, signal);
      const [source, metadata] = await abortable(
        Promise.all([
          this.resolver.resolve(String(id), level),
          this.catalog.track(String(id)).catch(() => ({ id: String(id), title: '', artists: [] })),
        ]),
        signal
      );
      this.check(epoch, signal);
      this.source = source;
      this.state = {
        ...this.state,
        title: metadata.title || '',
        artists: metadata.artists || [],
        duration: source.duration,
        level: source.level,
        format: source.format,
        bitrate: source.bitrate,
      };
      await this.engine.load(source, { position, generation, signal });
      await this.waitPlaying(position, epoch, signal);
      this.check(epoch, signal);
      this.state.phase = 'playing';
      this.state.verified = true;
      return this.status();
    } catch (error) {
      if (epoch === this.epoch && generation === this.generation) {
        this.state.phase = 'error';
        this.state.verified = false;
        this.state.lastError = safeError(error);
        await this.engine.stop().catch(() => {});
      }
      throw error;
    } finally {
      if (this.active === active) this.active = null;
    }
  }
  play(id, requestId, { level = this.config.playback.level } = {}) {
    if (!validId(id) || !['standard', 'exhigh'].includes(level))
      return Promise.reject(new MusicError('INVALID_ARGUMENT'));
    const epoch = this.epoch;
    return this.mutations.submit(
      requestId,
      JSON.stringify(['play', String(id), level]),
      async () => {
        this.check(epoch);
        this.ids = [String(id)];
        this.index = 0;
        this.queueName = '';
        this.queueMode = 'sequence';
        this.refill = null;
        this.needsRefill = false;
        this.recovery = 0;
        return this.startTrack(String(id), 0, epoch, level);
      }
    );
  }
  playCollection(loader, requestId, signature) {
    const epoch = this.epoch;
    return this.mutations.submit(requestId, signature, async () => {
      this.check(epoch);
      const active = new AbortController();
      this.active = active;
      this.generation++;
      this.refill = null;
      this.needsRefill = false;
      this.queueMode = 'sequence';
      this.state.phase = 'starting';
      try {
        await this.engine.stop();
        this.check(epoch, active.signal);
        const collection = await abortable(loader(), active.signal);
        this.check(epoch, active.signal);
        if (
          !collection.ids.length ||
          collection.ids.length > 10000 ||
          !collection.ids.every(validId)
        )
          throw new MusicError('NOTHING_TO_PLAY');
        this.ids = collection.ids.map(String);
        this.queueName = collection.name || '';
        this.refill = typeof collection.refill === 'function' ? collection.refill : null;
        this.queueMode = this.refill ? 'heart' : 'sequence';
        this.index = 0;
        this.recovery = 0;
        return await this.startTrack(this.ids[0], 0, epoch);
      } catch (error) {
        if (epoch === this.epoch) {
          this.state.phase = 'error';
          this.state.lastError = safeError(error);
          await this.engine.stop().catch(() => {});
        }
        throw error;
      } finally {
        if (this.active === active) this.active = null;
      }
    });
  }
  pause(requestId) {
    const interrupt = this.state.phase === 'starting';
    return this.mutations.submit(
      requestId,
      'pause',
      async () => {
        if (this.state.phase === 'starting') {
          this.epoch++;
          this.generation++;
          this.active?.abort();
          await this.engine.stop();
          this.state.phase = 'paused';
          this.state.verified = false;
          return { ...(await this.status()), changed: true };
        }
        const changed = this.state.phase === 'playing';
        if (changed) {
          await this.engine.pause(true);
          const s = await this.engine.snapshot();
          if (!s.paused) throw new MusicError('PLAYER_FAILED');
          this.state.position = s.position;
          this.state.phase = 'paused';
        }
        return { ...(await this.status()), changed };
      },
      { priority: interrupt }
    );
  }
  resume(requestId) {
    const epoch = this.epoch;
    return this.mutations.submit(requestId, 'resume', async () => {
      this.check(epoch);
      if (this.state.phase === 'playing') return { ...(await this.status()), changed: false };
      if (this.needsRefill && this.refill) return this.refillAndPlay(epoch);
      if (!this.state.songId) throw new MusicError('NOTHING_TO_PLAY');
      const s = await this.engine.snapshot();
      const position = ['ended', 'stopped'].includes(this.state.phase) ? 0 : this.state.position;
      if (s.idle || !this.source || this.source.expiresAt < Date.now() + 10000) {
        return this.startTrack(
          this.state.songId,
          position,
          epoch,
          this.source?.level || this.config.playback.level
        );
      }
      await this.engine.pause(false);
      await this.waitPlaying(position, epoch);
      this.state.phase = 'playing';
      this.state.verified = true;
      return { ...(await this.status()), changed: true };
    });
  }
  stop(requestId) {
    return this.mutations.submit(
      requestId,
      'stop',
      async () => {
        this.epoch++;
        this.generation++;
        this.active?.abort();
        await this.engine.stop();
        this.source = null;
        this.refill = null;
        this.needsRefill = false;
        this.queueMode = 'sequence';
        this.state = {
          ...this.state,
          phase: 'stopped',
          position: 0,
          verified: false,
          lastError: null,
        };
        return this.status();
      },
      { priority: true }
    );
  }
  seek(position, requestId) {
    const epoch = this.epoch;
    return this.mutations.submit(requestId, 'seek:' + position, async () => {
      this.check(epoch);
      if (
        !Number.isFinite(position) ||
        position < 0 ||
        position >= this.state.duration ||
        !['playing', 'paused'].includes(this.state.phase)
      )
        throw new MusicError('INVALID_ARGUMENT');
      const paused = this.state.phase === 'paused';
      await this.engine.seek(position);
      this.check(epoch);
      if (paused) await this.engine.pause(true);
      let s;
      const end = Date.now() + this.config.playback.commandTimeoutMs;
      do {
        s = await this.engine.snapshot();
        if (Math.abs(s.position - position) < 0.35) break;
        await delay(50);
        this.check(epoch);
      } while (Date.now() < end);
      if (Math.abs(s.position - position) >= 0.35) throw new MusicError('PLAYER_TIMEOUT');
      this.state.position = s.position;
      return this.status();
    });
  }
  volume(value, requestId) {
    if (!Number.isInteger(value) || value < 0 || value > 100)
      return Promise.reject(new MusicError('INVALID_ARGUMENT'));
    const epoch = this.epoch;
    return this.mutations.submit(requestId, 'volume:' + value, async () => {
      this.check(epoch);
      await this.engine.volume(value);
      this.check(epoch);
      this.state.volume = value;
      return this.status();
    });
  }
  move(delta, requestId) {
    const epoch = this.epoch;
    return this.mutations.submit(requestId, 'move:' + delta, async () => {
      this.check(epoch);
      const next = this.index + delta;
      if (delta === 1 && next === this.ids.length && this.refill) return this.refillAndPlay(epoch);
      if (![1, -1].includes(delta) || next < 0 || next >= this.ids.length)
        throw new MusicError('QUEUE_BOUNDARY');
      this.index = next;
      this.recovery = 0;
      return this.startTrack(this.ids[next], 0, epoch);
    });
  }
  onEnd(event) {
    if (
      this.closed ||
      event.generation !== this.generation ||
      !['eof', 'error'].includes(event.reason)
    )
      return;
    const epoch = this.epoch,
      generation = this.generation;
    this.mutations
      .submit('event:' + randomUUID(), 'end', async () => {
        if (this.closed || epoch !== this.epoch || generation !== this.generation) return;
        if (event.reason === 'error') {
          if (
            this.state.phase === 'playing' &&
            this.source?.expiresAt < Date.now() + 30000 &&
            this.recovery < 1
          ) {
            this.recovery++;
            return this.startTrack(this.state.songId, this.state.position, epoch);
          }
          this.state.phase = 'error';
          this.state.verified = false;
          this.state.lastError = safeError(new MusicError('PLAYER_FAILED'));
          return;
        }
        if (this.state.phase === 'playing' && this.index + 1 < this.ids.length) {
          this.index++;
          this.recovery = 0;
          return this.startTrack(this.ids[this.index], 0, epoch);
        }
        if (this.state.phase === 'playing' && this.refill) return this.refillAndPlay(epoch);
        this.state.phase = 'ended';
        this.state.position = this.state.duration;
        this.state.verified = false;
      })
      .catch(() => {});
  }
  async refillAndPlay(epoch) {
    this.check(epoch);
    const refill = this.refill;
    if (!refill) throw new MusicError('QUEUE_BOUNDARY');
    const active = new AbortController();
    this.active = active;
    const generation = ++this.generation;
    this.needsRefill = true;
    this.state.phase = 'starting';
    this.state.verified = false;
    this.state.lastError = null;
    try {
      await this.engine.stop();
      this.check(epoch, active.signal);
      const collection = await abortable(refill(this.state.songId), active.signal);
      this.check(epoch, active.signal);
      if (
        !Array.isArray(collection.ids) ||
        collection.ids.length > 10000 ||
        !collection.ids.every(validId)
      )
        throw new MusicError('INVALID_RESPONSE');
      const ids = [...new Set(collection.ids.map(String))].filter((id) => id !== this.state.songId);
      if (!ids.length) throw new MusicError('NOTHING_TO_PLAY');
      this.ids.push(...ids);
      this.index++;
      if (this.ids.length > 10000) {
        const trim = this.ids.length - 10000;
        this.ids.splice(0, trim);
        this.index -= trim;
      }
      this.needsRefill = false;
      this.recovery = 0;
      return await this.startTrack(this.ids[this.index], 0, epoch);
    } catch (error) {
      if (epoch === this.epoch && generation === this.generation) {
        this.state.phase = 'error';
        this.state.lastError = safeError(error);
      }
      throw error;
    } finally {
      if (this.active === active) this.active = null;
    }
  }
  async close() {
    this.closed = true;
    this.epoch++;
    this.generation++;
    this.active?.abort();
    this.refill = null;
    this.needsRefill = false;
    await this.engine.close();
    this.source = null;
    this.state.phase = 'stopped';
    this.state.verified = false;
    this.state.position = 0;
  }
}
