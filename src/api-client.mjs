import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MusicError } from './errors.mjs';
import { readOnlyMethods, writeMethods } from './api-methods.mjs';
export class ApiClient {
  constructor({ timeoutMs = 12000, forkImpl = fork } = {}) {
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.sequence = 0;
    this.child = null;
    this.fork = forkImpl;
    this.closed = false;
  }
  start() {
    if (this.closed) throw new MusicError('CANCELLED');
    if (this.child) return;
    const child = this.fork(fileURLToPath(new URL('./api-worker.mjs', import.meta.url)), [], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    this.child = child;
    child.on('message', (message) => {
      const p = this.pending.get(message.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(message.id);
      message.ok
        ? p.resolve({ body: message.body })
        : p.reject(
            Object.assign(new MusicError(message.code === 301 ? 'LOGIN_REQUIRED' : 'API_ERROR'), {
              body: { code: message.code },
            })
          );
    });
    const failed = () => {
      if (this.child !== child) return;
      this.child = null;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new MusicError('API_ERROR'));
      }
      this.pending.clear();
    };
    child.on('error', failed);
    child.on('exit', failed);
  }
  async call(method, params = {}) {
    if (!readOnlyMethods.has(method) && !writeMethods.has(method))
      throw new MusicError('INVALID_ARGUMENT');
    try {
      return await this.callOnce(method, params);
    } catch (error) {
      // Only reads may retry. A write timeout must be reconciled by reading account state.
      if (error.code !== 'API_TIMEOUT' || this.closed || !readOnlyMethods.has(method)) throw error;
      return this.callOnce(method, params);
    }
  }
  callOnce(method, params = {}) {
    if (this.pending.size >= 16) return Promise.reject(new MusicError('QUEUE_FULL'));
    this.start();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new MusicError('API_TIMEOUT'));
        this.reset();
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send({ id, method, params }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new MusicError('API_ERROR'));
        }
      });
    });
  }
  proxy() {
    return new Proxy({}, { get: (_, name) => (params) => this.call(name, params) });
  }
  close() {
    this.closed = true;
    this.reset();
  }
  reset() {
    const child = this.child;
    this.child = null;
    if (child) {
      if (child.connected)
        try {
          child.disconnect();
        } catch {}
      child.kill();
    }
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new MusicError('API_ERROR'));
    }
    this.pending.clear();
  }
}
