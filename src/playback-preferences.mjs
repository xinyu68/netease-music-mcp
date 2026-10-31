import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { MusicError } from './errors.mjs';

const validVolume = (value) => Number.isInteger(value) && value >= 0 && value <= 100;

export class PlaybackPreferences {
  constructor(stateDir) {
    this.directory = stateDir;
    this.file = path.join(stateDir, 'playback-preferences.json');
  }

  async readVolume(fallback) {
    let text;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw new MusicError('PREFERENCES_READ_FAILED');
    }
    try {
      const saved = JSON.parse(text);
      if (!saved || typeof saved !== 'object' || !validVolume(saved.volume))
        throw new Error('Invalid volume');
      return saved.volume;
    } catch {
      throw new MusicError('PREFERENCES_READ_FAILED');
    }
  }

  async writeVolume(volume) {
    if (!validVolume(volume)) throw new MusicError('INVALID_ARGUMENT');
    const temporary = path.join(this.directory, `.playback-preferences-${randomUUID()}.tmp`);
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify({ volume }) + '\n', {
        mode: 0o600,
        flag: 'wx',
        flush: true,
      });
      await rename(temporary, this.file);
    } catch {
      throw new MusicError('VOLUME_SAVE_FAILED');
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
}
