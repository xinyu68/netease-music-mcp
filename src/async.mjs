import { MusicError } from './errors.mjs';
export function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new MusicError('CANCELLED'));
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(new MusicError('CANCELLED'));
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}
export class Mutations {
  constructor({ limit = 32, history = 128, ttlMs = 600000 } = {}) {
    this.limit = limit;
    this.history = history;
    this.ttlMs = ttlMs;
    this.entries = new Map();
    this.tail = Promise.resolve();
    this.pending = 0;
  }
  submit(id, signature, operation, { priority = false } = {}) {
    if (typeof id !== 'string' || !id || id.length > 128)
      return Promise.reject(new MusicError('INVALID_ARGUMENT'));
    for (const [key, e] of this.entries) {
      if (e.done && Date.now() - e.at > this.ttlMs) this.entries.delete(key);
    }
    const old = this.entries.get(id);
    if (old)
      return old.signature === signature
        ? old.promise
        : Promise.reject(new MusicError('REQUEST_CONFLICT'));
    if (!priority && this.pending >= this.limit)
      return Promise.reject(new MusicError('QUEUE_FULL'));
    this.pending++;
    const promise = (priority ? Promise.resolve() : this.tail).then(operation);
    if (!priority) this.tail = promise.catch(() => {});
    const entry = { signature, promise, done: false, at: Date.now() };
    this.entries.set(id, entry);
    promise
      .finally(() => {
        this.pending--;
        entry.done = true;
        entry.at = Date.now();
        for (const [key, e] of this.entries) {
          if (this.entries.size <= this.history) break;
          if (e.done) this.entries.delete(key);
        }
      })
      .catch(() => {});
    return promise;
  }
}
