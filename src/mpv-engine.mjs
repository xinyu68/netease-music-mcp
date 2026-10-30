import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdtemp, chmod, unlink, rmdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { MusicError } from './errors.mjs';
export class MpvEngine extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.child = null;
    this.socket = null;
    this.starting = null;
    this.pending = new Map();
    this.sequence = 0;
    this.entryGenerations = new Map();
    this.loadGeneration = null;
    this.directory = null;
    this.ipcPath = null;
    this.closing = false;
  }
  async start() {
    if (this.socket && !this.socket.destroyed) return;
    if (this.starting) return this.starting;
    this.starting = this._start();
    try {
      await this.starting;
      await this.command(['observe_property', 1, 'time-pos']);
    } finally {
      this.starting = null;
    }
  }
  async _start() {
    this.closing = false;
    if (process.platform === 'win32')
      this.ipcPath = `\\\\.\\pipe\\netease-music-${process.pid}-${randomUUID()}`;
    else {
      this.directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-'));
      await chmod(this.directory, 0o700);
      this.ipcPath = path.join(this.directory, 'mpv.sock');
    }
    const p = this.config.playback;
    const args = [
      '--idle=yes',
      '--no-video',
      '--no-terminal',
      '--no-config',
      '--load-scripts=no',
      '--ytdl=no',
      '--input-terminal=no',
      `--input-ipc-server=${this.ipcPath}`,
      '--cache=yes',
      `--cache-secs=${p.cacheSeconds}`,
      `--demuxer-max-bytes=${p.bufferBytes}`,
      '--demuxer-max-back-bytes=1048576',
      '--network-timeout=10',
      `--volume=${p.volume}`,
    ];
    const child = spawn(p.mpvPath, args, { windowsHide: true, stdio: 'ignore' });
    this.child = child;
    let failed = false;
    child.once('error', () => {
      failed = true;
    });
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = null;
      this.socket?.destroy();
      if (!this.closing) this.emit('engine-error', new MusicError('PLAYER_DISCONNECTED'));
    });
    const end = Date.now() + p.startupTimeoutMs;
    while (Date.now() < end && !failed && this.child) {
      try {
        const socket = await new Promise((resolve, reject) => {
          const s = net.createConnection(this.ipcPath);
          s.once('error', () => {
            s.destroy();
            reject(new Error('not-ready'));
          });
          s.once('connect', () => resolve(s));
        });
        this.attach(socket);
        return;
      } catch {
        await delay(100);
      }
    }
    child.kill();
    throw new MusicError(failed ? 'MPV_NOT_FOUND' : 'PLAYER_TIMEOUT');
  }
  attach(socket) {
    this.socket = socket;
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) {
        socket.destroy();
        return;
      }
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.request_id != null) {
          const p = this.pending.get(message.request_id);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(message.request_id);
            message.error === 'success'
              ? p.resolve(message.data)
              : p.reject(new MusicError('PLAYER_COMMAND_FAILED'));
          }
        }
        if (message.event === 'start-file') {
          this.currentEntry = message.playlist_entry_id;
          this.entryGenerations.set(message.playlist_entry_id, this.loadGeneration);
          if (this.entryGenerations.size > 64)
            this.entryGenerations.delete(this.entryGenerations.keys().next().value);
        }
        if (
          message.event === 'property-change' &&
          message.name === 'time-pos' &&
          Number.isFinite(message.data)
        )
          this.emit('progress', {
            generation: this.entryGenerations.get(this.currentEntry) ?? null,
            position: message.data,
          });
        if (message.event === 'end-file')
          this.emit('end-file', {
            reason: message.reason,
            generation: this.entryGenerations.get(message.playlist_entry_id) ?? null,
          });
      }
    });
    const attachedChild = this.child;
    const disconnected = () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new MusicError('PLAYER_DISCONNECTED'));
      }
      this.pending.clear();
      if (!this.closing && this.child === attachedChild) {
        this.child = null;
        attachedChild?.kill();
        this.emit('engine-error', new MusicError('PLAYER_DISCONNECTED'));
      }
    };
    socket.on('error', disconnected);
    socket.on('close', disconnected);
  }
  async command(command) {
    if (!this.socket || this.socket.destroyed) throw new MusicError('PLAYER_DISCONNECTED');
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new MusicError('PLAYER_TIMEOUT'));
      }, this.config.playback.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ command, request_id: id }) + '\n', (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new MusicError('PLAYER_DISCONNECTED'));
        }
      });
    });
  }
  async property(name, fallback = null) {
    try {
      return await this.command(['get_property', name]);
    } catch (error) {
      if (error.code === 'PLAYER_COMMAND_FAILED') return fallback;
      throw error;
    }
  }
  async snapshot() {
    if (!this.socket || this.socket.destroyed)
      return {
        idle: true,
        position: 0,
        duration: 0,
        paused: true,
        buffering: false,
        audioReady: false,
      };
    const [position, duration, paused, idle, buffering, audio, volume] = await Promise.all([
      this.property('time-pos', 0),
      this.property('duration', 0),
      this.property('pause', true),
      this.property('idle-active', true),
      this.property('paused-for-cache', false),
      this.property('audio-out-params'),
      this.property('volume', this.config.playback.volume),
    ]);
    return {
      position: Number(position) || 0,
      duration: Number(duration) || 0,
      paused: Boolean(paused),
      idle: Boolean(idle),
      buffering: Boolean(buffering),
      audioReady: Boolean(audio),
      volume: Number(volume),
    };
  }
  async load(source, { position = 0, generation, signal } = {}) {
    await this.start();
    if (signal?.aborted) throw new MusicError('CANCELLED');
    this.loadGeneration = generation;
    await this.command(['set_property', 'pause', true]);
    if (signal?.aborted) throw new MusicError('CANCELLED');
    await this.command(['loadfile', source.url, 'replace']);
    const end = Date.now() + this.config.playback.startupTimeoutMs;
    let loaded = false;
    while (Date.now() < end) {
      if (signal?.aborted) throw new MusicError('CANCELLED');
      const state = await this.snapshot();
      const currentPath = await this.property('path');
      if (!state.idle && state.duration > 0 && state.audioReady && currentPath === source.url) {
        loaded = true;
        break;
      }
      await delay(100);
    }
    if (!loaded) throw new MusicError('PLAYER_TIMEOUT');
    if (signal?.aborted) throw new MusicError('CANCELLED');
    if (position > 0) await this.command(['seek', position, 'absolute+exact']);
    if (signal?.aborted) throw new MusicError('CANCELLED');
    await this.command(['set_property', 'pause', false]);
  }
  async pause(paused) {
    if (!this.child && paused) return;
    await this.command(['set_property', 'pause', Boolean(paused)]);
  }
  async stop() {
    if (this.socket && !this.socket.destroyed) await this.command(['stop']);
  }
  async seek(position) {
    await this.command(['seek', position, 'absolute+exact']);
  }
  async volume(value) {
    await this.start();
    await this.command(['set_property', 'volume', value]);
  }
  async close() {
    this.closing = true;
    const child = this.child;
    if (child) {
      try {
        await this.command(['quit']);
      } catch {}
      await Promise.race([new Promise((r) => child.once('exit', r)), delay(500)]);
      if (this.child === child) {
        this.child = null;
        child.kill();
      }
    }
    this.socket?.destroy();
    this.socket = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new MusicError('PLAYER_DISCONNECTED'));
    }
    this.pending.clear();
    if (process.platform !== 'win32' && this.directory) {
      try {
        await unlink(this.ipcPath);
      } catch {}
      try {
        await rmdir(this.directory);
      } catch {}
    }
  }
}
